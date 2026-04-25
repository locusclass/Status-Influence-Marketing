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

async function insertAdvertiser() {
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
      'Threshold Advertiser',
      'threshold-advertiser@example.com',
      '+256700000001',
      'x',
      'ADVERTISER',
      'ACTIVE'
    )
    RETURNING *
    `
  );
  return result.rows[0];
}

async function insertActiveDistributors(count: number) {
  if (count <= 0) return;
  await pool!.query(
    `
    INSERT INTO users (
      full_name,
      email,
      phone,
      password_hash,
      role,
      status
    )
    SELECT
      'Distributor ' || series_id,
      'distributor-' || series_id || '@example.com',
      '+25678' || LPAD(series_id::text, 7, '0'),
      'x',
      'DISTRIBUTOR',
      'ACTIVE'
    FROM generate_series(1, $1) AS series_id
    `,
    [count]
  );
}

function buildPublicCampaignPayload() {
  return {
    title: 'Threshold public campaign',
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
    terms_requirement: 'VIEWS',
  };
}

describe('Public contract eligibility', () => {
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

  it('reports the backend-confirmed active distributor threshold for public contracts', async () => {
    await insertActiveDistributors(4999);
    const advertiser = await insertAdvertiser();
    const token = app.jwt.sign(buildAuthClaims(advertiser));

    const response = await app.inject({
      method: 'GET',
      url: '/campaigns/public-contract-eligibility',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      eligible: false,
      active_distributors: 4999,
      required_active_distributors: 5000,
    });
  });

  it('blocks public contracts below the threshold and allows them once the backend confirms enough distributors', async () => {
    await insertActiveDistributors(4999);
    const advertiser = await insertAdvertiser();
    const token = app.jwt.sign(buildAuthClaims(advertiser));

    const blocked = await app.inject({
      method: 'POST',
      url: '/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: buildPublicCampaignPayload(),
    });

    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({
      error: 'public_contract_distributor_threshold_unmet',
      eligible: false,
      active_distributors: 4999,
      required_active_distributors: 5000,
    });

    await insertActiveDistributors(1);

    const allowed = await app.inject({
      method: 'POST',
      url: '/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: buildPublicCampaignPayload(),
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json().campaign).toMatchObject({
      platform: 'WHATSAPP_STATUS',
      execution_mode: 'OPEN_BUDGET',
      visibility: 'PUBLIC',
    });
  });
});
