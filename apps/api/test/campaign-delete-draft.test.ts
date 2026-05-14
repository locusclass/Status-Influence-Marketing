import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuid } from 'uuid';

import { buildAuthClaims } from '../src/services/roles.js';
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
      advert_media_interactions,
      advert_offers,
      advert_tracking_links,
      advert_listing_field_values,
      advert_media,
      advert_listings,
      advert_field_options,
      advert_field_definitions,
      advert_listing_types,
      advert_subcategories,
      advert_categories,
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
      status
    )
    VALUES ($1, $2, $3, 'x', $4, $5, 'ACTIVE')
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

async function createListingTaxonomy() {
  const suffix = uuid().slice(0, 8);
  const category = await pool!.query(
    `
    INSERT INTO advert_categories (slug, name, icon, sort_order)
    VALUES ($1, $2, NULL, 0)
    RETURNING *
    `,
    [`delete-test-cat-${suffix}`, 'Delete Test Category']
  );
  const subcategory = await pool!.query(
    `
    INSERT INTO advert_subcategories (category_id, slug, name, sort_order)
    VALUES ($1, $2, $3, 0)
    RETURNING *
    `,
    [category.rows[0].id, `delete-test-sub-${suffix}`, 'Delete Test Subcategory']
  );
  const listingType = await pool!.query(
    `
    INSERT INTO advert_listing_types (subcategory_id, slug, name, sort_order)
    VALUES ($1, $2, $3, 0)
    RETURNING *
    `,
    [subcategory.rows[0].id, `delete-test-type-${suffix}`, 'Delete Test Type']
  );
  return listingType.rows[0];
}

describe('Campaign draft deletion', () => {
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

  it('deletes a draft campaign that already has an advert listing', async () => {
    const business = await insertUser({
      fullName: 'Draft Delete Business',
      email: 'draft-delete@example.com',
      phone: '+256700000010',
      role: 'AMBASSADOR',
      activeRole: 'BUSINESS',
    });
    const listingType = await createListingTaxonomy();
    const campaign = await pool!.query(
      `
      INSERT INTO campaigns (
        business_id,
        title,
        platform,
        execution_mode,
        visibility,
        payout_amount,
        budget_total,
        media_type,
        media_text,
        start_date,
        end_date
      )
      VALUES (
        $1,
        'Draft delete campaign',
        'WHATSAPP_STATUS',
        'PRIVATE_CONTRACT',
        'PRIVATE',
        2500,
        2500,
        'TEXT',
        'Draft delete creative',
        '2026-01-01',
        '2026-12-31'
      )
      RETURNING *
      `,
      [business.id]
    );
    const listing = await pool!.query(
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
        campaign.rows[0].id,
        business.id,
        listingType.id,
        `draft-delete-listing-${uuid().slice(0, 8)}`,
        'Draft delete listing',
        'Short summary for delete test listing',
        'Long description for delete test listing that is long enough to satisfy the schema.',
      ]
    );
    const token = app.jwt.sign(buildAuthClaims(business));

    const response = await app.inject({
      method: 'DELETE',
      url: `/campaigns/${campaign.rows[0].id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      deleted: true,
      campaign_id: campaign.rows[0].id,
    });

    const listingRow = await pool!.query(
      'SELECT id FROM advert_listings WHERE id = $1',
      [listing.rows[0].id]
    );
    const campaignRow = await pool!.query(
      'SELECT id FROM campaigns WHERE id = $1',
      [campaign.rows[0].id]
    );
    expect(listingRow.rowCount).toBe(0);
    expect(campaignRow.rowCount).toBe(0);
  });
});
