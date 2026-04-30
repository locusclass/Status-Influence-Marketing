import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildAuthClaims } from '../src/services/roles.js';
import { applySchema, getTestPool } from './db.js';

const pool = getTestPool();
let app: any;

async function resetDatabase() {
  if (!pool) return;
  await pool.query(`
    TRUNCATE TABLE
      promoter_profile_reviews,
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

async function insertUser(input: {
  fullName: string;
  email: string;
  phone: string;
  role: 'ADVERTISER' | 'DISTRIBUTOR' | 'DUAL_USER';
  activeRole?: 'ADVERTISER' | 'DISTRIBUTOR';
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
      status,
      max_status_viewers_12h
    )
    VALUES ($1, $2, $3, 'x', $4, $5, 'ACTIVE', 1500)
    RETURNING *
    `,
    [
      input.fullName,
      input.email,
      input.phone,
      input.role,
      input.activeRole ?? input.role,
    ]
  );
  return result.rows[0];
}

async function insertCompletedContract(advertiserId: string, promoterId: string) {
  const campaign = await pool!.query(
    `
    INSERT INTO campaigns (
      advertiser_id,
      title,
      platform,
      payout_amount,
      budget_total,
      media_type,
      media_url,
      start_date,
      end_date,
      visibility,
      execution_mode,
      assigned_distributor_id
    )
    VALUES (
      $1,
      'Reviewed campaign',
      'WHATSAPP_STATUS',
      5000,
      5000,
      'IMAGE',
      'https://example.com/reviewed.jpg',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      'PRIVATE',
      'PRIVATE_CONTRACT',
      $2
    )
    RETURNING *
    `,
    [advertiserId, promoterId]
  );
  const contract = await pool!.query(
    `
    INSERT INTO contracts (
      campaign_id,
      distributor_id,
      status,
      accepted_at,
      completed_at
    )
    VALUES ($1, $2, 'COMPLETED', NOW(), NOW())
    RETURNING *
    `,
    [campaign.rows[0].id, promoterId]
  );
  return contract.rows[0];
}

function buildPrivateCampaignPayload(promoterId: string) {
  return {
    title: 'Profile media payload',
    platform: 'WHATSAPP_STATUS',
    payout_amount: 5000,
    budget_total: 5000,
    execution_mode: 'PRIVATE_CONTRACT',
    beneficiary_user_ids: [promoterId],
    start_date: '2026-01-01T00:00:00.000Z',
    end_date: '2026-01-02T00:00:00.000Z',
    media_type: 'IMAGE',
    media_urls: ['https://example.com/assets/campaign-a.jpg'],
    impression_target: 10,
    terms_keep_hours: 24,
    terms_requirement: 'DURATION',
  };
}

describe('Chat promoter profiles', () => {
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

  it('exposes public promoter profiles with review summaries and accepts advertiser reviews', async () => {
    const advertiser = await insertUser({
      fullName: 'Advertiser One',
      email: 'advertiser-one@example.com',
      phone: '+256700100100',
      role: 'ADVERTISER',
      activeRole: 'ADVERTISER',
    });
    const promoter = await insertUser({
      fullName: 'Promoter One',
      email: 'promoter-one@example.com',
      phone: '+256700200200',
      role: 'DISTRIBUTOR',
      activeRole: 'DISTRIBUTOR',
    });
    await insertCompletedContract(advertiser.id, promoter.id);
    const token = app.jwt.sign(buildAuthClaims(advertiser));

    const profileResponse = await app.inject({
      method: 'GET',
      url: `/chat/profiles/${promoter.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(profileResponse.statusCode).toBe(200);
    expect(profileResponse.json()).toMatchObject({
      can_review: true,
      profile: {
        id: promoter.id,
        average_rating: 0,
        rating_count: 0,
      },
      reviews: [],
    });

    const reviewResponse = await app.inject({
      method: 'POST',
      url: `/chat/profiles/${promoter.id}/reviews`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        rating: 5,
        comment: 'Professional delivery and strong audience response.',
      },
    });

    expect(reviewResponse.statusCode).toBe(200);
    expect(reviewResponse.json()).toMatchObject({
      profile: {
        id: promoter.id,
        average_rating: 5,
        rating_count: 1,
        latest_review_comment: 'Professional delivery and strong audience response.',
      },
    });

    const refreshedProfile = await app.inject({
      method: 'GET',
      url: `/chat/profiles/${promoter.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(refreshedProfile.statusCode).toBe(200);
    expect(refreshedProfile.json()).toMatchObject({
      profile: {
        id: promoter.id,
        average_rating: 5,
        rating_count: 1,
      },
      reviews: [
        {
          rating: 5,
          comment: 'Professional delivery and strong audience response.',
        },
      ],
    });
  });

  it('accepts campaign media_urls without requiring a raw media_url field', async () => {
    const advertiser = await insertUser({
      fullName: 'Advertiser Two',
      email: 'advertiser-two@example.com',
      phone: '+256700300300',
      role: 'ADVERTISER',
      activeRole: 'ADVERTISER',
    });
    const promoter = await insertUser({
      fullName: 'Promoter Two',
      email: 'promoter-two@example.com',
      phone: '+256700400400',
      role: 'DISTRIBUTOR',
      activeRole: 'DISTRIBUTOR',
    });
    const token = app.jwt.sign(buildAuthClaims(advertiser));

    const response = await app.inject({
      method: 'POST',
      url: '/campaigns',
      headers: { authorization: `Bearer ${token}` },
      payload: buildPrivateCampaignPayload(promoter.id),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().campaign).toMatchObject({
      media_url: 'https://example.com/assets/campaign-a.jpg',
      media_urls: ['https://example.com/assets/campaign-a.jpg'],
    });
  });
});
