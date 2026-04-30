import { CreateCampaignSchema, DeliveryModelSchema, FundCampaignSchema, MediaTypeSchema, PlatformAdapterSchema, getPublicContractUnitRate, getCampaignBurstMode, isCreatorPlatform, normalizeExecutionMeta, recordCampaignRevenueEntry, resolveDeliveryModel, } from '@prime/shared';
import { z } from 'zod';
import { withTransaction } from '../db.js';
import { CampaignRepo } from '../repositories/campaignRepo.js';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import { v4 as uuid } from 'uuid';
import { config, hasYoClientCredentials, hasYoEncryptionKey, } from '../config.js';
import { resolveAvailableYoUgandaCheckoutProfile } from '../services/yoUgandaCheckoutProfile.js';
import { ensureChatSchema } from '../services/chat.js';
import { ensurePublicIdColumns } from '../services/publicId.js';
import { canAccessAdvertiserFeatures, canAccessDistributorFeatures, normalizeActiveRole, } from '../services/roles.js';
const PRIVATE_PLATFORM_FEE_PERCENT = 0;
const OPEN_PLATFORM_FEE_PERCENT = 0;
const PRIVATE_CONTRACT_WINDOW_HOURS = 24;
const CREATOR_DEFAULT_TARGET_METRIC = 100;
const ACTIVE_CAMPAIGN_PLATFORM = 'WHATSAPP_STATUS';
const PUBLIC_CONTRACT_ACTIVE_DISTRIBUTOR_THRESHOLD = 5000;
const PUBLIC_CONTRACT_ELIGIBLE_ROLES = [
    'ADMIN',
    'DISTRIBUTOR',
    'DUAL_USER',
];
const TEMPORARY_PLATFORM_INCORPORATION_DETAIL = 'Support for TikTok and X campaigns is coming soon. WhatsApp Status is the only supported campaign platform right now.';
const SUPPORTED_PLATFORM_CHECK_SQL = `CHECK (platform IN (${PlatformAdapterSchema.options
    .map((platform) => `'${platform}'`)
    .join(', ')}))`;
function normalizePhone(input) {
    return input.replace(/[^\d+]/g, '').trim();
}
function normalizePricePrivacyMode(value) {
    return String(value ?? 'NEGOTIABLE').trim().toUpperCase() === 'FIXED'
        ? 'FIXED'
        : 'NEGOTIABLE';
}
function roundPercent(value) {
    return Math.round(value * 100) / 100;
}
function resolveGroupPricePrivacyMode(values) {
    let negotiableCount = 0;
    let fixedCount = 0;
    for (const value of values) {
        if (normalizePricePrivacyMode(value) === 'FIXED') {
            fixedCount += 1;
        }
        else {
            negotiableCount += 1;
        }
    }
    return negotiableCount > fixedCount ? 'NEGOTIABLE' : 'FIXED';
}
function normalizeUserAccountStatus(value) {
    const status = String(value ?? 'ACTIVE').trim().toUpperCase();
    if (status === 'SUSPENDED' || status === 'BANNED') {
        return status;
    }
    return 'ACTIVE';
}
function buildAccountRestrictionResult(status, audience) {
    const normalizedStatus = normalizeUserAccountStatus(status);
    if (normalizedStatus === 'ACTIVE') {
        return null;
    }
    const actionText = audience === 'advertiser'
        ? 'create adverts'
        : 'view or accept promoter opportunities';
    const detail = normalizedStatus === 'BANNED'
        ? `Your account is banned. You cannot ${actionText}.`
        : `Your account is suspended. You cannot ${actionText} until an administrator reactivates it.`;
    return {
        error: 'account_restricted',
        detail,
        status: normalizedStatus,
    };
}
async function getUserAccountRestriction(client, userId, audience) {
    const normalizedUserId = String(userId ?? '').trim();
    if (!normalizedUserId) {
        return null;
    }
    const userRes = await client.query(`
    SELECT status
    FROM users
    WHERE id = $1
    LIMIT 1
    `, [normalizedUserId]);
    return buildAccountRestrictionResult(userRes.rows[0]?.status ?? 'ACTIVE', audience);
}
function normalizeUrlOrigin(value) {
    if (!value)
        return null;
    try {
        return new URL(value).origin;
    }
    catch {
        return null;
    }
}
function getForwardedHeader(value) {
    if (Array.isArray(value)) {
        return value[0]?.trim() || undefined;
    }
    return value?.split(',')[0]?.trim() || undefined;
}
function getRequestBaseUrl(request) {
    const explicit = config.apiBaseUrl.trim();
    if (explicit) {
        try {
            return new URL(explicit).origin;
        }
        catch {
            // Ignore invalid configuration and fall through to request headers.
        }
    }
    const forwardedProto = getForwardedHeader(request.headers['x-forwarded-proto']);
    const forwardedHost = getForwardedHeader(request.headers['x-forwarded-host']);
    const host = forwardedHost || getForwardedHeader(request.headers.host);
    if (!host)
        return null;
    const protocol = forwardedProto || request.protocol || 'https';
    return `${protocol}://${host}`;
}
function getBrowserOrigin(request) {
    const origin = normalizeUrlOrigin(getForwardedHeader(request.headers.origin));
    if (origin)
        return origin;
    const referer = getForwardedHeader(request.headers.referer) ?? getForwardedHeader(request.headers.referrer);
    return normalizeUrlOrigin(referer);
}
function resolveWebRedirectUrl(rawUrl, browserOrigin, fallbackPath) {
    const value = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    if (value) {
        try {
            return new URL(value, browserOrigin ?? undefined).toString();
        }
        catch {
            return null;
        }
    }
    if (!browserOrigin)
        return null;
    return new URL(fallbackPath, browserOrigin).toString();
}
function buildPaymentCallbackUrl(request, routePath, targetUrl) {
    const baseUrl = getRequestBaseUrl(request);
    if (!baseUrl)
        return null;
    const url = new URL(routePath, `${baseUrl}/`);
    if (targetUrl) {
        url.searchParams.set('target', targetUrl);
    }
    return url.toString();
}
function getCampaignBundleId(campaign) {
    const value = String(campaign?.campaign_bundle_id ?? '').trim();
    return value.length > 0 ? value : null;
}
function getEscrowCampaignId(campaign) {
    return String(campaign?.bundle_root_campaign_id ??
        campaign?.parent_campaign_id ??
        campaign?.id ??
        '').trim();
}
const confirmedEscrowFundingStatuses = [
    'FUNDED',
    'PARTIALLY_DISBURSED',
    'COMPLETED',
];
function isConfirmedEscrowFundingStatus(value) {
    const normalized = String(value ?? '').trim().toUpperCase();
    return confirmedEscrowFundingStatuses.includes(normalized);
}
function buildConfirmedEscrowEvidenceSql(campaignAlias, escrowAlias) {
    return `
    ${escrowAlias}.status IN ('FUNDED', 'PARTIALLY_DISBURSED', 'COMPLETED')
    AND (
      EXISTS (
        SELECT 1
        FROM pesapal_transactions pt
        WHERE pt.id = ${escrowAlias}.pesapal_txn_id
          AND pt.type = 'FUNDING'
          AND pt.status = 'COMPLETED'
      )
      OR EXISTS (
        SELECT 1
        FROM wallet_txns wt
        WHERE wt.direction = 'DEBIT'
          AND (
            wt.reference =
              'ESCROW_FUND:' ||
              COALESCE(
                ${campaignAlias}.bundle_root_campaign_id,
                ${campaignAlias}.parent_campaign_id,
                ${campaignAlias}.id
              )::text
            OR (
              ${campaignAlias}.campaign_bundle_id IS NOT NULL
              AND wt.reference =
                'ESCROW_FUND:BUNDLE:' ||
                ${campaignAlias}.campaign_bundle_id::text
            )
          )
      )
    )
  `;
}
async function hasConfirmedEscrowFunding(client, campaignId) {
    const fundingRes = await client.query(`
    SELECT EXISTS (
      SELECT 1
      FROM campaigns c
      LEFT JOIN escrow_ledger e
        ON e.campaign_id = COALESCE(
          c.bundle_root_campaign_id,
          c.parent_campaign_id,
          c.id
        )
      WHERE c.id = $1
        AND ${buildConfirmedEscrowEvidenceSql('c', 'e')}
    ) AS funding_confirmed
    `, [campaignId]);
    return fundingRes.rows[0]?.funding_confirmed === true;
}
function normalizePlatformList(values) {
    return Array.from(new Set(values
        .map((value) => String(value ?? '').trim().toUpperCase())
        .filter((value) => value.length > 0)));
}
function hasOnlyActiveCampaignPlatforms(platforms) {
    return platforms.every((platform) => platform === ACTIVE_CAMPAIGN_PLATFORM);
}
function buildPublicContractEligibilityDetail(activeDistributorCount) {
    if (activeDistributorCount >= PUBLIC_CONTRACT_ACTIVE_DISTRIBUTOR_THRESHOLD) {
        return `Backend confirmed ${activeDistributorCount} active distributors. Public contracts are available.`;
    }
    return `Public contracts unlock once the backend confirms at least ${PUBLIC_CONTRACT_ACTIVE_DISTRIBUTOR_THRESHOLD} active distributors. Current confirmed active distributors: ${activeDistributorCount}.`;
}
async function getPublicContractEligibility(client) {
    const distributorCountRes = await client.query(`
    SELECT COUNT(*)::int AS count
    FROM users
    WHERE status = 'ACTIVE'
      AND role = ANY($1::text[])
    `, [PUBLIC_CONTRACT_ELIGIBLE_ROLES]);
    const activeDistributorCount = Math.max(0, Number(distributorCountRes.rows[0]?.count ?? 0));
    return {
        eligible: activeDistributorCount >= PUBLIC_CONTRACT_ACTIVE_DISTRIBUTOR_THRESHOLD,
        active_distributors: activeDistributorCount,
        required_active_distributors: PUBLIC_CONTRACT_ACTIVE_DISTRIBUTOR_THRESHOLD,
        detail: buildPublicContractEligibilityDetail(activeDistributorCount),
    };
}
function resolveRequestedPlatforms(body) {
    const bundleItemPlatforms = Array.isArray(body?.bundle_items)
        ? normalizePlatformList(body.bundle_items.map((item) => item?.platform))
        : [];
    if (bundleItemPlatforms.length > 0) {
        return bundleItemPlatforms;
    }
    const declaredPlatforms = Array.isArray(body?.platforms)
        ? normalizePlatformList(body.platforms)
        : [];
    if (declaredPlatforms.length > 0) {
        return declaredPlatforms;
    }
    return normalizePlatformList([body?.platform]);
}
function buildBundleItems(body) {
    if (Array.isArray(body?.bundle_items) && body.bundle_items.length > 0) {
        return body.bundle_items.map((item) => ({
            ...body,
            ...item,
            title: String(item?.title ?? body?.title ?? '').trim() || body.title,
            platform: item.platform,
        }));
    }
    return resolveRequestedPlatforms(body).map((platform) => ({
        ...body,
        platform,
        title: body.title,
    }));
}
async function ensureWalletForUser(client, userId, preferredCurrency) {
    const existing = await client.query('SELECT * FROM wallets WHERE user_id=$1 LIMIT 1', [userId]);
    if (existing.rows[0]) {
        return existing.rows[0];
    }
    const currency = preferredCurrency?.toString().trim().toUpperCase() ||
        (await client.query('SELECT preferred_currency FROM users WHERE id=$1 LIMIT 1', [userId])).rows[0]?.preferred_currency?.toString().trim().toUpperCase() ||
        'UGX';
    const created = await client.query(`
    INSERT INTO wallets (user_id, currency, balance_available, balance_escrow, balance)
    VALUES ($1,$2,0,0,0)
    RETURNING *
    `, [userId, currency]);
    return created.rows[0];
}
async function creditAdvertiserWallet(client, advertiserId, amount, reference, preferredCurrency) {
    if (amount <= 0) {
        return null;
    }
    const wallet = await ensureWalletForUser(client, advertiserId, preferredCurrency);
    const updated = await client.query(`
    UPDATE wallets
    SET balance_available = balance_available + $2,
        balance = balance + $2
    WHERE id=$1
    RETURNING *
    `, [wallet.id, amount]);
    await client.query(`
    INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
    VALUES ($1,$2,'CREDIT',$3)
    `, [wallet.id, amount, reference]);
    return updated.rows[0] ?? wallet;
}
async function refundEscrowAmountToAdvertiser(client, escrowId, advertiserId, refundAmount, reference, preferredCurrency) {
    if (refundAmount <= 0) {
        return { refunded_amount: 0, wallet: null };
    }
    const escrowUpdate = await client.query(`
    UPDATE escrow_ledger
    SET amount_available = amount_available - $2,
        status = CASE
          WHEN amount_available - $2 <= 0 THEN 'COMPLETED'
          ELSE 'PARTIALLY_DISBURSED'
        END
    WHERE id=$1 AND amount_available >= $2
    RETURNING *
    `, [escrowId, refundAmount]);
    if (!escrowUpdate.rows[0]) {
        return { refunded_amount: 0, wallet: null };
    }
    const wallet = await creditAdvertiserWallet(client, advertiserId, refundAmount, reference, preferredCurrency);
    return { refunded_amount: refundAmount, wallet };
}
async function ensureCampaignColumns(client) {
    await ensurePublicIdColumns(client);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS parent_campaign_id UUID REFERENCES campaigns(id)
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS campaign_bundle_id UUID
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS bundle_root_campaign_id UUID REFERENCES campaigns(id)
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS assigned_distributor_id UUID REFERENCES users(id)
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS assigned_phone TEXT
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'PRIVATE_CONTRACT'
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'PUBLIC'
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS impression_target INTEGER
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS platform_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 0
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS advertiser_wallet_mode TEXT NOT NULL DEFAULT 'CAMPAIGN_ONLY'
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS last_allocated_at TIMESTAMPTZ
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS allocation_round INTEGER NOT NULL DEFAULT 0
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS media_text TEXT
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS delivery_model TEXT NOT NULL DEFAULT 'DETERMINISTIC'
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS execution_meta JSONB
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS campaign_burst_mode BOOLEAN NOT NULL DEFAULT FALSE
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS campaigns_campaign_bundle_id_idx
    ON campaigns (campaign_bundle_id)
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS campaigns_bundle_root_campaign_id_idx
    ON campaigns (bundle_root_campaign_id)
  `);
    await client.query(`
    DO $$ BEGIN
      IF to_regclass('public.campaigns') IS NOT NULL THEN
        ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_platform_check;
        ALTER TABLE campaigns
          ADD CONSTRAINT campaigns_platform_check ${SUPPORTED_PLATFORM_CHECK_SQL};
      END IF;
    END $$;
  `);
}
function normalizeCampaignMutationError(message) {
    if (message.startsWith('beneficiary_not_found'))
        return 'beneficiary_not_found';
    if (message.startsWith('beneficiary_capacity_not_set')) {
        return 'beneficiary_capacity_not_set';
    }
    if (message.startsWith('beneficiary_capacity_insufficient')) {
        return 'beneficiary_capacity_insufficient';
    }
    if (message === 'group_not_found')
        return 'group_not_found';
    if (message === 'group_beneficiary_empty')
        return 'group_beneficiary_empty';
    if (message.startsWith('duplicate_bundle_platform')) {
        return 'duplicate_bundle_platform';
    }
    if (message.includes('campaigns_platform_check')) {
        return 'unsupported_platform';
    }
    return message;
}
async function usersHasColumn(client, columnName) {
    const res = await client.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='users'
      AND column_name=$1
    LIMIT 1
    `, [columnName]);
    return Boolean(res.rowCount);
}
async function getVerifiedEngagements24h(client, userId, platform) {
    const params = [userId];
    const platformFilter = platform && platform.trim().length > 0
        ? `AND s.platform = $2`
        : '';
    if (platform && platform.trim().length > 0) {
        params.push(platform.trim().toUpperCase());
    }
    const res = await client.query(`
    SELECT COALESCE(SUM(COALESCE(p.observed_views, 0)), 0)::int AS engagements_24h
    FROM proofs p
    JOIN verification_sessions s ON s.id = p.session_id
    WHERE p.user_id = $1
      AND p.status = 'VERIFIED'
      AND p.decision = 'VERIFIED'
      AND p.created_at >= now() - interval '24 hours'
      ${platformFilter}
    `, params);
    return Math.max(0, Number(res.rows[0]?.engagements_24h ?? 0));
}
function resolveDeterministicEngagements24h(provenEngagements24h, maxStatusViewers12h) {
    if (provenEngagements24h > 0) {
        return provenEngagements24h;
    }
    const capacity24h = Math.max(0, maxStatusViewers12h) * 2;
    return Math.max(1, capacity24h);
}
function normalizeCampaignMediaUrls(value) {
    const executionMeta = value.execution_meta && typeof value.execution_meta === 'object'
        ? value.execution_meta
        : null;
    const urls = [
        ...(Array.isArray(value.media_urls) ? value.media_urls : []),
        ...(Array.isArray(executionMeta?.media_urls) ? executionMeta.media_urls : []),
        value.media_url,
    ]
        .map((entry) => String(entry ?? '').trim())
        .filter((entry) => entry.length > 0);
    return Array.from(new Set(urls));
}
function primaryCampaignMediaUrl(value) {
    return normalizeCampaignMediaUrls(value)[0] ?? null;
}
function withCampaignMediaUrls(campaign) {
    return {
        ...campaign,
        media_urls: normalizeCampaignMediaUrls(campaign),
    };
}
async function buildPrivatePricingQuote(client, distributor, mediaType, platform) {
    const provenEngagements24h = await getVerifiedEngagements24h(client, String(distributor.id), platform);
    const pricingReferenceEngagements24h = resolveDeterministicEngagements24h(provenEngagements24h, Number(distributor.max_status_viewers_12h ?? 0));
    const deterministicRateUgx = pricingReferenceEngagements24h * getPublicContractUnitRate(mediaType);
    const privateContractRateUgx = Math.max(0, Number(distributor.private_contract_rate_ugx ?? 0));
    const selectedRateUgx = privateContractRateUgx > 0 ? privateContractRateUgx : deterministicRateUgx;
    const pricePrivacyMode = normalizePricePrivacyMode(distributor.price_privacy_mode);
    return {
        pricing_mode: privateContractRateUgx > 0
            ? 'CUSTOM_RATE'
            : 'DETERMINISTIC',
        private_contract_rate_ugx: privateContractRateUgx,
        deterministic_rate_ugx: deterministicRateUgx,
        selected_rate_ugx: selectedRateUgx,
        official_price_ugx: selectedRateUgx,
        proven_engagements_24h: provenEngagements24h,
        pricing_reference_engagements_24h: pricingReferenceEngagements24h,
        impression_target: Math.max(1, pricingReferenceEngagements24h),
        price_privacy_mode: pricePrivacyMode,
        negotiation_allowed: pricePrivacyMode === 'NEGOTIABLE',
    };
}
async function findDistributorById(client, distributorId) {
    const hasFullName = await usersHasColumn(client, 'full_name');
    const fullNameSelect = hasFullName
        ? "COALESCE(NULLIF(u.full_name, ''), NULLIF(p.full_name, ''), u.email)"
        : "COALESCE(NULLIF(p.full_name, ''), u.email)";
    const res = await client.query(`
    SELECT
      u.id,
      u.public_id,
      u.phone,
      COALESCE(u.max_status_viewers_12h, 0)::int AS max_status_viewers_12h,
      COALESCE(u.private_contract_rate_ugx, 0)::int AS private_contract_rate_ugx,
      COALESCE(NULLIF(u.price_privacy_mode, ''), 'NEGOTIABLE') AS price_privacy_mode,
      ${fullNameSelect} AS full_name,
      COALESCE(p.avatar_url, '') AS avatar_url,
      u.email
    FROM users u
    LEFT JOIN user_profiles p ON p.user_id = u.id
    WHERE u.id = $1
      AND u.role IN ('DISTRIBUTOR', 'DUAL_USER', 'ADMIN')
    LIMIT 1
    `, [distributorId]);
    return res.rows[0] ?? null;
}
async function findDistributorByPhone(client, rawPhone) {
    const phone = normalizePhone(rawPhone);
    const hasFullName = await usersHasColumn(client, 'full_name');
    const fullNameSelect = hasFullName
        ? "COALESCE(NULLIF(u.full_name, ''), NULLIF(p.full_name, ''), u.email)"
        : "COALESCE(NULLIF(p.full_name, ''), u.email)";
    const res = await client.query(`
    SELECT
      u.id,
      u.public_id,
      u.phone,
      COALESCE(u.max_status_viewers_12h, 0)::int AS max_status_viewers_12h,
      COALESCE(u.private_contract_rate_ugx, 0)::int AS private_contract_rate_ugx,
      COALESCE(NULLIF(u.price_privacy_mode, ''), 'NEGOTIABLE') AS price_privacy_mode,
      ${fullNameSelect} AS full_name,
      COALESCE(p.avatar_url, '') AS avatar_url,
      u.email
    FROM users u
    LEFT JOIN user_profiles p ON p.user_id = u.id
    WHERE regexp_replace(COALESCE(u.phone, ''), '[^0-9+]', '', 'g') = $1
      AND u.role IN ('DISTRIBUTOR', 'DUAL_USER', 'ADMIN')
    LIMIT 1
    `, [phone]);
    return res.rows[0] ?? null;
}
async function listGroupCampaignMembers(client, groupId) {
    const hasFullName = await usersHasColumn(client, 'full_name');
    const fullNameSelect = hasFullName
        ? "COALESCE(NULLIF(u.full_name, ''), NULLIF(p.full_name, ''), u.email)"
        : "COALESCE(NULLIF(p.full_name, ''), u.email)";
    const res = await client.query(`
    SELECT
      membership.user_id,
      membership.role AS group_role,
      membership.joined_at,
      u.id,
      u.public_id,
      u.phone,
      COALESCE(u.max_status_viewers_12h, 0)::int AS max_status_viewers_12h,
      COALESCE(u.private_contract_rate_ugx, 0)::int AS private_contract_rate_ugx,
      COALESCE(NULLIF(u.price_privacy_mode, ''), 'NEGOTIABLE') AS price_privacy_mode,
      ${fullNameSelect} AS full_name,
      COALESCE(p.avatar_url, '') AS avatar_url,
      u.email,
      COALESCE(view_stats.views_24h, 0)::int AS verified_views_24h
    FROM chat_group_memberships membership
    JOIN users u ON u.id = membership.user_id
    LEFT JOIN user_profiles p ON p.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(COALESCE(pr.observed_views, 0)), 0)::int AS views_24h
      FROM proofs pr
      JOIN verification_sessions vs ON vs.id = pr.session_id
      WHERE pr.user_id = u.id
        AND pr.status = 'VERIFIED'
        AND pr.decision = 'VERIFIED'
        AND pr.created_at >= now() - interval '24 hours'
        AND vs.platform = 'WHATSAPP_STATUS'
    ) view_stats ON TRUE
    WHERE membership.group_id = $1
      AND membership.status = 'ACTIVE'
    ORDER BY
      CASE WHEN membership.role = 'ADMIN' THEN 0 ELSE 1 END,
      membership.joined_at ASC
    `, [groupId]);
    return res.rows;
}
async function buildGroupBeneficiaryQuote(client, groupId, mediaType) {
    const groupRes = await client.query(`
    SELECT
      id,
      public_id,
      name,
      description,
      COALESCE(public_price_ugx, 0)::int AS public_price_ugx
    FROM chat_groups
    WHERE id = $1
    LIMIT 1
    `, [groupId]);
    const group = groupRes.rows[0];
    if (!group) {
        return null;
    }
    const memberRows = await listGroupCampaignMembers(client, groupId);
    const memberQuotes = [];
    for (const row of memberRows) {
        const pricing = await buildPrivatePricingQuote(client, row, mediaType, 'WHATSAPP_STATUS');
        memberQuotes.push({
            row,
            pricing,
        });
    }
    const pricingReferenceTotal = memberQuotes.reduce((sum, entry) => sum + Number(entry.pricing.pricing_reference_engagements_24h ?? 0), 0);
    const provenTotal = memberQuotes.reduce((sum, entry) => sum + Number(entry.pricing.proven_engagements_24h ?? 0), 0);
    const derivedOfficialPrice = memberQuotes.reduce((sum, entry) => sum + Number(entry.pricing.selected_rate_ugx ?? 0), 0);
    const officialPrice = Number(group.public_price_ugx ?? 0) > 0
        ? Number(group.public_price_ugx ?? 0)
        : derivedOfficialPrice;
    const weightValues = memberQuotes.map((entry) => Math.max(1, Number(entry.pricing.pricing_reference_engagements_24h ?? 0)));
    const budgetShares = distributeIntegerTotal(officialPrice, weightValues);
    const impressionShares = distributeIntegerTotal(Math.max(pricingReferenceTotal, weightValues.reduce((sum, value) => sum + value, 0)), weightValues);
    const totalWeight = weightValues.reduce((sum, value) => sum + value, 0);
    const pricePrivacyMode = resolveGroupPricePrivacyMode(memberQuotes.map((entry) => entry.pricing.price_privacy_mode));
    const members = memberQuotes.map((entry, index) => {
        const weight = weightValues[index] ?? 0;
        const budgetTotal = Math.max(0, Number(budgetShares[index] ?? 0));
        const impressionTarget = Math.max(1, Number(impressionShares[index] ?? 0));
        return {
            distributor: entry.row,
            impression_target: impressionTarget,
            payout_amount: budgetTotal,
            budget_total: budgetTotal,
            pricing_mode: entry.pricing.pricing_mode,
            private_contract_rate_ugx: entry.pricing.private_contract_rate_ugx,
            deterministic_rate_ugx: entry.pricing.deterministic_rate_ugx,
            proven_engagements_24h: entry.pricing.proven_engagements_24h,
            pricing_reference_engagements_24h: entry.pricing.pricing_reference_engagements_24h,
            price_privacy_mode: normalizePricePrivacyMode(entry.pricing.price_privacy_mode),
            group_role: String(entry.row.group_role ?? 'MEMBER'),
            share_percent: totalWeight <= 0 ? 0 : roundPercent((weight / totalWeight) * 100),
        };
    });
    return {
        group: {
            id: String(group.id ?? ''),
            public_id: String(group.public_id ?? ''),
            name: String(group.name ?? 'ChatBiz Group'),
            description: String(group.description ?? ''),
            public_price_ugx: Number(group.public_price_ugx ?? 0),
        },
        members,
        member_count: members.length,
        official_price_ugx: officialPrice,
        selected_rate_ugx: officialPrice,
        pricing_mode: Number(group.public_price_ugx ?? 0) > 0
            ? 'PUBLIC_GROUP_RATE'
            : 'AGGREGATED_MEMBER_RATE',
        price_privacy_mode: pricePrivacyMode,
        negotiation_allowed: pricePrivacyMode === 'NEGOTIABLE',
        proven_engagements_24h: provenTotal,
        pricing_reference_engagements_24h: Math.max(pricingReferenceTotal, weightValues.reduce((sum, value) => sum + value, 0)),
        impression_target: Math.max(1, pricingReferenceTotal || weightValues.reduce((sum, value) => sum + value, 0)),
    };
}
async function loadEditableCampaign(client, campaignId, advertiserId) {
    const root = await new CampaignRepo().getCampaign(client, campaignId);
    if (!root)
        return { error: 'campaign_not_found' };
    if (root.advertiser_id !== advertiserId)
        return { error: 'forbidden' };
    if (root.parent_campaign_id)
        return { error: 'campaign_edit_root_only' };
    const bundleId = getCampaignBundleId(root);
    const bundleRoots = bundleId
        ? (await client.query(`
          SELECT *
          FROM campaigns
          WHERE campaign_bundle_id=$1
            AND parent_campaign_id IS NULL
          ORDER BY created_at ASC
          `, [bundleId])).rows
        : [root];
    const childrenRes = await client.query('SELECT * FROM campaigns WHERE parent_campaign_id=$1 ORDER BY created_at ASC', [root.id]);
    const children = childrenRes.rows;
    const campaignIds = [root.id, ...children.map((row) => row.id)];
    const contractRes = await client.query(`SELECT id, status
     FROM contracts
     WHERE campaign_id = ANY($1::uuid[])
     LIMIT 1`, [campaignIds]);
    if (contractRes.rows[0]) {
        return { error: 'campaign_already_claimed' };
    }
    const escrowRes = await client.query('SELECT * FROM escrow_ledger WHERE campaign_id=$1 LIMIT 1', [getEscrowCampaignId(root)]);
    const escrow = escrowRes.rows[0] ?? null;
    if (!escrow)
        return { error: 'escrow_not_found' };
    return { root, children, escrow, bundle_id: bundleId, bundle_roots: bundleRoots };
}
function deriveCampaignBudget(platform, executionMode, budgetTotal, payoutAmount, requestedMetricTarget, mediaType) {
    const platformFeePercent = executionMode === 'OPEN_BUDGET'
        ? OPEN_PLATFORM_FEE_PERCENT
        : PRIVATE_PLATFORM_FEE_PERCENT;
    const distributableBudget = Math.max(0, Math.floor(budgetTotal));
    const publicUnitRate = getPublicContractUnitRate(mediaType);
    if (isCreatorPlatform(platform) && executionMode === 'OPEN_BUDGET') {
        const impressionTarget = Math.max(1, Math.floor(distributableBudget / publicUnitRate));
        const estimatedAllocationCount = Math.max(1, Math.ceil(impressionTarget / CREATOR_DEFAULT_TARGET_METRIC));
        const normalizedPayout = publicUnitRate;
        return {
            platformFeePercent,
            distributableBudget,
            normalizedPayout,
            impressionTarget,
            estimatedAllocationCount,
            perAllocationTarget: Math.max(1, Math.ceil(impressionTarget / estimatedAllocationCount)),
            visibility: 'PUBLIC',
        };
    }
    const normalizedPayout = executionMode === 'OPEN_BUDGET'
        ? publicUnitRate
        : Math.max(1, Number(payoutAmount ?? distributableBudget));
    const impressionTarget = executionMode === 'OPEN_BUDGET'
        ? Math.max(1, Math.floor(distributableBudget / publicUnitRate))
        : Math.max(1, Math.round(Number(requestedMetricTarget ?? 1)));
    return {
        platformFeePercent,
        distributableBudget,
        normalizedPayout,
        impressionTarget,
        estimatedAllocationCount: executionMode === 'OPEN_BUDGET'
            ? Math.max(1, Math.floor(distributableBudget / normalizedPayout))
            : 1,
        perAllocationTarget: impressionTarget,
        visibility: executionMode === 'OPEN_BUDGET' ? 'PUBLIC' : 'PRIVATE',
    };
}
function resolveExecutionMode(platform, requestedMode) {
    return requestedMode ?? (isCreatorPlatform(platform) ? 'OPEN_BUDGET' : 'PRIVATE_CONTRACT');
}
function buildCampaignExecutionMeta(platform, rawMeta, overrides) {
    const normalized = normalizeExecutionMeta(platform, rawMeta) ?? {};
    for (const [key, value] of Object.entries(overrides ?? {})) {
        if (value != null) {
            normalized[key] = value;
        }
    }
    return Object.keys(normalized).length > 0 ? normalized : null;
}
function normalizeBeneficiaryContacts(body) {
    return Array.from(new Set([
        ...(body.beneficiary_contacts ?? []),
        ...(body.counterparty_contact ? [body.counterparty_contact] : []),
    ]
        .map((value) => normalizePhone(String(value ?? '')))
        .filter(Boolean)));
}
function normalizeBeneficiaryUserIds(body) {
    return Array.from(new Set((body.beneficiary_user_ids ?? [])
        .map((value) => String(value ?? '').trim())
        .filter(Boolean)));
}
function normalizeBeneficiaryGroupId(body) {
    const groupId = String(body.beneficiary_group_id ?? '').trim();
    return groupId.length > 0 ? groupId : null;
}
function distributeIntegerTotal(total, weights) {
    if (weights.length === 0) {
        return [];
    }
    if (total <= 0) {
        return weights.map(() => 0);
    }
    const safeWeights = weights.map((value) => Math.max(0, Math.trunc(value)));
    const totalWeight = safeWeights.reduce((sum, value) => sum + value, 0);
    if (totalWeight <= 0) {
        const base = Math.floor(total / safeWeights.length);
        const remainder = total - base * safeWeights.length;
        return safeWeights.map((_, index) => base + (index < remainder ? 1 : 0));
    }
    const exactShares = safeWeights.map((weight) => (total * weight) / totalWeight);
    const shares = exactShares.map((value) => Math.floor(value));
    let remainder = total - shares.reduce((sum, value) => sum + value, 0);
    const order = exactShares
        .map((value, index) => ({
        index,
        fraction: value - Math.floor(value),
        weight: safeWeights[index] ?? 0,
    }))
        .sort((left, right) => {
        if (right.fraction !== left.fraction) {
            return right.fraction - left.fraction;
        }
        if (right.weight !== left.weight) {
            return right.weight - left.weight;
        }
        return left.index - right.index;
    });
    for (const item of order) {
        if (remainder <= 0)
            break;
        shares[item.index] = (shares[item.index] ?? 0) + 1;
        remainder -= 1;
    }
    return shares;
}
async function resolvePrivateDistributorShares(client, beneficiaryContacts, mediaType, platform) {
    const shares = [];
    for (const phone of beneficiaryContacts) {
        const distributor = await findDistributorByPhone(client, phone);
        if (!distributor) {
            throw new Error(`beneficiary_not_found:${phone}`);
        }
        const pricing = await buildPrivatePricingQuote(client, distributor, mediaType, platform);
        shares.push({
            distributor,
            impression_target: pricing.impression_target,
            payout_amount: pricing.selected_rate_ugx,
            budget_total: pricing.selected_rate_ugx,
            pricing_mode: pricing.pricing_mode,
            private_contract_rate_ugx: pricing.private_contract_rate_ugx,
            deterministic_rate_ugx: pricing.deterministic_rate_ugx,
            proven_engagements_24h: pricing.proven_engagements_24h,
            pricing_reference_engagements_24h: pricing.pricing_reference_engagements_24h,
        });
    }
    return shares;
}
async function resolvePrivateDistributorSharesByUserId(client, beneficiaryUserIds, mediaType, platform) {
    const shares = [];
    for (const userId of beneficiaryUserIds) {
        const distributor = await findDistributorById(client, userId);
        if (!distributor) {
            throw new Error(`beneficiary_not_found:${userId}`);
        }
        const pricing = await buildPrivatePricingQuote(client, distributor, mediaType, platform);
        shares.push({
            distributor,
            impression_target: pricing.impression_target,
            payout_amount: pricing.selected_rate_ugx,
            budget_total: pricing.selected_rate_ugx,
            pricing_mode: pricing.pricing_mode,
            private_contract_rate_ugx: pricing.private_contract_rate_ugx,
            deterministic_rate_ugx: pricing.deterministic_rate_ugx,
            proven_engagements_24h: pricing.proven_engagements_24h,
            pricing_reference_engagements_24h: pricing.pricing_reference_engagements_24h,
        });
    }
    return shares;
}
async function resolvePrivateGroupDistributorShares(client, beneficiaryGroupId, mediaType) {
    const groupQuote = await buildGroupBeneficiaryQuote(client, beneficiaryGroupId, mediaType);
    if (!groupQuote) {
        throw new Error('group_not_found');
    }
    if (groupQuote.member_count <= 0 || groupQuote.members.length == 0) {
        throw new Error('group_beneficiary_empty');
    }
    const shares = groupQuote.members.map((member) => ({
        distributor: member.distributor,
        impression_target: member.impression_target,
        payout_amount: member.payout_amount,
        budget_total: member.budget_total,
        pricing_mode: member.pricing_mode,
        private_contract_rate_ugx: member.private_contract_rate_ugx,
        deterministic_rate_ugx: member.deterministic_rate_ugx,
        proven_engagements_24h: member.proven_engagements_24h,
        pricing_reference_engagements_24h: member.pricing_reference_engagements_24h,
    }));
    return { groupQuote, shares };
}
async function resolvePrivateContractSelection(client, options, mediaType, platform) {
    if (options.beneficiaryGroupId) {
        const groupResult = await resolvePrivateGroupDistributorShares(client, options.beneficiaryGroupId, mediaType);
        return {
            privateShares: groupResult.shares,
            privateGroupQuote: groupResult.groupQuote,
        };
    }
    const byUserId = await resolvePrivateDistributorSharesByUserId(client, options.beneficiaryUserIds, mediaType, platform);
    const byPhone = await resolvePrivateDistributorShares(client, options.beneficiaryContacts, mediaType, platform);
    const merged = new Map();
    for (const share of [...byUserId, ...byPhone]) {
        const distributorId = String(share.distributor.id ?? '').trim();
        if (!distributorId || merged.has(distributorId)) {
            continue;
        }
        merged.set(distributorId, share);
    }
    return {
        privateShares: Array.from(merged.values()),
        privateGroupQuote: null,
    };
}
function buildPrivateBeneficiaryMeta(privateShares) {
    return privateShares.map((share) => ({
        distributor_id: String(share.distributor.id ?? ''),
        distributor_public_id: String(share.distributor.public_id ?? ''),
        full_name: String(share.distributor.full_name ?? share.distributor.phone ?? ''),
        phone: String(share.distributor.phone ?? ''),
        pricing_mode: share.pricing_mode,
        private_contract_rate_ugx: share.private_contract_rate_ugx,
        deterministic_rate_ugx: share.deterministic_rate_ugx,
        selected_rate_ugx: share.budget_total,
        proven_engagements_24h: share.proven_engagements_24h,
        pricing_reference_engagements_24h: share.pricing_reference_engagements_24h,
        impression_target: share.impression_target,
    }));
}
function buildPrivateGroupMeta(groupQuote) {
    if (!groupQuote) {
        return null;
    }
    return {
        id: groupQuote.group.id,
        public_id: groupQuote.group.public_id,
        name: groupQuote.group.name,
        description: groupQuote.group.description,
        public_price_ugx: groupQuote.group.public_price_ugx,
        selected_rate_ugx: groupQuote.selected_rate_ugx,
        official_price_ugx: groupQuote.official_price_ugx,
        pricing_mode: groupQuote.pricing_mode,
        price_privacy_mode: groupQuote.price_privacy_mode,
        negotiation_allowed: groupQuote.negotiation_allowed,
        proven_engagements_24h: groupQuote.proven_engagements_24h,
        pricing_reference_engagements_24h: groupQuote.pricing_reference_engagements_24h,
        impression_target: groupQuote.impression_target,
        member_count: groupQuote.member_count,
    };
}
async function loadBundleSummary(client, bundleId, userId) {
    const bundleRes = await client.query(`
    SELECT *
    FROM campaigns
    WHERE campaign_bundle_id=$1
      AND parent_campaign_id IS NULL
    ORDER BY created_at ASC
    `, [bundleId]);
    const campaigns = bundleRes.rows;
    if (campaigns.length === 0) {
        return null;
    }
    const ownerCampaignId = getEscrowCampaignId(campaigns[0]);
    const escrowRes = await client.query('SELECT * FROM escrow_ledger WHERE campaign_id=$1 LIMIT 1', [ownerCampaignId]);
    const escrow = escrowRes.rows[0] ?? null;
    const summaries = await buildCampaignStatusSummaries(client, campaigns.map((row) => String(row.id)), userId ?? null);
    return {
        bundle_id: bundleId,
        bundle_root_campaign_id: ownerCampaignId,
        title: String(campaigns[0]?.title ?? 'Campaign bundle'),
        advertiser_id: String(campaigns[0]?.advertiser_id ?? ''),
        total_budget: campaigns.reduce((sum, row) => sum + Number(row.budget_total ?? 0), 0),
        escrow_status: String(escrow?.status ?? 'PENDING'),
        amount_total: Number(escrow?.amount_total ?? 0),
        amount_available: Number(escrow?.amount_available ?? 0),
        campaigns: campaigns.map((row) => ({
            ...withCampaignMediaUrls(row),
            status_summary: summaries.get(String(row.id)) ?? {
                campaign_status: String(row.status ?? 'ACTIVE'),
                escrow_status: String(escrow?.status ?? 'PENDING'),
                latest_contract_status: 'UNCLAIMED',
                my_contract_status: null,
                proof_status: 'NOT_SUBMITTED',
                settlement_status: String(escrow?.status ?? 'PENDING') === 'PENDING'
                    ? 'AWAITING_FUNDING'
                    : 'LOCKED_IN_ESCROW',
                is_available: false,
            },
        })),
    };
}
async function loadBundleForAdvertiser(client, bundleId, advertiserId, role) {
    const bundle = await loadBundleSummary(client, bundleId, advertiserId);
    if (!bundle) {
        return { error: 'campaign_bundle_not_found' };
    }
    if (bundle.advertiser_id !== advertiserId && role !== 'ADMIN') {
        return { error: 'forbidden' };
    }
    const ownerCampaignRes = await client.query(`
    SELECT *
    FROM campaigns
    WHERE id=$1
    LIMIT 1
    `, [bundle.bundle_root_campaign_id]);
    const ownerCampaign = ownerCampaignRes.rows[0];
    if (!ownerCampaign) {
        return { error: 'campaign_not_found' };
    }
    return { bundle, ownerCampaign };
}
function deriveProofStatus(latestProof) {
    if (!latestProof)
        return 'NOT_SUBMITTED';
    if (latestProof.status === 'VERIFIED' && latestProof.decision === 'VERIFIED') {
        return 'VERIFIED';
    }
    if (latestProof.status === 'VERIFIED' && latestProof.decision === 'REJECTED') {
        return 'REJECTED';
    }
    if (latestProof.decision === 'MANUAL_REVIEW' || latestProof.status === 'MANUAL_REVIEW') {
        return 'UNDER_REVIEW';
    }
    if (latestProof.status === 'REJECTED') {
        return 'REJECTED';
    }
    return 'PENDING_REVIEW';
}
function deriveSettlementStatus(escrowStatus, latestContractStatus, proofStatus) {
    if (proofStatus === 'VERIFIED' || latestContractStatus === 'COMPLETED') {
        return escrowStatus === 'COMPLETED' ? 'PAID_OUT' : 'PAYOUT_IN_PROGRESS';
    }
    if (latestContractStatus === 'CANCELLED') {
        return 'NOT_SETTLED';
    }
    if (escrowStatus === 'PENDING') {
        return 'AWAITING_FUNDING';
    }
    return 'LOCKED_IN_ESCROW';
}
async function buildCampaignStatusSummary(client, campaignId, userId) {
    const summaries = await buildCampaignStatusSummaries(client, [campaignId], userId);
    return (summaries.get(campaignId) ?? {
        campaign_status: 'ACTIVE',
        escrow_status: 'PENDING',
        latest_contract_status: 'UNCLAIMED',
        my_contract_status: null,
        proof_status: 'NOT_SUBMITTED',
        settlement_status: 'AWAITING_FUNDING',
        funding_confirmed: false,
        is_available: false,
    });
}
export async function buildCampaignStatusSummaries(client, campaignIds, userId) {
    if (campaignIds.length === 0) {
        return new Map();
    }
    const statusRes = await client.query(`
    WITH
    scope AS (
      SELECT
        c.id,
        c.id AS campaign_id,
        c.parent_campaign_id,
        c.bundle_root_campaign_id,
        COALESCE(c.bundle_root_campaign_id, c.parent_campaign_id, c.id) AS escrow_campaign_id,
        c.campaign_bundle_id,
        c.status AS campaign_status,
        (c.parent_campaign_id IS NULL) AS is_root
      FROM campaigns c
      WHERE c.id = ANY($1::uuid[])
    ),
    scoped_members AS (
      SELECT
        s.campaign_id AS selected_campaign_id,
        c.id AS member_campaign_id
      FROM scope s
      JOIN campaigns c
        ON (
          (s.is_root AND (c.id = s.campaign_id OR c.parent_campaign_id = s.campaign_id))
          OR
          ((NOT s.is_root) AND c.id = s.campaign_id)
        )
    )
    SELECT
      s.campaign_status,
      s.campaign_id,
      COALESCE(e.status, 'PENDING') AS escrow_status,
      COALESCE(fc.funding_confirmed, FALSE) AS funding_confirmed,
      lc.status AS latest_contract_status,
      mc.status AS my_contract_status,
      lp.status AS latest_proof_status,
      lp.decision AS latest_proof_decision
    FROM scope s
    LEFT JOIN escrow_ledger e ON e.campaign_id = s.escrow_campaign_id
    LEFT JOIN LATERAL (
      SELECT status
      FROM contracts
      WHERE campaign_id IN (
        SELECT member_campaign_id
        FROM scoped_members
        WHERE selected_campaign_id = s.campaign_id
      )
      ORDER BY created_at DESC
      LIMIT 1
    ) lc ON TRUE
    LEFT JOIN LATERAL (
      SELECT status
      FROM contracts
      WHERE campaign_id = s.campaign_id
        AND distributor_id = $2
      ORDER BY created_at DESC
      LIMIT 1
    ) mc ON TRUE
    LEFT JOIN LATERAL (
      SELECT p.status, p.decision
      FROM proofs p
      JOIN verification_sessions vs ON vs.id = p.session_id
      WHERE vs.campaign_id IN (
        SELECT member_campaign_id
        FROM scoped_members
        WHERE selected_campaign_id = s.campaign_id
      )
      ORDER BY p.created_at DESC
      LIMIT 1
    ) lp ON TRUE
    LEFT JOIN LATERAL (
      SELECT TRUE AS funding_confirmed
      WHERE ${buildConfirmedEscrowEvidenceSql('s', 'e')}
    ) fc ON TRUE
    `, [campaignIds, userId ?? null]);
    const result = new Map();
    for (const row of statusRes.rows) {
        const campaignStatus = String(row.campaign_status ?? 'ACTIVE');
        const escrowStatus = String(row.escrow_status ?? 'PENDING');
        const fundingConfirmed = row.funding_confirmed === true;
        const latestContractStatus = String(row.latest_contract_status ?? 'UNCLAIMED');
        const myContractStatus = row.my_contract_status == null ? null : String(row.my_contract_status);
        const proofStatus = deriveProofStatus(row.latest_proof_status
            ? { status: row.latest_proof_status, decision: row.latest_proof_decision }
            : null);
        const settlementStatus = deriveSettlementStatus(escrowStatus, latestContractStatus, proofStatus);
        result.set(String(row.campaign_id), {
            campaign_status: campaignStatus,
            escrow_status: escrowStatus,
            latest_contract_status: latestContractStatus,
            my_contract_status: myContractStatus,
            proof_status: proofStatus,
            settlement_status: settlementStatus,
            funding_confirmed: fundingConfirmed,
            is_available: campaignStatus === 'ACTIVE' &&
                fundingConfirmed &&
                isConfirmedEscrowFundingStatus(escrowStatus) &&
                latestContractStatus === 'UNCLAIMED',
        });
    }
    return result;
}
async function getContractCompletionReadiness(client, contractId, userId) {
    const contractRes = await client.query(`
    SELECT
      ctr.*,
      c.platform,
      COALESCE(c.bundle_root_campaign_id, c.parent_campaign_id, c.id) AS escrow_campaign_id
    FROM contracts ctr
    JOIN campaigns c ON c.id = ctr.campaign_id
    WHERE ctr.id=$1
    LIMIT 1
    `, [contractId]);
    const contract = contractRes.rows[0];
    if (!contract)
        return { error: 'contract_not_found' };
    if (contract.distributor_id !== userId)
        return { error: 'forbidden' };
    if (contract.status !== 'ACTIVE')
        return { error: 'contract_not_active' };
    const escrowRes = await client.query(`
    SELECT status
    FROM escrow_ledger
    WHERE campaign_id=$1
    LIMIT 1
    `, [contract.escrow_campaign_id]);
    const escrow = escrowRes.rows[0];
    if (!escrow ||
        !isConfirmedEscrowFundingStatus(escrow.status) ||
        !(await hasConfirmedEscrowFunding(client, contract.campaign_id))) {
        return { error: 'campaign_not_funded' };
    }
    const proofRes = await client.query(`
    SELECT p.id
    FROM proofs p
    JOIN verification_sessions s ON s.id = p.session_id
    WHERE s.campaign_id=$1
      AND p.user_id=$2
      AND p.status='VERIFIED'
      AND p.decision='VERIFIED'
    ORDER BY p.created_at DESC
    LIMIT 1
    `, [contract.campaign_id, userId]);
    if (!proofRes.rows[0]) {
        return { error: 'verified_proof_required' };
    }
    return { contract };
}
async function getContractForAdvertiserAction(client, contractId, advertiserId, role) {
    const contractRes = await client.query(`
    SELECT
      ctr.*,
      c.advertiser_id,
      c.parent_campaign_id,
      c.platform,
      c.budget_total,
      COALESCE(c.bundle_root_campaign_id, c.parent_campaign_id, c.id) AS escrow_campaign_id
    FROM contracts ctr
    JOIN campaigns c ON c.id = ctr.campaign_id
    WHERE ctr.id=$1
    LIMIT 1
    `, [contractId]);
    const contract = contractRes.rows[0];
    if (!contract)
        return { error: 'contract_not_found' };
    if (contract.advertiser_id !== advertiserId && role !== 'ADMIN') {
        return { error: 'forbidden' };
    }
    return { contract };
}
export async function campaignRoutes(app) {
    await withTransaction(async (client) => {
        await ensureCampaignColumns(client);
        await ensureChatSchema(client);
    });
    const campaignRepo = new CampaignRepo();
    const paymentRepo = new PaymentRepo();
    const AcceptContractSchema = z.object({
        campaign_id: z.string().trim().min(3),
    });
    const UpdateCampaignSchema = z
        .object({
        title: z.string().min(3).max(120),
        platform: PlatformAdapterSchema,
        delivery_model: DeliveryModelSchema.optional(),
        payout_amount: z.number().int().positive(),
        budget_total: z.number().int().positive(),
        execution_mode: z.enum(['PRIVATE_CONTRACT', 'OPEN_BUDGET']).optional(),
        visibility: z.enum(['PUBLIC', 'PRIVATE']).optional(),
        counterparty_contact: z.string().trim().min(7).max(20).optional(),
        beneficiary_contacts: z.array(z.string().trim().min(7).max(20)).optional(),
        beneficiary_user_ids: z.array(z.string().uuid()).optional(),
        beneficiary_group_id: z.string().uuid().optional(),
        start_date: z.string(),
        end_date: z.string(),
        media_type: MediaTypeSchema,
        media_url: z.string().url().optional(),
        media_urls: z.array(z.string().url()).max(8).optional(),
        media_text: z.string().trim().min(3).max(4000).optional(),
        execution_meta: z.record(z.any()).optional(),
        impression_target: z.number().int().min(1).optional(),
        platform_fee_percent: z.number().min(0).max(100).optional(),
        advertiser_wallet_mode: z.enum(['CAMPAIGN_ONLY']).optional(),
        terms_keep_hours: z.number().int().min(1).max(168).optional(),
        terms_min_views: z.number().int().min(1).optional().nullable(),
        terms_requirement: z.enum(['DURATION', 'VIEWS', 'BOTH']).optional(),
    })
        .superRefine((value, ctx) => {
        const hasMediaUrl = primaryCampaignMediaUrl(value) != null;
        const hasMediaText = typeof value.media_text === 'string' &&
            value.media_text.trim().length > 0;
        if (!hasMediaUrl && !hasMediaText) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['media_url'],
                message: 'Either media_url or media_text is required.',
            });
        }
    });
    const FundBundleSchema = FundCampaignSchema.omit({ campaign_id: true });
    const LookupDistributorSchema = z
        .object({
        phone: z.string().trim().min(7).max(20).optional(),
        user_id: z.string().uuid().optional(),
        media_type: MediaTypeSchema.optional(),
    })
        .refine((value) => Boolean(value.phone || value.user_id), {
        message: 'Either phone or user_id is required.',
        path: ['phone'],
    });
    const LookupGroupSchema = z.object({
        group_id: z.string().uuid(),
        media_type: MediaTypeSchema.optional(),
    });
    app.get('/campaigns/distributor-lookup', { preHandler: [app.authenticate] }, async (request, reply) => {
        const role = request.user?.role;
        if (!canAccessAdvertiserFeatures(role)) {
            reply.code(403);
            return { error: 'forbidden' };
        }
        const parsed = LookupDistributorSchema.safeParse(request.query);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        const distributor = await withTransaction(async (client) => {
            const found = parsed.data.user_id
                ? await findDistributorById(client, String(parsed.data.user_id))
                : await findDistributorByPhone(client, String(parsed.data.phone));
            if (!found) {
                return null;
            }
            const pricing = await buildPrivatePricingQuote(client, found, parsed.data.media_type ?? 'IMAGE', 'WHATSAPP_STATUS');
            return {
                ...found,
                ...pricing,
            };
        });
        if (!distributor) {
            reply.code(404);
            return { error: 'distributor_not_found' };
        }
        return { distributor };
    });
    app.get('/campaigns/group-lookup', { preHandler: [app.authenticate] }, async (request, reply) => {
        const role = request.user?.role;
        if (!canAccessAdvertiserFeatures(role)) {
            reply.code(403);
            return { error: 'forbidden' };
        }
        const parsed = LookupGroupSchema.safeParse(request.query);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        const group = await withTransaction(async (client) => {
            return buildGroupBeneficiaryQuote(client, parsed.data.group_id, parsed.data.media_type ?? 'IMAGE');
        });
        if (!group) {
            reply.code(404);
            return { error: 'group_not_found' };
        }
        if (group.member_count <= 0) {
            reply.code(409);
            return { error: 'group_beneficiary_empty' };
        }
        return { group };
    });
    app.get('/campaigns/public-contract-eligibility', { preHandler: [app.authenticate] }, async (request, reply) => {
        const authSub = request.user?.sub;
        const authUser = authSub === 'ariaka-access'
            ? '00000000-0000-0000-0000-000000000000'
            : authSub;
        const role = request.user?.role;
        if (!authUser) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        if (!canAccessAdvertiserFeatures(role)) {
            reply.code(403);
            return { error: 'forbidden' };
        }
        return withTransaction(async (client) => getPublicContractEligibility(client));
    });
    app.get('/campaigns', { preHandler: [app.authenticate] }, async (request, reply) => {
        const authSub = request.user?.sub;
        const authUser = authSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : authSub;
        const role = normalizeActiveRole(request.user?.active_role, request.user?.role);
        const query = (request.query ?? {});
        const limitRaw = Number(query.limit ?? 50);
        const offsetRaw = Number(query.offset ?? 0);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
        const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
        const campaigns = await withTransaction(async (client) => {
            if (role === 'DISTRIBUTOR') {
                const restriction = await getUserAccountRestriction(client, authUser, 'distributor');
                if (restriction) {
                    return restriction;
                }
            }
            const params = [];
            const filters = [];
            let idx = 1;
            if (query.platform) {
                filters.push(`c.platform = $${idx}`);
                params.push(query.platform);
                idx++;
            }
            if (query.status) {
                filters.push(`c.status = $${idx}`);
                params.push(query.status);
                idx++;
            }
            filters.push(`c.platform = '${ACTIVE_CAMPAIGN_PLATFORM}'`);
            if (role === 'DISTRIBUTOR') {
                filters.push(`(
          (c.parent_campaign_id IS NOT NULL AND c.assigned_distributor_id = $${idx})
          OR (
            c.parent_campaign_id IS NULL
            AND c.execution_mode != 'OPEN_BUDGET'
            AND c.visibility='PUBLIC'
          )
        )`);
                params.push(authUser ?? '');
                idx++;
            }
            else if (role !== 'ADMIN') {
                filters.push(`c.advertiser_id = $${idx}`);
                params.push(authUser ?? '');
                idx++;
                filters.push(`c.parent_campaign_id IS NULL`);
            }
            const availableOnly = (query.available_only ?? 'true').toString().toLowerCase();
            if (role === 'DISTRIBUTOR' && availableOnly !== 'false') {
                filters.push(`c.status='ACTIVE'`);
                filters.push(`NOT EXISTS (
             SELECT 1
             FROM contracts ctr
             WHERE ctr.campaign_id = c.id
               AND ctr.status = 'ACTIVE'
           )`);
            }
            if (role === 'DISTRIBUTOR') {
                filters.push(`(
          c.platform = 'WHATSAPP_STATUS'
          OR EXISTS (
            SELECT 1
            FROM creators cr
            JOIN creator_accounts ca
              ON ca.creator_id = cr.id
             AND ca.platform = c.platform
             AND ca.active = TRUE
            WHERE cr.user_id = $${idx}
              AND NULLIF(BTRIM(COALESCE(ca.profile_url, ca.handle, '')), '') IS NOT NULL
          )
        )`);
                params.push(authUser ?? '');
                idx++;
                filters.push(`(c.parent_campaign_id IS NOT NULL OR c.visibility='PUBLIC')`);
            }
            const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
            const res = await client.query(`
        SELECT c.*
        FROM campaigns c
        LEFT JOIN campaigns parent ON parent.id = c.parent_campaign_id
        WHERE c.id IN (
          SELECT c2.id
          FROM campaigns c2
          LEFT JOIN escrow_ledger e
            ON e.campaign_id = COALESCE(c2.bundle_root_campaign_id, c2.parent_campaign_id, c2.id)
          WHERE (${buildConfirmedEscrowEvidenceSql('c2', 'e')})
             OR c2.advertiser_id = $${idx}
        )
        ${where ? `AND ${where.replace(/^WHERE /, '')}` : ''}
        ORDER BY c.created_at DESC
        LIMIT $${idx + 1} OFFSET $${idx + 2}
        `, [...params, authUser ?? '', limit, offset]);
            const statusSummaries = await buildCampaignStatusSummaries(client, res.rows.map((row) => String(row.id)), authUser ?? null);
            const campaignsWithStatus = res.rows.map((row) => ({
                ...row,
                status_summary: statusSummaries.get(String(row.id)) ?? {
                    campaign_status: String(row.status ?? 'ACTIVE'),
                    escrow_status: 'PENDING',
                    latest_contract_status: 'UNCLAIMED',
                    my_contract_status: null,
                    proof_status: 'NOT_SUBMITTED',
                    settlement_status: 'AWAITING_FUNDING',
                    funding_confirmed: false,
                    is_available: false,
                },
            }));
            return campaignsWithStatus;
        });
        if (campaigns?.error === 'account_restricted') {
            reply.code(403);
            return campaigns;
        }
        return { campaigns };
    });
    app.get('/campaigns/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const authSub = request.user?.sub;
        const authUser = authSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : authSub;
        const role = normalizeActiveRole(request.user?.active_role, request.user?.role);
        const campaign = await withTransaction(async (client) => {
            if (role === 'DISTRIBUTOR') {
                const restriction = await getUserAccountRestriction(client, authUser, 'distributor');
                if (restriction) {
                    return restriction;
                }
            }
            const found = await campaignRepo.getCampaign(client, params.id);
            if (!found)
                return null;
            if (String(found.platform ?? '').trim().toUpperCase() !==
                ACTIVE_CAMPAIGN_PLATFORM &&
                role !== 'ADMIN') {
                return null;
            }
            if (found.visibility === 'PRIVATE' &&
                found.assigned_distributor_id &&
                found.assigned_distributor_id !== authUser &&
                found.advertiser_id !== authUser) {
                return null;
            }
            const activeContract = await client.query(`SELECT *
         FROM contracts
        WHERE campaign_id=$1
           AND status='ACTIVE'
         ORDER BY created_at DESC`, [found.id]);
            const activeContractRow = activeContract.rows[0] ?? null;
            const beneficiaries = found.advertiser_id === authUser && !found.parent_campaign_id
                ? (await client.query(`SELECT
                   c.id,
                   c.assigned_distributor_id,
                   c.assigned_phone,
                   COALESCE(u.max_status_viewers_12h, 0)::int AS max_status_viewers_12h,
                   COALESCE(u.private_contract_rate_ugx, 0)::int AS private_contract_rate_ugx,
                   COALESCE(NULLIF(u.full_name, ''), NULLIF(p.full_name, ''), c.assigned_phone) AS full_name,
                   c.payout_amount,
                   c.impression_target,
                   c.execution_meta
                 FROM campaigns
                 c
                 LEFT JOIN users u ON u.id = c.assigned_distributor_id
                 LEFT JOIN user_profiles p ON p.user_id = c.assigned_distributor_id
                 WHERE c.parent_campaign_id=$1
                 ORDER BY c.created_at ASC`, [found.id])).rows
                : [];
            const managedContracts = found.advertiser_id === authUser
                ? (await client.query(`
                SELECT
                  c.id AS campaign_id,
                  c.public_id AS campaign_public_id,
                  c.title AS campaign_title,
                  c.assigned_phone,
                  c.assigned_distributor_id,
                  ctr.id AS contract_id,
                  ctr.status AS contract_status,
                  ctr.accepted_at,
                  ctr.post_deadline_at,
                  ctr.contract_deadline_at,
                  ctr.completed_at,
                  ctr.cancelled_at,
                  p.status AS latest_proof_status,
                  p.decision AS latest_proof_decision
                FROM campaigns c
                LEFT JOIN LATERAL (
                  SELECT *
                  FROM contracts ctr
                  WHERE ctr.campaign_id = c.id
                  ORDER BY ctr.created_at DESC
                  LIMIT 1
                ) ctr ON TRUE
                LEFT JOIN LATERAL (
                  SELECT p.status, p.decision
                  FROM proofs p
                  JOIN verification_sessions vs ON vs.id = p.session_id
                  WHERE vs.campaign_id = c.id
                    AND (
                      ctr.distributor_id IS NULL
                      OR p.user_id = ctr.distributor_id
                    )
                  ORDER BY p.created_at DESC
                  LIMIT 1
                ) p ON TRUE
                WHERE (
                  ($1::boolean = TRUE AND c.parent_campaign_id = $2)
                  OR ($1::boolean = FALSE AND c.id = $2)
                )
                ORDER BY c.created_at ASC
                `, [beneficiaries.length > 0, found.id])).rows.map((row) => {
                    const proof_status = deriveProofStatus(row.latest_proof_status
                        ? {
                            status: row.latest_proof_status,
                            decision: row.latest_proof_decision,
                        }
                        : null);
                    return {
                        ...row,
                        proof_status,
                        can_complete: row.contract_status === 'ACTIVE' && proof_status === 'VERIFIED',
                        can_cancel: row.contract_status === 'ACTIVE',
                    };
                })
                : [];
            return {
                ...withCampaignMediaUrls(found),
                beneficiaries,
                managed_contracts: managedContracts,
                active_contract: activeContractRow,
                my_active_contract: authUser
                    ? activeContract.rows.find((row) => row.distributor_id === authUser) ?? null
                    : null,
                status_summary: await buildCampaignStatusSummary(client, found.id, authUser ?? null),
            };
        });
        if (campaign?.error === 'account_restricted') {
            reply.code(403);
            return campaign;
        }
        if (!campaign) {
            reply.code(404);
            return { error: 'campaign_not_found' };
        }
        return { campaign };
    });
    app.get('/campaign-bundles/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const authSub = request.user?.sub;
        const authUser = authSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : authSub;
        const role = request.user?.role;
        if (!authUser) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        if (!canAccessAdvertiserFeatures(role)) {
            reply.code(403);
            return { error: 'forbidden' };
        }
        const result = await withTransaction(async (client) => {
            return loadBundleForAdvertiser(client, params.id, authUser, role);
        });
        if (result.error) {
            const error = result.error;
            reply.code(error === 'campaign_bundle_not_found' || error === 'campaign_not_found'
                ? 404
                : 403);
            return { error };
        }
        return {
            bundle: {
                ...result.bundle,
                campaigns: (result.bundle?.campaigns ?? []).map((row) => withCampaignMediaUrls(row)),
            },
        };
    });
    app.get('/campaigns/:id/proofs', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const authSub = request.user?.sub;
        const authUser = authSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : authSub;
        if (!authUser) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        const proofs = await withTransaction(async (client) => {
            const campaign = await campaignRepo.getCampaign(client, params.id);
            if (!campaign)
                return { error: 'campaign_not_found' };
            if (campaign.advertiser_id !== authUser)
                return { error: 'not_campaign_advertiser' };
            const campaignIdsRes = await client.query(`SELECT id FROM campaigns WHERE id=$1 OR parent_campaign_id=$1`, [campaign.id]);
            const campaignIds = campaignIdsRes.rows.map((row) => row.id);
            const res = await client.query(`SELECT p.id,
                p.status,
                p.decision,
                p.observed_views,
                p.observed_post_hash,
                p.challenge_seen,
                p.confidence,
                p.meta,
                p.created_at,
                s.platform,
                u.id AS distributor_id,
                u.email AS distributor_email
         FROM proofs p
         JOIN verification_sessions s ON s.id = p.session_id
         JOIN users u ON u.id = p.user_id
         WHERE s.campaign_id = ANY($1::uuid[])
         ORDER BY p.created_at DESC`, [campaignIds]);
            return { proofs: res.rows };
        });
        if (proofs.error) {
            reply.code(403);
            return proofs;
        }
        return proofs;
    });
    app.get('/campaigns/:id/proofs/summary', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const authSub = request.user?.sub;
        const authUser = authSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : authSub;
        if (!authUser) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        let summary;
        try {
            summary = await withTransaction(async (client) => {
                const campaign = await campaignRepo.getCampaign(client, params.id);
                if (!campaign)
                    return { error: 'campaign_not_found' };
                if (campaign.advertiser_id !== authUser) {
                    return { error: 'not_campaign_advertiser' };
                }
                const scopeId = campaign.parent_campaign_id ?? campaign.id;
                const campaignIdsRes = await client.query(`SELECT id FROM campaigns WHERE id=$1 OR parent_campaign_id=$1`, [scopeId]);
                const campaignIds = Array.from(new Set(campaignIdsRes.rows
                    .map((row) => String(row.id ?? '').trim())
                    .filter(Boolean)));
                if (campaignIds.length === 0) {
                    return {
                        total: 0,
                        latest: null,
                        contract_completion_notice: 'Contract completion summary generated from verified screen-recording review results.',
                        completed_contracts: 0,
                        successful_contracts: 0,
                        thanks_note: 'Thank you for advertising with the platform.',
                    };
                }
                const totalRes = await client.query(`SELECT COUNT(*)::int AS total
           FROM proofs p
           JOIN verification_sessions s ON s.id = p.session_id
           WHERE s.campaign_id = ANY($1::uuid[])`, [campaignIds]);
                const latestRes = await client.query(`SELECT p.status, p.decision, p.created_at
           FROM proofs p
           JOIN verification_sessions s ON s.id = p.session_id
           WHERE s.campaign_id = ANY($1::uuid[])
           ORDER BY p.created_at DESC
           LIMIT 1`, [campaignIds]);
                const completedRes = await client.query(`SELECT
             COUNT(*)::int AS completed_contracts,
             COALESCE(SUM(CASE WHEN status='COMPLETED' THEN 1 ELSE 0 END), 0)::int AS successful_contracts
           FROM contracts
           WHERE campaign_id = ANY($1::uuid[])`, [campaignIds]);
                return {
                    total: totalRes.rows[0]?.total ?? 0,
                    latest: latestRes.rows[0] ?? null,
                    contract_completion_notice: 'Contract completion summary generated from verified screen-recording review results.',
                    completed_contracts: completedRes.rows[0]?.completed_contracts ?? 0,
                    successful_contracts: completedRes.rows[0]?.successful_contracts ?? 0,
                    thanks_note: 'Thank you for advertising with the platform.',
                };
            });
        }
        catch (error) {
            app.log.error({
                error,
                campaignId: params.id,
                advertiserId: authUser,
            }, 'campaign_proofs_summary_failed');
            reply.code(200);
            return {
                total: 0,
                latest: null,
                contract_completion_notice: 'Contract completion summary is temporarily unavailable.',
                completed_contracts: 0,
                successful_contracts: 0,
                thanks_note: 'Thank you for advertising with the platform.',
            };
        }
        if (summary.error) {
            const error = summary.error;
            reply.code(error === 'campaign_not_found' ? 404 : 403);
            return summary;
        }
        return summary;
    });
    app.post('/campaigns', { preHandler: [app.authenticate] }, async (request, reply) => {
        const parsedBody = CreateCampaignSchema.safeParse(request.body);
        if (!parsedBody.success) {
            request.log.warn({
                issues: parsedBody.error.issues,
                body: request.body,
            }, 'campaign_create_validation_failed');
            reply.code(400);
            return { error: 'validation_failed', issues: parsedBody.error.issues };
        }
        const body = parsedBody.data;
        const requestedPlatforms = resolveRequestedPlatforms(body);
        if (!hasOnlyActiveCampaignPlatforms(requestedPlatforms)) {
            reply.code(400);
            return {
                error: 'platform_temporarily_unavailable',
                detail: TEMPORARY_PLATFORM_INCORPORATION_DETAIL,
            };
        }
        const authSub = request.user?.sub;
        const authUser = authSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : authSub;
        const role = request.user?.role;
        if (!authUser) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        if (!canAccessAdvertiserFeatures(role)) {
            reply.code(403);
            return { error: 'forbidden' };
        }
        const restriction = await withTransaction(async (client) => getUserAccountRestriction(client, authUser, 'advertiser'));
        if (restriction) {
            reply.code(403);
            return restriction;
        }
        const bundleItems = buildBundleItems(body);
        const requiresPublicContractEligibility = bundleItems.some((item) => resolveExecutionMode(String(item.platform), item.execution_mode) === 'OPEN_BUDGET');
        if (requiresPublicContractEligibility) {
            const eligibility = await withTransaction(async (client) => getPublicContractEligibility(client));
            if (!eligibility.eligible) {
                reply.code(409);
                return {
                    error: 'public_contract_distributor_threshold_unmet',
                    ...eligibility,
                };
            }
        }
        let campaign;
        try {
            campaign = await withTransaction(async (client) => {
                const bundlePlatforms = normalizePlatformList(bundleItems.map((item) => item.platform));
                if (bundlePlatforms.length !== bundleItems.length) {
                    throw new Error('duplicate_bundle_platform');
                }
                const bundleId = bundleItems.length > 1 ? uuid() : null;
                const createdRootCampaigns = [];
                let bundleRootCampaignId = null;
                let totalEscrowAmount = 0;
                for (const item of bundleItems) {
                    const executionMode = resolveExecutionMode(item.platform, item.execution_mode);
                    const beneficiaryContacts = normalizeBeneficiaryContacts(item);
                    const beneficiaryUserIds = normalizeBeneficiaryUserIds(item);
                    const beneficiaryGroupId = normalizeBeneficiaryGroupId(item);
                    const deliveryModel = resolveDeliveryModel(item.platform, item.delivery_model);
                    const resolvedTermsKeepHours = executionMode === 'PRIVATE_CONTRACT'
                        ? Math.max(PRIVATE_CONTRACT_WINDOW_HOURS, Number(item.terms_keep_hours ?? PRIVATE_CONTRACT_WINDOW_HOURS))
                        : Number(item.terms_keep_hours ?? 12);
                    if (executionMode === 'PRIVATE_CONTRACT' &&
                        beneficiaryContacts.length === 0 &&
                        beneficiaryUserIds.length === 0 &&
                        !beneficiaryGroupId) {
                        throw new Error('private_beneficiary_required');
                    }
                    let platformFeePercent = PRIVATE_PLATFORM_FEE_PERCENT;
                    let visibility = executionMode === 'OPEN_BUDGET' ? 'PUBLIC' : 'PRIVATE';
                    let distributableBudget = Math.max(0, Number(item.budget_total ?? 0));
                    let resolvedRootPayout = Math.max(1, Number(item.payout_amount ?? 0));
                    let resolvedBudgetTotal = distributableBudget;
                    let resolvedImpressionTarget = Math.max(1, Number(item.impression_target ?? 1));
                    let estimatedAllocationCount = 1;
                    let perAllocationTarget = resolvedImpressionTarget;
                    let privateShares = [];
                    let privateGroupQuote = null;
                    let privateBeneficiaryMeta = [];
                    if (executionMode === 'PRIVATE_CONTRACT') {
                        const privateSelection = await resolvePrivateContractSelection(client, {
                            beneficiaryContacts,
                            beneficiaryUserIds,
                            beneficiaryGroupId,
                        }, item.media_type, item.platform);
                        privateShares = privateSelection.privateShares;
                        privateGroupQuote = privateSelection.privateGroupQuote;
                        resolvedBudgetTotal = privateShares.reduce((sum, share) => sum + Number(share.budget_total ?? 0), 0);
                        distributableBudget = resolvedBudgetTotal;
                        resolvedRootPayout = privateShares.reduce((sum, share) => sum + Number(share.payout_amount ?? 0), 0);
                        resolvedImpressionTarget = privateShares.reduce((sum, share) => sum + Number(share.impression_target ?? 0), 0);
                        estimatedAllocationCount = Math.max(1, privateShares.length);
                        perAllocationTarget = Math.max(1, Math.ceil(resolvedImpressionTarget / estimatedAllocationCount));
                        visibility = 'PRIVATE';
                        platformFeePercent = PRIVATE_PLATFORM_FEE_PERCENT;
                        privateBeneficiaryMeta = buildPrivateBeneficiaryMeta(privateShares);
                    }
                    else {
                        const publicBudget = deriveCampaignBudget(item.platform, executionMode, item.budget_total, item.payout_amount, item.impression_target, item.media_type);
                        platformFeePercent = publicBudget.platformFeePercent;
                        visibility = publicBudget.visibility;
                        distributableBudget = publicBudget.distributableBudget;
                        resolvedRootPayout = publicBudget.normalizedPayout;
                        resolvedBudgetTotal = Math.max(0, Number(item.budget_total ?? 0));
                        resolvedImpressionTarget = publicBudget.impressionTarget;
                        estimatedAllocationCount = publicBudget.estimatedAllocationCount;
                        perAllocationTarget = publicBudget.perAllocationTarget;
                    }
                    const resolvedMediaUrls = normalizeCampaignMediaUrls(item);
                    const resolvedMediaUrl = primaryCampaignMediaUrl(item);
                    const executionMeta = buildCampaignExecutionMeta(item.platform, item.execution_meta, executionMode === 'PRIVATE_CONTRACT'
                        ? {
                            private_contract_window_hours: PRIVATE_CONTRACT_WINDOW_HOURS,
                            private_contract_scope: privateGroupQuote == null ? 'INDIVIDUALS' : 'GROUP',
                            private_pricing_model: 'PROMOTER_RATE',
                            private_beneficiaries: privateBeneficiaryMeta,
                            private_group_beneficiary: buildPrivateGroupMeta(privateGroupQuote),
                            private_total_rate_ugx: resolvedBudgetTotal,
                            private_total_proven_engagements_24h: resolvedImpressionTarget,
                            media_urls: resolvedMediaUrls,
                        }
                        : isCreatorPlatform(item.platform) &&
                            executionMode === 'OPEN_BUDGET'
                            ? {
                                allocation_strategy: 'REPUTATION_BASED',
                                creator_unit_count: estimatedAllocationCount,
                                per_creator_target_metric: perAllocationTarget,
                                target_metric_total: resolvedImpressionTarget,
                                public_contract_rate_ugx: getPublicContractUnitRate(item.media_type),
                                media_urls: resolvedMediaUrls,
                            }
                            : {
                                public_contract_rate_ugx: getPublicContractUnitRate(item.media_type),
                                media_urls: resolvedMediaUrls,
                            });
                    const campaignBurstMode = getCampaignBurstMode({
                        execution_meta: executionMeta,
                    });
                    const root = await campaignRepo.createCampaign(client, {
                        advertiser_id: authUser,
                        campaign_bundle_id: bundleId,
                        bundle_root_campaign_id: bundleRootCampaignId,
                        title: String(item.title ?? body.title),
                        platform: item.platform,
                        delivery_model: deliveryModel,
                        execution_mode: executionMode,
                        visibility,
                        payout_amount: resolvedRootPayout,
                        budget_total: resolvedBudgetTotal,
                        impression_target: resolvedImpressionTarget,
                        platform_fee_percent: platformFeePercent,
                        advertiser_wallet_mode: 'CAMPAIGN_ONLY',
                        media_type: item.media_type,
                        media_text: item.media_text,
                        media_url: resolvedMediaUrl ?? undefined,
                        execution_meta: executionMeta,
                        campaign_burst_mode: campaignBurstMode,
                        terms_keep_hours: resolvedTermsKeepHours,
                        terms_min_views: item.terms_min_views ?? null,
                        terms_requirement: item.terms_requirement ?? 'DURATION',
                        start_date: item.start_date,
                        end_date: item.end_date,
                    });
                    if (!bundleRootCampaignId) {
                        bundleRootCampaignId = String(root.id);
                        if (bundleId) {
                            await client.query(`
                UPDATE campaigns
                SET bundle_root_campaign_id=$2
                WHERE id=$1
                `, [root.id, bundleRootCampaignId]);
                            root.bundle_root_campaign_id = bundleRootCampaignId;
                        }
                    }
                    totalEscrowAmount += resolvedBudgetTotal;
                    if (executionMode === 'PRIVATE_CONTRACT') {
                        for (const share of privateShares) {
                            const childExecutionMeta = buildCampaignExecutionMeta(item.platform, executionMeta, {
                                private_contract_window_hours: PRIVATE_CONTRACT_WINDOW_HOURS,
                                private_pricing_model: share.pricing_mode,
                                private_contract_rate_ugx: share.private_contract_rate_ugx,
                                deterministic_rate_ugx: share.deterministic_rate_ugx,
                                selected_rate_ugx: share.budget_total,
                                proven_engagements_24h: share.proven_engagements_24h,
                                pricing_reference_engagements_24h: share.pricing_reference_engagements_24h,
                            });
                            await campaignRepo.createCampaign(client, {
                                advertiser_id: authUser,
                                campaign_bundle_id: bundleId,
                                bundle_root_campaign_id: bundleRootCampaignId,
                                parent_campaign_id: root.id,
                                assigned_distributor_id: share.distributor.id,
                                assigned_phone: share.distributor.phone,
                                title: String(item.title ?? body.title),
                                platform: item.platform,
                                delivery_model: deliveryModel,
                                execution_mode: 'PRIVATE_CONTRACT',
                                visibility: 'PRIVATE',
                                payout_amount: share.payout_amount,
                                budget_total: share.budget_total,
                                impression_target: share.impression_target,
                                platform_fee_percent: PRIVATE_PLATFORM_FEE_PERCENT,
                                advertiser_wallet_mode: 'CAMPAIGN_ONLY',
                                media_type: item.media_type,
                                media_text: item.media_text,
                                media_url: resolvedMediaUrl ?? undefined,
                                execution_meta: childExecutionMeta,
                                campaign_burst_mode: campaignBurstMode,
                                terms_keep_hours: resolvedTermsKeepHours,
                                terms_min_views: item.terms_min_views ?? null,
                                terms_requirement: item.terms_requirement ?? 'DURATION',
                                start_date: item.start_date,
                                end_date: item.end_date,
                            });
                        }
                    }
                    createdRootCampaigns.push(withCampaignMediaUrls({
                        ...root,
                        campaign_bundle_id: bundleId,
                        bundle_root_campaign_id: bundleRootCampaignId,
                        beneficiary_count: beneficiaryContacts.length,
                        platform_fee_percent: platformFeePercent,
                        distributable_budget: distributableBudget,
                        estimated_minimum_users: estimatedAllocationCount,
                        estimated_allocations: estimatedAllocationCount,
                        per_allocation_target: perAllocationTarget,
                    }));
                }
                await paymentRepo.createEscrow(client, bundleRootCampaignId ?? String(createdRootCampaigns[0]?.id ?? ''), bundleId ? totalEscrowAmount : Number(createdRootCampaigns[0]?.budget_total ?? 0));
                if (bundleId && bundleRootCampaignId) {
                    await client.query(`
            UPDATE campaigns
            SET bundle_root_campaign_id=$2
            WHERE campaign_bundle_id=$1
              AND bundle_root_campaign_id IS NULL
            `, [bundleId, bundleRootCampaignId]);
                    const bundle = await loadBundleSummary(client, bundleId, authUser);
                    return {
                        campaign: createdRootCampaigns[0],
                        campaigns: bundle?.campaigns ?? createdRootCampaigns,
                        bundle,
                    };
                }
                return {
                    campaign: createdRootCampaigns[0],
                };
            });
        }
        catch (error) {
            const message = String(error?.message ?? 'campaign_create_failed');
            const normalizedError = normalizeCampaignMutationError(message);
            request.log.warn({
                error,
                detail: message,
                body,
            }, 'campaign_create_failed');
            reply.code(400);
            return {
                error: normalizedError,
                detail: normalizedError === message ? message : '',
            };
        }
        return campaign;
    });
    app.patch('/campaigns/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const parsedBody = UpdateCampaignSchema.safeParse(request.body);
        if (!parsedBody.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsedBody.error.issues };
        }
        const body = parsedBody.data;
        if (!hasOnlyActiveCampaignPlatforms(normalizePlatformList([body.platform]))) {
            reply.code(400);
            return {
                error: 'platform_temporarily_unavailable',
                detail: TEMPORARY_PLATFORM_INCORPORATION_DETAIL,
            };
        }
        const platformKey = String(body.platform);
        const authSub = request.user?.sub;
        const authUser = authSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : authSub;
        const role = request.user?.role;
        if (!authUser) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        if (!canAccessAdvertiserFeatures(role)) {
            reply.code(403);
            return { error: 'forbidden' };
        }
        const requestedExecutionMode = resolveExecutionMode(platformKey, body.execution_mode);
        if (requestedExecutionMode === 'OPEN_BUDGET') {
            const eligibility = await withTransaction(async (client) => getPublicContractEligibility(client));
            if (!eligibility.eligible) {
                reply.code(409);
                return {
                    error: 'public_contract_distributor_threshold_unmet',
                    ...eligibility,
                };
            }
        }
        try {
            const campaign = await withTransaction(async (client) => {
                const editable = await loadEditableCampaign(client, params.id, authUser);
                if ('error' in editable) {
                    return editable;
                }
                const bundleId = editable.bundle_id;
                if (bundleId) {
                    const duplicatePlatformRes = await client.query(`
            SELECT 1
            FROM campaigns
            WHERE campaign_bundle_id=$1
              AND parent_campaign_id IS NULL
              AND id <> $2
              AND platform=$3
            LIMIT 1
            `, [bundleId, editable.root.id, body.platform]);
                    if (duplicatePlatformRes.rows[0]) {
                        throw new Error('duplicate_bundle_platform');
                    }
                }
                const executionMode = requestedExecutionMode;
                const beneficiaryContacts = normalizeBeneficiaryContacts(body);
                const beneficiaryUserIds = normalizeBeneficiaryUserIds(body);
                const beneficiaryGroupId = normalizeBeneficiaryGroupId(body);
                const deliveryModel = resolveDeliveryModel(platformKey, body.delivery_model);
                const resolvedTermsKeepHours = executionMode === 'PRIVATE_CONTRACT'
                    ? Math.max(PRIVATE_CONTRACT_WINDOW_HOURS, Number(body.terms_keep_hours ?? PRIVATE_CONTRACT_WINDOW_HOURS))
                    : Number(body.terms_keep_hours ?? editable.root.terms_keep_hours ?? 12);
                if (executionMode === 'PRIVATE_CONTRACT' &&
                    beneficiaryContacts.length === 0 &&
                    beneficiaryUserIds.length === 0 &&
                    !beneficiaryGroupId) {
                    throw new Error('private_beneficiary_required');
                }
                let platformFeePercent = PRIVATE_PLATFORM_FEE_PERCENT;
                let visibility = executionMode === 'OPEN_BUDGET' ? 'PUBLIC' : 'PRIVATE';
                let distributableBudget = Math.max(0, Number(body.budget_total ?? 0));
                let resolvedRootPayout = Math.max(1, Number(body.payout_amount ?? 0));
                let resolvedBudgetTotal = distributableBudget;
                let resolvedImpressionTarget = Math.max(1, Number(body.impression_target ?? 1));
                let estimatedAllocationCount = 1;
                let perAllocationTarget = resolvedImpressionTarget;
                let privateShares = [];
                let privateGroupQuote = null;
                let privateBeneficiaryMeta = [];
                if (executionMode === 'PRIVATE_CONTRACT') {
                    const privateSelection = await resolvePrivateContractSelection(client, {
                        beneficiaryContacts,
                        beneficiaryUserIds,
                        beneficiaryGroupId,
                    }, body.media_type, platformKey);
                    privateShares = privateSelection.privateShares;
                    privateGroupQuote = privateSelection.privateGroupQuote;
                    resolvedBudgetTotal = privateShares.reduce((sum, share) => sum + Number(share.budget_total ?? 0), 0);
                    distributableBudget = resolvedBudgetTotal;
                    resolvedRootPayout = privateShares.reduce((sum, share) => sum + Number(share.payout_amount ?? 0), 0);
                    resolvedImpressionTarget = privateShares.reduce((sum, share) => sum + Number(share.impression_target ?? 0), 0);
                    estimatedAllocationCount = Math.max(1, privateShares.length);
                    perAllocationTarget = Math.max(1, Math.ceil(resolvedImpressionTarget / estimatedAllocationCount));
                    visibility = 'PRIVATE';
                    platformFeePercent = PRIVATE_PLATFORM_FEE_PERCENT;
                    privateBeneficiaryMeta = buildPrivateBeneficiaryMeta(privateShares);
                }
                else {
                    const publicBudget = deriveCampaignBudget(platformKey, executionMode, Number(body.budget_total), body.payout_amount == null ? null : Number(body.payout_amount), body.impression_target == null
                        ? null
                        : Number(body.impression_target), body.media_type);
                    platformFeePercent = publicBudget.platformFeePercent;
                    visibility = publicBudget.visibility;
                    distributableBudget = publicBudget.distributableBudget;
                    resolvedRootPayout = publicBudget.normalizedPayout;
                    resolvedBudgetTotal = Math.max(0, Number(body.budget_total ?? 0));
                    resolvedImpressionTarget = publicBudget.impressionTarget;
                    estimatedAllocationCount = publicBudget.estimatedAllocationCount;
                    perAllocationTarget = publicBudget.perAllocationTarget;
                }
                const escrowStatus = String(editable.escrow.status ?? 'PENDING').toUpperCase();
                const currentRootBudget = Number(editable.root.budget_total ?? 0);
                const nextRootBudget = resolvedBudgetTotal;
                const nextEscrowTotal = Number(editable.escrow.amount_total ?? 0) - currentRootBudget + nextRootBudget;
                if (escrowStatus !== 'PENDING' &&
                    currentRootBudget !== nextRootBudget) {
                    return { error: 'campaign_edit_budget_locked' };
                }
                const resolvedMediaUrls = normalizeCampaignMediaUrls(body);
                const resolvedMediaUrl = primaryCampaignMediaUrl(body);
                const executionMeta = buildCampaignExecutionMeta(platformKey, body.execution_meta, executionMode === 'PRIVATE_CONTRACT'
                    ? {
                        private_contract_window_hours: PRIVATE_CONTRACT_WINDOW_HOURS,
                        private_contract_scope: privateGroupQuote == null ? 'INDIVIDUALS' : 'GROUP',
                        private_pricing_model: 'PROMOTER_RATE',
                        private_beneficiaries: privateBeneficiaryMeta,
                        private_group_beneficiary: buildPrivateGroupMeta(privateGroupQuote),
                        private_total_rate_ugx: resolvedBudgetTotal,
                        private_total_proven_engagements_24h: resolvedImpressionTarget,
                        media_urls: resolvedMediaUrls,
                    }
                    : isCreatorPlatform(body.platform) &&
                        executionMode === 'OPEN_BUDGET'
                        ? {
                            allocation_strategy: 'REPUTATION_BASED',
                            creator_unit_count: estimatedAllocationCount,
                            per_creator_target_metric: perAllocationTarget,
                            target_metric_total: resolvedImpressionTarget,
                            public_contract_rate_ugx: getPublicContractUnitRate(body.media_type),
                            media_urls: resolvedMediaUrls,
                        }
                        : {
                            public_contract_rate_ugx: getPublicContractUnitRate(body.media_type),
                            media_urls: resolvedMediaUrls,
                        });
                const campaignBurstMode = getCampaignBurstMode({
                    execution_meta: executionMeta,
                });
                const executionMetaJson = executionMeta == null ? null : JSON.stringify(executionMeta);
                const updatedRootRes = await client.query(`UPDATE campaigns
           SET title=$2,
               platform=$3,
               delivery_model=$4,
               execution_mode=$5,
               visibility=$6,
               payout_amount=$7,
               budget_total=$8,
               impression_target=$9,
               platform_fee_percent=$10,
               media_type=$11,
               media_text=$12,
               media_url=$13,
               execution_meta=$14::jsonb,
               campaign_burst_mode=$15,
               terms_keep_hours=$16,
               terms_min_views=$17,
               terms_requirement=$18,
               start_date=$19,
               end_date=$20,
               assigned_distributor_id=NULL,
               assigned_phone=NULL
           WHERE id=$1
           RETURNING *`, [
                    editable.root.id,
                    body.title,
                    body.platform,
                    deliveryModel,
                    executionMode,
                    visibility,
                    resolvedRootPayout,
                    resolvedBudgetTotal,
                    resolvedImpressionTarget,
                    platformFeePercent,
                    body.media_type,
                    body.media_text ?? null,
                    resolvedMediaUrl,
                    executionMetaJson,
                    campaignBurstMode,
                    resolvedTermsKeepHours,
                    body.terms_min_views ?? null,
                    body.terms_requirement ?? editable.root.terms_requirement ?? 'DURATION',
                    body.start_date,
                    body.end_date,
                ]);
                const updatedRoot = updatedRootRes.rows[0];
                if (escrowStatus === 'PENDING') {
                    await client.query(`UPDATE escrow_ledger
             SET amount_total=$2,
                  amount_available=$2
             WHERE id=$1`, [editable.escrow.id, nextEscrowTotal]);
                }
                await client.query('DELETE FROM campaigns WHERE parent_campaign_id=$1', [
                    editable.root.id,
                ]);
                if (executionMode === 'PRIVATE_CONTRACT') {
                    for (const share of privateShares) {
                        const childExecutionMeta = buildCampaignExecutionMeta(platformKey, executionMeta, {
                            private_contract_window_hours: PRIVATE_CONTRACT_WINDOW_HOURS,
                            private_pricing_model: share.pricing_mode,
                            private_contract_rate_ugx: share.private_contract_rate_ugx,
                            deterministic_rate_ugx: share.deterministic_rate_ugx,
                            selected_rate_ugx: share.budget_total,
                            proven_engagements_24h: share.proven_engagements_24h,
                            pricing_reference_engagements_24h: share.pricing_reference_engagements_24h,
                        });
                        await campaignRepo.createCampaign(client, {
                            ...body,
                            advertiser_id: authUser,
                            campaign_bundle_id: bundleId,
                            bundle_root_campaign_id: getEscrowCampaignId(editable.root),
                            delivery_model: deliveryModel,
                            execution_meta: childExecutionMeta,
                            campaign_burst_mode: campaignBurstMode,
                            parent_campaign_id: editable.root.id,
                            assigned_distributor_id: share.distributor.id,
                            assigned_phone: share.distributor.phone,
                            visibility: 'PRIVATE',
                            execution_mode: 'PRIVATE_CONTRACT',
                            payout_amount: share.payout_amount,
                            budget_total: share.budget_total,
                            platform_fee_percent: PRIVATE_PLATFORM_FEE_PERCENT,
                            advertiser_wallet_mode: 'CAMPAIGN_ONLY',
                            impression_target: share.impression_target,
                            media_url: resolvedMediaUrl,
                            terms_keep_hours: resolvedTermsKeepHours,
                        });
                    }
                }
                return withCampaignMediaUrls({
                    ...updatedRoot,
                    campaign_bundle_id: bundleId,
                    bundle_root_campaign_id: getEscrowCampaignId(editable.root),
                    beneficiary_count: beneficiaryContacts.length,
                    platform_fee_percent: platformFeePercent,
                    distributable_budget: distributableBudget,
                    estimated_minimum_users: estimatedAllocationCount,
                    estimated_allocations: estimatedAllocationCount,
                    per_allocation_target: perAllocationTarget,
                    status_summary: await buildCampaignStatusSummary(client, editable.root.id, authUser),
                    ...(bundleId
                        ? { bundle: await loadBundleSummary(client, bundleId, authUser) }
                        : {}),
                });
            });
            if (campaign.error) {
                const error = campaign.error;
                const code = error === 'campaign_not_found'
                    ? 404
                    : error === 'forbidden'
                        ? 403
                        : error === 'campaign_edit_locked'
                            ? 409
                            : error === 'campaign_edit_budget_locked'
                                ? 409
                                : error === 'campaign_edit_root_only'
                                    ? 400
                                    : 409;
                reply.code(code);
                return { error };
            }
            return { campaign };
        }
        catch (error) {
            const message = String(error?.message ?? 'campaign_update_failed');
            const normalizedError = normalizeCampaignMutationError(message);
            reply.code(400);
            return {
                error: normalizedError,
                detail: normalizedError === message ? message : '',
            };
        }
    });
    app.delete('/campaigns/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const authSub = request.user?.sub;
        const authUser = authSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : authSub;
        const role = request.user?.role;
        if (!authUser) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        if (!canAccessAdvertiserFeatures(role)) {
            reply.code(403);
            return { error: 'forbidden' };
        }
        const result = await withTransaction(async (client) => {
            const editable = await loadEditableCampaign(client, params.id, authUser);
            if ('error' in editable) {
                return editable;
            }
            const escrowStatus = String(editable.escrow.status ?? 'PENDING').toUpperCase();
            if (escrowStatus !== 'PENDING') {
                return { error: 'campaign_delete_locked' };
            }
            const campaignIds = [editable.root.id, ...editable.children.map((row) => row.id)];
            const escrowOwnerId = getEscrowCampaignId(editable.root);
            const remainingBundleRoots = editable.bundle_id
                ? editable.bundle_roots.filter((row) => String(row.id) !== String(editable.root.id))
                : [];
            const isBundleOwner = String(editable.root.id) === escrowOwnerId;
            const sessionRes = await client.query(`SELECT id
         FROM verification_sessions
         WHERE campaign_id = ANY($1::uuid[])`, [campaignIds]);
            const sessionIds = sessionRes.rows.map((row) => row.id);
            const proofRes = await client.query(`SELECT id
         FROM proofs
         WHERE session_id = ANY($1::uuid[])`, [sessionIds]);
            const proofIds = proofRes.rows.map((row) => row.id);
            await client.query(`DELETE FROM payout_requests
         WHERE proof_id = ANY($1::uuid[])`, [proofIds]);
            if (!editable.bundle_id || remainingBundleRoots.length === 0) {
                await client.query(`DELETE FROM pesapal_transactions
           WHERE escrow_id IN (
             SELECT id FROM escrow_ledger WHERE campaign_id = $1
           )`, [escrowOwnerId]);
            }
            await client.query(`DELETE FROM proofs
         WHERE id = ANY($1::uuid[]) OR session_id = ANY($2::uuid[])`, [proofIds, sessionIds]);
            await client.query(`DELETE FROM verification_sessions
         WHERE id = ANY($1::uuid[]) OR campaign_id = ANY($2::uuid[])`, [sessionIds, campaignIds]);
            await client.query(`DELETE FROM contracts
         WHERE campaign_id = ANY($1::uuid[])`, [campaignIds]);
            if (editable.bundle_id && remainingBundleRoots.length > 0) {
                const nextEscrowTotal = Math.max(0, Number(editable.escrow.amount_total ?? 0) - Number(editable.root.budget_total ?? 0));
                if (isBundleOwner) {
                    const nextOwnerId = String(remainingBundleRoots[0].id);
                    await client.query(`
            UPDATE escrow_ledger
            SET campaign_id=$2,
                amount_total=$3,
                amount_available=$3
            WHERE id=$1
            `, [editable.escrow.id, nextOwnerId, nextEscrowTotal]);
                    await client.query(`
            UPDATE campaigns
            SET bundle_root_campaign_id=$2
            WHERE campaign_bundle_id=$1
            `, [editable.bundle_id, nextOwnerId]);
                }
                else {
                    await client.query(`
            UPDATE escrow_ledger
            SET amount_total=$2,
                amount_available=$2
            WHERE id=$1
            `, [editable.escrow.id, nextEscrowTotal]);
                }
            }
            else {
                await client.query(`DELETE FROM escrow_ledger
           WHERE campaign_id = $1`, [escrowOwnerId]);
            }
            await client.query(`DELETE FROM campaigns
         WHERE id = ANY($1::uuid[])`, [campaignIds]);
            return {
                deleted: true,
                campaign_id: editable.root.id,
                ...(editable.bundle_id && remainingBundleRoots.length > 0
                    ? { bundle: await loadBundleSummary(client, editable.bundle_id, authUser) }
                    : {}),
            };
        });
        if (result.error) {
            const error = result.error;
            const code = error === 'campaign_not_found'
                ? 404
                : error === 'forbidden'
                    ? 403
                    : error === 'campaign_edit_root_only'
                        ? 400
                        : 409;
            reply.code(code);
            return { error };
        }
        return result;
    });
    app.post('/campaign-bundles/:id/fund', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const body = FundBundleSchema.parse(request.body);
        const fundSource = (body.fund_source ?? 'FLUTTERWAVE') === 'PESAPAL'
            ? 'FLUTTERWAVE'
            : (body.fund_source ?? 'FLUTTERWAVE');
        const browserOrigin = getBrowserOrigin(request);
        const webReturnUrl = resolveWebRedirectUrl(body.return_url, browserOrigin, '/payment/success');
        const webCancelUrl = resolveWebRedirectUrl(body.cancel_url, browserOrigin, '/payment/cancel');
        const callbackUrl = buildPaymentCallbackUrl(request, '/payments/return', webReturnUrl);
        const cancellationUrl = buildPaymentCallbackUrl(request, '/payments/cancel', webCancelUrl);
        if (!webReturnUrl || !webCancelUrl || !callbackUrl || !cancellationUrl) {
            reply.code(400);
            return { error: 'payment_redirect_urls_invalid' };
        }
        const result = await withTransaction(async (client) => {
            const authSub = request.user?.sub;
            const authUser = authSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : authSub;
            const role = request.user?.role;
            if (!authUser) {
                reply.code(401);
                return { error: 'unauthorized' };
            }
            if (!canAccessAdvertiserFeatures(role)) {
                reply.code(403);
                return { error: 'forbidden' };
            }
            const userEmailRes = await client.query('SELECT email, phone, preferred_currency, country FROM users WHERE id=$1', [authUser]);
            const userEmail = userEmailRes.rows?.[0]?.email;
            const userPhone = userEmailRes.rows?.[0]?.phone;
            const userCountry = userEmailRes.rows?.[0]?.country;
            const preferredCurrency = userEmailRes.rows?.[0]?.preferred_currency;
            if (fundSource === 'FLUTTERWAVE' && !userEmail) {
                reply.code(400);
                return { error: 'user_email_missing' };
            }
            const firstName = (userEmail ?? 'user@example.com').split('@')[0] ?? 'User';
            const loadedBundle = await loadBundleForAdvertiser(client, params.id, authUser, role);
            if ('error' in loadedBundle) {
                reply.code(loadedBundle.error === 'campaign_bundle_not_found' ||
                    loadedBundle.error === 'campaign_not_found'
                    ? 404
                    : loadedBundle.error === 'forbidden'
                        ? 403
                        : 400);
                return loadedBundle;
            }
            const { bundle, ownerCampaign } = loadedBundle;
            const escrow = await paymentRepo.getEscrowByCampaign(client, bundle.bundle_root_campaign_id);
            if (!escrow) {
                reply.code(404);
                return { error: 'escrow_not_found' };
            }
            if (body.amount !== escrow.amount_total) {
                reply.code(400);
                return { error: 'amount_mismatch' };
            }
            if (fundSource === 'WALLET') {
                const wallet = await ensureWalletForUser(client, authUser, preferredCurrency);
                const lockedWalletRes = await client.query('SELECT * FROM wallets WHERE id=$1 FOR UPDATE', [wallet.id]);
                const lockedWallet = lockedWalletRes.rows[0];
                const balanceAvailable = Number(lockedWallet?.balance_available ?? 0);
                if (!lockedWallet || balanceAvailable < body.amount) {
                    reply.code(400);
                    return { error: 'insufficient_wallet_balance' };
                }
                const reference = `ESCROW_FUND:BUNDLE:${bundle.bundle_id}`;
                await client.query(`
          UPDATE wallets
          SET balance_available = balance_available - $2,
              balance = GREATEST(balance - $2, 0)
          WHERE id=$1
          `, [wallet.id, body.amount]);
                await client.query(`
          INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
          VALUES ($1,$2,'DEBIT',$3)
          `, [wallet.id, body.amount, reference]);
                await client.query(`
          UPDATE escrow_ledger
          SET status='FUNDED'
          WHERE id=$1
          `, [escrow.id]);
                return {
                    fund_source: fundSource,
                    funded: true,
                    bundle,
                    owner_campaign: ownerCampaign,
                    wallet_reference: reference,
                };
            }
            if (!hasYoClientCredentials()) {
                reply.code(503);
                return { error: 'yo_uganda_not_configured' };
            }
            const checkoutProfile = resolveAvailableYoUgandaCheckoutProfile(userCountry, { cardEnabled: hasYoEncryptionKey() });
            const paymentCurrency = checkoutProfile.currency;
            const merchantReference = uuid();
            const pesapalTxn = await paymentRepo.createPesaPalTransaction(client, {
                escrow_id: escrow.id,
                type: 'FUNDING',
                amount: body.amount,
                merchant_reference: merchantReference,
                raw_payload: {
                    kind: 'CAMPAIGN_BUNDLE_FUNDING',
                    bundle_id: bundle.bundle_id,
                    bundle_root_campaign_id: bundle.bundle_root_campaign_id,
                    country: checkoutProfile.country,
                    payment_currency: paymentCurrency,
                    return_url: callbackUrl,
                    cancel_url: cancellationUrl,
                },
            });
            const checkoutMeta = {
                merchant_reference: merchantReference,
                kind: 'CAMPAIGN_BUNDLE_FUNDING',
                bundle_id: bundle.bundle_id,
                bundle_root_campaign_id: bundle.bundle_root_campaign_id,
                country: checkoutProfile.country,
                payment_currency: paymentCurrency,
                return_url: callbackUrl,
                cancel_url: cancellationUrl,
            };
            await client.query(`UPDATE pesapal_transactions
         SET raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb
         WHERE merchant_reference=$1`, [
                merchantReference,
                JSON.stringify({
                    ...checkoutMeta,
                    payment_options: checkoutProfile.paymentOptions,
                    supported_payment_methods: checkoutProfile.supportedPaymentMethods,
                    mobile_money_networks: checkoutProfile.mobileMoneyNetworks,
                    phone_country_code: checkoutProfile.phoneCountryCode,
                    availability_notes: checkoutProfile.availabilityNotes,
                    customer: {
                        email: userEmail,
                        name: `${firstName} User`.trim(),
                        phone_number: userPhone ?? null,
                    },
                }),
            ]);
            const checkoutPayload = {
                provider: 'YO_UGANDA',
                mode: 'DIRECT_CHARGE',
                tx_ref: merchantReference,
                amount: body.amount,
                currency: paymentCurrency,
                payment_options: checkoutProfile.paymentOptions,
                supported_payment_methods: checkoutProfile.supportedPaymentMethods,
                mobile_money_networks: checkoutProfile.mobileMoneyNetworks,
                phone_country_code: checkoutProfile.phoneCountryCode,
                availability_notes: checkoutProfile.availabilityNotes,
                country: checkoutProfile.country,
                redirect_url: callbackUrl,
                customer: {
                    email: userEmail,
                    name: `${firstName} User`.trim(),
                    phone_number: userPhone ?? null,
                },
                meta: checkoutMeta,
            };
            return {
                fund_source: fundSource,
                funded: false,
                bundle,
                owner_campaign: ownerCampaign,
                checkout_payload: checkoutPayload,
                pesapalTxn,
            };
        });
        if (result?.error) {
            return result;
        }
        if (result?.funded) {
            return result;
        }
        const { checkout_payload: checkoutPayload, pesapalTxn, bundle, owner_campaign: ownerCampaign, } = result;
        return {
            checkout_payload: checkoutPayload,
            yo_uganda_txn: pesapalTxn,
            fund_source: fundSource,
            funded: false,
            bundle,
            owner_campaign: ownerCampaign,
        };
    });
    app.post('/campaigns/:id/fund', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const body = FundCampaignSchema.parse({
            campaign_id: params.id,
            ...request.body,
        });
        const fundSource = (body.fund_source ?? 'FLUTTERWAVE') === 'PESAPAL'
            ? 'FLUTTERWAVE'
            : (body.fund_source ?? 'FLUTTERWAVE');
        const browserOrigin = getBrowserOrigin(request);
        const webReturnUrl = resolveWebRedirectUrl(body.return_url, browserOrigin, '/payment/success');
        const webCancelUrl = resolveWebRedirectUrl(body.cancel_url, browserOrigin, '/payment/cancel');
        const callbackUrl = buildPaymentCallbackUrl(request, '/payments/return', webReturnUrl);
        const cancellationUrl = buildPaymentCallbackUrl(request, '/payments/cancel', webCancelUrl);
        if (!webReturnUrl || !webCancelUrl || !callbackUrl || !cancellationUrl) {
            reply.code(400);
            return { error: 'payment_redirect_urls_invalid' };
        }
        const result = await withTransaction(async (client) => {
            const authSub = request.user?.sub;
            const authUser = authSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : authSub;
            const role = request.user?.role;
            const userEmailRes = authUser
                ? await client.query('SELECT email, phone, preferred_currency, country FROM users WHERE id=$1', [authUser])
                : null;
            const userEmail = userEmailRes?.rows?.[0]?.email;
            const userPhone = userEmailRes?.rows?.[0]?.phone;
            const userCountry = userEmailRes?.rows?.[0]?.country;
            const preferredCurrency = userEmailRes?.rows?.[0]?.preferred_currency;
            if (fundSource === 'FLUTTERWAVE' && !userEmail) {
                reply.code(400);
                return { error: 'user_email_missing' };
            }
            const firstName = (userEmail ?? 'user@example.com').split('@')[0] ?? 'User';
            const campaign = await campaignRepo.getCampaign(client, params.id);
            if (!campaign) {
                reply.code(404);
                return { error: 'campaign_not_found' };
            }
            if (campaign.advertiser_id !== authUser && role !== 'ADMIN') {
                reply.code(403);
                return { error: 'not_campaign_advertiser' };
            }
            const bundleId = getCampaignBundleId(campaign);
            const escrowOwnerId = getEscrowCampaignId(campaign);
            const escrow = await paymentRepo.getEscrowByCampaign(client, escrowOwnerId);
            if (!escrow) {
                reply.code(404);
                return { error: 'escrow_not_found' };
            }
            if (body.amount !== escrow.amount_total) {
                reply.code(400);
                return { error: 'amount_mismatch' };
            }
            if (fundSource === 'WALLET') {
                const wallet = await ensureWalletForUser(client, authUser, preferredCurrency);
                const lockedWalletRes = await client.query('SELECT * FROM wallets WHERE id=$1 FOR UPDATE', [wallet.id]);
                const lockedWallet = lockedWalletRes.rows[0];
                const balanceAvailable = Number(lockedWallet?.balance_available ?? 0);
                if (!lockedWallet || balanceAvailable < body.amount) {
                    reply.code(400);
                    return { error: 'insufficient_wallet_balance' };
                }
                const reference = bundleId
                    ? `ESCROW_FUND:BUNDLE:${bundleId}`
                    : `ESCROW_FUND:${escrowOwnerId}`;
                await client.query(`
          UPDATE wallets
          SET balance_available = balance_available - $2,
              balance = GREATEST(balance - $2, 0)
          WHERE id=$1
          `, [wallet.id, body.amount]);
                await client.query(`
          INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
          VALUES ($1,$2,'DEBIT',$3)
          `, [wallet.id, body.amount, reference]);
                await client.query(`
          UPDATE escrow_ledger
          SET status='FUNDED'
          WHERE id=$1
          `, [escrow.id]);
                return {
                    fund_source: fundSource,
                    funded: true,
                    campaign,
                    wallet_reference: reference,
                };
            }
            if (!hasYoClientCredentials()) {
                reply.code(503);
                return { error: 'yo_uganda_not_configured' };
            }
            const checkoutProfile = resolveAvailableYoUgandaCheckoutProfile(userCountry, { cardEnabled: hasYoEncryptionKey() });
            const paymentCurrency = checkoutProfile.currency;
            const merchantReference = uuid();
            const pesapalTxn = await paymentRepo.createPesaPalTransaction(client, {
                escrow_id: escrow.id,
                type: 'FUNDING',
                amount: body.amount,
                merchant_reference: merchantReference,
                raw_payload: {
                    kind: 'CAMPAIGN_FUNDING',
                    campaign_id: campaign.id,
                    ...(bundleId ? { bundle_id: bundleId, bundle_root_campaign_id: escrowOwnerId } : {}),
                    country: checkoutProfile.country,
                    payment_currency: paymentCurrency,
                    return_url: callbackUrl,
                    cancel_url: cancellationUrl,
                },
            });
            const checkoutMeta = {
                merchant_reference: merchantReference,
                kind: 'CAMPAIGN_FUNDING',
                campaign_id: campaign.id,
                ...(bundleId ? { bundle_id: bundleId, bundle_root_campaign_id: escrowOwnerId } : {}),
                country: checkoutProfile.country,
                payment_currency: paymentCurrency,
                return_url: callbackUrl,
                cancel_url: cancellationUrl,
            };
            await client.query(`UPDATE pesapal_transactions
         SET raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb
         WHERE merchant_reference=$1`, [
                merchantReference,
                JSON.stringify({
                    ...checkoutMeta,
                    payment_options: checkoutProfile.paymentOptions,
                    supported_payment_methods: checkoutProfile.supportedPaymentMethods,
                    mobile_money_networks: checkoutProfile.mobileMoneyNetworks,
                    phone_country_code: checkoutProfile.phoneCountryCode,
                    availability_notes: checkoutProfile.availabilityNotes,
                    customer: {
                        email: userEmail,
                        name: `${firstName} User`.trim(),
                        phone_number: userPhone ?? null,
                    },
                }),
            ]);
            const checkoutPayload = {
                provider: 'YO_UGANDA',
                mode: 'DIRECT_CHARGE',
                tx_ref: merchantReference,
                amount: body.amount,
                currency: paymentCurrency,
                payment_options: checkoutProfile.paymentOptions,
                supported_payment_methods: checkoutProfile.supportedPaymentMethods,
                mobile_money_networks: checkoutProfile.mobileMoneyNetworks,
                phone_country_code: checkoutProfile.phoneCountryCode,
                availability_notes: checkoutProfile.availabilityNotes,
                country: checkoutProfile.country,
                redirect_url: callbackUrl,
                customer: {
                    email: userEmail,
                    name: `${firstName} User`.trim(),
                    phone_number: userPhone ?? null,
                },
                meta: checkoutMeta,
            };
            return { fund_source: fundSource, checkout_payload: checkoutPayload, pesapalTxn };
        });
        if (result?.error) {
            return result;
        }
        if (result?.funded) {
            return result;
        }
        const { checkout_payload: checkoutPayload, pesapalTxn } = result;
        return {
            checkout_payload: checkoutPayload,
            yo_uganda_txn: pesapalTxn,
            fund_source: fundSource,
            funded: false,
        };
    });
    app.post('/campaigns/:id/accept', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const body = AcceptContractSchema.parse({ campaign_id: params.id });
        const authSub = request.user?.sub;
        const authUser = authSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : authSub;
        const role = request.user?.role;
        if (!authUser) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        if (!canAccessDistributorFeatures(role)) {
            reply.code(403);
            return { error: 'forbidden' };
        }
        const result = await withTransaction(async (client) => {
            const restriction = await getUserAccountRestriction(client, authUser, 'distributor');
            if (restriction) {
                return restriction;
            }
            const campaign = await campaignRepo.getCampaign(client, body.campaign_id);
            if (!campaign)
                return { error: 'campaign_not_found' };
            if (campaign.status !== 'ACTIVE')
                return { error: 'campaign_not_active' };
            if (campaign.execution_mode === 'OPEN_BUDGET' && !campaign.parent_campaign_id) {
                return { error: 'open_campaign_allocation_required' };
            }
            if (campaign.advertiser_id === authUser) {
                return { error: 'self_contract_forbidden' };
            }
            if (campaign.visibility === 'PRIVATE' &&
                campaign.assigned_distributor_id !== authUser &&
                role !== 'ADMIN') {
                return { error: 'forbidden' };
            }
            const fundingConfirmed = await hasConfirmedEscrowFunding(client, body.campaign_id);
            if (!fundingConfirmed) {
                return { error: 'campaign_not_funded' };
            }
            const userRes = await client.query('SELECT can_multi_contract FROM users WHERE id=$1', [authUser]);
            const user = userRes.rows[0];
            if (!user)
                return { error: 'user_not_found' };
            if (!user.can_multi_contract) {
                const activeCountRes = await client.query(`SELECT COUNT(*)::int AS count
           FROM contracts
           WHERE distributor_id=$1
             AND status='ACTIVE'`, [authUser]);
                const activeCount = activeCountRes.rows[0]?.count ?? 0;
                if (activeCount > 0) {
                    return { error: 'distributor_active_contract_exists' };
                }
            }
            const activeCampaignContractRes = await client.query(`SELECT id
         FROM contracts
         WHERE campaign_id=$1
           AND status='ACTIVE'
         LIMIT 1`, [body.campaign_id]);
            if (activeCampaignContractRes.rows[0]) {
                return { error: 'campaign_already_claimed' };
            }
            const allocatedViews = Math.max(1, Number(campaign.impression_target ?? 0));
            const contractRes = await client.query(`INSERT INTO contracts (
          campaign_id,
          distributor_id,
          status,
          accepted_at,
          post_deadline_at,
          contract_deadline_at
        )
        SELECT
          $1,
          $2,
          'ACTIVE',
          now(),
          now() + interval '1 hour',
          now() + (($3::int * 60 + 60)::text || ' minutes')::interval
        WHERE NOT EXISTS (
          SELECT 1 FROM contracts WHERE campaign_id=$1 AND status='ACTIVE'
        )
        RETURNING *`, [body.campaign_id, authUser, Number(campaign.terms_keep_hours ?? 12)]);
            if (!contractRes.rows[0]) {
                return { error: 'campaign_already_claimed' };
            }
            return {
                contract: {
                    ...contractRes.rows[0],
                    allocated_views: allocatedViews,
                    allocated_value: Number(campaign.payout_amount ??
                        allocatedViews * getPublicContractUnitRate(campaign.media_type)),
                },
                campaign: {
                    ...campaign,
                    allocated_views: allocatedViews,
                    status_summary: await buildCampaignStatusSummary(client, campaign.id, authUser),
                },
            };
        });
        if (result?.error === 'account_restricted') {
            reply.code(403);
            return result;
        }
        if (result.error) {
            const error = result.error;
            const code = error === 'campaign_not_found'
                ? 404
                : error === 'open_campaign_allocation_required'
                    ? 409
                    : error === 'forbidden' || error === 'self_contract_forbidden'
                        ? 403
                        : 409;
            reply.code(code);
            return { error };
        }
        return result;
    });
    app.post('/contracts/:id/cancel', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const authSub = request.user?.sub;
        const authUser = authSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : authSub;
        const role = request.user?.role;
        if (!authUser) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        const result = await withTransaction(async (client) => {
            const contractAccess = await getContractForAdvertiserAction(client, params.id, authUser, role);
            if ('error' in contractAccess)
                return contractAccess;
            const contract = contractAccess.contract;
            const canManage = contract.distributor_id === authUser ||
                contract.advertiser_id === authUser ||
                role === 'ADMIN';
            if (!canManage)
                return { error: 'forbidden' };
            if (contract.status !== 'ACTIVE')
                return { error: 'contract_not_active' };
            const updated = await client.query(`UPDATE contracts
         SET status='CANCELLED', cancelled_at=now()
         WHERE id=$1
         RETURNING *`, [params.id]);
            await client.query(`UPDATE campaigns
         SET last_allocated_at = CASE
               WHEN execution_mode='OPEN_BUDGET'
               THEN now() - interval '2 hours'
               ELSE last_allocated_at
             END
         WHERE id=$1`, [contract.campaign_id]);
            await client.query(`UPDATE campaigns
         SET status='CANCELLED'
         WHERE id=$1
           AND execution_mode='PRIVATE_CONTRACT'
           AND visibility='PRIVATE'`, [contract.campaign_id]);
            let walletRefundedAmount = 0;
            if (contract.parent_campaign_id) {
                const escrowRes = await client.query('SELECT * FROM escrow_ledger WHERE campaign_id=$1 LIMIT 1', [contract.escrow_campaign_id]);
                const escrow = escrowRes.rows[0];
                if (escrow) {
                    const refund = await refundEscrowAmountToAdvertiser(client, escrow.id, contract.advertiser_id, Number(contract.budget_total ?? 0), `ESCROW_RETURN:CONTRACT_CANCEL:${contract.id}`);
                    walletRefundedAmount = refund.refunded_amount;
                }
            }
            return {
                ...updated.rows[0],
                wallet_refunded_amount: walletRefundedAmount,
            };
        });
        if (!result) {
            reply.code(404);
            return { error: 'contract_not_found' };
        }
        if (result.error) {
            reply.code(result.error === 'forbidden' ? 403 : 400);
            return result;
        }
        return { contract: result };
    });
    app.post('/contracts/:id/complete', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const authSub = request.user?.sub;
        const authUser = authSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : authSub;
        const role = request.user?.role;
        if (!authUser) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        const result = await withTransaction(async (client) => {
            const contractAccess = await getContractForAdvertiserAction(client, params.id, authUser, role);
            if ('error' in contractAccess)
                return contractAccess;
            const accessContract = contractAccess.contract;
            const readiness = accessContract.distributor_id === authUser
                ? await getContractCompletionReadiness(client, params.id, authUser)
                : accessContract.advertiser_id === authUser || role === 'ADMIN'
                    ? await (async () => {
                        if (accessContract.status !== 'ACTIVE') {
                            return { error: 'contract_not_active' };
                        }
                        const escrowRes = await client.query(`
                    SELECT status
                    FROM escrow_ledger
                    WHERE campaign_id=$1
                    LIMIT 1
                    `, [accessContract.escrow_campaign_id]);
                        const escrow = escrowRes.rows[0];
                        if (!escrow ||
                            !isConfirmedEscrowFundingStatus(escrow.status) ||
                            !(await hasConfirmedEscrowFunding(client, accessContract.campaign_id))) {
                            return { error: 'campaign_not_funded' };
                        }
                        const proofRes = await client.query(`
                    SELECT p.id
                    FROM proofs p
                    JOIN verification_sessions s ON s.id = p.session_id
                    WHERE s.campaign_id=$1
                      AND p.user_id=$2
                      AND p.status='VERIFIED'
                      AND p.decision='VERIFIED'
                    ORDER BY p.created_at DESC
                    LIMIT 1
                    `, [accessContract.campaign_id, accessContract.distributor_id]);
                        if (!proofRes.rows[0]) {
                            return { error: 'verified_proof_required' };
                        }
                        return { contract: accessContract };
                    })()
                    : { error: 'forbidden' };
            if ('error' in readiness)
                return readiness;
            const contract = readiness.contract;
            const updated = await client.query(`UPDATE contracts
         SET status='COMPLETED', completed_at=now()
         WHERE id=$1 AND status='ACTIVE'
         RETURNING *`, [params.id]);
            await client.query(`UPDATE campaigns
         SET status='COMPLETED'
         WHERE id=$1
           AND execution_mode='PRIVATE_CONTRACT'
           AND visibility='PRIVATE'`, [contract.campaign_id]);
            if (!updated.rows[0])
                return { error: 'contract_not_active' };
            await recordCampaignRevenueEntry(client, contract.campaign_id);
            return { contract: updated.rows[0], campaign_platform: contract.platform, campaign_id: contract.campaign_id };
        });
        if (!result) {
            reply.code(404);
            return { error: 'contract_not_found' };
        }
        if (result.error) {
            const error = result.error;
            const code = error === 'forbidden'
                ? 403
                : error === 'contract_not_found'
                    ? 404
                    : error === 'campaign_not_funded' || error === 'verified_proof_required'
                        ? 409
                        : 400;
            reply.code(code);
            return result;
        }
        return result;
    });
    app.post('/campaigns/:id/cancel', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const authSub = request.user?.sub;
        const authUser = authSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : authSub;
        const role = request.user?.role;
        if (!authUser) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        if (!canAccessAdvertiserFeatures(role)) {
            reply.code(403);
            return { error: 'forbidden' };
        }
        const result = await withTransaction(async (client) => {
            const campaign = await campaignRepo.getCampaign(client, params.id);
            if (!campaign)
                return { error: 'campaign_not_found' };
            if (campaign.advertiser_id !== authUser && role !== 'ADMIN') {
                return { error: 'forbidden' };
            }
            const scopeId = campaign.parent_campaign_id ?? campaign.id;
            const scopeRes = await client.query('SELECT id FROM campaigns WHERE id=$1 OR parent_campaign_id=$1', [scopeId]);
            const campaignIds = scopeRes.rows.map((row) => row.id);
            await client.query(`UPDATE contracts
         SET status='CANCELLED',
             cancelled_at=COALESCE(cancelled_at, now())
         WHERE campaign_id = ANY($1::uuid[])
           AND status='ACTIVE'`, [campaignIds]);
            await client.query(`UPDATE campaigns
         SET status='CANCELLED'
         WHERE id = ANY($1::uuid[])`, [campaignIds]);
            const escrowRes = await client.query('SELECT * FROM escrow_ledger WHERE campaign_id=$1 LIMIT 1', [scopeId]);
            const escrow = escrowRes.rows[0];
            let walletRefundedAmount = 0;
            if (escrow) {
                const refund = await refundEscrowAmountToAdvertiser(client, escrow.id, campaign.advertiser_id, Number(escrow.amount_available ?? 0), `ESCROW_RETURN:CAMPAIGN_CANCEL:${scopeId}`);
                walletRefundedAmount = refund.refunded_amount;
            }
            const refreshed = await campaignRepo.getCampaign(client, scopeId);
            return {
                ...refreshed,
                wallet_refunded_amount: walletRefundedAmount,
                status_summary: await buildCampaignStatusSummary(client, scopeId, authUser),
            };
        });
        if ('error' in result) {
            reply.code(result.error === 'campaign_not_found' ? 404 : 403);
            return result;
        }
        return { campaign: result };
    });
}
