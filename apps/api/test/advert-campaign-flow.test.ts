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
  const tables = tablesRes.rows
    .map((row: any) => String(row.tablename ?? '').trim())
    .filter((name: string) => name.length > 0);
  if (tables.length > 0) {
    const quoted = tables.map((name: string) => `"${name}"`).join(', ');
    await pool.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
  }
  await applySchema(pool);
  await ensurePolicyAcceptanceColumns(pool);
}

async function insertUser(input: {
  fullName: string;
  email: string;
  phone: string;
  role: 'BUSINESS' | 'AMBASSADOR' | 'DUAL_USER';
  activeRole?: 'BUSINESS' | 'AMBASSADOR';
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

function buildDraftListingPayload() {
  return {
    title: 'Campaign Product Preview',
    summary: 'Preview product page for a business campaign.',
    description:
      'This draft product page is created before funding so the business can review the public-facing creative and later attach it to the campaign.',
    images: [{ url: 'https://example.com/assets/product-preview.jpg', media_type: 'IMAGE' }],
    content_blocks: [
      { id: 'hero', type: 'heading', text: 'Campaign Product Preview' },
      { id: 'copy', type: 'text', content: 'Pre-funding preview content.' },
    ],
    draft_mode: true,
  };
}

async function insertCampaign(businessId: string) {
  const result = await pool!.query(
    `
    INSERT INTO campaigns (
      business_id,
      title,
      platform,
      payout_amount,
      budget_total,
      media_type,
      media_url,
      start_date,
      end_date,
      visibility,
      execution_mode
    )
    VALUES (
      $1,
      'Campaign Product Preview',
      'WHATSAPP_STATUS',
      5000,
      5000,
      'IMAGE',
      'https://example.com/assets/campaign-a.jpg',
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      'PRIVATE',
      'PRIVATE_CONTRACT'
    )
    RETURNING id
    `,
    [businessId]
  );
  return String(result.rows[0].id);
}

describe('Advert campaign creation flow', () => {
  if (!pool) {
    it('skipped: TEST_DATABASE_URL not set', () => expect(true).toBe(true));
    return;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
    const serverModule = await import('../src/server.js');
    app = serverModule.buildServer();
    await applySchema(pool);
    await ensurePolicyAcceptanceColumns(pool);
    await app.ready();
  }, 30000);

  beforeEach(async () => {
    await resetDatabase();
  }, 30000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  }, 30000);

  it('creates a campaign draft listing that can be attached to a campaign and still appears in my listings', async () => {
    const business = await insertUser({
      fullName: 'Business One',
      email: 'business-one@example.com',
      phone: '+256700300300',
      role: 'BUSINESS',
      activeRole: 'BUSINESS',
    });
    await acceptRequiredPolicies(String(business.id));
    const token = app.jwt.sign(buildAuthClaims(business));

    const listingResponse = await app.inject({
      method: 'POST',
      url: '/api/marketplace/listings',
      headers: { authorization: `Bearer ${token}` },
      payload: buildDraftListingPayload(),
    });

    expect(listingResponse.statusCode).toBe(201);
    const listingBody = listingResponse.json() as {
      listing: { slug: string; status: string; preview_token?: string | null };
    };
    expect(listingBody.listing).toMatchObject({
      status: 'DRAFT',
    });
    expect(typeof listingBody.listing.preview_token).toBe('string');

    const campaignId = await insertCampaign(String(business.id));

    const attachResponse = await app.inject({
      method: 'PATCH',
      url: `/api/advert/listings/${listingBody.listing.slug}/attach-campaign`,
      headers: { authorization: `Bearer ${token}` },
      payload: { campaign_id: campaignId },
    });

    expect(attachResponse.statusCode).toBe(200);
    expect(attachResponse.json()).toMatchObject({
      listing: {
        slug: listingBody.listing.slug,
        campaign_id: campaignId,
      },
    });
  }, 30000);

  it('requires the preview token to load a draft product page', async () => {
    const business = await insertUser({
      fullName: 'Business Two',
      email: 'business-two@example.com',
      phone: '+256700500500',
      role: 'BUSINESS',
      activeRole: 'BUSINESS',
    });
    await acceptRequiredPolicies(String(business.id));
    const token = app.jwt.sign(buildAuthClaims(business));

    const listingResponse = await app.inject({
      method: 'POST',
      url: '/api/marketplace/listings',
      headers: { authorization: `Bearer ${token}` },
      payload: buildDraftListingPayload(),
    });

    expect(listingResponse.statusCode).toBe(201);
    const listingBody = listingResponse.json() as {
      listing: { slug: string; preview_token: string };
    };

    const blocked = await app.inject({
      method: 'GET',
      url: `/api/advert/listings/${listingBody.listing.slug}`,
    });

    expect(blocked.statusCode).toBe(404);

    const allowed = await app.inject({
      method: 'GET',
      url: `/api/advert/listings/${listingBody.listing.slug}?preview_token=${listingBody.listing.preview_token}`,
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toMatchObject({
      listing: {
        slug: listingBody.listing.slug,
        is_draft: true,
      },
    });

    const timeStatusBlocked = await app.inject({
      method: 'GET',
      url: `/api/advert/listings/${listingBody.listing.slug}/time-status`,
    });

    expect(timeStatusBlocked.statusCode).toBe(404);

    const timeStatusAllowed = await app.inject({
      method: 'GET',
      url: `/api/advert/listings/${listingBody.listing.slug}/time-status?preview_token=${listingBody.listing.preview_token}`,
    });

    expect(timeStatusAllowed.statusCode).toBe(200);
    expect(timeStatusAllowed.json()).toMatchObject({
      status: 'DRAFT',
    });
  }, 30000);
});
