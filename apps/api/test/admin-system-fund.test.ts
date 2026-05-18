import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildAuthClaims } from '../src/services/roles.js';
import { buildCampaignStatusSummaries } from '../src/routes/campaigns.js';
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
  await pool.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS campaign_bundle_id UUID
  `);
  await pool.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS bundle_root_campaign_id UUID REFERENCES campaigns(id)
  `);
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
  full_name: string;
  email: string;
  phone: string;
  role: string;
  active_role: string;
  admin_role?: string | null;
  country?: string | null;
  country_id?: string | null;
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
      status,
      max_status_viewers_12h
    )
    VALUES ($1, $2, $3, 'x', $4, $5, $6, $7, 'UGX', $8, 'ACTIVE', 1200)
    RETURNING *
    `,
    [
      input.full_name,
      input.email,
      input.phone,
      input.role,
      input.active_role,
      input.admin_role ?? null,
      input.country ?? 'UG',
      input.country_id ?? null,
    ]
  );
  return result.rows[0];
}

async function insertCampaign(input: {
  business_id: string;
  title: string;
  country_id: string;
  parent_campaign_id?: string | null;
  bundle_root_campaign_id?: string | null;
  assigned_ambassador_id?: string | null;
}) {
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
      execution_mode,
      status,
      country_id,
      parent_campaign_id,
      bundle_root_campaign_id,
      assigned_ambassador_id
    )
    VALUES (
      $1,
      $2,
      'WHATSAPP_STATUS',
      2500,
      2500,
      'IMAGE',
      'https://example.com/assets/system-grant.jpg',
      '2026-01-01T00:00:00.000Z',
      '2026-12-31T00:00:00.000Z',
      'PRIVATE',
      'PRIVATE_CONTRACT',
      'ACTIVE',
      $3,
      $4,
      $5,
      $6
    )
    RETURNING *
    `,
    [
      input.business_id,
      input.title,
      input.country_id,
      input.parent_campaign_id ?? null,
      input.bundle_root_campaign_id ?? null,
      input.assigned_ambassador_id ?? null,
    ]
  );
  return result.rows[0];
}

async function createListingTaxonomy() {
  const suffix = randomUUID().slice(0, 8);
  const category = await pool!.query(
    `
    INSERT INTO advert_categories (slug, name, icon, sort_order)
    VALUES ($1, $2, NULL, 0)
    RETURNING *
    `,
    [`system-fund-cat-${suffix}`, 'System Fund Category']
  );
  const subcategory = await pool!.query(
    `
    INSERT INTO advert_subcategories (category_id, slug, name, sort_order)
    VALUES ($1, $2, $3, 0)
    RETURNING *
    `,
    [category.rows[0].id, `system-fund-sub-${suffix}`, 'System Fund Subcategory']
  );
  const listingType = await pool!.query(
    `
    INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order)
    VALUES ($1, $2, $3, 0)
    RETURNING *
    `,
    [subcategory.rows[0].id, `system-fund-type-${suffix}`, 'System Fund Type']
  );
  return listingType.rows[0];
}

async function insertDraftListing(input: {
  campaign_id: string;
  business_id: string;
  listing_type_id: string;
  title: string;
}) {
  const result = await pool!.query(
    `
    INSERT INTO advert_listings (
      campaign_id,
      business_id,
      listing_type_id,
      slug,
      title,
      summary,
      description,
      status
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'DRAFT')
    RETURNING *
    `,
    [
      input.campaign_id,
      input.business_id,
      input.listing_type_id,
      `system-fund-listing-${randomUUID().slice(0, 8)}`,
      input.title,
      'System-funded listing summary',
      'System-funded listing description for regression coverage.',
    ]
  );
  return result.rows[0];
}

describe('Admin system funding', () => {
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

  it('funds child campaigns against the resolved escrow owner and notifies the tagged ambassador', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const superAdmin = await insertUser({
      full_name: 'Prime Super Admin',
      email: 'system-fund-admin@prime.test',
      phone: '+256700300300',
      role: 'ADMIN',
      active_role: 'ADMIN',
      admin_role: 'SUPER_ADMIN',
      country: 'UG',
      country_id: ug.id,
    });
    const business = await insertUser({
      full_name: 'Campaign Business',
      email: 'system-fund-business@prime.test',
      phone: '+256700300301',
      role: 'BUSINESS',
      active_role: 'BUSINESS',
      country: 'UG',
      country_id: ug.id,
    });
    const ambassador = await insertUser({
      full_name: 'Tagged Ambassador',
      email: 'system-fund-ambassador@prime.test',
      phone: '+256700300302',
      role: 'AMBASSADOR',
      active_role: 'AMBASSADOR',
      country: 'UG',
      country_id: ug.id,
    });

    const rootCampaign = await insertCampaign({
      business_id: business.id,
      title: 'Root funded campaign',
      country_id: ug.id,
    });
    const listingType = await createListingTaxonomy();
    await insertDraftListing({
      campaign_id: rootCampaign.id,
      business_id: business.id,
      listing_type_id: listingType.id,
      title: 'Root funded listing',
    });
    const childCampaign = await insertCampaign({
      business_id: business.id,
      title: 'Granted child campaign',
      country_id: ug.id,
      parent_campaign_id: rootCampaign.id,
      bundle_root_campaign_id: rootCampaign.id,
      assigned_ambassador_id: ambassador.id,
    });

    const adminToken = app.jwt.sign(
      buildAuthClaims({
        ...superAdmin,
        country_id: ug.id,
      })
    );

    const response = await app.inject({
      method: 'POST',
      url: `/admin/campaigns/${childCampaign.id}/system-fund`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        note: 'Approved via system grant',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      funded: true,
      campaign_id: childCampaign.id,
    });

    const rootEscrow = await pool!.query(
      `
      SELECT *
      FROM escrow_ledger
      WHERE campaign_id = $1
      LIMIT 1
      `,
      [rootCampaign.id]
    );
    expect(rootEscrow.rows[0]).toMatchObject({
      campaign_id: rootCampaign.id,
      status: 'FUNDED',
    });

    const listing = await pool!.query(
      `
      SELECT status
      FROM advert_listings
      WHERE campaign_id = $1
      LIMIT 1
      `,
      [rootCampaign.id]
    );
    expect(listing.rows[0]).toMatchObject({
      status: 'ACTIVE',
    });

    const childEscrow = await pool!.query(
      `
      SELECT *
      FROM escrow_ledger
      WHERE campaign_id = $1
      LIMIT 1
      `,
      [childCampaign.id]
    );
    expect(childEscrow.rows[0] ?? null).toBeNull();

    const grantTxn = await pool!.query(
      `
      SELECT merchant_reference, raw_payload
      FROM pesapal_transactions
      WHERE escrow_id = $1
      LIMIT 1
      `,
      [rootEscrow.rows[0].id]
    );
    expect(grantTxn.rows[0]).toMatchObject({
      merchant_reference: expect.stringMatching(/^SYSTEM_GRANT:/),
      raw_payload: expect.objectContaining({
        kind: 'SYSTEM_GRANT',
        campaign_id: childCampaign.id,
        escrow_campaign_id: rootCampaign.id,
      }),
    });

    const summaries = await buildCampaignStatusSummaries(
      pool,
      [childCampaign.id],
      ambassador.id
    );
    expect(summaries.get(childCampaign.id)).toMatchObject({
      escrow_status: 'FUNDED',
      funding_confirmed: true,
      is_available: true,
    });

    const notifications = await pool!.query(
      `
      SELECT category, title, body, target_id
      FROM user_notifications
      WHERE user_id = $1
      ORDER BY created_at DESC
      `,
      [ambassador.id]
    );
    expect(notifications.rows[0]).toMatchObject({
      category: 'CAMPAIGN_ASSIGNMENT',
      title: 'New campaign assignment',
      target_id: childCampaign.id,
    });
    expect(String(notifications.rows[0].body ?? '')).toContain(
      'review and accept the contract'
    );
  });
});
