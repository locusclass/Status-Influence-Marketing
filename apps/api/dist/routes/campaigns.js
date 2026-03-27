import { CreateCampaignSchema, FundCampaignSchema, getCampaignBurstMode, isCreatorPlatform, normalizeExecutionMeta, resolveDeliveryModel, } from '@prime/shared';
import { z } from 'zod';
import { withTransaction } from '../db.js';
import { CampaignRepo } from '../repositories/campaignRepo.js';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import { v4 as uuid } from 'uuid';
import { config, hasValidFlutterwaveKeys } from '../config.js';
import { createHostedPayment } from '../services/flutterwave.js';
import { ensurePublicIdColumns } from '../services/publicId.js';
import { canAccessAdvertiserFeatures, canAccessDistributorFeatures, normalizeActiveRole, } from '../services/roles.js';
const PRIVATE_RATE_UGX = 25;
const OPEN_RATE_UGX = 10;
const PRIVATE_PLATFORM_FEE_PERCENT = 15;
const OPEN_PLATFORM_FEE_PERCENT = 25;
function normalizePhone(input) {
    return input.replace(/[^\d+]/g, '').trim();
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
async function loadEditableCampaign(client, campaignId, advertiserId) {
    const root = await new CampaignRepo().getCampaign(client, campaignId);
    if (!root)
        return { error: 'campaign_not_found' };
    if (root.advertiser_id !== advertiserId)
        return { error: 'forbidden' };
    if (root.parent_campaign_id)
        return { error: 'campaign_edit_root_only' };
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
    const escrowRes = await client.query('SELECT * FROM escrow_ledger WHERE campaign_id=$1 LIMIT 1', [root.id]);
    const escrow = escrowRes.rows[0] ?? null;
    if (!escrow)
        return { error: 'escrow_not_found' };
    return { root, children, escrow };
}
function deriveCampaignBudget(platform, executionMode, budgetTotal, payoutAmount, requestedMetricTarget) {
    const platformFeePercent = executionMode === 'OPEN_BUDGET'
        ? OPEN_PLATFORM_FEE_PERCENT
        : PRIVATE_PLATFORM_FEE_PERCENT;
    const distributableBudget = Math.floor(budgetTotal * ((100 - platformFeePercent) / 100));
    if (isCreatorPlatform(platform) && executionMode === 'OPEN_BUDGET') {
        const normalizedPayout = Math.max(1, Number(payoutAmount ?? 0));
        const impressionTarget = Math.max(1, Math.round(Number(requestedMetricTarget ?? 1)));
        const estimatedAllocationCount = Math.floor(distributableBudget / normalizedPayout);
        if (estimatedAllocationCount < 1) {
            throw new Error('creator_budget_insufficient');
        }
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
        ? OPEN_RATE_UGX
        : Math.max(1, Number(payoutAmount ?? distributableBudget));
    const impressionTarget = executionMode === 'OPEN_BUDGET'
        ? Math.max(1, Math.floor(distributableBudget / OPEN_RATE_UGX))
        : Math.max(1, Math.floor(distributableBudget / PRIVATE_RATE_UGX));
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
async function resolvePrivateDistributorShares(client, beneficiaryContacts, requestedViewerTarget, rootBudgetTotal, distributableBudget) {
    const distributors = [];
    let remainingViewers = requestedViewerTarget;
    for (const phone of beneficiaryContacts) {
        const distributor = await findDistributorByPhone(client, phone);
        if (!distributor) {
            throw new Error(`beneficiary_not_found:${phone}`);
        }
        const capacity = Math.max(0, Number(distributor.max_status_viewers_12h ?? 0));
        if (capacity <= 0) {
            throw new Error(`beneficiary_capacity_not_set:${phone}`);
        }
        const allocatedViews = Math.min(capacity, remainingViewers);
        if (allocatedViews > 0) {
            distributors.push({
                distributor,
                allocated_views: allocatedViews,
            });
            remainingViewers -= allocatedViews;
        }
        if (remainingViewers <= 0) {
            break;
        }
    }
    if (remainingViewers > 0) {
        throw new Error(`beneficiary_capacity_insufficient:${remainingViewers}`);
    }
    const weights = distributors.map((entry) => entry.allocated_views);
    const payoutShares = distributeIntegerTotal(distributableBudget, weights);
    const budgetShares = distributeIntegerTotal(rootBudgetTotal, weights);
    return distributors.map((entry, index) => ({
        distributor: entry.distributor,
        allocated_views: entry.allocated_views,
        payout_amount: Math.max(1, payoutShares[index] ?? 0),
        budget_total: Math.max(1, budgetShares[index] ?? 0),
    }));
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
        c.id AS campaign_id,
        COALESCE(c.parent_campaign_id, c.id) AS escrow_campaign_id,
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
    `, [campaignIds, userId ?? null]);
    const result = new Map();
    for (const row of statusRes.rows) {
        const campaignStatus = String(row.campaign_status ?? 'ACTIVE');
        const escrowStatus = String(row.escrow_status ?? 'PENDING');
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
            is_available: campaignStatus === 'ACTIVE' &&
                escrowStatus !== 'PENDING' &&
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
      COALESCE(c.parent_campaign_id, c.id) AS escrow_campaign_id
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
    if (!escrow || !['FUNDED', 'PARTIALLY_DISBURSED', 'COMPLETED'].includes(String(escrow.status))) {
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
      COALESCE(c.parent_campaign_id, c.id) AS escrow_campaign_id
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
    });
    const campaignRepo = new CampaignRepo();
    const paymentRepo = new PaymentRepo();
    const AcceptContractSchema = z.object({
        campaign_id: z.string().trim().min(3),
    });
    const UpdateCampaignSchema = CreateCampaignSchema;
    const LookupDistributorSchema = z.object({
        phone: z.string().trim().min(7).max(20),
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
            return findDistributorByPhone(client, parsed.data.phone);
        });
        if (!distributor) {
            reply.code(404);
            return { error: 'distributor_not_found' };
        }
        return { distributor };
    });
    app.get('/campaigns', { preHandler: [app.authenticate] }, async (request) => {
        const authUser = request.user?.sub;
        const role = normalizeActiveRole(request.user?.active_role, request.user?.role);
        const query = (request.query ?? {});
        const limitRaw = Number(query.limit ?? 50);
        const offsetRaw = Number(query.offset ?? 0);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
        const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
        const campaigns = await withTransaction(async (client) => {
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
            ON e.campaign_id = COALESCE(c2.parent_campaign_id, c2.id)
          WHERE e.status IN ('FUNDED', 'PARTIALLY_DISBURSED', 'COMPLETED')
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
                    is_available: false,
                },
            }));
            return campaignsWithStatus;
        });
        return { campaigns };
    });
    app.get('/campaigns/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const authUser = request.user?.sub;
        const campaign = await withTransaction(async (client) => {
            const found = await campaignRepo.getCampaign(client, params.id);
            if (!found)
                return null;
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
                   COALESCE(u.max_status_viewers_12h, 0)::int AS max_status_viewers_12h
                 FROM campaigns
                 c
                 LEFT JOIN users u ON u.id = c.assigned_distributor_id
                 WHERE c.parent_campaign_id=$1
                 ORDER BY created_at ASC`, [found.id])).rows
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
                ...found,
                beneficiaries,
                managed_contracts: managedContracts,
                active_contract: activeContractRow,
                my_active_contract: authUser
                    ? activeContract.rows.find((row) => row.distributor_id === authUser) ?? null
                    : null,
                status_summary: await buildCampaignStatusSummary(client, found.id, authUser ?? null),
            };
        });
        if (!campaign) {
            reply.code(404);
            return { error: 'campaign_not_found' };
        }
        return { campaign };
    });
    app.get('/campaigns/:id/proofs', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const authUser = request.user?.sub;
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
        const authUser = request.user?.sub;
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
        const body = CreateCampaignSchema.parse(request.body);
        const authUser = request.user?.sub;
        const role = request.user?.role;
        if (!authUser) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        if (!canAccessAdvertiserFeatures(role)) {
            reply.code(403);
            return { error: 'forbidden' };
        }
        let campaign;
        try {
            campaign = await withTransaction(async (client) => {
                const executionMode = resolveExecutionMode(body.platform, body.execution_mode);
                const beneficiaryContacts = normalizeBeneficiaryContacts(body);
                if (executionMode === 'PRIVATE_CONTRACT' && beneficiaryContacts.length === 0) {
                    throw new Error('private_beneficiary_required');
                }
                const { platformFeePercent, visibility, distributableBudget, normalizedPayout: rootPayout, impressionTarget: budgetImpressionTarget, estimatedAllocationCount, perAllocationTarget, } = deriveCampaignBudget(body.platform, executionMode, body.budget_total, body.payout_amount, body.impression_target);
                const requestedViewerTarget = executionMode === 'OPEN_BUDGET'
                    ? budgetImpressionTarget
                    : Number(body.impression_target ?? budgetImpressionTarget);
                if (executionMode === 'PRIVATE_CONTRACT' && requestedViewerTarget > budgetImpressionTarget) {
                    throw new Error('private_target_exceeds_budget');
                }
                const rootBudget = body.budget_total;
                const deliveryModel = resolveDeliveryModel(body.platform, body.delivery_model);
                const executionMeta = buildCampaignExecutionMeta(body.platform, body.execution_meta, isCreatorPlatform(body.platform) && executionMode === 'OPEN_BUDGET'
                    ? {
                        allocation_strategy: 'REPUTATION_BASED',
                        creator_unit_count: estimatedAllocationCount,
                        per_creator_target_metric: perAllocationTarget,
                        target_metric_total: budgetImpressionTarget,
                    }
                    : undefined);
                const campaignBurstMode = getCampaignBurstMode({
                    execution_meta: executionMeta,
                });
                const root = await campaignRepo.createCampaign(client, {
                    ...body,
                    advertiser_id: authUser,
                    delivery_model: deliveryModel,
                    execution_meta: executionMeta,
                    campaign_burst_mode: campaignBurstMode,
                    visibility,
                    execution_mode: executionMode,
                    payout_amount: rootPayout,
                    platform_fee_percent: platformFeePercent,
                    advertiser_wallet_mode: 'CAMPAIGN_ONLY',
                    impression_target: executionMode === 'OPEN_BUDGET'
                        ? budgetImpressionTarget
                        : requestedViewerTarget,
                });
                await paymentRepo.createEscrow(client, root.id, root.budget_total);
                if (executionMode === 'PRIVATE_CONTRACT') {
                    const shares = await resolvePrivateDistributorShares(client, beneficiaryContacts, requestedViewerTarget, rootBudget, distributableBudget);
                    for (const share of shares) {
                        await campaignRepo.createCampaign(client, {
                            ...body,
                            advertiser_id: authUser,
                            delivery_model: deliveryModel,
                            execution_meta: executionMeta,
                            campaign_burst_mode: campaignBurstMode,
                            parent_campaign_id: root.id,
                            assigned_distributor_id: share.distributor.id,
                            assigned_phone: share.distributor.phone,
                            visibility: 'PRIVATE',
                            execution_mode: 'PRIVATE_CONTRACT',
                            payout_amount: share.payout_amount,
                            budget_total: share.budget_total,
                            platform_fee_percent: PRIVATE_PLATFORM_FEE_PERCENT,
                            advertiser_wallet_mode: 'CAMPAIGN_ONLY',
                            impression_target: share.allocated_views,
                        });
                    }
                }
                return {
                    ...root,
                    beneficiary_count: beneficiaryContacts.length,
                    platform_fee_percent: platformFeePercent,
                    distributable_budget: distributableBudget,
                    estimated_minimum_users: estimatedAllocationCount,
                    estimated_allocations: estimatedAllocationCount,
                    per_allocation_target: perAllocationTarget,
                };
            });
        }
        catch (error) {
            const message = String(error?.message ?? 'campaign_create_failed');
            reply.code(400);
            return {
                error: message.startsWith('beneficiary_not_found')
                    ? 'beneficiary_not_found'
                    : message.startsWith('beneficiary_capacity_not_set')
                        ? 'beneficiary_capacity_not_set'
                        : message.startsWith('beneficiary_capacity_insufficient')
                            ? 'beneficiary_capacity_insufficient'
                            : message,
                detail: message,
            };
        }
        return { campaign };
    });
    app.patch('/campaigns/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const body = UpdateCampaignSchema.parse(request.body);
        const authUser = request.user?.sub;
        const role = request.user?.role;
        if (!authUser) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        if (!canAccessAdvertiserFeatures(role)) {
            reply.code(403);
            return { error: 'forbidden' };
        }
        try {
            const campaign = await withTransaction(async (client) => {
                const editable = await loadEditableCampaign(client, params.id, authUser);
                if ('error' in editable) {
                    return editable;
                }
                const executionMode = resolveExecutionMode(body.platform, body.execution_mode);
                const beneficiaryContacts = normalizeBeneficiaryContacts(body);
                if (executionMode === 'PRIVATE_CONTRACT' && beneficiaryContacts.length === 0) {
                    throw new Error('private_beneficiary_required');
                }
                const { platformFeePercent, visibility, distributableBudget, normalizedPayout: rootPayout, impressionTarget: budgetImpressionTarget, estimatedAllocationCount, perAllocationTarget, } = deriveCampaignBudget(body.platform, executionMode, body.budget_total, body.payout_amount, body.impression_target);
                const requestedViewerTarget = executionMode === 'OPEN_BUDGET'
                    ? budgetImpressionTarget
                    : Number(body.impression_target ?? budgetImpressionTarget);
                if (executionMode === 'PRIVATE_CONTRACT' && requestedViewerTarget > budgetImpressionTarget) {
                    throw new Error('private_target_exceeds_budget');
                }
                const escrowStatus = String(editable.escrow.status ?? 'PENDING').toUpperCase();
                if (escrowStatus !== 'PENDING' &&
                    Number(editable.escrow.amount_total ?? 0) !== body.budget_total) {
                    return { error: 'campaign_edit_budget_locked' };
                }
                const deliveryModel = resolveDeliveryModel(body.platform, body.delivery_model);
                const executionMeta = buildCampaignExecutionMeta(body.platform, body.execution_meta, isCreatorPlatform(body.platform) && executionMode === 'OPEN_BUDGET'
                    ? {
                        allocation_strategy: 'REPUTATION_BASED',
                        creator_unit_count: estimatedAllocationCount,
                        per_creator_target_metric: perAllocationTarget,
                        target_metric_total: budgetImpressionTarget,
                    }
                    : undefined);
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
                    rootPayout,
                    body.budget_total,
                    executionMode === 'OPEN_BUDGET'
                        ? budgetImpressionTarget
                        : requestedViewerTarget,
                    platformFeePercent,
                    body.media_type,
                    body.media_text ?? null,
                    body.media_url ?? null,
                    executionMetaJson,
                    campaignBurstMode,
                    Number(body.terms_keep_hours ?? editable.root.terms_keep_hours ?? 12),
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
             WHERE id=$1`, [editable.escrow.id, body.budget_total]);
                }
                await client.query('DELETE FROM campaigns WHERE parent_campaign_id=$1', [
                    editable.root.id,
                ]);
                if (executionMode === 'PRIVATE_CONTRACT') {
                    const shares = await resolvePrivateDistributorShares(client, beneficiaryContacts, requestedViewerTarget, body.budget_total, distributableBudget);
                    for (const share of shares) {
                        await campaignRepo.createCampaign(client, {
                            ...body,
                            advertiser_id: authUser,
                            delivery_model: deliveryModel,
                            execution_meta: executionMeta,
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
                            impression_target: share.allocated_views,
                        });
                    }
                }
                return {
                    ...updatedRoot,
                    beneficiary_count: beneficiaryContacts.length,
                    platform_fee_percent: platformFeePercent,
                    distributable_budget: distributableBudget,
                    estimated_minimum_users: estimatedAllocationCount,
                    estimated_allocations: estimatedAllocationCount,
                    per_allocation_target: perAllocationTarget,
                    status_summary: await buildCampaignStatusSummary(client, editable.root.id, authUser),
                };
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
            reply.code(400);
            return {
                error: message.startsWith('beneficiary_not_found')
                    ? 'beneficiary_not_found'
                    : message.startsWith('beneficiary_capacity_not_set')
                        ? 'beneficiary_capacity_not_set'
                        : message.startsWith('beneficiary_capacity_insufficient')
                            ? 'beneficiary_capacity_insufficient'
                            : message,
                detail: message,
            };
        }
    });
    app.delete('/campaigns/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const authUser = request.user?.sub;
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
            await client.query(`DELETE FROM pesapal_transactions
         WHERE escrow_id IN (
           SELECT id FROM escrow_ledger WHERE campaign_id = ANY($1::uuid[])
         )`, [campaignIds]);
            await client.query(`DELETE FROM proofs
         WHERE id = ANY($1::uuid[]) OR session_id = ANY($2::uuid[])`, [proofIds, sessionIds]);
            await client.query(`DELETE FROM verification_sessions
         WHERE id = ANY($1::uuid[]) OR campaign_id = ANY($2::uuid[])`, [sessionIds, campaignIds]);
            await client.query(`DELETE FROM contracts
         WHERE campaign_id = ANY($1::uuid[])`, [campaignIds]);
            await client.query(`DELETE FROM escrow_ledger
         WHERE campaign_id = ANY($1::uuid[])`, [campaignIds]);
            await client.query(`DELETE FROM campaigns
         WHERE id = ANY($1::uuid[])`, [campaignIds]);
            return {
                deleted: true,
                campaign_id: editable.root.id,
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
    app.post('/campaigns/:id/fund', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const body = FundCampaignSchema.parse({
            campaign_id: params.id,
            ...request.body,
        });
        const fundSource = (body.fund_source ?? 'FLUTTERWAVE') === 'PESAPAL'
            ? 'FLUTTERWAVE'
            : (body.fund_source ?? 'FLUTTERWAVE');
        const paymentCurrency = 'UGX';
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
            const authUser = request.user?.sub;
            const role = request.user?.role;
            const userEmailRes = authUser
                ? await client.query('SELECT email, phone, preferred_currency FROM users WHERE id=$1', [authUser])
                : null;
            const userEmail = userEmailRes?.rows?.[0]?.email;
            const userPhone = userEmailRes?.rows?.[0]?.phone;
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
            const escrowOwnerId = campaign.parent_campaign_id ?? campaign.id;
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
                const reference = `ESCROW_FUND:${campaign.id}`;
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
            if (!hasValidFlutterwaveKeys()) {
                reply.code(503);
                return { error: 'flutterwave_not_configured' };
            }
            const merchantReference = uuid();
            const pesapalTxn = await paymentRepo.createPesaPalTransaction(client, {
                escrow_id: escrow.id,
                type: 'FUNDING',
                amount: body.amount,
                merchant_reference: merchantReference,
                raw_payload: {
                    kind: 'CAMPAIGN_FUNDING',
                    campaign_id: campaign.id,
                    return_url: callbackUrl,
                    cancel_url: cancellationUrl,
                    network: body.network ?? 'MTN',
                },
            });
            const checkoutMeta = {
                merchant_reference: merchantReference,
                kind: 'CAMPAIGN_FUNDING',
                campaign_id: campaign.id,
                return_url: callbackUrl,
                cancel_url: cancellationUrl,
                network: body.network ?? 'MTN',
            };
            let hostedCheckout;
            try {
                hostedCheckout = await createHostedPayment({
                    txRef: merchantReference,
                    amount: body.amount,
                    currency: paymentCurrency,
                    redirectUrl: callbackUrl,
                    customer: {
                        email: userEmail,
                        name: `${firstName} User`.trim(),
                        phoneNumber: userPhone ?? undefined,
                    },
                    customizations: {
                        title: 'Prime Checkout',
                        description: `Campaign funding: ${campaign.title}`,
                    },
                    meta: checkoutMeta,
                });
            }
            catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                request.log.error({ error, detail, campaign: campaign.id, tx_ref: merchantReference }, `flutterwave_checkout_failed: ${detail}`);
                reply.code(502);
                return { error: 'flutterwave_checkout_failed', detail };
            }
            if (!hostedCheckout.checkoutUrl) {
                reply.code(502);
                return { error: 'flutterwave_missing_checkout_link' };
            }
            await client.query(`UPDATE pesapal_transactions
         SET raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb
         WHERE merchant_reference=$1`, [
                merchantReference,
                JSON.stringify({
                    ...checkoutMeta,
                    checkout_url: hostedCheckout.checkoutUrl,
                }),
            ]);
            const checkoutPayload = {
                provider: 'FLUTTERWAVE_CHECKOUT',
                checkout_url: hostedCheckout.checkoutUrl,
                tx_ref: merchantReference,
                amount: body.amount,
                currency: paymentCurrency,
                payment_options: 'card,mobilemoneyuganda',
                redirect_url: callbackUrl,
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
            flutterwave_txn: pesapalTxn,
            fund_source: fundSource,
            funded: false,
        };
    });
    app.post('/campaigns/:id/accept', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const body = AcceptContractSchema.parse({ campaign_id: params.id });
        const authUser = request.user?.sub;
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
            const escrowOwnerId = campaign.parent_campaign_id ?? body.campaign_id;
            const escrowRes = await client.query('SELECT * FROM escrow_ledger WHERE campaign_id=$1 LIMIT 1', [escrowOwnerId]);
            const escrow = escrowRes.rows[0];
            if (!escrow || (escrow.status !== 'FUNDED' && escrow.status !== 'PARTIALLY_DISBURSED')) {
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
                    allocated_value: campaign.execution_mode === 'OPEN_BUDGET'
                        ? allocatedViews * OPEN_RATE_UGX
                        : Number(campaign.payout_amount ?? 0),
                },
                campaign: {
                    ...campaign,
                    allocated_views: allocatedViews,
                    status_summary: await buildCampaignStatusSummary(client, campaign.id, authUser),
                },
            };
        });
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
        const authUser = request.user?.sub;
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
        const authUser = request.user?.sub;
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
                            !['FUNDED', 'PARTIALLY_DISBURSED', 'COMPLETED'].includes(String(escrow.status))) {
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
        const authUser = request.user?.sub;
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
