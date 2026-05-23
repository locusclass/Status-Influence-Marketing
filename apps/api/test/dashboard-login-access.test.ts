import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/services/auth.js';
import { applySchema, getTestPool } from './db.js';

const pool = getTestPool();
let app: any;

async function resetDatabase() {
  if (!pool) return;
  await pool.query(`
    TRUNCATE TABLE
      ambassador_profile_reviews,
      chat_offer_group_votes,
      chat_offer_events,
      chat_group_price_overrides,
      chat_group_deal_threads,
      chat_group_memberships,
      chat_groups,
      chat_typing_states,
      chat_messages,
      chat_thread_members,
      chat_threads,
      proofs,
      verification_sessions,
      payouts,
      earnings_ledger,
      escrow_ledger,
      contracts,
      campaigns,
      wallet_txns,
      wallets,
      admin_user_division_scopes,
      admin_user_country_scopes,
      admin_user_modules,
      admin_users,
      division_admins,
      country_admins,
      divisions,
      users,
      countries
    CASCADE
  `);
  await applySchema(pool);
}

async function insertRoleOnlyAdminUser() {
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
      status
    )
    VALUES ($1, $2, $3, $4, 'ADMIN', 'ADMIN', 'USER', 'ACTIVE')
    RETURNING *
    `,
    [
      'Role Only Admin',
      'role-only-admin@example.com',
      '+256700111999',
      hashPassword('Password123!'),
    ]
  );
  return result.rows[0];
}

describe('Dashboard login access', () => {
  if (!pool) {
    it('skipped: TEST_DATABASE_URL not set', () => expect(true).toBe(true));
    return;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
    const serverModule = await import('../src/server.js');
    app = serverModule.buildServer();
    await applySchema(pool);
    await app.ready();
  }, 120000);

  beforeEach(async () => {
    await resetDatabase();
  }, 120000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  }, 120000);

  it('does not advertise dashboard access for users without persisted admin access', async () => {
    await insertRoleOnlyAdminUser();

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'role-only-admin@example.com',
        password: 'Password123!',
      },
    });

    expect(loginResponse.statusCode).toBe(200);
    expect(loginResponse.json()).toMatchObject({
      user: {
        admin_role: 'USER',
      },
    });

    const token = String(loginResponse.json().token ?? '');
    const dashboardAccess = await app.inject({
      method: 'GET',
      url: '/api/dashboard/access',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(dashboardAccess.statusCode).toBe(403);
  }, 120000);
});
