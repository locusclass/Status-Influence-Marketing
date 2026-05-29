import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildAuthClaims } from '../src/services/roles.js';
import {
  CURRENT_PLATFORM_POLICY_VERSION,
  CURRENT_PRIVACY_POLICY_VERSION,
  ensurePolicyAcceptanceColumns,
} from '../src/services/policies.js';
import { applySchema, getTestPool } from './db.js';

const pool = getTestPool();
let app: any;

async function resetDatabase() {
  if (!pool) return;
  const tablesRes = await pool.query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);
  const tables = tablesRes.rows.map((row: any) => `"${row.tablename}"`);
  if (tables.length > 0) {
    await pool.query(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
  }
  await applySchema(pool);
  await ensurePolicyAcceptanceColumns(pool);
}

async function insertUser() {
  const res = await pool!.query(
    `INSERT INTO users (full_name, email, phone, password_hash, role, active_role, status, country)
     VALUES ('Provider One', 'provider@example.com', '+256700000111', 'x', 'BUSINESS', 'BUSINESS', 'ACTIVE', 'UG')
     RETURNING *`
  );
  await pool!.query(
    `UPDATE users
     SET privacy_policy_accepted_version=$2,
         privacy_policy_accepted_at=now(),
         platform_policy_accepted_version=$3,
         platform_policy_accepted_at=now()
     WHERE id=$1`,
    [res.rows[0].id, CURRENT_PRIVACY_POLICY_VERSION, CURRENT_PLATFORM_POLICY_VERSION]
  );
  return res.rows[0];
}

describe('Prime Requests marketplace', () => {
  beforeAll(async () => {
    if (!pool) return;
    process.env.SKIP_OPTIONAL_STARTUP_WARMUPS = '1';
    const serverModule = await import('../src/server.js');
    app = serverModule.buildServer();
    await app.ready();
  });

  beforeEach(async () => {
    if (!pool) return;
    await resetDatabase();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  it('keeps private requester details out of public responses and reveals them after wallet unlock', async () => {
    if (!pool) return;

    const created = await app.inject({
      method: 'POST',
      url: '/api/marketplace/prime-requests',
      payload: {
        title: 'Need catering services for 80 people',
        description: 'I need a reliable caterer for a Saturday family event with food and serving staff.',
        category: 'Events',
        location: 'Kampala',
        budget_min: 500000,
        budget_max: 900000,
        urgency: 'This week',
        requester_name: 'Jane Buyer',
        requester_phone: '+256701111222',
        requester_whatsapp: '+256701111222',
        consent_provider_contact: true,
      },
    });
    expect(created.statusCode).toBe(201);
    const requestId = created.json().request.id;
    await pool.query(`UPDATE prime_requests SET status='active' WHERE id=$1`, [requestId]);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/marketplace/prime-requests',
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().requests[0]).not.toHaveProperty('requester_phone');

    const provider = await insertUser();
    await pool.query(
      `INSERT INTO wallets (user_id, currency, balance, balance_available, balance_escrow)
       VALUES ($1, 'UGX', 5000, 5000, 0)`,
      [provider.id]
    );
    const token = app.jwt.sign(buildAuthClaims(provider));

    const lockedBeforePay = await app.inject({
      method: 'GET',
      url: `/api/marketplace/prime-requests/${requestId}/full`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(lockedBeforePay.statusCode).toBe(200);
    expect(lockedBeforePay.json().access_required).toBe(true);
    expect(lockedBeforePay.json().request).not.toHaveProperty('requester_phone');

    const unlock = await app.inject({
      method: 'POST',
      url: `/api/marketplace/prime-requests/${requestId}/unlock`,
      headers: { authorization: `Bearer ${token}` },
      payload: { fund_source: 'WALLET' },
    });
    expect(unlock.statusCode).toBe(200);
    expect(unlock.json().request.requester_phone).toBe('+256701111222');

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/marketplace/prime-requests/${requestId}/unlock`,
      headers: { authorization: `Bearer ${token}` },
      payload: { fund_source: 'WALLET' },
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json().already_unlocked).toBe(true);

    const wallet = await pool.query(`SELECT balance_available FROM wallets WHERE user_id=$1`, [provider.id]);
    expect(Number(wallet.rows[0].balance_available)).toBe(3000);
  });
});
