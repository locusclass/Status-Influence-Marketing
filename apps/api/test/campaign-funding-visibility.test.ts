import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildCampaignStatusSummaries } from '../src/routes/campaigns.js';
import { applySchema, getTestPool } from './db.js';

const pool = getTestPool();

describe('Campaign funding visibility', () => {
  if (!pool) {
    it('skipped: TEST_DATABASE_URL not set', () => expect(true).toBe(true));
    return;
  }

  beforeAll(async () => {
    await applySchema(pool);
    await pool.query(`
      ALTER TABLE campaigns
        ADD COLUMN IF NOT EXISTS campaign_bundle_id UUID
    `);
    await pool.query(`
      ALTER TABLE campaigns
        ADD COLUMN IF NOT EXISTS bundle_root_campaign_id UUID REFERENCES campaigns(id)
    `);
  });

  it('keeps ambassador availability false until escrow has real funding evidence', async () => {
    const businessEmail = `business-${randomUUID()}@example.com`;
    const ambassadorEmail = `ambassador-${randomUUID()}@example.com`;

    const business = await pool.query(
      `
      INSERT INTO users (email, phone, password_hash, role)
      VALUES ($1, $2, 'x', 'BUSINESS')
      RETURNING *
      `,
      [businessEmail, `+25670${Date.now().toString().slice(-7)}`]
    );
    const ambassador = await pool.query(
      `
      INSERT INTO users (email, phone, password_hash, role)
      VALUES ($1, $2, 'x', 'AMBASSADOR')
      RETURNING *
      `,
      [ambassadorEmail, `+25471${Date.now().toString().slice(-7)}`]
    );
    const wallet = await pool.query(
      `
      INSERT INTO wallets (user_id, currency, balance_available, balance)
      VALUES ($1, 'UGX', 5000, 5000)
      RETURNING *
      `,
      [business.rows[0].id]
    );
    const campaign = await pool.query(
      `
      INSERT INTO campaigns (
        business_id,
        title,
        platform,
        payout_amount,
        budget_total,
        media_type,
        start_date,
        end_date,
        visibility,
        execution_mode
      )
      VALUES (
        $1,
        'Visibility funding test',
        'WHATSAPP_STATUS',
        1000,
        1000,
        'IMAGE',
        '2026-01-01',
        '2026-12-31',
        'PUBLIC',
        'PRIVATE_CONTRACT'
      )
      RETURNING *
      `,
      [business.rows[0].id]
    );
    await pool.query(
      `
      INSERT INTO escrow_ledger (campaign_id, amount_total, amount_available, status)
      VALUES ($1, 1000, 1000, 'FUNDED')
      `,
      [campaign.rows[0].id]
    );

    let summaries = await buildCampaignStatusSummaries(
      pool,
      [campaign.rows[0].id],
      ambassador.rows[0].id
    );
    expect(summaries.get(campaign.rows[0].id)).toMatchObject({
      escrow_status: 'FUNDED',
      funding_confirmed: false,
      is_available: false,
    });

    await pool.query(
      `
      INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
      VALUES ($1, 1000, 'DEBIT', $2)
      `,
      [wallet.rows[0].id, `ESCROW_FUND:${campaign.rows[0].id}`]
    );

    summaries = await buildCampaignStatusSummaries(
      pool,
      [campaign.rows[0].id],
      ambassador.rows[0].id
    );
    expect(summaries.get(campaign.rows[0].id)).toMatchObject({
      escrow_status: 'FUNDED',
      funding_confirmed: true,
      is_available: true,
    });
  });
});
