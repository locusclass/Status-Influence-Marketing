import { CreateCampaignSchema, FundCampaignSchema } from '@prime/shared';
import { z } from 'zod';
import { withTransaction } from '../db.js';
import { CampaignRepo } from '../repositories/campaignRepo.js';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import { submitOrder } from '../services/pesapal.js';
import { v4 as uuid } from 'uuid';
import { config } from '../config.js';
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
async function getLatestConfirmedViewers(client, distributorId) {
    const res = await client.query(`
    SELECT COALESCE(p.observed_views, 0)::int AS observed_views
    FROM proofs p
    WHERE p.user_id=$1
      AND p.status='VERIFIED'
      AND p.observed_views IS NOT NULL
    ORDER BY p.created_at DESC
    LIMIT 1
    `, [distributorId]);
    return Number(res.rows[0]?.observed_views ?? 0);
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
async function buildCampaignStatusSummaries(client, campaignIds, userId) {
    if (campaignIds.length === 0) {
        return new Map();
    }
    const statusRes = await client.query(`
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
export async function campaignRoutes(app) {
    await withTransaction(async (client) => {
        await ensureCampaignColumns(client);
    });
    const campaignRepo = new CampaignRepo();
    const paymentRepo = new PaymentRepo();
    const AcceptContractSchema = z.object({
        campaign_id: z.string().trim().min(3),
    });
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
            filters.push(`(c.parent_campaign_id IS NOT NULL OR c.visibility='PUBLIC')`);
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
            return {
                ...found,
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
                p.created_at,
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
        const summary = await withTransaction(async (client) => {
            const campaign = await campaignRepo.getCampaign(client, params.id);
            if (!campaign)
                return { error: 'campaign_not_found' };
            if (campaign.advertiser_id !== authUser)
                return { error: 'not_campaign_advertiser' };
            const campaignIdsRes = await client.query(`SELECT id FROM campaigns WHERE id=$1 OR parent_campaign_id=$1`, [campaign.id]);
            const campaignIds = campaignIdsRes.rows.map((row) => row.id);
            const totalRes = await client.query(`SELECT COUNT(*)::int AS total FROM proofs p
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
           COUNT(*) FILTER (WHERE status='COMPLETED')::int AS successful_contracts
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
        if (summary.error) {
            reply.code(403);
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
                const executionMode = body.execution_mode ?? 'PRIVATE_CONTRACT';
                const beneficiaryContacts = Array.from(new Set([
                    ...(body.beneficiary_contacts ?? []),
                    ...(body.counterparty_contact ? [body.counterparty_contact] : []),
                ]
                    .map((value) => normalizePhone(value))
                    .filter(Boolean)));
                if (executionMode === 'PRIVATE_CONTRACT' && beneficiaryContacts.length === 0) {
                    throw new Error('private_beneficiary_required');
                }
                const platformFeePercent = executionMode === 'OPEN_BUDGET'
                    ? OPEN_PLATFORM_FEE_PERCENT
                    : PRIVATE_PLATFORM_FEE_PERCENT;
                const visibility = executionMode === 'OPEN_BUDGET' ? 'PUBLIC' : 'PRIVATE';
                const rootBudget = body.budget_total;
                const rootPayout = executionMode === 'OPEN_BUDGET' ? OPEN_RATE_UGX : body.payout_amount;
                const distributableBudget = Math.floor(rootBudget * ((100 - platformFeePercent) / 100));
                const impressionTarget = executionMode === 'OPEN_BUDGET'
                    ? Math.max(1, Math.floor(distributableBudget / OPEN_RATE_UGX))
                    : Math.max(1, Math.floor(distributableBudget / PRIVATE_RATE_UGX));
                const root = await campaignRepo.createCampaign(client, {
                    ...body,
                    advertiser_id: authUser,
                    visibility,
                    execution_mode: executionMode,
                    payout_amount: rootPayout,
                    platform_fee_percent: platformFeePercent,
                    advertiser_wallet_mode: 'CAMPAIGN_ONLY',
                    impression_target: executionMode === 'OPEN_BUDGET'
                        ? impressionTarget
                        : body.impression_target ?? impressionTarget,
                });
                await paymentRepo.createEscrow(client, root.id, root.budget_total);
                if (executionMode === 'PRIVATE_CONTRACT') {
                    const splitDistributable = Math.floor(distributableBudget / beneficiaryContacts.length);
                    const splitGrossBudget = Math.floor(rootBudget / beneficiaryContacts.length);
                    const budgetRemainder = rootBudget - splitGrossBudget * beneficiaryContacts.length;
                    const distributableRemainder = distributableBudget - splitDistributable * beneficiaryContacts.length;
                    let beneficiaryIndex = 0;
                    for (const phone of beneficiaryContacts) {
                        const distributor = await findDistributorByPhone(client, phone);
                        if (!distributor) {
                            throw new Error(`beneficiary_not_found:${phone}`);
                        }
                        const grossBudgetShare = splitGrossBudget + (beneficiaryIndex < budgetRemainder ? 1 : 0);
                        const distributableShare = splitDistributable + (beneficiaryIndex < distributableRemainder ? 1 : 0);
                        await campaignRepo.createCampaign(client, {
                            ...body,
                            advertiser_id: authUser,
                            parent_campaign_id: root.id,
                            assigned_distributor_id: distributor.id,
                            assigned_phone: distributor.phone,
                            visibility: 'PRIVATE',
                            execution_mode: 'PRIVATE_CONTRACT',
                            payout_amount: distributableShare,
                            budget_total: grossBudgetShare,
                            platform_fee_percent: PRIVATE_PLATFORM_FEE_PERCENT,
                            advertiser_wallet_mode: 'CAMPAIGN_ONLY',
                            impression_target: Math.max(1, Math.floor(distributableShare / PRIVATE_RATE_UGX)),
                        });
                        beneficiaryIndex += 1;
                    }
                }
                return {
                    ...root,
                    beneficiary_count: beneficiaryContacts.length,
                    platform_fee_percent: platformFeePercent,
                    distributable_budget: distributableBudget,
                    estimated_minimum_users: impressionTarget,
                };
            });
        }
        catch (error) {
            const message = String(error?.message ?? 'campaign_create_failed');
            reply.code(400);
            return {
                error: message.startsWith('beneficiary_not_found')
                    ? 'beneficiary_not_found'
                    : message,
                detail: message,
            };
        }
        return { campaign };
    });
    app.post('/campaigns/:id/fund', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const body = FundCampaignSchema.parse({ campaign_id: params.id, ...request.body });
        const pesapalCurrency = 'UGX';
        const browserOrigin = getBrowserOrigin(request);
        const webReturnUrl = resolveWebRedirectUrl(body.return_url, browserOrigin, '/payment/success');
        const webCancelUrl = resolveWebRedirectUrl(body.cancel_url, browserOrigin, '/payment/cancel');
        const callbackUrl = buildPaymentCallbackUrl(request, '/payments/return', webReturnUrl);
        const cancellationUrl = buildPaymentCallbackUrl(request, '/payments/cancel', webCancelUrl);
        const { order, pesapalTxn, campaign } = await withTransaction(async (client) => {
            if (!config.pesapal.ipnId) {
                reply.code(503);
                return { error: 'pesapal_ipn_not_configured' };
            }
            const authUser = request.user?.sub;
            const role = request.user?.role;
            const userEmailRes = authUser
                ? await client.query('SELECT email FROM users WHERE id=$1', [authUser])
                : null;
            const userEmail = userEmailRes?.rows?.[0]?.email;
            if (!userEmail) {
                reply.code(400);
                return { error: 'user_email_missing' };
            }
            if (!callbackUrl || !cancellationUrl) {
                reply.code(400);
                return { error: 'payment_redirect_urls_missing' };
            }
            if ((body.return_url && !webReturnUrl) || (body.cancel_url && !webCancelUrl)) {
                reply.code(400);
                return { error: 'payment_redirect_urls_invalid' };
            }
            const firstName = userEmail.split('@')[0] ?? 'User';
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
            const merchantReference = uuid();
            const pesapalTxn = await paymentRepo.createPesaPalTransaction(client, {
                escrow_id: escrow.id,
                type: 'FUNDING',
                amount: body.amount,
                merchant_reference: merchantReference
            });
            const order = await submitOrder({
                amount: body.amount,
                description: `Campaign funding: ${campaign.title}`,
                type: 'MERCHANT',
                reference: merchantReference,
                firstName,
                lastName: 'User',
                email: userEmail,
                currency: pesapalCurrency,
                callback_url: callbackUrl,
                cancellation_url: cancellationUrl
            });
            return { order, pesapalTxn, campaign };
        });
        const orderAny = order;
        const pesapalError = orderAny?.error ?? orderAny?.errro;
        const status = orderAny?.status;
        if (pesapalError || (status && status !== '200' && status !== 200)) {
            app.log.error({
                order,
                campaignId: campaign.public_id ?? campaign.id,
                amount: body.amount,
                currency: pesapalCurrency
            }, 'pesapal_submit_order_failed');
            reply.code(502);
            return { error: 'pesapal_submit_failed', pesapal_response: order };
        }
        const redirectUrl = orderAny?.redirect_url;
        if (!redirectUrl) {
            app.log.error({ order }, 'pesapal_submit_order_missing_redirect_url');
            reply.code(502);
            return { error: 'pesapal_missing_redirect_url', pesapal_response: order };
        }
        return { redirect_url: redirectUrl, pesapal_txn: pesapalTxn };
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
            const latestConfirmedViewers = await getLatestConfirmedViewers(client, authUser);
            const allocatedViews = campaign.execution_mode === 'OPEN_BUDGET'
                ? Math.max(1, latestConfirmedViewers || Math.floor(Number(campaign.impression_target ?? 1) / 10) || 1)
                : Number(campaign.impression_target ?? 0);
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
        if (!authUser) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        const result = await withTransaction(async (client) => {
            const contractRes = await client.query('SELECT * FROM contracts WHERE id=$1', [params.id]);
            const contract = contractRes.rows[0];
            if (!contract)
                return null;
            if (contract.distributor_id !== authUser)
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
            return updated.rows[0];
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
        if (!authUser) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        const result = await withTransaction(async (client) => {
            const readiness = await getContractCompletionReadiness(client, params.id, authUser);
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
}
