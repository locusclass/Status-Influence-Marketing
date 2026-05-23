import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildAuthClaims } from '../src/services/roles.js';
import { applySchema, getTestPool } from './db.js';

const pool = getTestPool();
let app: any;

async function resetDatabase() {
  if (!pool) return;
  const tablesRes = await pool.query(`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `);
  const tables = tablesRes.rows
    .map((row: any) => String(row.tablename ?? '').trim())
    .filter((name: string) => name.length > 0);
  if (tables.length > 0) {
    const quoted = tables.map((name: string) => `"${name}"`).join(', ');
    await pool.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
  }
  await applySchema(pool);
  // Apply migration columns needed for these tests
  await pool.query(`
    ALTER TABLE proofs
      ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'PENDING',
      ADD COLUMN IF NOT EXISTS reviewed_by_admin_id UUID,
      ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS verification_failure_reason TEXT
  `);
}

async function insertCountry(code: string, name: string) {
  const result = await pool!.query(
    `INSERT INTO countries (name, code, status) VALUES ($1, $2, 'ACTIVE') RETURNING *`,
    [name, code]
  );
  return result.rows[0];
}

async function insertUser(input: {
  email: string;
  phone: string;
  role: string;
  active_role: string;
  admin_role?: string | null;
  is_observer?: boolean;
  country_id?: string | null;
}) {
  const result = await pool!.query(
    `INSERT INTO users (full_name, email, phone, password_hash, role, active_role, admin_role, country, preferred_currency, country_id, status, max_status_viewers_12h)
     VALUES ($1, $2, $3, 'x', $4, $5, $6, 'UG', 'UGX', $7, 'ACTIVE', 1000) RETURNING *`,
    [
      `Test ${input.role}`,
      input.email,
      input.phone,
      input.role,
      input.active_role,
      input.admin_role ?? null,
      input.country_id ?? null,
    ]
  );
  const user = result.rows[0];
  if (input.role === 'ADMIN' && input.admin_role) {
    await pool!.query(
      `INSERT INTO admin_users (user_id, admin_role, is_observer, status) VALUES ($1, $2, $3, 'ACTIVE')
       ON CONFLICT (user_id) DO UPDATE SET admin_role=$2, is_observer=$3`,
      [user.id, input.admin_role, input.is_observer ?? false]
    );
  }
  return user;
}

async function insertProofWithSession(businessId: string, ambassadorId: string) {
  const campaignRes = await pool!.query(
    `INSERT INTO campaigns (business_id, title, platform, payout_amount, budget_total, media_type, media_url, start_date, end_date, visibility, execution_mode, status)
     VALUES ($1, 'Test Campaign', 'WHATSAPP_STATUS', 2500, 2500, 'IMAGE', 'https://example.com/img.jpg', '2026-01-01', '2026-12-31', 'PRIVATE', 'PRIVATE_CONTRACT', 'ACTIVE')
     RETURNING *`,
    [businessId]
  );
  const campaign = campaignRes.rows[0];

  const sessionRes = await pool!.query(
    `INSERT INTO verification_sessions (user_id, campaign_id, platform, challenge_code, challenge_phrase, script, expires_at, status)
     VALUES ($1, $2, 'WHATSAPP_STATUS', 'TEST123', 'blue mango', '[]'::jsonb, now() + interval '1 hour', 'ACTIVE') RETURNING *`,
    [ambassadorId, campaign.id]
  );
  const session = sessionRes.rows[0];

  const proofRes = await pool!.query(
    `INSERT INTO proofs (session_id, user_id, video_url, status, verification_status, meta)
     VALUES ($1, $2, '/uploads/files/test.mp4', 'PENDING', 'MANUAL_REVIEW', '{}'::jsonb) RETURNING *`,
    [session.id, ambassadorId]
  );
  return { campaign, session, proof: proofRes.rows[0] };
}

describe('Admin proof verification decision endpoints', () => {
  if (!pool) {
    it('skipped: TEST_DATABASE_URL not set', () => expect(true).toBe(true));
    return;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
    process.env.SKIP_OPTIONAL_STARTUP_WARMUPS = '1';
    process.env.TEST_ROUTE_SCOPE = 'admin';
    const serverModule = await import('../src/server.js');
    app = serverModule.buildServer();
    await applySchema(pool);
    await app.ready();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.SKIP_OPTIONAL_STARTUP_WARMUPS;
    delete process.env.TEST_ROUTE_SCOPE;
  });

  it('observer admin cannot approve a proof (403 admin_observer_read_only)', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const observer = await insertUser({
      email: 'observer@prime.test',
      phone: '+256700111001',
      role: 'ADMIN',
      active_role: 'ADMIN',
      admin_role: 'ADMIN',
      is_observer: true,
      country_id: ug.id,
    });
    const business = await insertUser({
      email: 'biz@prime.test',
      phone: '+256700111002',
      role: 'BUSINESS',
      active_role: 'BUSINESS',
      country_id: ug.id,
    });
    const ambassador = await insertUser({
      email: 'amb@prime.test',
      phone: '+256700111003',
      role: 'AMBASSADOR',
      active_role: 'AMBASSADOR',
      country_id: ug.id,
    });

    const { proof } = await insertProofWithSession(business.id, ambassador.id);

    const token = app.jwt.sign(buildAuthClaims({ ...observer, country_id: ug.id }));
    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/proofs/${proof.id}/verification-decision`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'approve' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'admin_observer_read_only' });
  });

  it('observer admin cannot reject a proof (403 admin_observer_read_only)', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const observer = await insertUser({
      email: 'observer2@prime.test',
      phone: '+256700222001',
      role: 'ADMIN',
      active_role: 'ADMIN',
      admin_role: 'ADMIN',
      is_observer: true,
      country_id: ug.id,
    });
    const business = await insertUser({
      email: 'biz2@prime.test',
      phone: '+256700222002',
      role: 'BUSINESS',
      active_role: 'BUSINESS',
      country_id: ug.id,
    });
    const ambassador = await insertUser({
      email: 'amb2@prime.test',
      phone: '+256700222003',
      role: 'AMBASSADOR',
      active_role: 'AMBASSADOR',
      country_id: ug.id,
    });

    const { proof } = await insertProofWithSession(business.id, ambassador.id);

    const token = app.jwt.sign(buildAuthClaims({ ...observer, country_id: ug.id }));
    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/proofs/${proof.id}/verification-decision`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'reject', reason: 'Fraudulent recording' },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: 'admin_observer_read_only' });
  });

  it('super admin approve sets correct DB fields', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const superAdmin = await insertUser({
      email: 'super@prime.test',
      phone: '+256700333001',
      role: 'ADMIN',
      active_role: 'ADMIN',
      admin_role: 'SUPER_ADMIN',
      country_id: ug.id,
    });
    const business = await insertUser({
      email: 'biz3@prime.test',
      phone: '+256700333002',
      role: 'BUSINESS',
      active_role: 'BUSINESS',
      country_id: ug.id,
    });
    const ambassador = await insertUser({
      email: 'amb3@prime.test',
      phone: '+256700333003',
      role: 'AMBASSADOR',
      active_role: 'AMBASSADOR',
      country_id: ug.id,
    });

    const { proof, campaign } = await insertProofWithSession(business.id, ambassador.id);

    // Ensure escrow funded so payout can proceed
    await pool!.query(
      `INSERT INTO escrow_ledger (campaign_id, amount_total, amount_available, currency, status)
       VALUES ($1, 2500, 2500, 'UGX', 'FUNDED')`,
      [campaign.id]
    );
    await pool!.query(
      `INSERT INTO contracts (campaign_id, ambassador_id, status)
       VALUES ($1, $2, 'ACTIVE')`,
      [campaign.id, ambassador.id]
    );

    const token = app.jwt.sign(buildAuthClaims({ ...superAdmin, country_id: ug.id }));
    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/proofs/${proof.id}/verification-decision`,
      headers: { authorization: `Bearer ${token}` },
      payload: { action: 'approve' },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.proof).toMatchObject({
      id: proof.id,
      verification_status: 'APPROVED',
      decision: 'VERIFIED',
      status: 'VERIFIED',
    });
    expect(body.proof.reviewed_by_admin_id).toBe(superAdmin.id);
    expect(body.proof.reviewed_at).toBeTruthy();
  });
});
