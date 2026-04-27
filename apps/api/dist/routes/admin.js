import crypto from 'crypto';
import { z } from 'zod';
import { recordCampaignRevenueEntry, ADMIN_ROLE_SUPER_ADMIN, ADMIN_ROLE_COUNTRY_ADMIN, ADMIN_ROLE_DIVISION_ADMIN, } from '@prime/shared';
import { withTransaction } from '../db.js';
import { hashPassword } from '../services/auth.js';
import { config } from '../config.js';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import { JobRepo } from '../repositories/jobRepo.js';
import { verifyTransaction } from '../services/yoUganda.js';
import { buildCampaignStatusSummaries } from './campaigns.js';
import { ensurePublicIdColumns, resolveCampaignId, resolveUserId, } from '../services/publicId.js';
import { ACCOUNT_ROLE_ADMIN, ACCOUNT_ROLE_ADVERTISER, ACCOUNT_ROLE_DISTRIBUTOR, ACCOUNT_ROLE_DUAL_USER, normalizeActiveRole, } from '../services/roles.js';
import { getRequestDashboardAccess, loadDashboardAccessContext, } from '../services/adminTenant.js';
import { collectCampaignNotificationUserIds, createUserNotifications, ensureUserSignalSchema, } from '../services/userSignals.js';
const UpdateUserRoleSchema = z.object({
    role: z.enum(['ADMIN', 'ADVERTISER', 'DISTRIBUTOR', 'DUAL_USER'])
});
const UpdateUserStatusSchema = z.object({
    status: z.enum(['ACTIVE', 'SUSPENDED', 'BANNED']),
    reason: z.string().trim().max(500).optional().nullable(),
});
const UpdateUserContractPrivilegeSchema = z.object({
    can_multi_contract: z.boolean()
});
const ResetPasswordSchema = z.object({
    password: z.string().min(8)
});
const UpdateProofSchema = z.object({
    status: z.enum(['PENDING', 'VERIFIED', 'REJECTED', 'MANUAL_REVIEW']).optional(),
    decision: z.enum(['VERIFIED', 'REJECTED', 'MANUAL_REVIEW']).optional()
});
const UpdatePayoutSchema = z.object({
    status: z.enum(['REQUESTED', 'PROCESSING', 'PAID', 'FAILED'])
});
const UpdateEscrowSchema = z.object({
    status: z.enum(['PENDING', 'FUNDED', 'PARTIALLY_DISBURSED', 'COMPLETED'])
});
const UpdateCampaignSchema = z.object({
    title: z.string().min(3).max(120).optional(),
    platform: z.literal('WHATSAPP_STATUS').optional(),
    payout_amount: z.number().int().positive().optional(),
    budget_total: z.number().int().positive().optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    media_type: z.enum(['TEXT', 'IMAGE', 'VIDEO']).optional(),
    media_text: z.string().trim().max(2000).nullable().optional(),
    media_url: z.string().url().nullable().optional(),
    terms_keep_hours: z.number().int().positive().max(168).optional(),
    terms_min_views: z.number().int().positive().nullable().optional(),
    terms_requirement: z.enum(['DURATION', 'VIEWS', 'BOTH']).optional(),
    status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED']).optional()
});
const UpdateContractSchema = z.object({
    status: z.enum(['ACTIVE', 'COMPLETED', 'CANCELLED']).optional(),
    distributor_id: z.string().uuid().optional()
});
const AdjustWalletSchema = z.object({
    amount: z.number().int().positive(),
    direction: z.enum(['CREDIT', 'DEBIT']),
    reference: z.string().min(3).max(120).optional()
});
const UpdateJobSchema = z.object({
    status: z.enum(['QUEUED', 'PROCESSING', 'RETRY', 'FAILED', 'DONE']).optional(),
    attempts: z.number().int().min(0).optional(),
    last_error: z.string().optional().nullable(),
    retry_reason: z.string().optional().nullable()
});
const AdminAccessSchema = z.object({
    phrase: z.string().min(6)
});
const AuditQuerySchema = z.object({
    q: z.string().optional(),
    action: z.string().optional(),
    target_type: z.string().optional(),
    actor_id: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    limit: z.string().optional(),
    offset: z.string().optional()
});
function pushScopedCondition(state, condition, value) {
    state.conditions.push(condition.replaceAll('?', `$${state.idx}`));
    state.params.push(value);
    state.idx += 1;
}
function appendTenantScope(state, access, scope) {
    if (access.admin_role === ADMIN_ROLE_COUNTRY_ADMIN) {
        if (!access.country_id) {
            state.conditions.push('1 = 0');
            return;
        }
        pushScopedCondition(state, `${scope.country} = ?`, access.country_id);
        return;
    }
    if (access.admin_role === ADMIN_ROLE_DIVISION_ADMIN) {
        if (!access.division_id || !scope.division) {
            state.conditions.push('1 = 0');
            return;
        }
        pushScopedCondition(state, `${scope.division} = ?`, access.division_id);
    }
}
function matchesTenantScope(access, row) {
    if (!row)
        return false;
    if (access.admin_role === ADMIN_ROLE_SUPER_ADMIN) {
        return true;
    }
    if (access.admin_role === ADMIN_ROLE_COUNTRY_ADMIN) {
        return (Boolean(access.country_id) &&
            String(row.country_id ?? '') === String(access.country_id));
    }
    if (access.admin_role === ADMIN_ROLE_DIVISION_ADMIN) {
        return (Boolean(access.division_id) &&
            String(row.division_id ?? '') === String(access.division_id));
    }
    return false;
}
function isSuperDashboardAccess(access) {
    return access.admin_role === ADMIN_ROLE_SUPER_ADMIN;
}
function isManagedAdminAccount(row) {
    const role = String(row?.role ?? '').trim().toUpperCase();
    const adminRole = String(row?.admin_role ?? '').trim().toUpperCase();
    return role === 'ADMIN' || adminRole !== 'USER';
}
function verifyEmergencyPhrase(input) {
    const expected = config.adminAccessPhrase.trim();
    const candidate = input.trim();
    if (!expected || !candidate) {
        return false;
    }
    const left = Buffer.from(candidate, 'utf8');
    const right = Buffer.from(expected, 'utf8');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}
async function getLiveDashboardAccess(client, request) {
    const access = getRequestDashboardAccess(request);
    if (!access.user_id || access.user_id === 'ariaka-access') {
        return access;
    }
    return (await loadDashboardAccessContext(client, access.user_id)) ?? access;
}
async function requireSuperDashboardAccess(client, request, reply) {
    const access = await getLiveDashboardAccess(client, request);
    if (!isSuperDashboardAccess(access)) {
        reply.code(403);
        return null;
    }
    return access;
}
async function loadScopedUser(client, access, rawUserId) {
    await ensurePublicIdColumns(client);
    const resolvedUserId = await resolveUserId(client, rawUserId);
    if (!resolvedUserId) {
        return null;
    }
    const res = await client.query(`
    SELECT id, role, admin_role, country_id, division_id
    FROM users
    WHERE id = $1
    LIMIT 1
    `, [resolvedUserId]);
    const user = res.rows[0] ?? null;
    if (!matchesTenantScope(access, user)) {
        return null;
    }
    return {
        resolvedUserId,
        user,
    };
}
async function loadScopedCampaign(client, access, rawCampaignId) {
    await ensurePublicIdColumns(client);
    const resolvedCampaignId = await resolveCampaignId(client, rawCampaignId);
    if (!resolvedCampaignId) {
        return null;
    }
    const res = await client.query(`
    SELECT id, country_id, division_id
    FROM campaigns
    WHERE id = $1
    LIMIT 1
    `, [resolvedCampaignId]);
    const campaign = res.rows[0] ?? null;
    if (!matchesTenantScope(access, campaign)) {
        return null;
    }
    return {
        resolvedCampaignId,
        campaign,
    };
}
async function markContractCompletedForVerifiedProof(client, proofId) {
    const proofContextRes = await client.query(`
    SELECT
      p.id,
      p.user_id,
      p.status,
      p.decision,
      s.campaign_id,
      COALESCE(c.parent_campaign_id, c.id) AS escrow_campaign_id
    FROM proofs p
    JOIN verification_sessions s ON s.id = p.session_id
    JOIN campaigns c ON c.id = s.campaign_id
    WHERE p.id=$1
    LIMIT 1
    `, [proofId]);
    const proofContext = proofContextRes.rows[0];
    if (!proofContext)
        return;
    if (proofContext.status !== 'VERIFIED' || proofContext.decision !== 'VERIFIED')
        return;
    const escrowRes = await client.query(`SELECT status FROM escrow_ledger WHERE campaign_id=$1 LIMIT 1`, [proofContext.escrow_campaign_id]);
    const escrow = escrowRes.rows[0];
    if (!escrow || !['FUNDED', 'PARTIALLY_DISBURSED', 'COMPLETED'].includes(String(escrow.status))) {
        return;
    }
    await client.query(`
    UPDATE contracts
    SET status='COMPLETED',
        completed_at=COALESCE(completed_at, now())
    WHERE campaign_id=$1
      AND distributor_id=$2
      AND status='ACTIVE'
    `, [proofContext.campaign_id, proofContext.user_id]);
    await client.query(`
    UPDATE campaigns
    SET status='COMPLETED'
    WHERE id=$1
    `, [proofContext.campaign_id]);
    await recordCampaignRevenueEntry(client, proofContext.campaign_id);
}
function parsePaging(query) {
    const limitRaw = Number(query?.limit ?? 50);
    const offsetRaw = Number(query?.offset ?? 0);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
    return { limit, offset };
}
function parseDateRange(from, to) {
    const start = from ? new Date(from) : null;
    const end = to ? new Date(to) : null;
    return {
        from: start && !isNaN(start.getTime()) ? start.toISOString() : null,
        to: end && !isNaN(end.getTime()) ? end.toISOString() : null
    };
}
function parseNumberRange(min, max) {
    const minValue = Number(min);
    const maxValue = Number(max);
    return {
        min: Number.isFinite(minValue) ? minValue : null,
        max: Number.isFinite(maxValue) ? maxValue : null,
    };
}
async function ensureCampaignDraftsTable(client) {
    await client.query(`
    CREATE TABLE IF NOT EXISTS campaign_creation_drafts (
      id UUID PRIMARY KEY,
      advertiser_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS campaign_creation_drafts_updated_at_idx
      ON campaign_creation_drafts (updated_at DESC)
  `);
}
async function logAudit(client, actorId, action, targetType, targetId, meta) {
    await client.query(`INSERT INTO admin_audit_logs (actor_id, action, target_type, target_id, meta)
     VALUES ($1,$2,$3,$4,$5)`, [actorId || null, action, targetType, targetId, meta ?? null]);
}
function summarizeCampaignAdminChanges(input) {
    const labels = [];
    if (typeof input.status === 'string' && input.status.trim().length > 0) {
        labels.push(`status ${input.status}`);
    }
    if (typeof input.title === 'string' && input.title.trim().length > 0) {
        labels.push('title');
    }
    if (typeof input.start_date === 'string' || typeof input.end_date === 'string') {
        labels.push('schedule');
    }
    if (typeof input.budget_total === 'number' ||
        typeof input.payout_amount === 'number') {
        labels.push('funding');
    }
    if (typeof input.media_type === 'string' ||
        typeof input.media_text === 'string' ||
        typeof input.media_url === 'string') {
        labels.push('creative');
    }
    if (typeof input.terms_keep_hours === 'number' ||
        typeof input.terms_min_views === 'number' ||
        typeof input.terms_requirement === 'string') {
        labels.push('terms');
    }
    return labels.length > 0 ? labels.join(', ') : 'campaign settings';
}
export async function adminRoutes(app) {
    const jobRepo = new JobRepo();
    const paymentRepo = new PaymentRepo();
    app.post('/admin/access', async (request, reply) => {
        const body = AdminAccessSchema.parse(request.body);
        if (!config.adminAccessPhrase.trim()) {
            reply.code(503);
            return {
                error: 'admin_access_disabled',
                detail: 'Emergency admin access is not configured on this server.',
            };
        }
        if (!verifyEmergencyPhrase(body.phrase)) {
            reply.code(403);
            return { error: 'invalid_phrase' };
        }
        const token = app.jwt.sign({
            sub: 'ariaka-access',
            role: 'ADMIN',
            active_role: 'ADMIN',
            admin_role: 'SUPER_ADMIN'
        });
        return {
            token,
            user: {
                id: 'ariaka-access',
                email: 'ariaka-access@local',
                role: 'ADMIN',
                active_role: 'ADMIN',
                admin_role: 'SUPER_ADMIN'
            }
        };
    });
    app.get('/admin/audit', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const query = AuditQuerySchema.parse(request.query ?? {});
        const { limit, offset } = parsePaging(query);
        const range = parseDateRange(query.from, query.to);
        return withTransaction(async (client) => {
            if (!(await requireSuperDashboardAccess(client, request, reply))) {
                return { error: 'forbidden' };
            }
            const conditions = [];
            const params = [];
            let idx = 1;
            if (query.q) {
                conditions.push(`(action ILIKE $${idx} OR target_type ILIKE $${idx} OR COALESCE(target_id, '') ILIKE $${idx})`);
                params.push(`%${query.q}%`);
                idx++;
            }
            if (query.action) {
                conditions.push(`action = $${idx}`);
                params.push(query.action);
                idx++;
            }
            if (query.target_type) {
                conditions.push(`target_type = $${idx}`);
                params.push(query.target_type);
                idx++;
            }
            if (query.actor_id) {
                conditions.push(`actor_id = $${idx}`);
                params.push(query.actor_id);
                idx++;
            }
            if (range.from) {
                conditions.push(`created_at >= $${idx}`);
                params.push(range.from);
                idx++;
            }
            if (range.to) {
                conditions.push(`created_at <= $${idx}`);
                params.push(range.to);
                idx++;
            }
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const list = await client.query(`SELECT * FROM admin_audit_logs ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]);
            return { logs: list.rows };
        });
    });
    app.get('/admin/finance', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const range = parseDateRange(query?.from, query?.to);
        const groupByRaw = (query?.group_by ?? '').toString().toLowerCase();
        const groupBy = groupByRaw === 'day' || groupByRaw === 'month' ? groupByRaw : null;
        return withTransaction(async (client) => {
            if (!(await requireSuperDashboardAccess(client, request, reply))) {
                return { error: 'forbidden' };
            }
            const conditions = [];
            const params = [];
            let idx = 1;
            if (query?.q) {
                conditions.push(`(source_id::text ILIKE $${idx} OR reference ILIKE $${idx})`);
                params.push(`%${query.q}%`);
                idx++;
            }
            if (query?.type) {
                conditions.push(`source_type = $${idx}`);
                params.push(query.type);
                idx++;
            }
            if (query?.status) {
                conditions.push(`status = $${idx}`);
                params.push(query.status);
                idx++;
            }
            if (query?.min_amount) {
                conditions.push(`amount >= $${idx}`);
                params.push(Number(query.min_amount));
                idx++;
            }
            if (query?.max_amount) {
                conditions.push(`amount <= $${idx}`);
                params.push(Number(query.max_amount));
                idx++;
            }
            if (range.from) {
                conditions.push(`created_at >= $${idx}`);
                params.push(range.from);
                idx++;
            }
            if (range.to) {
                conditions.push(`created_at <= $${idx}`);
                params.push(range.to);
                idx++;
            }
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const rows = await client.query(`
        WITH combined AS (
          SELECT
            p.id AS source_id,
            'PAYOUT'::text AS source_type,
            p.status::text AS status,
            p.amount::int AS amount,
            p.pesapal_reference::text AS reference,
            p.user_id::text AS user_id,
            p.created_at AS created_at
          FROM payout_requests p
          UNION ALL
          SELECT
            t.id AS source_id,
            t.type::text AS source_type,
            t.status::text AS status,
            t.amount::int AS amount,
            t.merchant_reference::text AS reference,
            NULL::text AS user_id,
            t.created_at AS created_at
          FROM pesapal_transactions t
        )
        SELECT *
        FROM combined
        ${where}
        ORDER BY created_at DESC
        LIMIT $${idx} OFFSET $${idx + 1}
        `, [...params, limit, offset]);
            const summary = await client.query(`
        WITH combined AS (
          SELECT
            'PAYOUT'::text AS source_type,
            p.status::text AS status,
            p.amount::int AS amount,
            p.pesapal_reference::text AS reference,
            p.id AS source_id,
            p.created_at AS created_at
          FROM payout_requests p
          UNION ALL
          SELECT
            t.type::text AS source_type,
            t.status::text AS status,
            t.amount::int AS amount,
            t.merchant_reference::text AS reference,
            t.id AS source_id,
            t.created_at AS created_at
          FROM pesapal_transactions t
        ),
        filtered AS (
          SELECT *
          FROM combined
          ${where}
        )
        SELECT
          COALESCE(SUM(amount), 0)::bigint AS total_amount,
          COALESCE(SUM(CASE WHEN source_type = 'PAYOUT' THEN amount ELSE 0 END), 0)::bigint AS payout_amount,
          COALESCE(SUM(CASE WHEN source_type <> 'PAYOUT' THEN amount ELSE 0 END), 0)::bigint AS provider_amount
        FROM filtered
        `, params);
            const escrowConditions = [];
            const escrowParams = [];
            let eidx = 1;
            if (range.from) {
                escrowConditions.push(`c.created_at >= $${eidx}`);
                escrowParams.push(range.from);
                eidx++;
            }
            if (range.to) {
                escrowConditions.push(`c.created_at <= $${eidx}`);
                escrowParams.push(range.to);
                eidx++;
            }
            if (query?.min_amount) {
                escrowConditions.push(`amount_total >= $${eidx}`);
                escrowParams.push(Number(query.min_amount));
                eidx++;
            }
            if (query?.max_amount) {
                escrowConditions.push(`amount_total <= $${eidx}`);
                escrowParams.push(Number(query.max_amount));
                eidx++;
            }
            if (query?.status && ['PENDING', 'FUNDED', 'PARTIALLY_DISBURSED', 'COMPLETED'].includes(query.status)) {
                escrowConditions.push(`status = $${eidx}`);
                escrowParams.push(query.status);
                eidx++;
            }
            else {
                escrowConditions.push(`status IN ('FUNDED','PARTIALLY_DISBURSED','COMPLETED')`);
            }
            const escrowWhere = escrowConditions.length ? `WHERE ${escrowConditions.join(' AND ')}` : '';
            const escrowRes = await client.query(`SELECT COALESCE(SUM(amount_total), 0)::bigint AS contracts_financed FROM escrow_ledger ${escrowWhere}`, escrowParams);
            let series = [];
            if (groupBy) {
                const seriesRes = await client.query(`
          WITH combined AS (
            SELECT
              'PAYOUT'::text AS source_type,
              p.status::text AS status,
              p.amount::int AS amount,
              p.pesapal_reference::text AS reference,
              p.id AS source_id,
              p.created_at AS created_at
            FROM payout_requests p
            UNION ALL
            SELECT
              t.type::text AS source_type,
              t.status::text AS status,
              t.amount::int AS amount,
              t.merchant_reference::text AS reference,
              t.id AS source_id,
              t.created_at AS created_at
            FROM pesapal_transactions t
          ),
          filtered AS (
            SELECT *
            FROM combined
            ${where}
          )
          SELECT
            date_trunc('${groupBy}', created_at) AS bucket,
            COALESCE(SUM(amount), 0)::bigint AS total_amount,
            COALESCE(SUM(CASE WHEN source_type = 'PAYOUT' THEN amount ELSE 0 END), 0)::bigint AS payout_amount,
          COALESCE(SUM(CASE WHEN source_type <> 'PAYOUT' THEN amount ELSE 0 END), 0)::bigint AS provider_amount,
            ROUND(COALESCE(SUM(CASE WHEN source_type = 'PAYOUT' THEN amount ELSE 0 END), 0) * 0.15)::bigint AS platform_fee
          FROM filtered
          GROUP BY bucket
          ORDER BY bucket DESC
          LIMIT 366
          `, params);
                series = seriesRes.rows;
            }
            const totals = summary.rows[0] ?? {};
            const payoutAmount = Number(totals.payout_amount ?? 0);
            const platformFee = Math.round(payoutAmount * 0.15);
            const contractsFinanced = Number(escrowRes.rows[0]?.contracts_financed ?? 0);
            return {
                summary: {
                    total_amount: Number(totals.total_amount ?? 0),
                    payout_amount: payoutAmount,
                    provider_amount: Number(totals.provider_amount ?? 0),
                    yo_uganda_amount: Number(totals.provider_amount ?? 0),
                    flutterwave_amount: Number(totals.provider_amount ?? 0),
                    pesapal_amount: Number(totals.provider_amount ?? 0),
                    platform_fee: platformFee,
                    contracts_financed: contractsFinanced
                },
                rows: rows.rows,
                series
            };
        });
    });
    app.get('/admin/overview', { preHandler: [app.adminOnly] }, async (request, reply) => {
        return withTransaction(async (client) => {
            if (!(await requireSuperDashboardAccess(client, request, reply))) {
                return { error: 'forbidden' };
            }
            await ensureCampaignDraftsTable(client);
            const users = await client.query('SELECT COUNT(*)::int AS count FROM users');
            const campaigns = await client.query('SELECT COUNT(*)::int AS count FROM campaigns');
            const proofs = await client.query('SELECT COUNT(*)::int AS count FROM proofs');
            const verificationSessions = await client.query('SELECT COUNT(*)::int AS count FROM verification_sessions');
            const payouts = await client.query('SELECT COUNT(*)::int AS count FROM payout_requests');
            const escrows = await client.query('SELECT COUNT(*)::int AS count FROM escrow_ledger');
            const campaignDrafts = await client.query('SELECT COUNT(*)::int AS count FROM campaign_creation_drafts');
            const walletWithdrawals = await client.query('SELECT COUNT(*)::int AS count FROM wallet_withdrawals');
            const trustProfiles = await client.query('SELECT COUNT(*)::int AS count FROM trust_scores');
            const deviceFingerprints = await client.query('SELECT COUNT(*)::int AS count FROM device_fingerprints');
            const providerTransactions = await client.query('SELECT COUNT(*)::int AS count FROM pesapal_transactions');
            return {
                users: users.rows[0]?.count ?? 0,
                campaigns: campaigns.rows[0]?.count ?? 0,
                proofs: proofs.rows[0]?.count ?? 0,
                verification_sessions: verificationSessions.rows[0]?.count ?? 0,
                payouts: payouts.rows[0]?.count ?? 0,
                escrows: escrows.rows[0]?.count ?? 0,
                campaign_drafts: campaignDrafts.rows[0]?.count ?? 0,
                wallet_withdrawals: walletWithdrawals.rows[0]?.count ?? 0,
                trust_profiles: trustProfiles.rows[0]?.count ?? 0,
                device_fingerprints: deviceFingerprints.rows[0]?.count ?? 0,
                provider_transactions: providerTransactions.rows[0]?.count ?? 0,
                yo_uganda_transactions: providerTransactions.rows[0]?.count ?? 0,
                flutterwave_transactions: providerTransactions.rows[0]?.count ?? 0,
                pesapal_transactions: providerTransactions.rows[0]?.count ?? 0
            };
        });
    });
    app.get('/admin/verification-sessions', { preHandler: [app.adminOnly] }, async (request) => {
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const range = parseDateRange(query?.from, query?.to);
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            await ensurePublicIdColumns(client);
            await ensureUserSignalSchema(client);
            const conditions = [];
            const params = [];
            let idx = 1;
            if (query?.q) {
                conditions.push(`(s.id::text ILIKE $${idx} OR u.email ILIKE $${idx} OR u.phone ILIKE $${idx} OR u.public_id ILIKE $${idx} OR c.title ILIKE $${idx} OR c.public_id ILIKE $${idx} OR s.challenge_code ILIKE $${idx} OR s.challenge_phrase ILIKE $${idx})`);
                params.push(`%${query.q}%`);
                idx++;
            }
            if (query?.platform) {
                conditions.push(`s.platform = $${idx}`);
                params.push(query.platform);
                idx++;
            }
            if (query?.state) {
                conditions.push(`(CASE WHEN p.id IS NOT NULL THEN 'PROOF_SUBMITTED' WHEN s.expires_at < now() THEN 'EXPIRED' ELSE 'ACTIVE' END) = $${idx}`);
                params.push(query.state);
                idx++;
            }
            if (query?.proof_status) {
                conditions.push(`COALESCE(p.status, 'NONE') = $${idx}`);
                params.push(query.proof_status);
                idx++;
            }
            if (range.from) {
                conditions.push(`s.created_at >= $${idx}`);
                params.push(range.from);
                idx++;
            }
            if (range.to) {
                conditions.push(`s.created_at <= $${idx}`);
                params.push(range.to);
                idx++;
            }
            const state = { conditions, params, idx };
            appendTenantScope(state, access, {
                country: 'c.country_id',
                division: 'c.division_id',
            });
            idx = state.idx;
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const res = await client.query(`
        SELECT
          s.*,
          u.email AS user_email,
          u.phone AS user_phone,
          u.public_id AS user_public_id,
          u.role AS user_role,
          c.title AS campaign_title,
          c.public_id AS campaign_public_id,
          p.id AS proof_id,
          p.status AS proof_status,
          p.decision AS proof_decision,
          p.created_at AS proof_created_at,
          CASE
            WHEN p.id IS NOT NULL THEN 'PROOF_SUBMITTED'
            WHEN s.expires_at < now() THEN 'EXPIRED'
            ELSE 'ACTIVE'
          END AS session_state
        FROM verification_sessions s
        JOIN users u ON u.id = s.user_id
        JOIN campaigns c ON c.id = s.campaign_id
        LEFT JOIN proofs p ON p.session_id = s.id
        ${where}
        ORDER BY s.created_at DESC
        LIMIT $${idx} OFFSET $${idx + 1}
        `, [...params, limit, offset]);
            return { sessions: res.rows };
        });
    });
    app.get('/admin/campaign-drafts', { preHandler: [app.adminOnly] }, async (request) => {
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const range = parseDateRange(query?.from, query?.to);
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            await ensureCampaignDraftsTable(client);
            await ensurePublicIdColumns(client);
            const conditions = [];
            const params = [];
            let idx = 1;
            if (query?.q) {
                conditions.push(`(u.email ILIKE $${idx} OR u.phone ILIKE $${idx} OR u.public_id ILIKE $${idx} OR d.id::text ILIKE $${idx} OR COALESCE(d.payload->>'title', '') ILIKE $${idx})`);
                params.push(`%${query.q}%`);
                idx++;
            }
            if (range.from) {
                conditions.push(`d.updated_at >= $${idx}`);
                params.push(range.from);
                idx++;
            }
            if (range.to) {
                conditions.push(`d.updated_at <= $${idx}`);
                params.push(range.to);
                idx++;
            }
            const state = { conditions, params, idx };
            appendTenantScope(state, access, {
                country: 'u.country_id',
                division: 'u.division_id',
            });
            idx = state.idx;
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const res = await client.query(`
        SELECT
          d.*,
          u.email AS advertiser_email,
          u.phone AS advertiser_phone,
          u.public_id AS advertiser_public_id
        FROM campaign_creation_drafts d
        JOIN users u ON u.id = d.advertiser_id
        ${where}
        ORDER BY d.updated_at DESC
        LIMIT $${idx} OFFSET $${idx + 1}
        `, [...params, limit, offset]);
            return {
                drafts: res.rows.map((row) => {
                    const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
                        ? row.payload
                        : {};
                    return {
                        ...row,
                        title: String(payload.title ?? '').trim(),
                        active_platform: String(payload.active_platform ?? '').trim().toUpperCase(),
                        selected_platforms: Array.isArray(payload.selected_platforms)
                            ? payload.selected_platforms
                            : [],
                        step: Number.isFinite(Number(payload.step)) ? Math.max(0, Math.trunc(Number(payload.step))) : 0,
                        saved_at: payload.saved_at ?? null,
                        server_updated_at: payload.server_updated_at ?? null,
                    };
                }),
            };
        });
    });
    app.get('/admin/trust', { preHandler: [app.adminOnly] }, async (request) => {
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const range = parseDateRange(query?.from, query?.to);
        const scoreRange = parseNumberRange(query?.min_score, query?.max_score);
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            await ensurePublicIdColumns(client);
            const conditions = [];
            const params = [];
            let idx = 1;
            if (query?.q) {
                conditions.push(`(u.email ILIKE $${idx} OR u.phone ILIKE $${idx} OR u.public_id ILIKE $${idx} OR u.id::text ILIKE $${idx})`);
                params.push(`%${query.q}%`);
                idx++;
            }
            if (query?.role) {
                conditions.push(`u.role = $${idx}`);
                params.push(query.role);
                idx++;
            }
            if (query?.event_type) {
                conditions.push(`COALESCE(latest.event_type, 'NONE') = $${idx}`);
                params.push(query.event_type);
                idx++;
            }
            if (scoreRange.min !== null) {
                conditions.push(`COALESCE(ts.score, 50) >= $${idx}`);
                params.push(scoreRange.min);
                idx++;
            }
            if (scoreRange.max !== null) {
                conditions.push(`COALESCE(ts.score, 50) <= $${idx}`);
                params.push(scoreRange.max);
                idx++;
            }
            if (range.from) {
                conditions.push(`COALESCE(latest.created_at, ts.updated_at, u.created_at) >= $${idx}`);
                params.push(range.from);
                idx++;
            }
            if (range.to) {
                conditions.push(`COALESCE(latest.created_at, ts.updated_at, u.created_at) <= $${idx}`);
                params.push(range.to);
                idx++;
            }
            const state = { conditions, params, idx };
            appendTenantScope(state, access, {
                country: 'u.country_id',
                division: 'u.division_id',
            });
            idx = state.idx;
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const res = await client.query(`
        SELECT
          u.id AS user_id,
          u.public_id,
          u.email,
          u.phone,
          u.role,
          COALESCE(ts.score, 50)::int AS trust_score,
          ts.updated_at AS trust_updated_at,
          latest.event_type AS latest_event_type,
          latest.delta AS latest_event_delta,
          latest.created_at AS latest_event_at,
          COALESCE(event_counts.verified_count, 0)::int AS verified_count,
          COALESCE(event_counts.rejected_count, 0)::int AS rejected_count,
          COALESCE(event_counts.manual_review_count, 0)::int AS manual_review_count,
          COALESCE(fp.fingerprint_count, 0)::int AS fingerprint_count
        FROM users u
        LEFT JOIN trust_scores ts ON ts.user_id = u.id
        LEFT JOIN LATERAL (
          SELECT event_type, delta, created_at
          FROM trust_events te
          WHERE te.user_id = u.id
          ORDER BY created_at DESC
          LIMIT 1
        ) latest ON TRUE
        LEFT JOIN LATERAL (
          SELECT
            COUNT(*) FILTER (WHERE event_type = 'VERIFIED') AS verified_count,
            COUNT(*) FILTER (WHERE event_type = 'REJECTED') AS rejected_count,
            COUNT(*) FILTER (WHERE event_type = 'MANUAL_REVIEW') AS manual_review_count
          FROM trust_events te
          WHERE te.user_id = u.id
        ) event_counts ON TRUE
        LEFT JOIN LATERAL (
          SELECT COUNT(*) AS fingerprint_count
          FROM device_fingerprints df
          WHERE df.user_id = u.id
        ) fp ON TRUE
        ${where}
        ORDER BY COALESCE(ts.updated_at, latest.created_at, u.created_at) DESC
        LIMIT $${idx} OFFSET $${idx + 1}
        `, [...params, limit, offset]);
            return { trust: res.rows };
        });
    });
    app.get('/admin/device-fingerprints', { preHandler: [app.adminOnly] }, async (request) => {
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const range = parseDateRange(query?.from, query?.to);
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            await ensurePublicIdColumns(client);
            const conditions = [];
            const params = [];
            let idx = 1;
            if (query?.q) {
                conditions.push(`(df.id::text ILIKE $${idx} OR df.fingerprint_hash ILIKE $${idx} OR u.email ILIKE $${idx} OR u.phone ILIKE $${idx} OR u.public_id ILIKE $${idx})`);
                params.push(`%${query.q}%`);
                idx++;
            }
            if (query?.role) {
                conditions.push(`u.role = $${idx}`);
                params.push(query.role);
                idx++;
            }
            if (range.from) {
                conditions.push(`df.created_at >= $${idx}`);
                params.push(range.from);
                idx++;
            }
            if (range.to) {
                conditions.push(`df.created_at <= $${idx}`);
                params.push(range.to);
                idx++;
            }
            if (query?.collision_only === 'true') {
                conditions.push(`COALESCE(collision.user_count, 0) > 1`);
            }
            const state = { conditions, params, idx };
            appendTenantScope(state, access, {
                country: 'u.country_id',
                division: 'u.division_id',
            });
            idx = state.idx;
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const res = await client.query(`
        SELECT
          df.*,
          u.email,
          u.phone,
          u.public_id,
          u.role,
          COALESCE(collision.user_count, 0)::int AS collision_user_count,
          COALESCE(collision.record_count, 0)::int AS collision_record_count
        FROM device_fingerprints df
        JOIN users u ON u.id = df.user_id
        LEFT JOIN LATERAL (
          SELECT
            COUNT(DISTINCT df2.user_id) AS user_count,
            COUNT(*) AS record_count
          FROM device_fingerprints df2
          WHERE df2.fingerprint_hash = df.fingerprint_hash
        ) collision ON TRUE
        ${where}
        ORDER BY df.created_at DESC
        LIMIT $${idx} OFFSET $${idx + 1}
        `, [...params, limit, offset]);
            return { fingerprints: res.rows };
        });
    });
    app.get('/admin/wallet-withdrawals', { preHandler: [app.adminOnly] }, async (request) => {
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const range = parseDateRange(query?.from, query?.to);
        const amountRange = parseNumberRange(query?.min_amount, query?.max_amount);
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            await ensurePublicIdColumns(client);
            const conditions = [];
            const params = [];
            let idx = 1;
            if (query?.q) {
                conditions.push(`(ww.id::text ILIKE $${idx} OR COALESCE(ww.pesapal_reference, '') ILIKE $${idx} OR ww.receiver_phone ILIKE $${idx} OR u.email ILIKE $${idx} OR u.phone ILIKE $${idx} OR u.public_id ILIKE $${idx})`);
                params.push(`%${query.q}%`);
                idx++;
            }
            if (query?.status) {
                conditions.push(`ww.status = $${idx}`);
                params.push(query.status);
                idx++;
            }
            if (query?.network) {
                conditions.push(`COALESCE(ww.mobile_money_network, '') = $${idx}`);
                params.push(query.network);
                idx++;
            }
            if (amountRange.min !== null) {
                conditions.push(`ww.amount >= $${idx}`);
                params.push(amountRange.min);
                idx++;
            }
            if (amountRange.max !== null) {
                conditions.push(`ww.amount <= $${idx}`);
                params.push(amountRange.max);
                idx++;
            }
            if (range.from) {
                conditions.push(`ww.created_at >= $${idx}`);
                params.push(range.from);
                idx++;
            }
            if (range.to) {
                conditions.push(`ww.created_at <= $${idx}`);
                params.push(range.to);
                idx++;
            }
            const state = { conditions, params, idx };
            appendTenantScope(state, access, {
                country: 'u.country_id',
                division: 'u.division_id',
            });
            idx = state.idx;
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const res = await client.query(`
        SELECT
          ww.*,
          u.email AS user_email,
          u.phone AS user_phone,
          u.public_id AS user_public_id,
          w.balance AS wallet_balance
        FROM wallet_withdrawals ww
        JOIN users u ON u.id = ww.user_id
        JOIN wallets w ON w.id = ww.wallet_id
        ${where}
        ORDER BY ww.created_at DESC
        LIMIT $${idx} OFFSET $${idx + 1}
        `, [...params, limit, offset]);
            return { withdrawals: res.rows };
        });
    });
    app.get('/admin/users', { preHandler: [app.adminOnly] }, async (request) => {
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const range = parseDateRange(query?.from, query?.to);
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            await ensurePublicIdColumns(client);
            const conditions = [];
            const params = [];
            let idx = 1;
            if (query?.q) {
                conditions.push(`(u.email ILIKE $${idx} OR COALESCE(u.full_name, '') ILIKE $${idx} OR u.phone ILIKE $${idx} OR u.id::text ILIKE $${idx} OR u.public_id ILIKE $${idx} OR COALESCE(u.country, '') ILIKE $${idx})`);
                params.push(`%${query.q}%`);
                idx++;
            }
            if (query?.role) {
                conditions.push(`u.role = $${idx}`);
                params.push(query.role);
                idx++;
            }
            if (query?.status) {
                conditions.push(`u.status = $${idx}`);
                params.push(query.status);
                idx++;
            }
            if (range.from) {
                conditions.push(`u.created_at >= $${idx}`);
                params.push(range.from);
                idx++;
            }
            if (range.to) {
                conditions.push(`u.created_at <= $${idx}`);
                params.push(range.to);
                idx++;
            }
            const state = { conditions, params, idx };
            appendTenantScope(state, access, {
                country: 'u.country_id',
                division: 'u.division_id',
            });
            idx = state.idx;
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const res = await client.query(`
        SELECT
          u.*,
          p.avatar_url,
        CASE
          WHEN COALESCE(u.last_seen_at, '-infinity'::timestamptz) >= NOW() - interval '5 minutes'
            THEN TRUE
          ELSE FALSE
        END AS is_online
      FROM users u
      LEFT JOIN user_profiles p ON p.user_id = u.id
      ${where}
      ORDER BY u.created_at DESC
      LIMIT $${idx} OFFSET $${idx + 1}
      `, [...params, limit, offset]);
            return { users: res.rows };
        });
    });
    app.get('/admin/users/:id/detail', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const result = await withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            await ensurePublicIdColumns(client);
            await ensureUserSignalSchema(client);
            const scopedUser = await loadScopedUser(client, access, params.id);
            if (!scopedUser) {
                return null;
            }
            const { resolvedUserId } = scopedUser;
            const userRes = await client.query(`
        SELECT
          u.*,
          p.avatar_url,
          CASE
            WHEN COALESCE(u.last_seen_at, '-infinity'::timestamptz) >= NOW() - interval '5 minutes'
              THEN TRUE
            ELSE FALSE
          END AS is_online
        FROM users u
        LEFT JOIN user_profiles p ON p.user_id = u.id
        WHERE u.id = $1
        LIMIT 1
        `, [resolvedUserId]);
            const user = userRes.rows[0];
            if (!user) {
                return null;
            }
            const walletsRes = await client.query(`
        SELECT *
        FROM wallets
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 20
        `, [resolvedUserId]);
            const payoutsRes = await client.query(`
        SELECT p.*, u.email AS user_email
        FROM payout_requests p
        JOIN users u ON u.id = p.user_id
        WHERE p.user_id = $1
        ORDER BY p.created_at DESC
        LIMIT 100
        `, [resolvedUserId]);
            const contractsRes = await client.query(`
        SELECT
          ctr.*,
          c.title AS campaign_title,
          c.public_id AS campaign_public_id,
          c.status AS campaign_status,
          u.email AS distributor_email,
          u.public_id AS distributor_public_id,
          adv.email AS advertiser_email,
          adv.public_id AS advertiser_public_id
        FROM contracts ctr
        JOIN campaigns c ON c.id = ctr.campaign_id
        JOIN users u ON u.id = ctr.distributor_id
        JOIN users adv ON adv.id = c.advertiser_id
        WHERE (
          c.advertiser_id = $1
          OR ctr.distributor_id = $1
        )
          AND ${access.admin_role === ADMIN_ROLE_COUNTRY_ADMIN
                ? 'c.country_id = $2'
                : access.admin_role === ADMIN_ROLE_DIVISION_ADMIN
                    ? 'c.division_id = $2'
                    : 'TRUE'}
        ORDER BY ctr.created_at DESC
        LIMIT 200
        `, access.admin_role === ADMIN_ROLE_COUNTRY_ADMIN
                ? [resolvedUserId, access.country_id]
                : access.admin_role === ADMIN_ROLE_DIVISION_ADMIN
                    ? [resolvedUserId, access.division_id]
                    : [resolvedUserId]);
            const campaignsRes = await client.query(`
        SELECT
          c.*,
          adv.email AS advertiser_email,
          adv.public_id AS advertiser_public_id,
          dist.email AS assigned_distributor_email,
          dist.public_id AS assigned_distributor_public_id,
          CASE
            WHEN c.advertiser_id = $1 THEN 'CREATED'
            WHEN EXISTS (
              SELECT 1
              FROM contracts ctr
              WHERE ctr.campaign_id = c.id
                AND ctr.distributor_id = $1
            ) THEN 'TOOK_ON'
            WHEN c.assigned_distributor_id = $1 THEN 'TAGGED'
            ELSE 'RELATED'
          END AS user_relation
        FROM campaigns c
        LEFT JOIN users adv ON adv.id = c.advertiser_id
        LEFT JOIN users dist ON dist.id = c.assigned_distributor_id
        WHERE (
          c.advertiser_id = $1
          OR c.assigned_distributor_id = $1
          OR EXISTS (
            SELECT 1
            FROM contracts ctr
            WHERE ctr.campaign_id = c.id
              AND ctr.distributor_id = $1
          )
        )
          AND ${access.admin_role === ADMIN_ROLE_COUNTRY_ADMIN
                ? 'c.country_id = $2'
                : access.admin_role === ADMIN_ROLE_DIVISION_ADMIN
                    ? 'c.division_id = $2'
                    : 'TRUE'}
        ORDER BY c.created_at DESC
        LIMIT 200
        `, access.admin_role === ADMIN_ROLE_COUNTRY_ADMIN
                ? [resolvedUserId, access.country_id]
                : access.admin_role === ADMIN_ROLE_DIVISION_ADMIN
                    ? [resolvedUserId, access.division_id]
                    : [resolvedUserId]);
            const statusSummaries = await buildCampaignStatusSummaries(client, campaignsRes.rows.map((row) => String(row.id)), null);
            return {
                user,
                wallets: walletsRes.rows,
                payouts: payoutsRes.rows,
                contracts: contractsRes.rows,
                campaigns: campaignsRes.rows.map((row) => ({
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
                })),
            };
        });
        if (!result) {
            reply.code(404);
            return { error: 'user_not_found' };
        }
        return result;
    });
    app.patch('/admin/users/:id/role', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = UpdateUserRoleSchema.parse(request.body);
        const result = await withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const scopedUser = await loadScopedUser(client, access, params.id);
            if (!scopedUser) {
                return null;
            }
            const { resolvedUserId, user } = scopedUser;
            if (!isSuperDashboardAccess(access) &&
                (body.role === ACCOUNT_ROLE_ADMIN || isManagedAdminAccount(user))) {
                reply.code(403);
                return { error: 'forbidden' };
            }
            const res = await client.query(`UPDATE users
         SET role=$2,
             active_role=$3
         WHERE id=$1
         RETURNING *`, [
                resolvedUserId,
                body.role,
                body.role === ACCOUNT_ROLE_ADMIN
                    ? ACCOUNT_ROLE_ADMIN
                    : body.role === ACCOUNT_ROLE_ADVERTISER
                        ? ACCOUNT_ROLE_ADVERTISER
                        : body.role === ACCOUNT_ROLE_DISTRIBUTOR
                            ? ACCOUNT_ROLE_DISTRIBUTOR
                            : normalizeActiveRole(null, ACCOUNT_ROLE_DUAL_USER),
            ]);
            if (res.rows[0]) {
                await logAudit(client, request.user.sub, 'UPDATE_USER_ROLE', 'user', resolvedUserId, { role: body.role });
                await createUserNotifications(client, [resolvedUserId], {
                    title: 'Account role updated by admin',
                    body: `An administrator changed your account role to ${body.role}.`,
                    actorId: request.user.sub,
                    targetType: 'user',
                    targetId: resolvedUserId,
                    meta: { role: body.role },
                });
            }
            return res.rows[0];
        });
        if (result?.error === 'forbidden') {
            return result;
        }
        if (!result) {
            reply.code(404);
            return { error: 'user_not_found' };
        }
        return { user: result };
    });
    app.patch('/admin/users/:id/status', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const parsed = UpdateUserStatusSchema.safeParse(request.body);
        if (!parsed.success) {
            reply.code(400);
            return {
                error: 'validation_failed',
                issues: parsed.error.issues,
            };
        }
        const body = parsed.data;
        const reason = (body.reason ?? '').trim();
        if ((body.status === 'SUSPENDED' || body.status === 'BANNED') && reason.length === 0) {
            reply.code(400);
            return {
                error: 'status_reason_required',
                detail: `Provide a reason when setting an account to ${body.status}.`,
            };
        }
        const result = await withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const scopedUser = await loadScopedUser(client, access, params.id);
            if (!scopedUser) {
                return null;
            }
            const { resolvedUserId, user } = scopedUser;
            if (!isSuperDashboardAccess(access) && isManagedAdminAccount(user)) {
                reply.code(403);
                return { error: 'forbidden' };
            }
            const res = await client.query(`
        UPDATE users
        SET status = $2::text,
            status_reason = CASE
              WHEN $2::text = 'ACTIVE' THEN NULL
              ELSE NULLIF($3::text, '')
            END,
            status_reason_updated_at = CASE
              WHEN $2::text = 'ACTIVE' THEN NULL
              ELSE NOW()
            END
        WHERE id = $1
        RETURNING *
        `, [resolvedUserId, body.status, reason]);
            if (!res.rows[0]) {
                return null;
            }
            await logAudit(client, request.user.sub, 'UPDATE_USER_STATUS', 'user', resolvedUserId, {
                status: body.status,
                reason: reason.length === 0 ? null : reason,
            });
            await createUserNotifications(client, [resolvedUserId], {
                title: body.status === 'ACTIVE'
                    ? 'Account reinstated by admin'
                    : 'Account status updated by admin',
                body: body.status === 'ACTIVE'
                    ? 'An administrator reinstated your account.'
                    : `An administrator changed your account status to ${body.status}. Reason: ${reason}`,
                actorId: request.user.sub,
                targetType: 'user',
                targetId: resolvedUserId,
                meta: {
                    status: body.status,
                    reason: reason.length === 0 ? null : reason,
                },
            });
            return res.rows[0];
        });
        if (result?.error === 'forbidden') {
            return result;
        }
        if (!result) {
            reply.code(404);
            return { error: 'user_not_found' };
        }
        return { user: result };
    });
    app.patch('/admin/users/:id/password', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = ResetPasswordSchema.parse(request.body);
        const result = await withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const scopedUser = await loadScopedUser(client, access, params.id);
            if (!scopedUser) {
                return null;
            }
            const { resolvedUserId, user } = scopedUser;
            if (!isSuperDashboardAccess(access) && isManagedAdminAccount(user)) {
                reply.code(403);
                return { error: 'forbidden' };
            }
            const res = await client.query('UPDATE users SET password_hash=$2 WHERE id=$1 RETURNING id, email, role', [resolvedUserId, hashPassword(body.password)]);
            if (res.rows[0]) {
                await logAudit(client, request.user.sub, 'RESET_USER_PASSWORD', 'user', resolvedUserId, {});
                await createUserNotifications(client, [resolvedUserId], {
                    title: 'Password reset by admin',
                    body: 'An administrator reset your account password. Sign in again if prompted.',
                    actorId: request.user.sub,
                    targetType: 'user',
                    targetId: resolvedUserId,
                    meta: {},
                });
            }
            return res.rows[0];
        });
        if (result?.error === 'forbidden') {
            return result;
        }
        if (!result) {
            reply.code(404);
            return { error: 'user_not_found' };
        }
        return { user: result };
    });
    app.patch('/admin/users/:id/contract-privilege', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = UpdateUserContractPrivilegeSchema.parse(request.body);
        const result = await withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const scopedUser = await loadScopedUser(client, access, params.id);
            if (!scopedUser) {
                return null;
            }
            const { resolvedUserId, user } = scopedUser;
            if (!isSuperDashboardAccess(access) && isManagedAdminAccount(user)) {
                reply.code(403);
                return { error: 'forbidden' };
            }
            const res = await client.query('UPDATE users SET can_multi_contract=$2 WHERE id=$1 RETURNING *', [resolvedUserId, body.can_multi_contract]);
            if (res.rows[0]) {
                await logAudit(client, request.user.sub, 'UPDATE_USER_CONTRACT_PRIVILEGE', 'user', resolvedUserId, { can_multi_contract: body.can_multi_contract });
                await createUserNotifications(client, [resolvedUserId], {
                    title: 'Contract privilege updated by admin',
                    body: body.can_multi_contract
                        ? 'An administrator enabled multi-contract access on your account.'
                        : 'An administrator disabled multi-contract access on your account.',
                    actorId: request.user.sub,
                    targetType: 'user',
                    targetId: resolvedUserId,
                    meta: { can_multi_contract: body.can_multi_contract },
                });
            }
            return res.rows[0];
        });
        if (result?.error === 'forbidden') {
            return result;
        }
        if (!result) {
            reply.code(404);
            return { error: 'user_not_found' };
        }
        return { user: result };
    });
    app.get('/admin/campaigns', { preHandler: [app.adminOnly] }, async (request) => {
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const range = parseDateRange(query?.from, query?.to);
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            await ensurePublicIdColumns(client);
            const conditions = [];
            const params = [];
            let idx = 1;
            if (query?.q) {
                conditions.push(`(c.title ILIKE $${idx} OR c.id::text ILIKE $${idx} OR c.public_id ILIKE $${idx} OR adv.email ILIKE $${idx} OR adv.public_id ILIKE $${idx} OR c.advertiser_id::text ILIKE $${idx} OR dist.email ILIKE $${idx} OR dist.public_id ILIKE $${idx} OR COALESCE(c.assigned_distributor_id::text, '') ILIKE $${idx})`);
                params.push(`%${query.q}%`);
                idx++;
            }
            if (query?.status) {
                conditions.push(`c.status = $${idx}`);
                params.push(query.status);
                idx++;
            }
            if (query?.platform) {
                conditions.push(`c.platform = $${idx}`);
                params.push(query.platform);
                idx++;
            }
            if (query?.min_amount) {
                conditions.push(`c.budget_total >= $${idx}`);
                params.push(Number(query.min_amount));
                idx++;
            }
            if (query?.max_amount) {
                conditions.push(`c.budget_total <= $${idx}`);
                params.push(Number(query.max_amount));
                idx++;
            }
            if (range.from) {
                conditions.push(`c.created_at >= $${idx}`);
                params.push(range.from);
                idx++;
            }
            if (range.to) {
                conditions.push(`c.created_at <= $${idx}`);
                params.push(range.to);
                idx++;
            }
            const state = { conditions, params, idx };
            appendTenantScope(state, access, {
                country: 'c.country_id',
                division: 'c.division_id',
            });
            idx = state.idx;
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const res = await client.query(`SELECT c.*, adv.email AS advertiser_email, adv.public_id AS advertiser_public_id, dist.email AS assigned_distributor_email, dist.public_id AS assigned_distributor_public_id FROM campaigns c LEFT JOIN users adv ON adv.id = c.advertiser_id LEFT JOIN users dist ON dist.id = c.assigned_distributor_id ${where} ORDER BY c.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]);
            const statusSummaries = await buildCampaignStatusSummaries(client, res.rows.map((row) => String(row.id)), null);
            return {
                campaigns: res.rows.map((row) => ({
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
                })),
            };
        });
    });
    app.patch('/admin/campaigns/:id', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = UpdateCampaignSchema.parse(request.body);
        const res = await withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const scopedCampaign = await loadScopedCampaign(client, access, params.id);
            if (!scopedCampaign) {
                return null;
            }
            const { resolvedCampaignId } = scopedCampaign;
            const updated = await client.query(`UPDATE campaigns SET
          title=COALESCE($2, title),
          platform=COALESCE($3, platform),
          payout_amount=COALESCE($4, payout_amount),
          budget_total=COALESCE($5, budget_total),
          media_type=COALESCE($6, media_type),
          media_text=COALESCE($7, media_text),
          media_url=COALESCE($8, media_url),
          status=COALESCE($9, status),
          start_date=COALESCE($10, start_date),
          end_date=COALESCE($11, end_date),
          terms_keep_hours=COALESCE($12, terms_keep_hours),
          terms_min_views=COALESCE($13, terms_min_views),
          terms_requirement=COALESCE($14, terms_requirement)
         WHERE id=$1
         RETURNING *`, [
                resolvedCampaignId,
                body.title ?? null,
                body.platform ?? null,
                body.payout_amount ?? null,
                body.budget_total ?? null,
                body.media_type ?? null,
                body.media_text ?? null,
                body.media_url ?? null,
                body.status ?? null,
                body.start_date ?? null,
                body.end_date ?? null,
                body.terms_keep_hours ?? null,
                body.terms_min_views ?? null,
                body.terms_requirement ?? null
            ]);
            if (updated.rows[0]) {
                await logAudit(client, request.user.sub, 'UPDATE_CAMPAIGN', 'campaign', resolvedCampaignId, body);
                const audience = await collectCampaignNotificationUserIds(client, resolvedCampaignId);
                await createUserNotifications(client, audience, {
                    title: 'Campaign updated by admin',
                    body: `An administrator updated campaign "${updated.rows[0].title ?? 'Campaign'}" (${summarizeCampaignAdminChanges(body)}).`,
                    actorId: request.user.sub,
                    targetType: 'campaign',
                    targetId: resolvedCampaignId,
                    meta: {
                        title: updated.rows[0].title ?? null,
                        public_id: updated.rows[0].public_id ?? null,
                        changes: body,
                    },
                });
            }
            return updated.rows[0];
        });
        if (!res) {
            reply.code(404);
            return { error: 'campaign_not_found' };
        }
        return { campaign: res };
    });
    app.get('/admin/proofs', { preHandler: [app.adminOnly] }, async (request) => {
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const range = parseDateRange(query?.from, query?.to);
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const conditions = [];
            const params = [];
            let idx = 1;
            if (query?.q) {
                conditions.push(`(p.id::text ILIKE $${idx} OR c.id::text ILIKE $${idx} OR c.public_id ILIKE $${idx} OR c.title ILIKE $${idx})`);
                params.push(`%${query.q}%`);
                idx++;
            }
            if (query?.status) {
                conditions.push(`p.status = $${idx}`);
                params.push(query.status);
                idx++;
            }
            if (query?.decision) {
                conditions.push(`p.decision = $${idx}`);
                params.push(query.decision);
                idx++;
            }
            if (range.from) {
                conditions.push(`p.created_at >= $${idx}`);
                params.push(range.from);
                idx++;
            }
            if (range.to) {
                conditions.push(`p.created_at <= $${idx}`);
                params.push(range.to);
                idx++;
            }
            const state = { conditions, params, idx };
            appendTenantScope(state, access, {
                country: 'c.country_id',
                division: 'c.division_id',
            });
            idx = state.idx;
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const res = await client.query(`SELECT
           p.*,
           c.title AS campaign_title,
           s.script AS verification_script,
           p.meta->'verification_report' AS verification_report
         FROM proofs p
         JOIN verification_sessions s ON s.id = p.session_id
         JOIN campaigns c ON c.id = s.campaign_id
         ${where}
         ORDER BY p.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]);
            return { proofs: res.rows };
        });
    });
    app.patch('/admin/proofs/:id', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = UpdateProofSchema.parse(request.body);
        if (!body.status && !body.decision) {
            reply.code(400);
            return { error: 'missing_fields' };
        }
        const res = await withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const proofScope = await client.query(`
        SELECT
          p.id,
          c.country_id,
          c.division_id
        FROM proofs p
        JOIN verification_sessions s ON s.id = p.session_id
        JOIN campaigns c ON c.id = s.campaign_id
        WHERE p.id = $1
        LIMIT 1
        `, [params.id]);
            if (!matchesTenantScope(access, proofScope.rows[0])) {
                return null;
            }
            const updated = await client.query(`UPDATE proofs
         SET status=COALESCE($2, status),
             decision=COALESCE($3, decision)
         WHERE id=$1
         RETURNING *`, [params.id, body.status ?? null, body.decision ?? null]);
            if (updated.rows[0]) {
                await logAudit(client, request.user.sub, 'UPDATE_PROOF', 'proof', params.id, body);
                const proof = updated.rows[0];
                if (proof.status === 'VERIFIED' && proof.decision === 'VERIFIED') {
                    await markContractCompletedForVerifiedProof(client, proof.id);
                    await jobRepo.enqueue(client, 'PAYOUT_PROOF', { proof_id: proof.id });
                }
            }
            return updated.rows[0];
        });
        if (!res) {
            reply.code(404);
            return { error: 'proof_not_found' };
        }
        return { proof: res };
    });
    app.get('/admin/wallets', { preHandler: [app.adminOnly] }, async (request) => {
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const range = parseDateRange(query?.from, query?.to);
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const conditions = [];
            const params = [];
            let idx = 1;
            if (query?.q) {
                conditions.push(`(w.id::text ILIKE $${idx} OR w.user_id::text ILIKE $${idx})`);
                params.push(`%${query.q}%`);
                idx++;
            }
            if (query?.min_amount) {
                conditions.push(`w.balance >= $${idx}`);
                params.push(Number(query.min_amount));
                idx++;
            }
            if (query?.max_amount) {
                conditions.push(`w.balance <= $${idx}`);
                params.push(Number(query.max_amount));
                idx++;
            }
            if (range.from) {
                conditions.push(`w.created_at >= $${idx}`);
                params.push(range.from);
                idx++;
            }
            if (range.to) {
                conditions.push(`w.created_at <= $${idx}`);
                params.push(range.to);
                idx++;
            }
            const state = { conditions, params, idx };
            appendTenantScope(state, access, {
                country: 'u.country_id',
                division: 'u.division_id',
            });
            idx = state.idx;
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const res = await client.query(`SELECT w.*, u.email AS user_email
         FROM wallets w
         JOIN users u ON u.id = w.user_id
         ${where}
         ORDER BY w.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]);
            return { wallets: res.rows };
        });
    });
    app.post('/admin/wallets/:id/adjust', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = AdjustWalletSchema.parse(request.body);
        const result = await withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const walletRes = await client.query(`
        SELECT
          w.*,
          u.country_id,
          u.division_id
        FROM wallets w
        JOIN users u ON u.id = w.user_id
        WHERE w.id = $1
        LIMIT 1
        `, [params.id]);
            const wallet = walletRes.rows[0];
            if (!matchesTenantScope(access, wallet))
                return null;
            const delta = body.direction === 'CREDIT' ? body.amount : -body.amount;
            const updated = await client.query(`UPDATE wallets
         SET balance_available = balance_available + $2,
             balance = balance + $2
         WHERE id = $1
           AND balance_available + $2 >= 0
           AND balance + $2 >= 0
         RETURNING *`, [params.id, delta]);
            if (!updated.rows[0]) {
                reply.code(400);
                return { error: 'wallet_balance_too_low' };
            }
            await client.query('INSERT INTO wallet_txns (wallet_id, amount, direction, reference) VALUES ($1,$2,$3,$4)', [params.id, body.amount, body.direction, body.reference ?? 'ADMIN_ADJUST']);
            await logAudit(client, request.user.sub, 'ADJUST_WALLET', 'wallet', params.id, { amount: body.amount, direction: body.direction, reference: body.reference });
            return updated.rows[0];
        });
        if (result?.error === 'wallet_balance_too_low') {
            return result;
        }
        if (!result) {
            reply.code(404);
            return { error: 'wallet_not_found' };
        }
        return { wallet: result };
    });
    app.get('/admin/wallets/:id/txns', { preHandler: [app.adminOnly] }, async (request) => {
        const params = request.params;
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const scopeFilter = access.admin_role === ADMIN_ROLE_COUNTRY_ADMIN
                ? {
                    sql: 'AND u.country_id = $2',
                    params: [access.country_id],
                }
                : access.admin_role === ADMIN_ROLE_DIVISION_ADMIN
                    ? {
                        sql: 'AND u.division_id = $2',
                        params: [access.division_id],
                    }
                    : {
                        sql: '',
                        params: [],
                    };
            const res = await client.query(`SELECT wt.*
         FROM wallet_txns wt
         JOIN wallets w ON w.id = wt.wallet_id
         JOIN users u ON u.id = w.user_id
         WHERE wt.wallet_id = $1
         ${scopeFilter.sql}
         ORDER BY wt.created_at DESC
         LIMIT 200`, [params.id, ...scopeFilter.params]);
            return { txns: res.rows };
        });
    });
    app.get('/admin/escrows', { preHandler: [app.adminOnly] }, async (request) => {
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const range = parseDateRange(query?.from, query?.to);
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const conditions = [];
            const params = [];
            let idx = 1;
            if (query?.q) {
                conditions.push(`(c.title ILIKE $${idx} OR c.id::text ILIKE $${idx} OR c.public_id ILIKE $${idx} OR e.id::text ILIKE $${idx})`);
                params.push(`%${query.q}%`);
                idx++;
            }
            if (query?.status) {
                conditions.push(`e.status = $${idx}`);
                params.push(query.status);
                idx++;
            }
            if (query?.min_amount) {
                conditions.push(`e.amount_total >= $${idx}`);
                params.push(Number(query.min_amount));
                idx++;
            }
            if (query?.max_amount) {
                conditions.push(`e.amount_total <= $${idx}`);
                params.push(Number(query.max_amount));
                idx++;
            }
            if (range.from) {
                conditions.push(`e.created_at >= $${idx}`);
                params.push(range.from);
                idx++;
            }
            if (range.to) {
                conditions.push(`e.created_at <= $${idx}`);
                params.push(range.to);
                idx++;
            }
            const state = { conditions, params, idx };
            appendTenantScope(state, access, {
                country: 'c.country_id',
                division: 'c.division_id',
            });
            idx = state.idx;
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const res = await client.query(`SELECT e.*, c.title AS campaign_title
         FROM escrow_ledger e
         JOIN campaigns c ON c.id = e.campaign_id
         ${where}
         ORDER BY e.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]);
            return { escrows: res.rows };
        });
    });
    app.patch('/admin/escrows/:id', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = UpdateEscrowSchema.parse(request.body);
        const res = await withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const scopeRes = await client.query(`
        SELECT
          e.id,
          c.country_id,
          c.division_id
        FROM escrow_ledger e
        JOIN campaigns c ON c.id = e.campaign_id
        WHERE e.id = $1
        LIMIT 1
        `, [params.id]);
            if (!matchesTenantScope(access, scopeRes.rows[0])) {
                return null;
            }
            const updated = await client.query('UPDATE escrow_ledger SET status=$2 WHERE id=$1 RETURNING *', [params.id, body.status]);
            if (updated.rows[0]) {
                await logAudit(client, request.user.sub, 'UPDATE_ESCROW', 'escrow', params.id, { status: body.status });
            }
            return updated.rows[0];
        });
        if (!res) {
            reply.code(404);
            return { error: 'escrow_not_found' };
        }
        return { escrow: res };
    });
    app.get('/admin/payout-requests', { preHandler: [app.adminOnly] }, async (request) => {
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const range = parseDateRange(query?.from, query?.to);
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const conditions = [];
            const params = [];
            let idx = 1;
            if (query?.q) {
                conditions.push(`(p.id::text ILIKE $${idx} OR COALESCE(p.pesapal_reference, '') ILIKE $${idx} OR u.email ILIKE $${idx} OR u.phone ILIKE $${idx} OR u.id::text ILIKE $${idx})`);
                params.push(`%${query.q}%`);
                idx++;
            }
            if (query?.status) {
                conditions.push(`p.status = $${idx}`);
                params.push(query.status);
                idx++;
            }
            if (query?.min_amount) {
                conditions.push(`p.amount >= $${idx}`);
                params.push(Number(query.min_amount));
                idx++;
            }
            if (query?.max_amount) {
                conditions.push(`p.amount <= $${idx}`);
                params.push(Number(query.max_amount));
                idx++;
            }
            if (range.from) {
                conditions.push(`p.created_at >= $${idx}`);
                params.push(range.from);
                idx++;
            }
            if (range.to) {
                conditions.push(`p.created_at <= $${idx}`);
                params.push(range.to);
                idx++;
            }
            const state = { conditions, params, idx };
            appendTenantScope(state, access, {
                country: 'u.country_id',
                division: 'u.division_id',
            });
            idx = state.idx;
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const res = await client.query(`SELECT p.*, u.email AS user_email
         FROM payout_requests p
         JOIN users u ON u.id = p.user_id
         ${where}
         ORDER BY p.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]);
            return { payouts: res.rows };
        });
    });
    app.get('/admin/contracts', { preHandler: [app.adminOnly] }, async (request) => {
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const range = parseDateRange(query?.from, query?.to);
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const conditions = [];
            const params = [];
            let idx = 1;
            if (query?.q) {
                conditions.push(`(c.title ILIKE $${idx} OR c.id::text ILIKE $${idx} OR u.email ILIKE $${idx} OR u.id::text ILIKE $${idx} OR adv.email ILIKE $${idx} OR adv.id::text ILIKE $${idx})`);
                params.push(`%${query.q}%`);
                idx++;
            }
            if (query?.status) {
                conditions.push(`ctr.status = $${idx}`);
                params.push(query.status);
                idx++;
            }
            if (range.from) {
                conditions.push(`ctr.created_at >= $${idx}`);
                params.push(range.from);
                idx++;
            }
            if (range.to) {
                conditions.push(`ctr.created_at <= $${idx}`);
                params.push(range.to);
                idx++;
            }
            const state = { conditions, params, idx };
            appendTenantScope(state, access, {
                country: 'c.country_id',
                division: 'c.division_id',
            });
            idx = state.idx;
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const res = await client.query(`SELECT ctr.*, c.title AS campaign_title, u.email AS distributor_email, adv.email AS advertiser_email FROM contracts ctr JOIN campaigns c ON c.id = ctr.campaign_id JOIN users u ON u.id = ctr.distributor_id JOIN users adv ON adv.id = c.advertiser_id
         ${where}
         ORDER BY ctr.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]);
            return { contracts: res.rows };
        });
    });
    app.patch('/admin/contracts/:id', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = UpdateContractSchema.parse(request.body);
        if (!body.status && !body.distributor_id) {
            reply.code(400);
            return { error: 'missing_fields' };
        }
        const res = await withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const scopeRes = await client.query(`
        SELECT
          ctr.id,
          c.country_id,
          c.division_id
        FROM contracts ctr
        JOIN campaigns c ON c.id = ctr.campaign_id
        WHERE ctr.id = $1
        LIMIT 1
        `, [params.id]);
            const scopedContract = scopeRes.rows[0] ?? null;
            if (!matchesTenantScope(access, scopedContract)) {
                return null;
            }
            if (body.distributor_id) {
                const distributorRes = await client.query(`
          SELECT id, country_id, division_id
          FROM users
          WHERE id = $1
          LIMIT 1
          `, [body.distributor_id]);
                const distributor = distributorRes.rows[0] ?? null;
                if (!distributor) {
                    reply.code(404);
                    return { error: 'distributor_not_found' };
                }
                const sameTenant = String(distributor.country_id ?? '') ===
                    String(scopedContract.country_id ?? '') &&
                    (!scopedContract.division_id ||
                        String(distributor.division_id ?? '') ===
                            String(scopedContract.division_id ?? ''));
                if (!sameTenant || !matchesTenantScope(access, distributor)) {
                    reply.code(409);
                    return { error: 'distributor_scope_mismatch' };
                }
            }
            const updated = await client.query(`UPDATE contracts
         SET status=COALESCE($2, status),
             distributor_id=COALESCE($3, distributor_id)
         WHERE id=$1
         RETURNING *`, [params.id, body.status ?? null, body.distributor_id ?? null]);
            if (updated.rows[0]) {
                await logAudit(client, request.user.sub, 'UPDATE_CONTRACT', 'contract', params.id, body);
            }
            return updated.rows[0];
        });
        if (res?.error === 'distributor_not_found' ||
            res?.error === 'distributor_scope_mismatch') {
            return res;
        }
        if (!res) {
            reply.code(404);
            return { error: 'contract_not_found' };
        }
        return { contract: res };
    });
    app.get('/admin/jobs', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        return withTransaction(async (client) => {
            const access = await requireSuperDashboardAccess(client, request, reply);
            if (!access) {
                return { error: 'forbidden' };
            }
            const conditions = [];
            const params = [];
            let idx = 1;
            if (query?.status) {
                conditions.push(`status = $${idx}`);
                params.push(query.status);
                idx++;
            }
            if (query?.q) {
                conditions.push(`(job_type ILIKE $${idx} OR id::text ILIKE $${idx})`);
                params.push(`%${query.q}%`);
                idx++;
            }
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const res = await client.query(`SELECT * FROM job_queue ${where} ORDER BY updated_at DESC LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]);
            return { jobs: res.rows };
        });
    });
    app.patch('/admin/jobs/:id', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = UpdateJobSchema.parse(request.body);
        const res = await withTransaction(async (client) => {
            const access = await requireSuperDashboardAccess(client, request, reply);
            if (!access) {
                return { error: 'forbidden' };
            }
            const updated = await client.query(`UPDATE job_queue
         SET status=COALESCE($2, status),
             attempts=COALESCE($3, attempts),
             last_error=COALESCE($4, last_error),
             retry_reason=COALESCE($5, retry_reason),
             updated_at=now()
         WHERE id=$1 RETURNING *`, [params.id, body.status ?? null, body.attempts ?? null, body.last_error ?? null, body.retry_reason ?? null]);
            if (updated.rows[0]) {
                await logAudit(client, request.user.sub, 'UPDATE_JOB', 'job', params.id, body);
            }
            return updated.rows[0];
        });
        if (res?.error === 'forbidden') {
            return res;
        }
        if (!res) {
            reply.code(404);
            return { error: 'job_not_found' };
        }
        return { job: res };
    });
    app.post('/admin/jobs/:id/retry', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = (request.body ?? {});
        const res = await withTransaction(async (client) => {
            const access = await requireSuperDashboardAccess(client, request, reply);
            if (!access) {
                return { error: 'forbidden' };
            }
            const updated = await client.query(`UPDATE job_queue
         SET status='QUEUED',
             attempts=0,
             retry_reason=COALESCE($2, retry_reason),
             run_at=now(),
             updated_at=now()
         WHERE id=$1 RETURNING *`, [params.id, body.reason ?? null]);
            if (updated.rows[0]) {
                await logAudit(client, request.user.sub, 'RETRY_JOB', 'job', params.id, { reason: body.reason ?? null });
            }
            return updated.rows[0];
        });
        if (res?.error === 'forbidden') {
            return res;
        }
        if (!res) {
            reply.code(404);
            return { error: 'job_not_found' };
        }
        return { job: res };
    });
    app.patch('/admin/payout-requests/:id', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = UpdatePayoutSchema.parse(request.body);
        const res = await withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const scopeRes = await client.query(`
        SELECT
          p.id,
          u.country_id,
          u.division_id
        FROM payout_requests p
        JOIN users u ON u.id = p.user_id
        WHERE p.id = $1
        LIMIT 1
        `, [params.id]);
            if (!matchesTenantScope(access, scopeRes.rows[0])) {
                return null;
            }
            const updated = await client.query('UPDATE payout_requests SET status=$2 WHERE id=$1 RETURNING *', [params.id, body.status]);
            if (updated.rows[0]) {
                await logAudit(client, request.user.sub, 'UPDATE_PAYOUT', 'payout', params.id, { status: body.status });
            }
            return updated.rows[0];
        });
        if (!res) {
            reply.code(404);
            return { error: 'payout_not_found' };
        }
        return { payout: res };
    });
    const yoAdminRouteBase = '/admin/yo-uganda';
    const legacyFlutterwaveAdminRouteBase = '/admin/flutterwave';
    const listYoUgandaTransactions = async (request, reply) => {
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const range = parseDateRange(query?.from, query?.to);
        return withTransaction(async (client) => {
            const access = await requireSuperDashboardAccess(client, request, reply);
            if (!access) {
                return { error: 'forbidden' };
            }
            const conditions = [];
            const params = [];
            let idx = 1;
            if (query?.q) {
                conditions.push(`(merchant_reference ILIKE $${idx} OR COALESCE(transaction_reference, '') ILIKE $${idx} OR id::text ILIKE $${idx})`);
                params.push(`%${query.q}%`);
                idx++;
            }
            if (query?.status) {
                conditions.push(`status = $${idx}`);
                params.push(query.status);
                idx++;
            }
            if (query?.type) {
                conditions.push(`type = $${idx}`);
                params.push(query.type);
                idx++;
            }
            if (query?.min_amount) {
                conditions.push(`amount >= $${idx}`);
                params.push(Number(query.min_amount));
                idx++;
            }
            if (query?.max_amount) {
                conditions.push(`amount <= $${idx}`);
                params.push(Number(query.max_amount));
                idx++;
            }
            if (range.from) {
                conditions.push(`created_at >= $${idx}`);
                params.push(range.from);
                idx++;
            }
            if (range.to) {
                conditions.push(`created_at <= $${idx}`);
                params.push(range.to);
                idx++;
            }
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const res = await client.query(`SELECT * FROM pesapal_transactions ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]);
            return { transactions: res.rows };
        });
    };
    const listYoUgandaWebhooks = async (request, reply) => {
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const range = parseDateRange(query?.from, query?.to);
        return withTransaction(async (client) => {
            const access = await requireSuperDashboardAccess(client, request, reply);
            if (!access) {
                return { error: 'forbidden' };
            }
            const conditions = [];
            const params = [];
            let idx = 1;
            if (query?.q) {
                conditions.push(`(event_id ILIKE $${idx})`);
                params.push(`%${query.q}%`);
                idx++;
            }
            if (range.from) {
                conditions.push(`received_at >= $${idx}`);
                params.push(range.from);
                idx++;
            }
            if (range.to) {
                conditions.push(`received_at <= $${idx}`);
                params.push(range.to);
                idx++;
            }
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const res = await client.query(`SELECT * FROM pesapal_webhook_events ${where} ORDER BY received_at DESC LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]);
            return { webhooks: res.rows };
        });
    };
    const replayYoUgandaWebhook = async (request, reply) => {
        const params = request.params;
        return withTransaction(async (client) => {
            const access = await requireSuperDashboardAccess(client, request, reply);
            if (!access) {
                return { error: 'forbidden' };
            }
            const res = await client.query('SELECT * FROM pesapal_webhook_events WHERE event_id=$1', [params.eventId]);
            const event = res.rows[0];
            if (!event) {
                reply.code(404);
                return { error: 'event_not_found' };
            }
            const body = event.payload ?? {};
            const reference = body.reference ?? body.merchant_reference ?? body.OrderMerchantReference ?? body.merchantReference;
            const trackingId = body.OrderTrackingId ?? body.orderTrackingId ?? body.id ?? body.event_id ?? body.tracking_id;
            const statusRaw = (body.status ?? body.payment_status_description ?? '').toString().toUpperCase();
            // Heuristic: payout webhooks usually have status + reference
            const isPayout = Boolean(body.status || body.tracking_id || body.merchant_reference);
            if (isPayout && reference) {
                const payoutRows = await client.query('SELECT * FROM payout_requests WHERE pesapal_reference=$1', [reference]);
                const payout = payoutRows.rows[0];
                if (!payout) {
                    reply.code(404);
                    return { error: 'payout_not_found' };
                }
                if (statusRaw.includes('PAID') || statusRaw.includes('COMPLETED') || statusRaw.includes('SUCCESS')) {
                    await paymentRepo.updatePayoutStatus(client, payout.id, 'PAID', reference);
                }
                else if (statusRaw.includes('FAILED')) {
                    await paymentRepo.updatePayoutStatus(client, payout.id, 'FAILED', reference);
                }
                await logAudit(client, request.user.sub, 'REPLAY_WEBHOOK_PAYOUT', 'payout', payout.id, { event_id: params.eventId });
                return { ok: true, type: 'PAYOUT' };
            }
            if (trackingId && reference) {
                const statusResponse = (await verifyTransaction(String(trackingId)));
                const statusInfo = (statusResponse.data ?? statusResponse);
                const txnRows = await client.query('SELECT * FROM pesapal_transactions WHERE merchant_reference=$1', [reference]);
                const txn = txnRows.rows[0];
                if (!txn) {
                    reply.code(404);
                    return { error: 'txn_not_found' };
                }
                const amountRaw = statusInfo.amount ?? statusInfo.Amount;
                const amount = typeof amountRaw === 'string' ? parseInt(amountRaw, 10) : Number(amountRaw ?? 0);
                const escrowRows = await client.query('SELECT * FROM escrow_ledger WHERE id=$1', [txn.escrow_id]);
                const escrow = escrowRows.rows[0];
                if (!escrow || amount !== escrow.amount_total) {
                    reply.code(400);
                    return { error: 'amount_mismatch' };
                }
                const statusText = ((statusInfo.status ?? statusInfo.payment_status_description) ?? '')
                    .toString()
                    .toUpperCase();
                if (statusText.includes('COMPLETED') || statusText.includes('SUCCESS')) {
                    await paymentRepo.updatePesaPalTxnStatus(client, reference, 'COMPLETED', String(trackingId));
                    await paymentRepo.markEscrowFunded(client, escrow.id, txn.id);
                }
                else if (statusText.includes('FAILED')) {
                    await paymentRepo.updatePesaPalTxnStatus(client, reference, 'FAILED', String(trackingId));
                }
                await logAudit(client, request.user.sub, 'REPLAY_WEBHOOK_IPN', 'escrow', escrow.id, { event_id: params.eventId });
                return { ok: true, type: 'IPN' };
            }
            reply.code(400);
            return { error: 'unhandled_payload' };
        });
    };
    for (const routeBase of [yoAdminRouteBase, legacyFlutterwaveAdminRouteBase]) {
        app.get(`${routeBase}/transactions`, { preHandler: [app.adminOnly] }, listYoUgandaTransactions);
        app.get(`${routeBase}/webhooks`, { preHandler: [app.adminOnly] }, listYoUgandaWebhooks);
        app.post(`${routeBase}/webhooks/:eventId/replay`, { preHandler: [app.adminOnly] }, replayYoUgandaWebhook);
    }
}
