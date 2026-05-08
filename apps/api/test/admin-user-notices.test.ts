import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildAuthClaims } from '../src/services/roles.js';
import {
  CURRENT_PLATFORM_POLICY_VERSION,
  CURRENT_PRIVACY_POLICY_VERSION,
  ensurePolicyAcceptanceColumns,
} from '../src/services/policies.js';
import { ensureUserSignalSchema } from '../src/services/userSignals.js';
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
  const tables = tablesRes.rows
    .map((row: any) => String(row.tablename ?? '').trim())
    .filter((name: string) => name.length > 0);
  if (tables.length > 0) {
    const quoted = tables.map((name: string) => `"${name}"`).join(', ');
    await pool.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
  }
  await applySchema(pool);
  await ensurePolicyAcceptanceColumns(pool);
  await ensureUserSignalSchema(pool);
}

async function insertCountry(code: string, name: string) {
  const result = await pool!.query(
    `
    INSERT INTO countries (name, code, status)
    VALUES ($1, $2, 'ACTIVE')
    RETURNING *
    `,
    [name, code]
  );
  return result.rows[0];
}

async function insertUser(input: {
  email: string;
  phone: string;
  full_name?: string;
  role?: string;
  active_role?: string;
  admin_role?: string;
  country?: string;
  country_id?: string | null;
  division_id?: string | null;
}) {
  const result = await pool!.query(
    `
    INSERT INTO users (
      full_name,
      email,
      phone,
      password_hash,
      role,
      active_role,
      admin_role,
      country,
      preferred_currency,
      country_id,
      division_id
    )
    VALUES ($1, $2, $3, 'test-hash', $4, $5, $6, $7, 'UGX', $8, $9)
    RETURNING *
    `,
    [
      input.full_name ?? 'Prime User',
      input.email,
      input.phone,
      input.role ?? 'AMBASSADOR',
      input.active_role ?? (input.role ?? 'AMBASSADOR'),
      input.admin_role ?? 'USER',
      input.country ?? 'UG',
      input.country_id ?? null,
      input.division_id ?? null,
    ]
  );
  return result.rows[0];
}

async function acceptRequiredPolicies(userId: string) {
  await pool!.query(
    `
    UPDATE users
    SET privacy_policy_accepted_version = $2,
        privacy_policy_accepted_at = NOW(),
        platform_policy_accepted_version = $3,
        platform_policy_accepted_at = NOW()
    WHERE id = $1
    `,
    [userId, CURRENT_PRIVACY_POLICY_VERSION, CURRENT_PLATFORM_POLICY_VERSION]
  );
}

describe('Admin user blocking notices', () => {
  if (!pool) {
    it('skipped: TEST_DATABASE_URL not set', () => expect(true).toBe(true));
    return;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
    process.env.ADMIN_ACCESS_PHRASE ??= 'prime-status-emergency';
    process.env.SKIP_OPTIONAL_STARTUP_WARMUPS = '1';
    delete process.env.TEST_ROUTE_SCOPE;
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
  });

  it('creates a selected-user blocking notice and removes it cleanly', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const admin = await insertUser({
      email: 'notice-admin@prime.test',
      phone: '+256700100101',
      full_name: 'Notice Admin',
      role: 'ADMIN',
      active_role: 'ADMIN',
      admin_role: 'SUPER_ADMIN',
      country_id: ug.id,
    });
    const ambassador = await insertUser({
      email: 'noticed-ambassador@prime.test',
      phone: '+256700100102',
      full_name: 'Target Ambassador',
      role: 'AMBASSADOR',
      active_role: 'AMBASSADOR',
      country_id: ug.id,
    });
    const business = await insertUser({
      email: 'clear-business@prime.test',
      phone: '+256700100103',
      full_name: 'Clear Business',
      role: 'BUSINESS',
      active_role: 'BUSINESS',
      country_id: ug.id,
    });
    await acceptRequiredPolicies(String(ambassador.id));
    await acceptRequiredPolicies(String(business.id));

    const adminToken = app.jwt.sign(buildAuthClaims(admin));
    const ambassadorToken = app.jwt.sign(buildAuthClaims(ambassador));
    const businessToken = app.jwt.sign(buildAuthClaims(business));

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/user-notices',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        title: 'Compliance hold',
        body: 'Contact support before continuing with any app activity.',
        send_to_all: false,
        user_ids: [String(ambassador.id)],
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      notice: {
        title: 'Compliance hold',
        body: 'Contact support before continuing with any app activity.',
        audience_kind: 'SELECTED_USERS',
        target_count: 1,
      },
    });
    const noticeId = String(created.json().notice.id);

    const users = await app.inject({
      method: 'GET',
      url: '/api/admin/users?limit=20',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(users.statusCode).toBe(200);
    const rows = users.json().users as Array<Record<string, unknown>>;
    const targetedRow = rows.find((row) => row.id === ambassador.id);
    const clearRow = rows.find((row) => row.id === business.id);
    expect(targetedRow).toMatchObject({
      active_admin_notice_id: noticeId,
      active_admin_notice_title: 'Compliance hold',
    });
    expect(clearRow?.active_admin_notice_id ?? null).toBeNull();

    const activeList = await app.inject({
      method: 'GET',
      url: '/api/admin/user-notices?status=ACTIVE&limit=10',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(activeList.statusCode).toBe(200);
    expect(activeList.json().notices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: noticeId,
          title: 'Compliance hold',
          target_count: 1,
        }),
      ])
    );

    const targetedProfile = await app.inject({
      method: 'GET',
      url: '/api/account/me',
      headers: { authorization: `Bearer ${ambassadorToken}` },
    });
    expect(targetedProfile.statusCode).toBe(200);
    expect(targetedProfile.json()).toMatchObject({
      profile: {
        active_admin_notice: {
          id: noticeId,
          title: 'Compliance hold',
          body: 'Contact support before continuing with any app activity.',
        },
      },
    });

    const clearProfile = await app.inject({
      method: 'GET',
      url: '/api/account/me',
      headers: { authorization: `Bearer ${businessToken}` },
    });
    expect(clearProfile.statusCode).toBe(200);
    expect(clearProfile.json().profile.active_admin_notice).toBeNull();

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/admin/user-notices/${noticeId}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({
      notice: {
        id: noticeId,
      },
    });

    const afterRemoval = await app.inject({
      method: 'GET',
      url: '/api/account/me',
      headers: { authorization: `Bearer ${ambassadorToken}` },
    });
    expect(afterRemoval.statusCode).toBe(200);
    expect(afterRemoval.json().profile.active_admin_notice).toBeNull();
  });

  it('can send a blocking notice to all non-admin users in scope', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const admin = await insertUser({
      email: 'all-notice-admin@prime.test',
      phone: '+256700100104',
      full_name: 'All Notice Admin',
      role: 'ADMIN',
      active_role: 'ADMIN',
      admin_role: 'SUPER_ADMIN',
      country_id: ug.id,
    });
    const ambassador = await insertUser({
      email: 'all-ambassador@prime.test',
      phone: '+256700100105',
      full_name: 'All Ambassador',
      role: 'AMBASSADOR',
      active_role: 'AMBASSADOR',
      country_id: ug.id,
    });
    const business = await insertUser({
      email: 'all-business@prime.test',
      phone: '+256700100106',
      full_name: 'All Business',
      role: 'BUSINESS',
      active_role: 'BUSINESS',
      country_id: ug.id,
    });
    await acceptRequiredPolicies(String(ambassador.id));
    await acceptRequiredPolicies(String(business.id));

    const adminToken = app.jwt.sign(buildAuthClaims(admin));
    const ambassadorToken = app.jwt.sign(buildAuthClaims(ambassador));
    const businessToken = app.jwt.sign(buildAuthClaims(business));

    const created = await app.inject({
      method: 'POST',
      url: '/api/admin/user-notices',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        title: 'Platform maintenance',
        body: 'The app is temporarily locked while account updates are applied.',
        send_to_all: true,
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      notice: {
        title: 'Platform maintenance',
        audience_kind: 'ALL_SCOPED_USERS',
        target_count: 2,
      },
    });
    const noticeId = String(created.json().notice.id);

    const ambassadorProfile = await app.inject({
      method: 'GET',
      url: '/api/account/me',
      headers: { authorization: `Bearer ${ambassadorToken}` },
    });
    expect(ambassadorProfile.statusCode).toBe(200);
    expect(ambassadorProfile.json()).toMatchObject({
      profile: {
        active_admin_notice: {
          id: noticeId,
          title: 'Platform maintenance',
        },
      },
    });

    const businessProfile = await app.inject({
      method: 'GET',
      url: '/api/account/me',
      headers: { authorization: `Bearer ${businessToken}` },
    });
    expect(businessProfile.statusCode).toBe(200);
    expect(businessProfile.json()).toMatchObject({
      profile: {
        active_admin_notice: {
          id: noticeId,
          title: 'Platform maintenance',
        },
      },
    });

    const notices = await app.inject({
      method: 'GET',
      url: '/api/admin/user-notices?status=ACTIVE&limit=10',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(notices.statusCode).toBe(200);
    expect(notices.json().notices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: noticeId,
          target_count: 2,
        }),
      ])
    );
  });
});
