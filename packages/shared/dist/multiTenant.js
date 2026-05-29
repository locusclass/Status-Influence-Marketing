export const ADMIN_ROLE_SUPER_ADMIN = 'SUPER_ADMIN';
export const ADMIN_ROLE_ADMIN = 'ADMIN';
export const ADMIN_ROLE_COUNTRY_ADMIN = 'COUNTRY_ADMIN';
export const ADMIN_ROLE_DIVISION_ADMIN = 'DIVISION_ADMIN';
export const ADMIN_ROLE_USER = 'USER';
function roundMoney(value) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
}
export function normalizeAdminDashboardRole(value) {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (normalized === ADMIN_ROLE_SUPER_ADMIN)
        return ADMIN_ROLE_SUPER_ADMIN;
    if (normalized === ADMIN_ROLE_ADMIN)
        return ADMIN_ROLE_ADMIN;
    if (normalized === ADMIN_ROLE_COUNTRY_ADMIN)
        return ADMIN_ROLE_COUNTRY_ADMIN;
    if (normalized === ADMIN_ROLE_DIVISION_ADMIN)
        return ADMIN_ROLE_DIVISION_ADMIN;
    return ADMIN_ROLE_USER;
}
export function canAccessAdminDashboard(value) {
    return normalizeAdminDashboardRole(value) !== ADMIN_ROLE_USER;
}
export function calculateRevenueBreakdown(grossAmount, hasDivision) {
    const gross = roundMoney(Math.max(0, Number(grossAmount) || 0));
    const platformFee = roundMoney(gross * 0.20);
    const countryShare = roundMoney(platformFee * 0.15);
    const divisionShare = hasDivision ? roundMoney(platformFee * 0.15) : 0;
    const netPlatformRevenue = roundMoney(platformFee - countryShare - divisionShare);
    return {
        gross_amount: gross,
        platform_fee: platformFee,
        country_share: countryShare,
        division_share: divisionShare,
        net_platform_revenue: netPlatformRevenue,
    };
}
export function getMonthlyPayoutWindow(anchorDate = new Date()) {
    const currentYear = anchorDate.getUTCFullYear();
    const currentMonth = anchorDate.getUTCMonth();
    const periodStart = new Date(Date.UTC(currentYear, currentMonth - 1, 1));
    const periodEnd = new Date(Date.UTC(currentYear, currentMonth, 0));
    return {
        periodStart,
        periodEnd,
        period_start: periodStart.toISOString().slice(0, 10),
        period_end: periodEnd.toISOString().slice(0, 10),
    };
}
export async function recordCampaignRevenueEntry(client, campaignId) {
    const campaignRes = await client.query(`
    SELECT
      c.id,
      c.country_id,
      c.division_id,
      c.status,
      COALESCE(c.budget_total, 0)::numeric AS gross_amount
    FROM campaigns c
    WHERE c.id = $1
    LIMIT 1
    `, [campaignId]);
    const campaign = campaignRes.rows[0];
    if (!campaign?.id || !campaign.country_id) {
        return null;
    }
    const breakdown = calculateRevenueBreakdown(Number(campaign.gross_amount ?? 0), Boolean(campaign.division_id));
    const inserted = await client.query(`
    INSERT INTO earnings_ledger (
      country_id,
      division_id,
      campaign_id,
      gross_amount,
      platform_fee,
      country_share,
      division_share,
      net_platform_revenue
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (campaign_id)
    DO UPDATE SET
      country_id = EXCLUDED.country_id,
      division_id = EXCLUDED.division_id,
      gross_amount = EXCLUDED.gross_amount,
      platform_fee = EXCLUDED.platform_fee,
      country_share = EXCLUDED.country_share,
      division_share = EXCLUDED.division_share,
      net_platform_revenue = EXCLUDED.net_platform_revenue
    RETURNING *
    `, [
        campaign.country_id,
        campaign.division_id ?? null,
        campaign.id,
        breakdown.gross_amount,
        breakdown.platform_fee,
        breakdown.country_share,
        breakdown.division_share,
        breakdown.net_platform_revenue,
    ]);
    return inserted.rows[0] ?? null;
}
export async function generateMonthlyPayouts(client, anchorDate = new Date()) {
    const { period_start, period_end } = getMonthlyPayoutWindow(anchorDate);
    const countryPayouts = await client.query(`
    WITH admin_counts AS (
      SELECT country_id, COUNT(*)::numeric AS admin_count
      FROM country_admins
      GROUP BY country_id
    ),
    scoped_earnings AS (
      SELECT
        ca.user_id,
        el.country_id,
        ROUND(
          SUM(
            CASE
              WHEN COALESCE(ac.admin_count, 0) > 0
                THEN el.country_share / ac.admin_count
              ELSE 0
            END
          )::numeric
        ) AS payout_amount
      FROM earnings_ledger el
      JOIN country_admins ca ON ca.country_id = el.country_id
      JOIN admin_counts ac ON ac.country_id = el.country_id
      WHERE el.created_at::date BETWEEN $1::date AND $2::date
      GROUP BY ca.user_id, el.country_id
    )
    INSERT INTO payouts (
      user_id,
      role,
      amount,
      period_start,
      period_end,
      status,
      country_id,
      division_id
    )
    SELECT
      user_id,
      'COUNTRY_ADMIN',
      payout_amount,
      $1::date,
      $2::date,
      'PENDING',
      country_id,
      NULL
    FROM scoped_earnings
    WHERE payout_amount > 0
    ON CONFLICT DO NOTHING
    RETURNING *
    `, [period_start, period_end]);
    const divisionPayouts = await client.query(`
    WITH admin_counts AS (
      SELECT division_id, COUNT(*)::numeric AS admin_count
      FROM division_admins
      GROUP BY division_id
    ),
    scoped_earnings AS (
      SELECT
        da.user_id,
        el.country_id,
        el.division_id,
        ROUND(
          SUM(
            CASE
              WHEN COALESCE(ac.admin_count, 0) > 0
                THEN el.division_share / ac.admin_count
              ELSE 0
            END
          )::numeric
        ) AS payout_amount
      FROM earnings_ledger el
      JOIN division_admins da ON da.division_id = el.division_id
      JOIN admin_counts ac ON ac.division_id = el.division_id
      WHERE el.division_id IS NOT NULL
        AND el.created_at::date BETWEEN $1::date AND $2::date
      GROUP BY da.user_id, el.country_id, el.division_id
    )
    INSERT INTO payouts (
      user_id,
      role,
      amount,
      period_start,
      period_end,
      status,
      country_id,
      division_id
    )
    SELECT
      user_id,
      'DIVISION_ADMIN',
      payout_amount,
      $1::date,
      $2::date,
      'PENDING',
      country_id,
      division_id
    FROM scoped_earnings
    WHERE payout_amount > 0
    ON CONFLICT DO NOTHING
    RETURNING *
    `, [period_start, period_end]);
    const createdPayouts = [
        ...countryPayouts.rows,
        ...divisionPayouts.rows,
    ];
    for (const payout of createdPayouts) {
        const walletCreditAmount = Math.round(Number(payout.amount ?? 0));
        if (walletCreditAmount <= 0) {
            continue;
        }
        const existingWallet = await client.query(`
      SELECT *
      FROM wallets
      WHERE user_id = $1
      LIMIT 1
      `, [payout.user_id]);
        const wallet = existingWallet.rows[0] ??
            (await client.query(`
          INSERT INTO wallets (
            user_id,
            currency,
            balance_available,
            balance_escrow,
            balance
          )
          SELECT
            u.id,
            COALESCE(NULLIF(BTRIM(u.preferred_currency), ''), 'UGX'),
            0,
            0,
            0
          FROM users u
          WHERE u.id = $1
          RETURNING *
          `, [payout.user_id])).rows[0];
        if (!wallet?.id) {
            continue;
        }
        await client.query(`
      UPDATE wallets
      SET balance_available = balance_available + $2,
          balance = balance + $2
      WHERE id = $1
      `, [wallet.id, walletCreditAmount]);
        await client.query(`
      INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
      VALUES ($1,$2,'CREDIT',$3)
      `, [wallet.id, walletCreditAmount, `MANAGER_PAYOUT:${payout.id}`]);
        await client.query(`
      UPDATE payouts
      SET status = 'PAID',
          paid_at = NOW(),
          paid_by = 'SYSTEM_CRON'
      WHERE id = $1
      `, [payout.id]);
    }
    return {
        period_start,
        period_end,
        country_admin_payouts_created: countryPayouts.rowCount ?? 0,
        division_admin_payouts_created: divisionPayouts.rowCount ?? 0,
        wallet_credits_applied: createdPayouts.length,
    };
}
