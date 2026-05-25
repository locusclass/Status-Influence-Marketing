import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildAuthClaims } from '../src/services/roles.js';
import { applySchema, getTestPool } from './db.js';

const pool = getTestPool();
let app: any;

async function resetDatabase() {
  if (!pool) return;
  await pool.query(`
    TRUNCATE TABLE
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
      status
    )
    VALUES (
      'Threshold Business',
      'threshold-business@example.com',
      '+256700000001',
      'x',
      'BUSINESS',
      'ACTIVE'
    )
    RETURNING *
    `
  );
  return result.rows[0];
}

function buildPublicCampaignPayload() {
  return {
    title: 'Retired public campaign',
    platform: 'WHATSAPP_STATUS',
    payout_amount: 100,
    budget_total: 5000,
    execution_mode: 'OPEN_BUDGET',
    start_date: '2026-01-01T00:00:00.000Z',
    end_date: '2026-01-02T00:00:00.000Z',
    media_type: 'IMAGE',
    media_url: 'https://example.com/campaign.jpg',
    impression_target: 50,
    terms_keep_hours: 12,
    terms_min_views: 50,
    terms_requirement: 'DURATION',
  };
}

describe('Retired public contracts', () => {
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
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('returns 410 for the retired public-contract eligibility endpoint', async () => {
    const business = await insertBusiness();
    const token = app.jwt.sign(buildAuthClaims(business));

    const response = await app.inject({
      method: 'GET',
      url: '/campaigns/public-contract-eligibility',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(410);
    expect(response.json()).toMatchObject({
      code: 'public_contracts_retired',
    });
  });

  it('rejects OPEN_BUDGET campaign creation payloads', async () => {
    const business = await insertBusiness();
    const token = app.jwt.sign(buildAuthClaims(business));

    const blocked = await app.inject({
      method: 'POST',
      url: '/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: buildPublicCampaignPayload(),
    });

    expect(blocked.statusCode).toBe(400);
    expect(blocked.json()).toMatchObject({
      code: 'validation_error',
    });
  });
});
