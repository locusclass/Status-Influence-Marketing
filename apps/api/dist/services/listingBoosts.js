export const LISTING_BOOST_PRO_DISCOUNT_PERCENT = 20;
const MILLIS_PER_HOUR = 60 * 60 * 1000;
export const LISTING_BOOST_PLANS = {
    FEATURED_24H: {
        code: 'FEATURED_24H',
        label: 'Featured placement · 24 hours',
        description: 'Pushes your product page ahead of standard listings for one full day.',
        duration_hours: 24,
        amount_ugx: 5_000,
    },
    FEATURED_72H: {
        code: 'FEATURED_72H',
        label: 'Featured placement · 72 hours',
        description: 'Keeps your product page prioritized across the marketplace for three days.',
        duration_hours: 72,
        amount_ugx: 12_000,
    },
    FEATURED_168H: {
        code: 'FEATURED_168H',
        label: 'Featured placement · 7 days',
        description: 'Extends priority exposure for an entire week while your campaign remains live.',
        duration_hours: 168,
        amount_ugx: 25_000,
    },
};
export function effectivePromotionSql(alias = 'al') {
    return `(COALESCE(${alias}.is_promoted, FALSE) OR (${alias}.boost_expires_at IS NOT NULL AND ${alias}.boost_expires_at > NOW()))`;
}
export function resolveListingBoostPlan(code) {
    const normalized = code.trim().toUpperCase();
    return LISTING_BOOST_PLANS[normalized] ?? null;
}
export function calculateListingBoostPrice(planCode, proSubscriptionActive) {
    const plan = resolveListingBoostPlan(planCode);
    if (!plan) {
        return null;
    }
    const discountPercent = proSubscriptionActive
        ? LISTING_BOOST_PRO_DISCOUNT_PERCENT
        : 0;
    const amountUgx = Math.max(0, Math.round((plan.amount_ugx * (100 - discountPercent)) / 100));
    return {
        ...plan,
        base_amount_ugx: plan.amount_ugx,
        amount_ugx: amountUgx,
        discount_percent: discountPercent,
        is_discounted: discountPercent > 0 && amountUgx < plan.amount_ugx,
    };
}
export function buildListingBoostOptions(proSubscriptionActive) {
    return Object.values(LISTING_BOOST_PLANS).map((plan) => calculateListingBoostPrice(plan.code, proSubscriptionActive));
}
export async function ensureListingBoostSchema(client) {
    await client.query(`
    ALTER TABLE advert_listings
      ADD COLUMN IF NOT EXISTS boost_plan TEXT
  `);
    await client.query(`
    ALTER TABLE advert_listings
      ADD COLUMN IF NOT EXISTS boost_expires_at TIMESTAMPTZ
  `);
    await client.query(`
    CREATE TABLE IF NOT EXISTS advert_listing_boosts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      listing_id UUID NOT NULL REFERENCES advert_listings(id) ON DELETE CASCADE,
      business_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan_code TEXT NOT NULL,
      duration_hours INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'UGX',
      payment_reference TEXT,
      status TEXT NOT NULL DEFAULT 'PENDING',
      starts_at TIMESTAMPTZ,
      ends_at TIMESTAMPTZ,
      paid_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT advert_listing_boosts_status_check
        CHECK (status IN ('PENDING', 'ACTIVE', 'EXPIRED', 'FAILED', 'CANCELLED'))
    )
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS advert_listing_boosts_listing_idx
    ON advert_listing_boosts (listing_id, created_at DESC)
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS advert_listing_boosts_business_idx
    ON advert_listing_boosts (business_id, created_at DESC)
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS advert_listing_boosts_status_idx
    ON advert_listing_boosts (status, ends_at DESC)
  `);
    await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS advert_listing_boosts_payment_reference_idx
    ON advert_listing_boosts (payment_reference)
    WHERE payment_reference IS NOT NULL
  `);
}
export async function activateListingBoost(client, input) {
    await ensureListingBoostSchema(client);
    const plan = resolveListingBoostPlan(input.planCode);
    if (!plan) {
        throw new Error('listing_boost_plan_invalid');
    }
    const listingRes = await client.query(`
    SELECT id, business_id, status, access_state, campaign_end_at, boost_expires_at
    FROM advert_listings
    WHERE id = $1 AND business_id = $2
    LIMIT 1
    FOR UPDATE
    `, [input.listingId, input.businessId]);
    const listing = listingRes.rows[0];
    if (!listing) {
        throw new Error('listing_not_found');
    }
    const status = String(listing.status ?? '').trim().toUpperCase();
    const accessState = String(listing.access_state ?? 'PUBLIC')
        .trim()
        .toUpperCase();
    if (status !== 'ACTIVE' || accessState !== 'PUBLIC') {
        throw new Error('listing_boost_requires_active_listing');
    }
    const now = new Date();
    const currentBoostExpiry = listing.boost_expires_at
        ? new Date(listing.boost_expires_at)
        : null;
    const boostStartsAt = currentBoostExpiry != null && currentBoostExpiry.getTime() > now.getTime()
        ? currentBoostExpiry
        : now;
    let boostEndsAt = new Date(boostStartsAt.getTime() + plan.duration_hours * MILLIS_PER_HOUR);
    const campaignEndAt = listing.campaign_end_at
        ? new Date(listing.campaign_end_at)
        : null;
    if (campaignEndAt != null && boostEndsAt.getTime() > campaignEndAt.getTime()) {
        boostEndsAt = campaignEndAt;
    }
    const nextStatus = boostEndsAt.getTime() > now.getTime() ? 'ACTIVE' : 'EXPIRED';
    await client.query(`
    UPDATE advert_listing_boosts
    SET status = CASE
          WHEN status = 'ACTIVE' AND ends_at IS NOT NULL AND ends_at <= now()
            THEN 'EXPIRED'
          ELSE status
        END,
        updated_at = now()
    WHERE listing_id = $1
    `, [input.listingId]);
    const updatedBoost = await client.query(`
    UPDATE advert_listing_boosts
    SET status = $3,
        starts_at = COALESCE(starts_at, $4),
        ends_at = $5,
        paid_at = COALESCE(paid_at, now()),
        updated_at = now()
    WHERE listing_id = $1
      AND payment_reference = $2
    RETURNING *
    `, [
        input.listingId,
        input.paymentReference,
        nextStatus,
        boostStartsAt,
        boostEndsAt,
    ]);
    const boostRow = updatedBoost.rows[0] ??
        (await client.query(`
        INSERT INTO advert_listing_boosts (
          listing_id,
          business_id,
          plan_code,
          duration_hours,
          amount,
          currency,
          payment_reference,
          status,
          starts_at,
          ends_at,
          paid_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
        RETURNING *
        `, [
            input.listingId,
            input.businessId,
            plan.code,
            plan.duration_hours,
            input.amountUgx,
            input.currency ?? 'UGX',
            input.paymentReference,
            nextStatus,
            boostStartsAt,
            boostEndsAt,
        ])).rows[0];
    await client.query(`
    UPDATE advert_listings
    SET boost_plan = $2,
        boost_expires_at = $3,
        updated_at = now()
    WHERE id = $1
    `, [input.listingId, plan.code, boostEndsAt]);
    return {
        boost: boostRow,
        plan,
        boost_starts_at: boostStartsAt,
        boost_expires_at: boostEndsAt,
        is_active: nextStatus === 'ACTIVE',
    };
}
