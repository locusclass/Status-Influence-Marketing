import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/services/auth.js';
import {
  CURRENT_PLATFORM_POLICY_VERSION,
  CURRENT_PRIVACY_POLICY_VERSION,
} from '../src/services/policies.js';
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
      division_admins,
      country_admins,
      divisions,
      users,
      countries
    CASCADE
  `);
  await applySchema(pool);
}

async function insertBusiness() {
  const result = await pool!.query(
    `
    INSERT INTO users (
      full_name,
      email,
      phone,
      password_hash,
      role,
      active_role,
      status
    )
    VALUES ($1, $2, $3, $4, 'BUSINESS', 'BUSINESS', 'ACTIVE')
    RETURNING *
    `,
    [
      'Policy Business',
      'policy-business@example.com',
      '+256700999111',
      hashPassword('Password123!'),
    ]
  );
  await pool!.query(
    `
    INSERT INTO wallets (user_id, currency, balance_available, balance_escrow, balance)
    VALUES ($1, 'UGX', 0, 0, 0)
    `,
    [result.rows[0].id]
  );
  return result.rows[0];
}

describe('Policy acceptance gate', () => {
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

  it('blocks protected prefixed routes until both policy documents are accepted', async () => {
    await insertBusiness();

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'policy-business@example.com',
        password: 'Password123!',
      },
    });

    expect(loginResponse.statusCode).toBe(200);
    const loginBody = loginResponse.json();
    expect(loginBody.user).toMatchObject({
      policies_accepted: false,
      privacy_policy_required_version: CURRENT_PRIVACY_POLICY_VERSION,
      platform_policy_required_version: CURRENT_PLATFORM_POLICY_VERSION,
    });

    const blockedResponse = await app.inject({
      method: 'GET',
      url: '/api/dashboard/summary',
      headers: { authorization: `Bearer ${loginBody.token}` },
    });

    expect(blockedResponse.statusCode).toBe(428);
    expect(blockedResponse.json()).toMatchObject({
      error: 'policy_acceptance_required',
      policies_accepted: false,
    });

    const policyResponse = await app.inject({
      method: 'GET',
      url: '/api/account/policies',
      headers: { authorization: `Bearer ${loginBody.token}` },
    });

    expect(policyResponse.statusCode).toBe(200);
    expect(policyResponse.json()).toMatchObject({
      acceptance: {
        policies_accepted: false,
      },
      policies: {
        privacy_policy: {
          version: CURRENT_PRIVACY_POLICY_VERSION,
        },
        platform_policy: {
          version: CURRENT_PLATFORM_POLICY_VERSION,
        },
      },
    });

    const acceptResponse = await app.inject({
      method: 'POST',
      url: '/api/account/policies/accept',
      headers: { authorization: `Bearer ${loginBody.token}` },
      payload: {
        privacy_policy_version: CURRENT_PRIVACY_POLICY_VERSION,
        platform_policy_version: CURRENT_PLATFORM_POLICY_VERSION,
        accept_privacy_policy: true,
        accept_platform_policy: true,
      },
    });

    expect(acceptResponse.statusCode).toBe(200);
    const acceptBody = acceptResponse.json();
    expect(acceptBody.user).toMatchObject({
      policies_accepted: true,
      privacy_policy_accepted_version: CURRENT_PRIVACY_POLICY_VERSION,
      platform_policy_accepted_version: CURRENT_PLATFORM_POLICY_VERSION,
    });

    const unlockedResponse = await app.inject({
      method: 'GET',
      url: '/api/dashboard/summary',
      headers: { authorization: `Bearer ${acceptBody.token}` },
    });

    expect(unlockedResponse.statusCode).toBe(200);
  }, 120000);

  it('allows prefixed policy routes to bypass the acceptance gate', async () => {
    await insertBusiness();

    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: 'policy-business@example.com',
        password: 'Password123!',
      },
    });

    expect(loginResponse.statusCode).toBe(200);
    const loginBody = loginResponse.json();

    const policyResponse = await app.inject({
      method: 'GET',
      url: '/api/account/policies',
      headers: { authorization: `Bearer ${loginBody.token}` },
    });

    expect(policyResponse.statusCode).toBe(200);
    expect(policyResponse.json()).toMatchObject({
      acceptance: {
        policies_accepted: false,
      },
    });

    const acceptResponse = await app.inject({
      method: 'POST',
      url: '/api/account/policies/accept',
      headers: { authorization: `Bearer ${loginBody.token}` },
      payload: {
        privacy_policy_version: CURRENT_PRIVACY_POLICY_VERSION,
        platform_policy_version: CURRENT_PLATFORM_POLICY_VERSION,
        accept_privacy_policy: true,
        accept_platform_policy: true,
      },
    });

    expect(acceptResponse.statusCode).toBe(200);
    expect(acceptResponse.json()).toMatchObject({
      user: {
        policies_accepted: true,
      },
    });
  }, 120000);
});
