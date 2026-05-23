export const BUSINESS_PRO_SUBSCRIPTION_TIER = 'PRO_PRIME';
export const BUSINESS_PRO_PLANS = {
    monthly: {
        code: 'monthly',
        label: 'Monthly',
        amountUgx: 25_000,
        validDays: 30,
        description: 'UGX 25,000 / month',
    },
    annual: {
        code: 'annual',
        label: 'Annual',
        amountUgx: 240_000,
        validDays: 365,
        description: 'UGX 240,000 / year · 2 months free',
    },
};
// Keep legacy constants for backwards-compatibility with existing pay routes
export const BUSINESS_PRO_SUBSCRIPTION_AMOUNT_UGX = BUSINESS_PRO_PLANS.monthly.amountUgx;
export const BUSINESS_PRO_SUBSCRIPTION_VALID_DAYS = BUSINESS_PRO_PLANS.monthly.validDays;
/**
 * Returns a SQL EXISTS expression that is TRUE when businessIdSqlExpr belongs
 * to a business with an active (paid or waived) Pro Prime subscription.
 * Safe to embed in any SELECT that has access to the business_pro_subscriptions table.
 */
export function proKeepAliveConditionSql(businessIdSqlExpr) {
    return `EXISTS (
    SELECT 1 FROM business_pro_subscriptions bps_kp
    WHERE bps_kp.business_id = ${businessIdSqlExpr}
      AND bps_kp.valid_until > NOW()
      AND (bps_kp.is_waived = TRUE OR bps_kp.paid_at IS NOT NULL)
  )`;
}
export async function ensureBusinessProSubscriptionSchema(client) {
    await client.query(`
    CREATE TABLE IF NOT EXISTS business_pro_subscriptions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      tier TEXT NOT NULL DEFAULT '${BUSINESS_PRO_SUBSCRIPTION_TIER}',
      period_start DATE NOT NULL,
      valid_until TIMESTAMPTZ NOT NULL,
      amount INTEGER NOT NULL DEFAULT ${BUSINESS_PRO_SUBSCRIPTION_AMOUNT_UGX},
      currency TEXT NOT NULL DEFAULT 'UGX',
      payment_reference TEXT,
      paid_at TIMESTAMPTZ,
      is_waived BOOLEAN NOT NULL DEFAULT FALSE,
      waived_by_admin_id UUID REFERENCES users(id),
      waived_at TIMESTAMPTZ,
      waived_note TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS business_pro_subscriptions_business_idx
    ON business_pro_subscriptions (business_id, created_at DESC)
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS business_pro_subscriptions_valid_until_idx
    ON business_pro_subscriptions (valid_until DESC)
  `);
    await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS business_pro_subscriptions_payment_reference_idx
    ON business_pro_subscriptions (payment_reference)
    WHERE payment_reference IS NOT NULL
  `);
}
export async function getLatestBusinessProSubscription(client, businessId) {
    await ensureBusinessProSubscriptionSchema(client);
    const result = await client.query(`
    SELECT
      id,
      tier,
      amount,
      currency,
      is_waived,
      paid_at,
      waived_at,
      waived_note,
      period_start,
      valid_until,
      payment_reference
    FROM business_pro_subscriptions
    WHERE business_id = $1
    ORDER BY COALESCE(paid_at, waived_at, created_at) DESC, created_at DESC
    LIMIT 1
    `, [businessId]);
    return result.rows[0] ?? null;
}
export async function getBusinessProSubscriptionStatus(client, businessId) {
    const row = await getLatestBusinessProSubscription(client, businessId);
    const isWaived = row?.is_waived === true;
    const validUntil = row?.valid_until == null ? null : new Date(row.valid_until);
    const isActive = row != null &&
        validUntil != null &&
        validUntil.getTime() > Date.now() &&
        (isWaived || row.paid_at != null);
    return {
        tier: BUSINESS_PRO_SUBSCRIPTION_TIER,
        is_active: isActive,
        is_waived: isWaived,
        paid_at: row?.paid_at ?? null,
        valid_until: row?.valid_until ?? null,
        amount: Number.isFinite(Number(row?.amount))
            ? Math.trunc(Number(row.amount))
            : BUSINESS_PRO_SUBSCRIPTION_AMOUNT_UGX,
        currency: String(row?.currency ?? 'UGX'),
        period_start: row?.period_start ?? null,
        waived_note: row?.waived_note ?? null,
        plans: Object.values(BUSINESS_PRO_PLANS).map((p) => ({
            code: p.code,
            label: p.label,
            amount_ugx: p.amountUgx,
            valid_days: p.validDays,
            description: p.description,
        })),
    };
}
export async function hasActiveBusinessProSubscription(client, businessId) {
    const status = await getBusinessProSubscriptionStatus(client, businessId);
    return status.is_active === true;
}
export async function reserveBusinessProSubscription(client, businessId, paymentReference, planCode = 'monthly') {
    await ensureBusinessProSubscriptionSchema(client);
    const plan = BUSINESS_PRO_PLANS[planCode] ?? BUSINESS_PRO_PLANS.monthly;
    const now = new Date();
    const validUntil = new Date(now.getTime() + plan.validDays * 24 * 60 * 60 * 1000);
    const result = await client.query(`
    INSERT INTO business_pro_subscriptions (
      business_id,
      tier,
      period_start,
      valid_until,
      amount,
      currency,
      payment_reference
    )
    VALUES ($1, $2, $3, $4, $5, 'UGX', $6)
    RETURNING *
    `, [
        businessId,
        BUSINESS_PRO_SUBSCRIPTION_TIER,
        now.toISOString().slice(0, 10),
        validUntil,
        plan.amountUgx,
        paymentReference,
    ]);
    return result.rows[0];
}
export async function markBusinessProSubscriptionPaid(client, businessId, paymentReference) {
    await ensureBusinessProSubscriptionSchema(client);
    const updated = await client.query(`
    UPDATE business_pro_subscriptions
    SET paid_at = COALESCE(paid_at, now()),
        updated_at = now()
    WHERE business_id = $1
      AND payment_reference = $2
    RETURNING *
    `, [businessId, paymentReference]);
    if (updated.rows[0]) {
        return updated.rows[0];
    }
    const fallback = await client.query(`
    UPDATE business_pro_subscriptions
    SET paid_at = COALESCE(paid_at, now()),
        payment_reference = COALESCE(payment_reference, $2),
        updated_at = now()
    WHERE id = (
      SELECT id
      FROM business_pro_subscriptions
      WHERE business_id = $1
        AND paid_at IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    )
    RETURNING *
    `, [businessId, paymentReference]);
    return fallback.rows[0] ?? null;
}
