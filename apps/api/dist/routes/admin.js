import crypto from 'crypto';
import { z } from 'zod';
import { ADMIN_MODULE_ADMIN_MANAGEMENT, ADMIN_MODULE_AUDIT_LOGS, ADMIN_MODULE_CAMPAIGNS, ADMIN_MODULE_DRAFTS, ADMIN_MODULE_ESCROWS, ADMIN_MODULE_FINANCE, ADMIN_MODULE_GATEWAY, ADMIN_MODULE_OVERVIEW, ADMIN_MODULE_PAYOUT_REQUESTS, ADMIN_MODULE_PROOFS, ADMIN_MODULE_RISK, ADMIN_MODULE_SESSIONS, ADMIN_MODULE_USERS, ADMIN_MODULE_WITHDRAWALS, ADMIN_ROLE_ADMIN, ADMIN_ROLE_SUPER_ADMIN, ASSIGNABLE_ADMIN_MODULE_KEYS, adminModuleDefinitions, recordCampaignRevenueEntry, normalizeAdminModuleKey, } from '@prime/shared';
import { withTransaction } from '../db.js';
import { hashPassword } from '../services/auth.js';
import { config } from '../config.js';
import { resolveCountry } from '../countryResolver.js';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import { JobRepo } from '../repositories/jobRepo.js';
import { verifyTransaction } from '../services/yoUganda.js';
import { buildCampaignStatusSummaries } from './campaigns.js';
import { ensurePublicIdColumns, resolveCampaignId, resolveUserId, } from '../services/publicId.js';
import { ACCOUNT_ROLE_ADMIN, ACCOUNT_ROLE_BUSINESS, ACCOUNT_ROLE_AMBASSADOR, ACCOUNT_ROLE_DUAL_USER, normalizeAccountRole, normalizeActiveRole, } from '../services/roles.js';
import { appendDashboardTenantScope, ensureAdminAccountRecord, grantAdminModuleAssignments, hasAdminModuleAccess, isSuperDashboardAccess as hasSuperDashboardAccess, loadDashboardAccessContext, matchesDashboardTenantScope, replaceAdminModuleAssignments, replaceAdminScopeAssignments, resolveLiveDashboardAccess, } from '../services/adminTenant.js';
import { collectCampaignNotificationUserIds, createBlockingNotice, createUserNotifications, ensureUserSignalSchema, removeBlockingNotice, } from '../services/userSignals.js';
import { auditScopeFromAccess, recordAdminAudit } from '../services/adminAudit.js';
import { acknowledgeAdminOperationTask, claimAdminOperationTask, createAdminOperationMessage, ensureAdminOperationsSchema, loadAdminOperationTaskState, loadAdminOperationsSnapshot, releaseAdminOperationTaskClaim, resolveAdminOperationTaskByEntity, } from '../services/adminOperations.js';
import { ADMIN_HANDLER_JAZ_MESSAGE_TTL_HOURS, ADMIN_HANDLER_JAZ_ROOM_KEY, cleanupAdminHandlerJaz, createAdminHandlerJazMessage, createAdminHandlerJazSignalEvent, deactivateAdminHandlerJazPresence, ensureAdminHandlerJazSchema, listAdminHandlerJazMessages, listAdminHandlerJazParticipants, listAdminHandlerJazSignalEvents, loadAdminHandlerJazIdentity, maxLiveCursor, parseLiveCursor, timestampText, upsertAdminHandlerJazIdentity, upsertAdminHandlerJazPresence, } from '../services/adminHandlerJaz.js';
import { resolveMediaUploadError, storeMultipartAttachmentFile, } from '../services/mediaUploads.js';
import { ensureUserProfilesTable } from '../services/userProfiles.js';
import { ensureViewerVerificationSchema } from '../services/viewerVerification.js';
const UpdateUserRoleSchema = z.object({
    role: z
        .string()
        .trim()
        .transform((value, ctx) => {
        const role = normalizeAccountRole(value);
        if (role === ACCOUNT_ROLE_ADMIN ||
            role === ACCOUNT_ROLE_BUSINESS ||
            role === ACCOUNT_ROLE_AMBASSADOR ||
            role === ACCOUNT_ROLE_DUAL_USER) {
            return role;
        }
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Invalid role.',
        });
        return z.NEVER;
    }),
});
const UpdateUserStatusSchema = z.object({
    status: z.enum(['ACTIVE', 'SUSPENDED', 'BANNED']),
    reason: z.string().trim().max(500).optional().nullable(),
});
const UpdateUserContractPrivilegeSchema = z.object({
    can_multi_contract: z.boolean()
});
const CreateBlockingNoticeSchema = z
    .object({
    title: z.string().trim().min(3).max(120),
    body: z.string().trim().min(6).max(4000),
    send_to_all: z.boolean().default(false),
    user_ids: z.array(z.string().trim().min(1).max(120)).max(500).default([]),
})
    .superRefine((value, ctx) => {
    if (!value.send_to_all && value.user_ids.length == 0) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['user_ids'],
            message: 'Select at least one user or enable send_to_all.',
        });
    }
});
const ResetPasswordSchema = z.object({
    password: z.string().min(8)
});
const HandlerJazIdentitySchema = z.object({
    handle: z.string().trim().min(2).max(32),
});
const HandlerJazPresenceSchema = z.object({
    handle: z.string().trim().min(2).max(32).optional(),
    current_pane: z.string().trim().min(1).max(64).optional(),
    is_room_open: z.boolean().optional(),
    is_minimized: z.boolean().optional(),
    in_call: z.boolean().optional(),
    call_mode: z.enum(['NONE', 'AUDIO', 'VIDEO']).optional(),
    screen_share_active: z.boolean().optional(),
    call_session_id: z.string().trim().max(128).optional().nullable(),
});
const HandlerJazMessageSchema = z.object({
    body: z.string().trim().max(4000).default(''),
    attachment_url: z.string().trim().max(2048).optional(),
    attachment_name: z.string().trim().max(255).optional(),
    attachment_mime_type: z.string().trim().max(255).optional(),
}).refine((value) => value.body.trim().length > 0 ||
    (typeof value.attachment_url === 'string' &&
        value.attachment_url.trim().length > 0), {
    message: 'A message body or attachment is required.',
    path: ['body'],
});
const HandlerJazSignalSchema = z.object({
    event_type: z.string().trim().min(2).max(80),
    target_user_id: z.string().uuid().optional().nullable(),
    payload: z.record(z.string(), z.unknown()).default({}),
});
const UpdateProofSchema = z.object({
    status: z.enum(['PENDING', 'VERIFIED', 'REJECTED', 'MANUAL_REVIEW']).optional(),
    decision: z.enum(['VERIFIED', 'REJECTED', 'MANUAL_REVIEW']).optional(),
    observed_views: z.number().int().nonnegative().optional(),
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
    ambassador_id: z.string().uuid().optional()
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
const ManagedAdminRoleSchema = z.enum(['SUPER_ADMIN', 'ADMIN']);
const ManagedAdminStatusSchema = z.enum(['ACTIVE', 'SUSPENDED', 'DELETED']);
const CreateAdminSchema = z
    .object({
    user_id: z.string().trim().min(1).optional(),
    full_name: z.string().trim().min(2).max(120).optional(),
    email: z.string().email().optional(),
    phone: z.string().trim().min(7).max(20).optional(),
    password: z.string().min(8).optional(),
    role: ManagedAdminRoleSchema.default('ADMIN'),
    status: z.enum(['ACTIVE', 'SUSPENDED']).default('ACTIVE'),
    module_keys: z.array(z.string()).default([]),
    country_ids: z.array(z.string().uuid()).default([]),
    division_ids: z.array(z.string().uuid()).default([]),
})
    .refine((value) => Boolean(value.user_id ||
    (value.full_name && value.email && value.phone && value.password)), {
    message: 'user_id or full_name/email/phone/password is required',
});
const UpdateAdminSchema = z
    .object({
    full_name: z.string().trim().min(2).max(120).optional(),
    email: z.string().email().optional(),
    phone: z.string().trim().min(7).max(20).optional(),
    role: ManagedAdminRoleSchema.optional(),
    module_keys: z.array(z.string()).optional(),
    country_ids: z.array(z.string().uuid()).optional(),
    division_ids: z.array(z.string().uuid()).optional(),
})
    .refine((value) => value.full_name !== undefined ||
    value.email !== undefined ||
    value.phone !== undefined ||
    value.role !== undefined ||
    value.module_keys !== undefined ||
    value.country_ids !== undefined ||
    value.division_ids !== undefined, {
    message: 'at least one field is required',
});
const UpdateManagedAdminStatusSchema = z.object({
    status: z.enum(['ACTIVE', 'SUSPENDED']),
});
const ManageAdminPermissionsSchema = z.object({
    module_keys: z.array(z.string()).default([]),
});
const AdminListQuerySchema = z.object({
    q: z.string().optional(),
    role: ManagedAdminRoleSchema.optional(),
    status: ManagedAdminStatusSchema.optional(),
    limit: z.string().optional(),
    offset: z.string().optional(),
});
const AdminOperationsTaskActionSchema = z.object({
    minutes: z.number().int().min(1).max(120).optional(),
});
const AdminOperationsMessageSchema = z.object({
    body: z.string().trim().min(1).max(2000),
});
const AdminSettingsPatchSchema = z
    .object({
    campaign_approval_mode: z.enum(['AUTO', 'MANUAL']).optional(),
    operations_sla_minutes: z.number().int().min(5).max(120).optional(),
    operations_ack_minutes: z.number().int().min(1).max(120).optional(),
})
    .refine((value) => value.campaign_approval_mode !== undefined ||
    value.operations_sla_minutes !== undefined ||
    value.operations_ack_minutes !== undefined, {
    message: 'at least one field is required',
});
function appendTenantScope(state, access, scope) {
    appendDashboardTenantScope(state, access, scope);
}
function matchesTenantScope(access, row) {
    return matchesDashboardTenantScope(access, row);
}
function isSuperDashboardAccess(access) {
    return hasSuperDashboardAccess(access);
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
    return resolveLiveDashboardAccess(client, request);
}
async function requireSuperDashboardAccess(client, request, reply) {
    const access = await getLiveDashboardAccess(client, request);
    if (!isSuperDashboardAccess(access)) {
        reply.code(403);
        return null;
    }
    return access;
}
async function requireModuleAccess(client, request, reply, moduleKey) {
    const access = await getLiveDashboardAccess(client, request);
    if (!hasAdminModuleAccess(access, moduleKey)) {
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
const ACTIVE_BLOCKING_NOTICE_SELECT_SQL = `
  active_notice.id AS active_admin_notice_id,
  active_notice.title AS active_admin_notice_title,
  active_notice.created_at AS active_admin_notice_created_at
`;
const ACTIVE_BLOCKING_NOTICE_JOIN_SQL = `
  LEFT JOIN LATERAL (
    SELECT notice.id, notice.title, notice.created_at
    FROM admin_blocking_notice_targets target
    JOIN admin_blocking_notices notice
      ON notice.id = target.notice_id
    WHERE target.user_id = u.id
      AND notice.removed_at IS NULL
    ORDER BY notice.created_at DESC
    LIMIT 1
  ) active_notice ON TRUE
`;
function appendNoticeEligibleUserFilters(state, access, userAlias = 'u') {
    state.conditions.push(`${userAlias}.role <> 'ADMIN'`);
    appendTenantScope(state, access, {
        country: `${userAlias}.country_id`,
        division: `${userAlias}.division_id`,
    });
}
async function loadAllScopedNoticeTargetUsers(client, access) {
    const state = {
        conditions: [],
        params: [],
        idx: 1,
    };
    appendNoticeEligibleUserFilters(state, access);
    const where = state.conditions.length
        ? `WHERE ${state.conditions.join(' AND ')}`
        : '';
    const res = await client.query(`
    SELECT u.id, u.full_name, u.email, u.country_id, u.division_id
    FROM users u
    ${where}
    ORDER BY u.created_at DESC
    `, state.params);
    return res.rows;
}
async function loadScopedNoticeTargetUsers(client, access, rawUserIds) {
    await ensurePublicIdColumns(client);
    const resolvedUserIds = Array.from(new Set((await Promise.all(rawUserIds.map((value) => resolveUserId(client, value)))).filter((value) => Boolean(value))));
    if (resolvedUserIds.length === 0) {
        return [];
    }
    const res = await client.query(`
    SELECT id, role, full_name, email, country_id, division_id
    FROM users
    WHERE id = ANY($1::uuid[])
    `, [resolvedUserIds]);
    return res.rows.filter((row) => String(row.role ?? '').trim().toUpperCase() !== 'ADMIN' &&
        matchesTenantScope(access, row));
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
      AND ambassador_id=$2
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
function parseBooleanFlag(value, fallback = true) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (normalized === '1' || normalized === 'true' || normalized === 'yes') {
        return true;
    }
    if (normalized === '0' || normalized === 'false' || normalized === 'no') {
        return false;
    }
    return fallback;
}
function normalizeManagedAdminStatus(value) {
    const status = String(value ?? '').trim().toUpperCase();
    if (status === 'ACTIVE')
        return 'ACTIVE';
    if (status === 'SUSPENDED')
        return 'SUSPENDED';
    if (status === 'DELETED' || status === 'BANNED')
        return 'DELETED';
    return 'NONE';
}
function uniqueStringValues(values) {
    return Array.from(new Set(Array.from(values, (value) => String(value ?? '').trim()).filter(Boolean)));
}
function normalizeAssignableModuleKeys(values) {
    const normalized = [];
    for (const value of values) {
        const moduleKey = normalizeAdminModuleKey(value);
        if (!moduleKey) {
            continue;
        }
        if (moduleKey === ADMIN_MODULE_OVERVIEW ||
            moduleKey === ADMIN_MODULE_ADMIN_MANAGEMENT) {
            continue;
        }
        if (!ASSIGNABLE_ADMIN_MODULE_KEYS.includes(moduleKey)) {
            continue;
        }
        normalized.push(moduleKey);
    }
    return Array.from(new Set(normalized));
}
async function ensureUniqueAdminIdentity(client, input, excludeUserId) {
    const email = String(input.email ?? '').trim().toLowerCase();
    if (email) {
        const res = await client.query(`
      SELECT id
      FROM users
      WHERE email = $1
        AND ($2::uuid IS NULL OR id <> $2::uuid)
      LIMIT 1
      `, [email, excludeUserId ?? null]);
        if (res.rows[0]) {
            throw new Error('email_taken');
        }
    }
    const phone = String(input.phone ?? '').trim();
    if (phone) {
        const res = await client.query(`
      SELECT id
      FROM users
      WHERE phone = $1
        AND ($2::uuid IS NULL OR id <> $2::uuid)
      LIMIT 1
      `, [phone, excludeUserId ?? null]);
        if (res.rows[0]) {
            throw new Error('phone_taken');
        }
    }
}
async function validateAdminScopeAssignments(client, input) {
    const countryIds = uniqueStringValues(input.countryIds ?? []);
    const divisionIds = uniqueStringValues(input.divisionIds ?? []);
    const countryRowsById = new Map();
    if (countryIds.length > 0) {
        const countryRes = await client.query(`
      SELECT id, code, name
      FROM countries
      WHERE id = ANY($1::uuid[])
      `, [countryIds]);
        for (const row of countryRes.rows) {
            countryRowsById.set(String(row.id), {
                id: String(row.id),
                code: row.code ? String(row.code) : null,
                name: row.name ? String(row.name) : null,
            });
        }
        if (countryRowsById.size !== countryIds.length) {
            throw new Error('country_scope_not_found');
        }
    }
    const divisionRowsById = new Map();
    if (divisionIds.length > 0) {
        const divisionRes = await client.query(`
      SELECT
        d.id,
        d.name,
        d.type,
        d.country_id,
        c.code AS country_code,
        c.name AS country_name
      FROM divisions d
      JOIN countries c ON c.id = d.country_id
      WHERE d.id = ANY($1::uuid[])
      `, [divisionIds]);
        for (const row of divisionRes.rows) {
            divisionRowsById.set(String(row.id), {
                id: String(row.id),
                name: row.name ? String(row.name) : null,
                type: row.type ? String(row.type) : null,
                country_id: String(row.country_id),
                country_code: row.country_code ? String(row.country_code) : null,
                country_name: row.country_name ? String(row.country_name) : null,
            });
        }
        if (divisionRowsById.size !== divisionIds.length) {
            throw new Error('division_scope_not_found');
        }
    }
    const orderedCountryRows = countryIds.map((countryId) => countryRowsById.get(countryId));
    const orderedDivisionRows = divisionIds.map((divisionId) => divisionRowsById.get(divisionId));
    const primaryDivision = orderedDivisionRows[0] ?? null;
    const primaryCountry = orderedCountryRows[0] ??
        (primaryDivision
            ? {
                id: primaryDivision.country_id,
                code: primaryDivision.country_code,
                name: primaryDivision.country_name,
            }
            : null);
    return {
        countryIds,
        divisionIds,
        countryRows: orderedCountryRows,
        divisionRows: orderedDivisionRows,
        primaryCountry,
        primaryDivision,
    };
}
async function createManagedAdminUser(client, input) {
    const fallbackCountryCode = String(input.primaryCountry?.code ?? 'UG')
        .trim()
        .toUpperCase() || 'UG';
    const countryProfile = resolveCountry(fallbackCountryCode);
    await ensureUniqueAdminIdentity(client, {
        email: input.email,
        phone: input.phone,
    });
    const res = await client.query(`
    INSERT INTO users (
      full_name,
      email,
      phone,
      password_hash,
      role,
      active_role,
      country,
      preferred_currency,
      admin_role,
      country_id,
      division_id
    )
    VALUES ($1,$2,$3,$4,'ADMIN','ADMIN',$5,$6,$7,$8,$9)
    RETURNING *
    `, [
        input.full_name.trim(),
        input.email.trim().toLowerCase(),
        input.phone.trim(),
        hashPassword(input.password),
        countryProfile.iso2,
        countryProfile.currency,
        input.role,
        input.primaryCountry?.id ?? null,
        input.primaryDivision?.id ?? null,
    ]);
    return res.rows[0];
}
async function loadManagedAdminTarget(client, rawUserId) {
    await ensurePublicIdColumns(client);
    const resolvedUserId = await resolveUserId(client, rawUserId);
    if (!resolvedUserId) {
        return null;
    }
    const userRes = await client.query(`
    SELECT
      u.id,
      u.public_id,
      u.full_name,
      u.email,
      u.phone,
      u.status AS user_status,
      u.role,
      u.active_role,
      u.admin_role AS legacy_admin_role,
      u.country,
      u.country_id,
      u.division_id,
      u.created_at AS user_created_at,
      u.updated_at AS user_updated_at,
      au.id AS admin_user_id,
      au.role AS admin_account_role,
      au.status AS admin_account_status,
      au.created_by_super_admin_id,
      au.last_login_at,
      au.created_at AS admin_created_at,
      au.updated_at AS admin_updated_at
    FROM users u
    LEFT JOIN admin_users au ON au.user_id = u.id
    WHERE u.id = $1
    LIMIT 1
    `, [resolvedUserId]);
    const row = userRes.rows[0] ?? null;
    if (!row) {
        return null;
    }
    const access = await loadDashboardAccessContext(client, resolvedUserId);
    return {
        resolvedUserId,
        row,
        access,
    };
}
function serializeManagedAdminRecord(target) {
    return {
        id: String(target.row.id ?? target.access.user_id),
        public_id: String(target.row.public_id ?? ''),
        admin_user_id: target.access.admin_user_id,
        full_name: String(target.row.full_name ?? ''),
        email: String(target.row.email ?? ''),
        phone: String(target.row.phone ?? ''),
        user_status: String(target.row.user_status ?? 'ACTIVE'),
        admin_status: target.access.admin_status,
        role: target.access.admin_role,
        legacy_admin_role: target.access.legacy_admin_role,
        permissions: target.access.permissions,
        module_keys: target.access.module_keys,
        country: String(target.row.country ?? ''),
        country_id: target.access.country_id,
        division_id: target.access.division_id,
        country_ids: target.access.country_ids,
        division_ids: target.access.division_ids,
        country_scopes: target.access.country_scopes,
        division_scopes: target.access.division_scopes,
        created_by_super_admin_id: target.access.created_by_super_admin_id,
        last_login_at: target.access.last_login_at,
        created_at: target.row.admin_created_at ?? target.row.user_created_at ?? null,
        updated_at: target.row.admin_updated_at ?? target.row.user_updated_at ?? null,
    };
}
async function ensurePersistedAdminAccountId(client, target) {
    if (target.access?.admin_user_id) {
        return target.access.admin_user_id;
    }
    const role = target.access?.admin_role === ADMIN_ROLE_SUPER_ADMIN
        ? ADMIN_ROLE_SUPER_ADMIN
        : ADMIN_ROLE_ADMIN;
    const status = target.access?.admin_status && target.access.admin_status !== 'NONE'
        ? target.access.admin_status
        : normalizeManagedAdminStatus(target.row.admin_account_status);
    const account = await ensureAdminAccountRecord(client, {
        userId: target.resolvedUserId,
        role,
        status: status === 'NONE' ? 'ACTIVE' : status,
        createdBySuperAdminId: target.row.created_by_super_admin_id
            ? String(target.row.created_by_super_admin_id)
            : null,
    });
    return String(account.id);
}
async function ensureCampaignDraftsTable(client) {
    await client.query(`
    CREATE TABLE IF NOT EXISTS campaign_creation_drafts (
      id UUID PRIMARY KEY,
      business_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      payload JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS campaign_creation_drafts_updated_at_idx
      ON campaign_creation_drafts (updated_at DESC)
  `);
    await client.query(`
    ALTER TABLE campaign_creation_drafts
      ADD COLUMN IF NOT EXISTS advertiser_id UUID
  `);
    await client.query(`
    ALTER TABLE campaign_creation_drafts
      ADD COLUMN IF NOT EXISTS business_id UUID
  `);
    await client.query(`
    UPDATE campaign_creation_drafts
    SET business_id = COALESCE(business_id, advertiser_id),
        advertiser_id = COALESCE(advertiser_id, business_id)
    WHERE business_id IS NULL
       OR advertiser_id IS NULL
       OR business_id IS DISTINCT FROM advertiser_id
  `);
    await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS campaign_creation_drafts_business_id_key
      ON campaign_creation_drafts (business_id)
  `);
    await client.query(`
    CREATE OR REPLACE FUNCTION sync_campaign_creation_draft_owner_columns()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      resolved_owner UUID;
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF NEW.business_id IS DISTINCT FROM OLD.business_id THEN
          resolved_owner := NEW.business_id;
        ELSIF NEW.advertiser_id IS DISTINCT FROM OLD.advertiser_id THEN
          resolved_owner := NEW.advertiser_id;
        ELSE
          resolved_owner := COALESCE(NEW.business_id, NEW.advertiser_id);
        END IF;
      ELSE
        resolved_owner := COALESCE(NEW.business_id, NEW.advertiser_id);
      END IF;

      NEW.business_id := resolved_owner;
      NEW.advertiser_id := resolved_owner;
      RETURN NEW;
    END;
    $$;
  `);
    await client.query(`
    DROP TRIGGER IF EXISTS campaign_creation_drafts_sync_owner_columns
    ON campaign_creation_drafts
  `);
    await client.query(`
    CREATE TRIGGER campaign_creation_drafts_sync_owner_columns
    BEFORE INSERT OR UPDATE ON campaign_creation_drafts
    FOR EACH ROW
    EXECUTE FUNCTION sync_campaign_creation_draft_owner_columns()
  `);
}
async function ensureContractParticipantColumns(client) {
    await client.query(`
    ALTER TABLE contracts
      ADD COLUMN IF NOT EXISTS ambassador_id UUID
  `);
    await client.query(`
    ALTER TABLE contracts
      ADD COLUMN IF NOT EXISTS distributor_id UUID
  `);
    await client.query(`
    UPDATE contracts
    SET ambassador_id = COALESCE(ambassador_id, distributor_id),
        distributor_id = COALESCE(distributor_id, ambassador_id)
    WHERE ambassador_id IS NULL
       OR distributor_id IS NULL
       OR ambassador_id IS DISTINCT FROM distributor_id
  `);
    await client.query(`
    CREATE OR REPLACE FUNCTION sync_contract_participant_columns()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      resolved_participant UUID;
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF NEW.ambassador_id IS DISTINCT FROM OLD.ambassador_id THEN
          resolved_participant := NEW.ambassador_id;
        ELSIF NEW.distributor_id IS DISTINCT FROM OLD.distributor_id THEN
          resolved_participant := NEW.distributor_id;
        ELSE
          resolved_participant := COALESCE(NEW.ambassador_id, NEW.distributor_id);
        END IF;
      ELSE
        resolved_participant := COALESCE(NEW.ambassador_id, NEW.distributor_id);
      END IF;

      NEW.ambassador_id := resolved_participant;
      NEW.distributor_id := resolved_participant;
      RETURN NEW;
    END;
    $$;
  `);
    await client.query(`
    DROP TRIGGER IF EXISTS contracts_sync_participant_columns
    ON contracts
  `);
    await client.query(`
    CREATE TRIGGER contracts_sync_participant_columns
    BEFORE INSERT OR UPDATE ON contracts
    FOR EACH ROW
    EXECUTE FUNCTION sync_contract_participant_columns()
  `);
}
async function ensureProofReviewColumns(client) {
    await client.query(`
    ALTER TABLE proofs
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);
    await client.query(`
    UPDATE proofs
    SET updated_at = COALESCE(updated_at, created_at, NOW())
    WHERE updated_at IS NULL
  `);
}
async function logAudit(client, actorId, action, targetType, targetId, meta) {
    await recordAdminAudit(client, {
        actorId,
        action,
        targetType,
        targetId,
        meta,
    });
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
function resolveAdminRequestUserId(request) {
    const authSub = String(request.user?.sub ?? '').trim();
    return authSub === 'ariaka-access'
        ? '00000000-0000-0000-0000-000000000000'
        : authSub;
}
function buildDefaultHandlerJazHandle(access) {
    const rawAccess = access;
    const seeds = [
        rawAccess.full_name,
        access.email,
        rawAccess.phone,
        access.user_id,
    ]
        .map((value) => String(value ?? '').trim())
        .filter((value) => value.length > 0);
    const base = seeds[0] ?? 'handler';
    const normalized = base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 24);
    if (normalized.length >= 2) {
        return normalized;
    }
    return `handler_${String(access.user_id ?? 'admin').slice(0, 6)}`;
}
async function resolveHandlerJazHandle(client, access, overrideHandle, options = {}) {
    const explicit = String(overrideHandle ?? '').trim();
    if (explicit.length >= 2) {
        const saved = await upsertAdminHandlerJazIdentity(client, {
            userId: access.user_id,
            handle: explicit,
        });
        return String(saved.handle ?? explicit);
    }
    const existing = await loadAdminHandlerJazIdentity(client, access.user_id);
    if (existing?.handle) {
        return String(existing.handle);
    }
    if (options.allowFallbackDefault === true) {
        return buildDefaultHandlerJazHandle(access);
    }
    return null;
}
async function loadHandlerJazSnapshot(client, access, cursor) {
    const rawAccess = access;
    await cleanupAdminHandlerJaz(client);
    const participants = await listAdminHandlerJazParticipants(client);
    const messages = await listAdminHandlerJazMessages(client, {
        since: cursor ?? null,
    });
    const signals = await listAdminHandlerJazSignalEvents(client, access.user_id, {
        since: cursor ?? null,
    });
    const meIdentity = await loadAdminHandlerJazIdentity(client, access.user_id);
    const availableCount = participants.filter((item) => item.is_available === true).length;
    const activeCallCount = participants.filter((item) => item.in_call === true).length;
    const nextCursor = maxLiveCursor([
        ...messages.map((item) => item.created_at),
        ...signals.map((item) => item.created_at),
        ...participants.map((item) => item.updated_at),
    ]);
    return {
        room: {
            key: ADMIN_HANDLER_JAZ_ROOM_KEY,
            message_ttl_hours: ADMIN_HANDLER_JAZ_MESSAGE_TTL_HOURS,
            available_count: availableCount,
            active_call_count: activeCallCount,
        },
        me: {
            user_id: access.user_id,
            display_name: String(rawAccess.full_name ?? '').trim() ||
                String(access.email ?? '').trim() ||
                String(rawAccess.phone ?? '').trim() ||
                'Admin',
            handle: String(meIdentity?.handle ?? '').trim() || buildDefaultHandlerJazHandle(access),
            has_identity: Boolean(String(meIdentity?.handle ?? '').trim()),
        },
        participants,
        messages,
        signals,
        cursor: nextCursor,
    };
}
function hasPersistedHandlerJazUser(access) {
    if (!access)
        return false;
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
        .test(String(access.user_id ?? '').trim());
}
function rejectInvalidHandlerJazAccess(access, reply) {
    if (!access) {
        reply.code(403);
        return { error: 'forbidden' };
    }
    if (hasPersistedHandlerJazUser(access)) {
        return null;
    }
    reply.code(409);
    return {
        error: 'handler_jaz_persisted_admin_required',
        detail: "Handler's Jaz requires a signed-in admin account. Emergency access mode can't join the room.",
    };
}
export async function adminRoutes(app) {
    const jobRepo = new JobRepo();
    const paymentRepo = new PaymentRepo();
    let schemaReadyPromise = null;
    const ensureAdminRoutesSchema = () => {
        if (!schemaReadyPromise) {
            schemaReadyPromise = withTransaction(async (client) => {
                await ensurePublicIdColumns(client);
                await ensureUserSignalSchema(client);
                await ensureCampaignDraftsTable(client);
                await ensureContractParticipantColumns(client);
                await ensureProofReviewColumns(client);
                await ensureAdminOperationsSchema(client);
                await ensureAdminHandlerJazSchema(client);
                await ensureUserProfilesTable(client);
                await ensureViewerVerificationSchema(client);
            }).catch((error) => {
                schemaReadyPromise = null;
                throw error;
            });
        }
        return schemaReadyPromise;
    };
    app.addHook('onListen', async () => {
        if (process.env.SKIP_OPTIONAL_STARTUP_WARMUPS === '1') {
            return;
        }
        try {
            await ensureAdminRoutesSchema();
        }
        catch (error) {
            app.log.error({ err: error }, 'startup warmup failed for admin schema');
        }
    });
    app.addHook('preHandler', async () => {
        await ensureAdminRoutesSchema();
    });
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
    app.get('/admin/me', { preHandler: [app.adminOnly] }, async (request, reply) => {
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            if (access.user_id === 'ariaka-access') {
                return {
                    admin: {
                        id: access.user_id,
                        public_id: null,
                        admin_user_id: null,
                        full_name: 'Emergency Super Admin',
                        email: access.email,
                        phone: '',
                        user_status: 'ACTIVE',
                        admin_status: access.admin_status,
                        role: access.admin_role,
                        legacy_admin_role: access.legacy_admin_role,
                        permissions: access.permissions,
                        module_keys: access.module_keys,
                        country: '',
                        country_id: access.country_id,
                        division_id: access.division_id,
                        country_ids: access.country_ids,
                        division_ids: access.division_ids,
                        country_scopes: access.country_scopes,
                        division_scopes: access.division_scopes,
                        created_by_super_admin_id: access.created_by_super_admin_id,
                        last_login_at: access.last_login_at,
                        created_at: null,
                        updated_at: null,
                    },
                };
            }
            const target = await loadManagedAdminTarget(client, access.user_id);
            if (!target?.access || target.access.admin_role === 'USER') {
                reply.code(404);
                return { error: 'admin_not_found' };
            }
            return {
                admin: serializeManagedAdminRecord({
                    row: target.row,
                    access: target.access,
                }),
            };
        });
    });
    app.get('/admin/modules', { preHandler: [app.adminOnly] }, async (request) => {
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            return {
                modules: adminModuleDefinitions,
                assignable_module_keys: ASSIGNABLE_ADMIN_MODULE_KEYS,
                current_permissions: access.permissions,
            };
        });
    });
    app.get('/admin/admins', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const query = AdminListQuerySchema.parse(request.query ?? {});
        const { limit, offset } = parsePaging(query);
        return withTransaction(async (client) => {
            const actorAccess = await requireSuperDashboardAccess(client, request, reply);
            if (!actorAccess) {
                return { error: 'forbidden' };
            }
            await ensurePublicIdColumns(client);
            const candidates = await client.query(`
        SELECT u.id
        FROM users u
        LEFT JOIN admin_users au ON au.user_id = u.id
        WHERE au.id IS NOT NULL
           OR u.role = 'ADMIN'
           OR u.active_role = 'ADMIN'
           OR COALESCE(u.admin_role, 'USER') <> 'USER'
        ORDER BY COALESCE(au.created_at, u.created_at) DESC, u.created_at DESC
        `);
            const q = String(query.q ?? '').trim().toLowerCase();
            const filtered = [];
            for (const row of candidates.rows) {
                const target = await loadManagedAdminTarget(client, String(row.id));
                if (!target?.access || target.access.admin_role === 'USER') {
                    continue;
                }
                const record = serializeManagedAdminRecord({
                    row: target.row,
                    access: target.access,
                });
                if (query.role &&
                    String(record.role ?? '').trim().toUpperCase() !== query.role) {
                    continue;
                }
                if (query.status &&
                    String(record.admin_status ?? '').trim().toUpperCase() !== query.status) {
                    continue;
                }
                if (q) {
                    const haystack = [
                        record.public_id,
                        record.full_name,
                        record.email,
                        record.phone,
                    ]
                        .map((value) => String(value ?? '').toLowerCase())
                        .join(' ');
                    if (!haystack.includes(q)) {
                        continue;
                    }
                }
                filtered.push(record);
            }
            return {
                admins: filtered.slice(offset, offset + limit),
                total: filtered.length,
            };
        });
    });
    app.post('/admin/admins', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const body = CreateAdminSchema.parse(request.body);
        return withTransaction(async (client) => {
            const actorAccess = await requireSuperDashboardAccess(client, request, reply);
            if (!actorAccess) {
                return { error: 'forbidden' };
            }
            const role = body.role === ADMIN_ROLE_SUPER_ADMIN
                ? ADMIN_ROLE_SUPER_ADMIN
                : ADMIN_ROLE_ADMIN;
            const validatedScopes = role === ADMIN_ROLE_ADMIN
                ? await validateAdminScopeAssignments(client, {
                    countryIds: body.country_ids,
                    divisionIds: body.division_ids,
                })
                : {
                    countryIds: [],
                    divisionIds: [],
                    countryRows: [],
                    divisionRows: [],
                    primaryCountry: null,
                    primaryDivision: null,
                };
            let targetUserId;
            if (body.user_id) {
                const resolvedUserId = await resolveUserId(client, body.user_id);
                if (!resolvedUserId) {
                    reply.code(404);
                    return { error: 'user_not_found' };
                }
                const existing = await loadDashboardAccessContext(client, resolvedUserId);
                if (existing && existing.admin_role !== 'USER') {
                    reply.code(409);
                    return { error: 'admin_already_exists' };
                }
                targetUserId = resolvedUserId;
            }
            else {
                const created = await createManagedAdminUser(client, {
                    full_name: body.full_name,
                    email: body.email,
                    phone: body.phone,
                    password: body.password,
                    role,
                    primaryCountry: validatedScopes.primaryCountry,
                    primaryDivision: validatedScopes.primaryDivision,
                });
                targetUserId = String(created.id);
            }
            const account = await ensureAdminAccountRecord(client, {
                userId: targetUserId,
                role,
                status: body.status,
                createdBySuperAdminId: actorAccess.user_id === 'ariaka-access' ? null : actorAccess.user_id,
            });
            if (role === ADMIN_ROLE_ADMIN) {
                await replaceAdminModuleAssignments(client, String(account.id), role, body.module_keys);
                await replaceAdminScopeAssignments(client, String(account.id), {
                    countryIds: validatedScopes.countryIds,
                    divisionIds: validatedScopes.divisionIds,
                });
            }
            else {
                await replaceAdminModuleAssignments(client, String(account.id), role, []);
                await replaceAdminScopeAssignments(client, String(account.id), {
                    countryIds: [],
                    divisionIds: [],
                });
            }
            const target = await loadManagedAdminTarget(client, targetUserId);
            if (!target?.access || target.access.admin_role === 'USER') {
                reply.code(500);
                return { error: 'admin_create_failed' };
            }
            await recordAdminAudit(client, {
                actorId: actorAccess.user_id === 'ariaka-access' ? null : actorAccess.user_id,
                action: 'ADMIN_CREATED',
                targetType: 'admin_user',
                targetId: targetUserId,
                meta: {
                    role: target.access.admin_role,
                    admin_status: target.access.admin_status,
                    permissions: target.access.permissions,
                    country_ids: target.access.country_ids,
                    division_ids: target.access.division_ids,
                },
                ...auditScopeFromAccess(target.access),
            });
            return {
                admin: serializeManagedAdminRecord({
                    row: target.row,
                    access: target.access,
                }),
            };
        });
    });
    app.patch('/admin/admins/:id', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = UpdateAdminSchema.parse(request.body);
        return withTransaction(async (client) => {
            const actorAccess = await requireSuperDashboardAccess(client, request, reply);
            if (!actorAccess) {
                return { error: 'forbidden' };
            }
            const target = await loadManagedAdminTarget(client, params.id);
            if (!target?.access || target.access.admin_role === 'USER') {
                reply.code(404);
                return { error: 'admin_not_found' };
            }
            if (actorAccess.user_id === target.resolvedUserId) {
                reply.code(403);
                return { error: 'cannot_modify_own_admin_account' };
            }
            if (target.access.admin_status === 'DELETED') {
                reply.code(409);
                return { error: 'admin_deleted' };
            }
            if (body.email !== undefined || body.phone !== undefined) {
                await ensureUniqueAdminIdentity(client, {
                    email: body.email ?? null,
                    phone: body.phone ?? null,
                }, target.resolvedUserId);
            }
            const profileUpdates = [];
            const profileParams = [target.resolvedUserId];
            let profileIdx = 2;
            if (body.full_name !== undefined) {
                profileUpdates.push(`full_name = $${profileIdx}`);
                profileParams.push(body.full_name.trim());
                profileIdx += 1;
            }
            if (body.email !== undefined) {
                profileUpdates.push(`email = $${profileIdx}`);
                profileParams.push(body.email.trim().toLowerCase());
                profileIdx += 1;
            }
            if (body.phone !== undefined) {
                profileUpdates.push(`phone = $${profileIdx}`);
                profileParams.push(body.phone.trim());
                profileIdx += 1;
            }
            if (profileUpdates.length > 0) {
                await client.query(`
          UPDATE users
          SET ${profileUpdates.join(', ')}
          WHERE id = $1
          `, profileParams);
            }
            const currentRole = target.access.admin_role === ADMIN_ROLE_SUPER_ADMIN
                ? ADMIN_ROLE_SUPER_ADMIN
                : ADMIN_ROLE_ADMIN;
            const nextRole = body.role === ADMIN_ROLE_SUPER_ADMIN
                ? ADMIN_ROLE_SUPER_ADMIN
                : body.role === ADMIN_ROLE_ADMIN
                    ? ADMIN_ROLE_ADMIN
                    : currentRole;
            const account = await ensureAdminAccountRecord(client, {
                userId: target.resolvedUserId,
                role: nextRole,
                status: target.access.admin_status === 'NONE'
                    ? 'ACTIVE'
                    : target.access.admin_status,
                createdBySuperAdminId: target.access.created_by_super_admin_id,
            });
            const shouldReplaceScopes = nextRole === ADMIN_ROLE_SUPER_ADMIN
                ? true
                : body.country_ids !== undefined || body.division_ids !== undefined;
            if (shouldReplaceScopes) {
                const nextCountryIds = nextRole === ADMIN_ROLE_SUPER_ADMIN
                    ? []
                    : body.country_ids ?? target.access.country_scopes.map((scope) => scope.id);
                const nextDivisionIds = nextRole === ADMIN_ROLE_SUPER_ADMIN
                    ? []
                    : body.division_ids ?? target.access.division_scopes.map((scope) => scope.id);
                const validatedScopes = await validateAdminScopeAssignments(client, {
                    countryIds: nextCountryIds,
                    divisionIds: nextDivisionIds,
                });
                await replaceAdminScopeAssignments(client, String(account.id), {
                    countryIds: validatedScopes.countryIds,
                    divisionIds: validatedScopes.divisionIds,
                });
            }
            const shouldReplaceModules = nextRole === ADMIN_ROLE_SUPER_ADMIN || body.module_keys !== undefined;
            if (shouldReplaceModules) {
                await replaceAdminModuleAssignments(client, String(account.id), nextRole, nextRole === ADMIN_ROLE_SUPER_ADMIN ? [] : body.module_keys ?? target.access.permissions);
            }
            const updatedTarget = await loadManagedAdminTarget(client, target.resolvedUserId);
            if (!updatedTarget?.access || updatedTarget.access.admin_role === 'USER') {
                reply.code(500);
                return { error: 'admin_update_failed' };
            }
            await recordAdminAudit(client, {
                actorId: actorAccess.user_id === 'ariaka-access' ? null : actorAccess.user_id,
                action: 'ADMIN_UPDATED',
                targetType: 'admin_user',
                targetId: target.resolvedUserId,
                meta: {
                    profile_fields: {
                        full_name: body.full_name ?? null,
                        email: body.email ?? null,
                        phone: body.phone ?? null,
                    },
                    role: updatedTarget.access.admin_role,
                    permissions: updatedTarget.access.permissions,
                    country_ids: updatedTarget.access.country_ids,
                    division_ids: updatedTarget.access.division_ids,
                },
                ...auditScopeFromAccess(updatedTarget.access),
            });
            return {
                admin: serializeManagedAdminRecord({
                    row: updatedTarget.row,
                    access: updatedTarget.access,
                }),
            };
        });
    });
    app.patch('/admin/admins/:id/status', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = UpdateManagedAdminStatusSchema.parse(request.body);
        return withTransaction(async (client) => {
            const actorAccess = await requireSuperDashboardAccess(client, request, reply);
            if (!actorAccess) {
                return { error: 'forbidden' };
            }
            const target = await loadManagedAdminTarget(client, params.id);
            if (!target?.access || target.access.admin_role === 'USER') {
                reply.code(404);
                return { error: 'admin_not_found' };
            }
            if (actorAccess.user_id === target.resolvedUserId) {
                reply.code(403);
                return { error: 'cannot_modify_own_admin_account' };
            }
            if (target.access.admin_status === 'DELETED') {
                reply.code(409);
                return { error: 'admin_deleted' };
            }
            await ensureAdminAccountRecord(client, {
                userId: target.resolvedUserId,
                role: target.access.admin_role === ADMIN_ROLE_SUPER_ADMIN
                    ? ADMIN_ROLE_SUPER_ADMIN
                    : ADMIN_ROLE_ADMIN,
                status: body.status,
                createdBySuperAdminId: target.access.created_by_super_admin_id,
            });
            const updatedTarget = await loadManagedAdminTarget(client, target.resolvedUserId);
            if (!updatedTarget?.access || updatedTarget.access.admin_role === 'USER') {
                reply.code(500);
                return { error: 'admin_status_update_failed' };
            }
            await recordAdminAudit(client, {
                actorId: actorAccess.user_id === 'ariaka-access' ? null : actorAccess.user_id,
                action: body.status === 'ACTIVE' ? 'ADMIN_REACTIVATED' : 'ADMIN_SUSPENDED',
                targetType: 'admin_user',
                targetId: target.resolvedUserId,
                meta: {
                    admin_status: updatedTarget.access.admin_status,
                },
                ...auditScopeFromAccess(updatedTarget.access),
            });
            return {
                admin: serializeManagedAdminRecord({
                    row: updatedTarget.row,
                    access: updatedTarget.access,
                }),
            };
        });
    });
    app.put('/admin/admins/:id/permissions', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = ManageAdminPermissionsSchema.parse(request.body);
        return withTransaction(async (client) => {
            const actorAccess = await requireSuperDashboardAccess(client, request, reply);
            if (!actorAccess) {
                return { error: 'forbidden' };
            }
            const target = await loadManagedAdminTarget(client, params.id);
            if (!target?.access || target.access.admin_role === 'USER') {
                reply.code(404);
                return { error: 'admin_not_found' };
            }
            if (actorAccess.user_id === target.resolvedUserId) {
                reply.code(403);
                return { error: 'cannot_modify_own_admin_account' };
            }
            if (target.access.admin_role === ADMIN_ROLE_SUPER_ADMIN) {
                reply.code(409);
                return { error: 'super_admin_permissions_are_implicit' };
            }
            if (target.access.admin_status === 'DELETED') {
                reply.code(409);
                return { error: 'admin_deleted' };
            }
            const normalizedModuleKeys = normalizeAssignableModuleKeys(body.module_keys);
            const accountId = await ensurePersistedAdminAccountId(client, target);
            if (normalizedModuleKeys.length > 0) {
                await grantAdminModuleAssignments(client, accountId, ADMIN_ROLE_ADMIN, normalizedModuleKeys);
            }
            const updatedTarget = await loadManagedAdminTarget(client, target.resolvedUserId);
            if (!updatedTarget?.access || updatedTarget.access.admin_role === 'USER') {
                reply.code(500);
                return { error: 'admin_permissions_update_failed' };
            }
            await recordAdminAudit(client, {
                actorId: actorAccess.user_id === 'ariaka-access' ? null : actorAccess.user_id,
                action: 'ADMIN_PERMISSIONS_ASSIGNED',
                targetType: 'admin_user',
                targetId: target.resolvedUserId,
                meta: {
                    module_keys: normalizedModuleKeys,
                    permissions: updatedTarget.access.permissions,
                },
                ...auditScopeFromAccess(updatedTarget.access),
            });
            return {
                admin: serializeManagedAdminRecord({
                    row: updatedTarget.row,
                    access: updatedTarget.access,
                }),
            };
        });
    });
    app.delete('/admin/admins/:id/permissions', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = ManageAdminPermissionsSchema.parse(request.body ?? {});
        return withTransaction(async (client) => {
            const actorAccess = await requireSuperDashboardAccess(client, request, reply);
            if (!actorAccess) {
                return { error: 'forbidden' };
            }
            const target = await loadManagedAdminTarget(client, params.id);
            if (!target?.access || target.access.admin_role === 'USER') {
                reply.code(404);
                return { error: 'admin_not_found' };
            }
            if (actorAccess.user_id === target.resolvedUserId) {
                reply.code(403);
                return { error: 'cannot_modify_own_admin_account' };
            }
            if (target.access.admin_role === ADMIN_ROLE_SUPER_ADMIN) {
                reply.code(409);
                return { error: 'super_admin_permissions_are_implicit' };
            }
            if (target.access.admin_status === 'DELETED') {
                reply.code(409);
                return { error: 'admin_deleted' };
            }
            const normalizedModuleKeys = normalizeAssignableModuleKeys(body.module_keys);
            const accountId = await ensurePersistedAdminAccountId(client, target);
            if (normalizedModuleKeys.length > 0) {
                await client.query(`
          DELETE FROM admin_user_modules
          WHERE admin_user_id = $1
            AND module_key = ANY($2::text[])
          `, [accountId, normalizedModuleKeys]);
            }
            const updatedTarget = await loadManagedAdminTarget(client, target.resolvedUserId);
            if (!updatedTarget?.access || updatedTarget.access.admin_role === 'USER') {
                reply.code(500);
                return { error: 'admin_permissions_update_failed' };
            }
            await recordAdminAudit(client, {
                actorId: actorAccess.user_id === 'ariaka-access' ? null : actorAccess.user_id,
                action: 'ADMIN_PERMISSIONS_REMOVED',
                targetType: 'admin_user',
                targetId: target.resolvedUserId,
                meta: {
                    module_keys: normalizedModuleKeys,
                    permissions: updatedTarget.access.permissions,
                },
                ...auditScopeFromAccess(updatedTarget.access),
            });
            return {
                admin: serializeManagedAdminRecord({
                    row: updatedTarget.row,
                    access: updatedTarget.access,
                }),
            };
        });
    });
    app.delete('/admin/admins/:id', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        return withTransaction(async (client) => {
            const actorAccess = await requireSuperDashboardAccess(client, request, reply);
            if (!actorAccess) {
                return { error: 'forbidden' };
            }
            const target = await loadManagedAdminTarget(client, params.id);
            if (!target?.access || target.access.admin_role === 'USER') {
                reply.code(404);
                return { error: 'admin_not_found' };
            }
            if (actorAccess.user_id === target.resolvedUserId) {
                reply.code(403);
                return { error: 'cannot_modify_own_admin_account' };
            }
            if (target.access.admin_status === 'DELETED') {
                return {
                    admin: serializeManagedAdminRecord({
                        row: target.row,
                        access: target.access,
                    }),
                };
            }
            await ensureAdminAccountRecord(client, {
                userId: target.resolvedUserId,
                role: target.access.admin_role === ADMIN_ROLE_SUPER_ADMIN
                    ? ADMIN_ROLE_SUPER_ADMIN
                    : ADMIN_ROLE_ADMIN,
                status: 'DELETED',
                createdBySuperAdminId: target.access.created_by_super_admin_id,
            });
            const updatedTarget = await loadManagedAdminTarget(client, target.resolvedUserId);
            if (!updatedTarget?.access || updatedTarget.access.admin_role === 'USER') {
                reply.code(500);
                return { error: 'admin_delete_failed' };
            }
            await recordAdminAudit(client, {
                actorId: actorAccess.user_id === 'ariaka-access' ? null : actorAccess.user_id,
                action: 'ADMIN_DELETED',
                targetType: 'admin_user',
                targetId: target.resolvedUserId,
                meta: {
                    admin_status: updatedTarget.access.admin_status,
                },
                ...auditScopeFromAccess(updatedTarget.access),
            });
            return {
                admin: serializeManagedAdminRecord({
                    row: updatedTarget.row,
                    access: updatedTarget.access,
                }),
            };
        });
    });
    app.get('/admin/audit', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const query = AuditQuerySchema.parse(request.query ?? {});
        const { limit, offset } = parsePaging(query);
        const range = parseDateRange(query.from, query.to);
        return withTransaction(async (client) => {
            const access = await requireModuleAccess(client, request, reply, ADMIN_MODULE_AUDIT_LOGS);
            if (!access) {
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
            const state = { conditions, params, idx };
            appendTenantScope(state, access, {
                country: 'country_id',
                division: 'division_id',
            });
            idx = state.idx;
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
            const access = await requireModuleAccess(client, request, reply, ADMIN_MODULE_FINANCE);
            if (!access) {
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
            const state = { conditions, params, idx };
            appendTenantScope(state, access, {
                country: 'country_id',
                division: 'division_id',
            });
            idx = state.idx;
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
            p.created_at AS created_at,
            p.country_id,
            p.division_id
          FROM payout_requests p
          UNION ALL
          SELECT
            t.id AS source_id,
            t.type::text AS source_type,
            t.status::text AS status,
            t.amount::int AS amount,
            t.merchant_reference::text AS reference,
            NULL::text AS user_id,
            t.created_at AS created_at,
            COALESCE(e.country_id, c.country_id) AS country_id,
            COALESCE(e.division_id, c.division_id) AS division_id
          FROM pesapal_transactions t
          LEFT JOIN escrow_ledger e ON e.id = t.escrow_id
          LEFT JOIN campaigns c ON c.id = e.campaign_id
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
            p.created_at AS created_at,
            p.country_id,
            p.division_id
          FROM payout_requests p
          UNION ALL
          SELECT
            t.type::text AS source_type,
            t.status::text AS status,
            t.amount::int AS amount,
            t.merchant_reference::text AS reference,
            t.id AS source_id,
            t.created_at AS created_at,
            COALESCE(e.country_id, c.country_id) AS country_id,
            COALESCE(e.division_id, c.division_id) AS division_id
          FROM pesapal_transactions t
          LEFT JOIN escrow_ledger e ON e.id = t.escrow_id
          LEFT JOIN campaigns c ON c.id = e.campaign_id
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
            const escrowState = {
                conditions: escrowConditions,
                params: escrowParams,
                idx: eidx,
            };
            appendTenantScope(escrowState, access, {
                country: 'country_id',
                division: 'division_id',
            });
            eidx = escrowState.idx;
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
              p.created_at AS created_at,
              p.country_id,
              p.division_id
            FROM payout_requests p
            UNION ALL
            SELECT
              t.type::text AS source_type,
              t.status::text AS status,
              t.amount::int AS amount,
              t.merchant_reference::text AS reference,
              t.id AS source_id,
              t.created_at AS created_at,
              COALESCE(e.country_id, c.country_id) AS country_id,
              COALESCE(e.division_id, c.division_id) AS division_id
            FROM pesapal_transactions t
            LEFT JOIN escrow_ledger e ON e.id = t.escrow_id
            LEFT JOIN campaigns c ON c.id = e.campaign_id
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
            const access = await getLiveDashboardAccess(client, request);
            if (!hasAdminModuleAccess(access, ADMIN_MODULE_OVERVIEW)) {
                reply.code(403);
                return { error: 'forbidden' };
            }
            await ensureCampaignDraftsTable(client);
            const countScoped = async (input) => {
                if (!hasAdminModuleAccess(access, input.module)) {
                    return 0;
                }
                const state = { conditions: [], params: [], idx: 1 };
                appendTenantScope(state, access, {
                    country: input.country,
                    division: input.division,
                });
                const where = state.conditions.length
                    ? `WHERE ${state.conditions.join(' AND ')}`
                    : '';
                const res = await client.query(`SELECT COUNT(*)::int AS count FROM ${input.from} ${where}`, state.params);
                return Number(res.rows[0]?.count ?? 0);
            };
            const users = await countScoped({
                module: ADMIN_MODULE_USERS,
                from: 'users u',
                country: 'u.country_id',
                division: 'u.division_id',
            });
            const campaigns = await countScoped({
                module: ADMIN_MODULE_CAMPAIGNS,
                from: 'campaigns c',
                country: 'c.country_id',
                division: 'c.division_id',
            });
            const proofs = await countScoped({
                module: ADMIN_MODULE_PROOFS,
                from: 'proofs p',
                country: 'p.country_id',
                division: 'p.division_id',
            });
            const verificationSessions = await countScoped({
                module: ADMIN_MODULE_SESSIONS,
                from: 'verification_sessions s',
                country: 's.country_id',
                division: 's.division_id',
            });
            const payouts = await countScoped({
                module: ADMIN_MODULE_PAYOUT_REQUESTS,
                from: 'payout_requests p',
                country: 'p.country_id',
                division: 'p.division_id',
            });
            const escrows = await countScoped({
                module: ADMIN_MODULE_ESCROWS,
                from: 'escrow_ledger e',
                country: 'e.country_id',
                division: 'e.division_id',
            });
            const campaignDrafts = await countScoped({
                module: ADMIN_MODULE_DRAFTS,
                from: 'campaign_creation_drafts d JOIN users u ON u.id = d.business_id',
                country: 'u.country_id',
                division: 'u.division_id',
            });
            const walletWithdrawals = await countScoped({
                module: ADMIN_MODULE_WITHDRAWALS,
                from: 'wallet_withdrawals ww JOIN users u ON u.id = ww.user_id',
                country: 'u.country_id',
                division: 'u.division_id',
            });
            const trustProfiles = await countScoped({
                module: ADMIN_MODULE_RISK,
                from: 'trust_scores ts JOIN users u ON u.id = ts.user_id',
                country: 'u.country_id',
                division: 'u.division_id',
            });
            const deviceFingerprints = await countScoped({
                module: ADMIN_MODULE_RISK,
                from: 'device_fingerprints df JOIN users u ON u.id = df.user_id',
                country: 'u.country_id',
                division: 'u.division_id',
            });
            const providerTransactions = await countScoped({
                module: ADMIN_MODULE_GATEWAY,
                from: 'pesapal_transactions pt LEFT JOIN escrow_ledger e ON e.id = pt.escrow_id LEFT JOIN campaigns c ON c.id = e.campaign_id',
                country: 'COALESCE(e.country_id, c.country_id)',
                division: 'COALESCE(e.division_id, c.division_id)',
            });
            return {
                users,
                campaigns,
                proofs,
                verification_sessions: verificationSessions,
                payouts,
                escrows,
                campaign_drafts: campaignDrafts,
                wallet_withdrawals: walletWithdrawals,
                trust_profiles: trustProfiles,
                device_fingerprints: deviceFingerprints,
                provider_transactions: providerTransactions,
                yo_uganda_transactions: providerTransactions,
                flutterwave_transactions: providerTransactions,
                pesapal_transactions: providerTransactions,
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
          u.email AS business_email,
          u.phone AS business_phone,
          u.public_id AS business_public_id
        FROM campaign_creation_drafts d
        JOIN users u ON u.id = d.business_id
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
            await ensureUserSignalSchema(client);
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
          ${ACTIVE_BLOCKING_NOTICE_SELECT_SQL},
          CASE
            WHEN COALESCE(u.last_seen_at, '-infinity'::timestamptz) >= NOW() - interval '5 minutes'
              THEN TRUE
            ELSE FALSE
          END AS is_online
        FROM users u
        LEFT JOIN user_profiles p ON p.user_id = u.id
        ${ACTIVE_BLOCKING_NOTICE_JOIN_SQL}
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
          ${ACTIVE_BLOCKING_NOTICE_SELECT_SQL},
          CASE
            WHEN COALESCE(u.last_seen_at, '-infinity'::timestamptz) >= NOW() - interval '5 minutes'
              THEN TRUE
            ELSE FALSE
          END AS is_online
        FROM users u
        LEFT JOIN user_profiles p ON p.user_id = u.id
        ${ACTIVE_BLOCKING_NOTICE_JOIN_SQL}
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
            const contractsScopeState = {
                conditions: [],
                params: [resolvedUserId],
                idx: 2,
            };
            appendTenantScope(contractsScopeState, access, {
                country: 'c.country_id',
                division: 'c.division_id',
            });
            const contractsScopeClause = contractsScopeState.conditions.length
                ? `AND ${contractsScopeState.conditions.join(' AND ')}`
                : '';
            const contractsRes = await client.query(`
        SELECT
          ctr.*,
          c.title AS campaign_title,
          c.public_id AS campaign_public_id,
          c.status AS campaign_status,
          u.email AS ambassador_email,
          u.public_id AS ambassador_public_id,
          adv.email AS business_email,
          adv.public_id AS business_public_id
        FROM contracts ctr
        JOIN campaigns c ON c.id = ctr.campaign_id
        JOIN users u ON u.id = ctr.ambassador_id
        JOIN users adv ON adv.id = c.business_id
        WHERE (
          c.business_id = $1
          OR ctr.ambassador_id = $1
        )
          ${contractsScopeClause}
        ORDER BY ctr.created_at DESC
        LIMIT 200
        `, contractsScopeState.params);
            const campaignsScopeState = {
                conditions: [],
                params: [resolvedUserId],
                idx: 2,
            };
            appendTenantScope(campaignsScopeState, access, {
                country: 'c.country_id',
                division: 'c.division_id',
            });
            const campaignsScopeClause = campaignsScopeState.conditions.length
                ? `AND ${campaignsScopeState.conditions.join(' AND ')}`
                : '';
            const campaignsRes = await client.query(`
        SELECT
          c.*,
          adv.email AS business_email,
          adv.public_id AS business_public_id,
          dist.email AS assigned_ambassador_email,
          dist.public_id AS assigned_ambassador_public_id,
          CASE
            WHEN c.business_id = $1 THEN 'CREATED'
            WHEN EXISTS (
              SELECT 1
              FROM contracts ctr
              WHERE ctr.campaign_id = c.id
                AND ctr.ambassador_id = $1
            ) THEN 'TOOK_ON'
            WHEN c.assigned_ambassador_id = $1 THEN 'TAGGED'
            ELSE 'RELATED'
          END AS user_relation
        FROM campaigns c
        LEFT JOIN users adv ON adv.id = c.business_id
        LEFT JOIN users dist ON dist.id = c.assigned_ambassador_id
        WHERE (
          c.business_id = $1
          OR c.assigned_ambassador_id = $1
          OR EXISTS (
            SELECT 1
            FROM contracts ctr
            WHERE ctr.campaign_id = c.id
              AND ctr.ambassador_id = $1
          )
        )
          ${campaignsScopeClause}
        ORDER BY c.created_at DESC
        LIMIT 200
        `, campaignsScopeState.params);
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
                    : body.role === ACCOUNT_ROLE_BUSINESS
                        ? ACCOUNT_ROLE_BUSINESS
                        : body.role === ACCOUNT_ROLE_AMBASSADOR
                            ? ACCOUNT_ROLE_AMBASSADOR
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
    app.get('/admin/user-notices', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const status = typeof query?.status === 'string'
            ? query.status.trim().toUpperCase()
            : 'ACTIVE';
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            await ensureUserSignalSchema(client);
            if (!hasAdminModuleAccess(access, ADMIN_MODULE_USERS)) {
                reply.code(403);
                return { error: 'forbidden' };
            }
            const conditions = [`u.role <> 'ADMIN'`];
            const params = [];
            let idx = 1;
            if (status === 'ACTIVE') {
                conditions.push(`notice.removed_at IS NULL`);
            }
            else if (status === 'REMOVED') {
                conditions.push(`notice.removed_at IS NOT NULL`);
            }
            if (typeof query?.q === 'string' && query.q.trim().length > 0) {
                conditions.push(`(notice.title ILIKE $${idx} OR notice.body ILIKE $${idx})`);
                params.push(`%${query.q.trim()}%`);
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
          notice.id,
          notice.title,
          notice.body,
          notice.audience_kind,
          notice.created_at,
          notice.updated_at,
          notice.removed_at,
          notice.created_by_user_id,
          notice.removed_by_user_id,
          COALESCE(NULLIF(creator.full_name, ''), creator.email, 'Admin') AS created_by_name,
          COALESCE(NULLIF(remover.full_name, ''), remover.email, 'Admin') AS removed_by_name,
          COUNT(DISTINCT target.user_id)::int AS target_count
        FROM admin_blocking_notices notice
        JOIN admin_blocking_notice_targets target ON target.notice_id = notice.id
        JOIN users u ON u.id = target.user_id
        LEFT JOIN users creator ON creator.id = notice.created_by_user_id
        LEFT JOIN users remover ON remover.id = notice.removed_by_user_id
        ${where}
        GROUP BY notice.id, creator.full_name, creator.email, remover.full_name, remover.email
        ORDER BY
          CASE WHEN notice.removed_at IS NULL THEN 0 ELSE 1 END,
          notice.created_at DESC
        LIMIT $${idx} OFFSET $${idx + 1}
        `, [...params, limit, offset]);
            return { notices: res.rows };
        });
    });
    app.post('/admin/user-notices', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const parsed = CreateBlockingNoticeSchema.safeParse(request.body ?? {});
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            await ensureUserSignalSchema(client);
            if (!hasAdminModuleAccess(access, ADMIN_MODULE_USERS)) {
                reply.code(403);
                return { error: 'forbidden' };
            }
            const targetUsers = parsed.data.send_to_all
                ? await loadAllScopedNoticeTargetUsers(client, access)
                : await loadScopedNoticeTargetUsers(client, access, parsed.data.user_ids);
            const requestedTargetIds = Array.from(new Set(parsed.data.user_ids.map((value) => value.trim()).filter(Boolean)));
            if (!parsed.data.send_to_all && targetUsers.length !== requestedTargetIds.length) {
                reply.code(404);
                return { error: 'notice_target_not_found' };
            }
            if (targetUsers.length === 0) {
                reply.code(404);
                return { error: 'notice_target_not_found' };
            }
            const actorId = String(request.user.sub ?? '').trim();
            const notice = await createBlockingNotice(client, targetUsers.map((row) => row.id), {
                title: parsed.data.title,
                body: parsed.data.body,
                audienceKind: parsed.data.send_to_all
                    ? 'ALL_SCOPED_USERS'
                    : 'SELECTED_USERS',
                createdByUserId: actorId,
            });
            if (!notice) {
                reply.code(500);
                return { error: 'notice_create_failed' };
            }
            await createUserNotifications(client, targetUsers.map((row) => row.id), {
                category: 'ADMIN_NOTICE',
                title: parsed.data.title,
                body: parsed.data.body,
                actorId,
                targetType: 'ADMIN_BLOCKING_NOTICE',
                targetId: String(notice.id),
                meta: {
                    blocking_notice_id: String(notice.id),
                    audience_kind: parsed.data.send_to_all
                        ? 'ALL_SCOPED_USERS'
                        : 'SELECTED_USERS',
                },
            });
            await logAudit(client, actorId, 'CREATE_USER_BLOCKING_NOTICE', 'admin_blocking_notice', String(notice.id), {
                title: parsed.data.title,
                target_count: targetUsers.length,
                send_to_all: parsed.data.send_to_all,
            });
            return { notice };
        });
    });
    app.delete('/admin/user-notices/:id', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            await ensureUserSignalSchema(client);
            if (!hasAdminModuleAccess(access, ADMIN_MODULE_USERS)) {
                reply.code(403);
                return { error: 'forbidden' };
            }
            const scopeRes = await client.query(`
        SELECT
          notice.id,
          notice.removed_at,
          target.user_id,
          u.role,
          u.country_id,
          u.division_id
        FROM admin_blocking_notices notice
        JOIN admin_blocking_notice_targets target ON target.notice_id = notice.id
        JOIN users u ON u.id = target.user_id
        WHERE notice.id = $1
        `, [params.id]);
            if (scopeRes.rows.length === 0) {
                reply.code(404);
                return { error: 'notice_not_found' };
            }
            if (scopeRes.rows.some((row) => String(row.role ?? '').trim().toUpperCase() === 'ADMIN' ||
                !matchesTenantScope(access, row))) {
                reply.code(404);
                return { error: 'notice_not_found' };
            }
            if (scopeRes.rows[0]?.removed_at) {
                reply.code(409);
                return { error: 'notice_already_removed' };
            }
            const actorId = String(request.user.sub ?? '').trim();
            const removed = await removeBlockingNotice(client, params.id, actorId);
            if (!removed) {
                reply.code(404);
                return { error: 'notice_not_found' };
            }
            await logAudit(client, actorId, 'REMOVE_USER_BLOCKING_NOTICE', 'admin_blocking_notice', params.id, {
                target_count: scopeRes.rows.length,
            });
            return { notice: removed };
        });
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
                conditions.push(`(c.title ILIKE $${idx} OR c.id::text ILIKE $${idx} OR c.public_id ILIKE $${idx} OR adv.email ILIKE $${idx} OR adv.public_id ILIKE $${idx} OR c.business_id::text ILIKE $${idx} OR dist.email ILIKE $${idx} OR dist.public_id ILIKE $${idx} OR COALESCE(c.assigned_ambassador_id::text, '') ILIKE $${idx})`);
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
                conditions.push(`created_at >= $${idx}`);
                params.push(range.from);
                idx++;
            }
            if (range.to) {
                conditions.push(`created_at <= $${idx}`);
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
            const res = await client.query(`SELECT c.*, adv.email AS business_email, adv.public_id AS business_public_id, dist.email AS assigned_ambassador_email, dist.public_id AS assigned_ambassador_public_id FROM campaigns c LEFT JOIN users adv ON adv.id = c.business_id LEFT JOIN users dist ON dist.id = c.assigned_ambassador_id ${where} ORDER BY c.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]);
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
        if (!body.status && !body.decision && body.observed_views === undefined) {
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
             decision=COALESCE($3, decision),
             observed_views=COALESCE($4, observed_views)
         WHERE id=$1
         RETURNING *`, [params.id, body.status ?? null, body.decision ?? null, body.observed_views ?? null]);
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
    // ── Ambassador account verification recordings (admin review) ─────────────────
    app.get('/admin/user-verifications', { preHandler: [app.adminOnly] }, async (request) => {
        const query = request.query;
        const limit = Math.min(Number(query?.limit ?? 50), 200);
        const offset = Number(query?.offset ?? 0);
        const status = typeof query?.status === 'string' ? query.status : 'PENDING';
        return withTransaction(async (client) => {
            const conditions = [];
            const params = [];
            let idx = 1;
            if (status !== 'ALL') {
                conditions.push(`pvr.status=$${idx}`);
                params.push(status);
                idx++;
            }
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const res = await client.query(`SELECT
           pvr.id,
           pvr.user_id,
           pvr.video_url,
           pvr.status,
           pvr.approved_viewer_count,
           pvr.admin_note,
           pvr.reviewed_at,
           pvr.expires_at,
           pvr.video_expires_at,
           pvr.created_at,
           u.full_name AS user_name,
           u.email     AS user_email,
           u.phone     AS user_phone,
           u.max_status_viewers_12h AS current_verified_viewers
         FROM ambassador_verification_recordings pvr
         JOIN users u ON u.id = pvr.user_id
         ${where}
         ORDER BY pvr.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]);
            return { verifications: res.rows };
        });
    });
    app.patch('/admin/user-verifications/:id/approve', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = z.object({
            viewer_count: z.number().int().positive(),
            admin_note: z.string().trim().max(500).optional(),
        }).parse(request.body);
        return withTransaction(async (client) => {
            // Load the recording
            const recRes = await client.query(`SELECT pvr.*, u.id AS resolved_user_id
         FROM ambassador_verification_recordings pvr
         JOIN users u ON u.id = pvr.user_id
         WHERE pvr.id=$1 LIMIT 1`, [params.id]);
            const rec = recRes.rows[0];
            if (!rec) {
                reply.code(404);
                return { error: 'verification_not_found' };
            }
            const isExpiredApproved = rec.status === 'APPROVED' &&
                rec.expires_at != null &&
                new Date(rec.expires_at).getTime() < Date.now();
            if (rec.status !== 'PENDING' && !isExpiredApproved) {
                reply.code(409);
                return { error: 'already_reviewed' };
            }
            const adminUserId = request.user.sub;
            // Mark recording as approved; approval valid 30 days, video purged 24h after review
            await client.query(`UPDATE ambassador_verification_recordings
         SET status='APPROVED',
             approved_viewer_count=$2,
             admin_note=$3,
             reviewed_by_user_id=$4,
             reviewed_at=now(),
             expires_at=now() + INTERVAL '30 days',
             video_expires_at=now() + INTERVAL '24 hours',
             updated_at=now()
         WHERE id=$1`, [params.id, body.viewer_count, body.admin_note ?? null, adminUserId]);
            // Apply the verified viewer count to the user's account
            await client.query(`UPDATE users SET max_status_viewers_12h=$2 WHERE id=$1`, [rec.resolved_user_id, body.viewer_count]);
            await createUserNotifications(client, [rec.resolved_user_id], {
                category: 'ACCOUNT_VERIFICATION',
                title: 'Viewer count verified',
                body: `Your WhatsApp status viewer count was approved at ${body.viewer_count} views. This verification stays active until ${new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()}.`,
                actorId: adminUserId,
                targetType: 'AMBASSADOR_VERIFICATION',
                targetId: params.id,
                meta: {
                    viewer_count: body.viewer_count,
                    verified_viewer_count: body.viewer_count,
                    verification_status: 'APPROVED',
                    verification_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
                    admin_note: body.admin_note ?? null,
                },
            });
            await logAudit(client, adminUserId, 'APPROVE_USER_VERIFICATION', 'ambassador_verification_recording', params.id, { viewer_count: body.viewer_count });
            await resolveAdminOperationTaskByEntity(client, 'AMBASSADOR_VERIFICATION', params.id, adminUserId);
            const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
            return { ok: true, viewer_count: body.viewer_count, expires_at: expiresAt };
        });
    });
    app.patch('/admin/user-verifications/:id/reject', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = z.object({
            admin_note: z.string().trim().min(1).max(500).optional(),
        }).safeParse(request.body);
        return withTransaction(async (client) => {
            const recRes = await client.query(`SELECT pvr.user_id FROM ambassador_verification_recordings pvr WHERE pvr.id=$1 LIMIT 1`, [params.id]);
            const rec = recRes.rows[0];
            if (!rec) {
                reply.code(404);
                return { error: 'verification_not_found' };
            }
            const adminUserId = request.user.sub;
            const note = body.success ? (body.data.admin_note ?? null) : null;
            await client.query(`UPDATE ambassador_verification_recordings
         SET status='REJECTED',
             admin_note=$2,
             reviewed_by_user_id=$3,
             reviewed_at=now(),
             video_expires_at=now() + INTERVAL '24 hours',
             updated_at=now()
         WHERE id=$1`, [params.id, note, adminUserId]);
            await createUserNotifications(client, [rec.user_id], {
                category: 'ACCOUNT_VERIFICATION',
                title: 'Verification recording rejected',
                body: note
                    ? `Your verification recording was rejected: ${note}. Please re-submit a clearer recording.`
                    : 'Your verification recording was rejected. Please re-submit a clearer recording showing your viewer list.',
                actorId: adminUserId,
                targetType: 'AMBASSADOR_VERIFICATION',
                targetId: params.id,
                meta: {
                    verification_status: 'REJECTED',
                    admin_note: note,
                    requires_resubmission: true,
                },
            });
            await logAudit(client, adminUserId, 'REJECT_USER_VERIFICATION', 'ambassador_verification_recording', params.id, { admin_note: note });
            await resolveAdminOperationTaskByEntity(client, 'AMBASSADOR_VERIFICATION', params.id, adminUserId);
            return { ok: true };
        });
    });
    // ── Handler's Jaz admin collaboration room ────────────────────────────────
    app.get('/admin/handler-jaz/room', { preHandler: [app.adminOnly] }, async (request, reply) => {
        return withTransaction(async (client) => {
            const access = (request.adminAccess ?? null);
            const denied = rejectInvalidHandlerJazAccess(access, reply);
            if (denied)
                return denied;
            await ensureAdminHandlerJazSchema(client);
            return loadHandlerJazSnapshot(client, access);
        });
    });
    app.get('/admin/handler-jaz/live', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const query = (request.query ?? {});
        const cursor = parseLiveCursor(query.cursor);
        return withTransaction(async (client) => {
            const access = (request.adminAccess ?? null);
            const denied = rejectInvalidHandlerJazAccess(access, reply);
            if (denied)
                return denied;
            await ensureAdminHandlerJazSchema(client);
            return loadHandlerJazSnapshot(client, access, cursor);
        });
    });
    app.post('/admin/handler-jaz/identity', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const parsed = HandlerJazIdentitySchema.safeParse(request.body ?? {});
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        return withTransaction(async (client) => {
            const access = (request.adminAccess ?? null);
            const denied = rejectInvalidHandlerJazAccess(access, reply);
            if (denied)
                return denied;
            const identity = await upsertAdminHandlerJazIdentity(client, {
                userId: access.user_id,
                handle: parsed.data.handle,
            });
            await upsertAdminHandlerJazPresence(client, {
                userId: access.user_id,
                handle: parsed.data.handle,
                currentPane: 'HANDLER_JAZ',
                isRoomOpen: true,
            });
            return {
                identity: {
                    user_id: String(identity.user_id ?? access.user_id),
                    handle: String(identity.handle ?? parsed.data.handle),
                    updated_at: timestampText(identity.updated_at),
                },
            };
        });
    });
    app.post('/admin/handler-jaz/presence', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const parsed = HandlerJazPresenceSchema.safeParse(request.body ?? {});
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        return withTransaction(async (client) => {
            const access = (request.adminAccess ?? null);
            const denied = rejectInvalidHandlerJazAccess(access, reply);
            if (denied)
                return denied;
            const handle = await resolveHandlerJazHandle(client, access, parsed.data.handle);
            if (!handle) {
                reply.code(409);
                return { error: 'handler_jaz_identity_required' };
            }
            const presence = await upsertAdminHandlerJazPresence(client, {
                userId: access.user_id,
                handle,
                currentPane: parsed.data.current_pane,
                isRoomOpen: parsed.data.is_room_open,
                isMinimized: parsed.data.is_minimized,
                inCall: parsed.data.in_call,
                callMode: parsed.data.call_mode,
                screenShareActive: parsed.data.screen_share_active,
                callSessionId: parsed.data.call_session_id,
            });
            const snapshot = await loadHandlerJazSnapshot(client, access);
            return {
                presence: {
                    user_id: String(presence.user_id ?? access.user_id),
                    handle: String(presence.handle ?? handle),
                    current_pane: String(presence.current_pane ?? 'OVERVIEW'),
                    in_call: presence.in_call === true,
                    call_mode: String(presence.call_mode ?? 'NONE'),
                    screen_share_active: presence.screen_share_active === true,
                    updated_at: timestampText(presence.updated_at),
                    last_seen_at: timestampText(presence.last_seen_at),
                },
                room: snapshot.room,
                participants: snapshot.participants,
                cursor: snapshot.cursor,
            };
        });
    });
    app.post('/admin/handler-jaz/messages', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const isMultipart = String(request.headers['content-type'] ?? '')
            .toLowerCase()
            .includes('multipart/form-data');
        return withTransaction(async (client) => {
            const access = (request.adminAccess ?? null);
            const denied = rejectInvalidHandlerJazAccess(access, reply);
            if (denied)
                return denied;
            let payload = {};
            let attachmentUrl = null;
            let attachmentName = null;
            let attachmentMimeType = null;
            if (isMultipart) {
                const fields = {};
                try {
                    for await (const part of request.parts()) {
                        if (part.type === 'file' && attachmentUrl == null) {
                            const uploaded = await storeMultipartAttachmentFile({
                                part,
                                prefix: 'handler-jaz-attachment',
                                maxBytes: 50 * 1024 * 1024,
                            });
                            attachmentUrl = uploaded.fileUrl;
                            attachmentName = uploaded.fileName;
                            attachmentMimeType = uploaded.mimeType;
                        }
                        else if (part.type === 'field') {
                            fields[part.fieldname] = String(part.value ?? '');
                        }
                    }
                }
                catch (error) {
                    const handled = resolveMediaUploadError(error);
                    if (handled) {
                        reply.code(handled.statusCode);
                        return handled.payload;
                    }
                    throw error;
                }
                payload = {
                    body: fields.body ?? '',
                    attachment_url: attachmentUrl ?? undefined,
                    attachment_name: attachmentName ?? fields.attachment_name,
                    attachment_mime_type: attachmentMimeType ?? fields.attachment_mime_type,
                };
            }
            else {
                payload = request.body ?? {};
            }
            const parsed = HandlerJazMessageSchema.safeParse(payload);
            if (!parsed.success) {
                reply.code(400);
                return { error: 'validation_failed', issues: parsed.error.issues };
            }
            const handle = await resolveHandlerJazHandle(client, access, null);
            if (!handle) {
                reply.code(409);
                return { error: 'handler_jaz_identity_required' };
            }
            await upsertAdminHandlerJazPresence(client, {
                userId: access.user_id,
                handle,
                currentPane: 'HANDLER_JAZ',
                isRoomOpen: true,
            });
            const message = await createAdminHandlerJazMessage(client, {
                senderUserId: access.user_id,
                senderHandle: handle,
                body: parsed.data.body,
                attachmentUrl: parsed.data.attachment_url,
                attachmentName: parsed.data.attachment_name,
                attachmentMimeType: parsed.data.attachment_mime_type,
            });
            return { message };
        });
    });
    app.post('/admin/handler-jaz/signals', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const parsed = HandlerJazSignalSchema.safeParse(request.body ?? {});
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        return withTransaction(async (client) => {
            const access = (request.adminAccess ?? null);
            const denied = rejectInvalidHandlerJazAccess(access, reply);
            if (denied)
                return denied;
            const handle = await resolveHandlerJazHandle(client, access, null);
            if (!handle) {
                reply.code(409);
                return { error: 'handler_jaz_identity_required' };
            }
            await upsertAdminHandlerJazPresence(client, {
                userId: access.user_id,
                handle,
                currentPane: 'HANDLER_JAZ',
                isRoomOpen: true,
            });
            const signal = await createAdminHandlerJazSignalEvent(client, {
                senderUserId: access.user_id,
                senderHandle: handle,
                eventType: parsed.data.event_type,
                targetUserId: parsed.data.target_user_id,
                payload: parsed.data.payload,
            });
            return { signal };
        });
    });
    app.post('/admin/handler-jaz/leave', { preHandler: [app.adminOnly] }, async (request, reply) => {
        return withTransaction(async (client) => {
            const access = (request.adminAccess ?? null);
            const denied = rejectInvalidHandlerJazAccess(access, reply);
            if (denied)
                return denied;
            await deactivateAdminHandlerJazPresence(client, access.user_id);
            return { ok: true };
        });
    });
    // ── Admin operations command center ────────────────────────────────────────
    app.get('/admin/operations/live', { preHandler: [app.adminOnly] }, async (request) => {
        const query = request.query;
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            return loadAdminOperationsSnapshot(client, access, {
                includeMessages: parseBooleanFlag(query?.include_messages, true),
                includeWorkforce: parseBooleanFlag(query?.include_workforce, true),
                includeAudit: parseBooleanFlag(query?.include_audit, true),
                notificationLimit: Number(query?.notification_limit ?? 12),
                messageLimit: Number(query?.message_limit ?? 40),
                operatorLimit: Number(query?.operator_limit ?? 24),
                auditLimit: Number(query?.audit_limit ?? 20),
            });
        });
    });
    app.post('/admin/operations/tasks/:taskKey/claim', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = AdminOperationsTaskActionSchema.safeParse(request.body ?? {});
        if (!body.success) {
            reply.code(400);
            return { error: 'invalid_body', issues: body.error.issues };
        }
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const snapshot = await loadAdminOperationsSnapshot(client, access, {
                includeMessages: false,
                includeWorkforce: false,
                includeAudit: false,
            });
            const task = snapshot.tasks.find((item) => item.task_key === params.taskKey);
            if (!task || task.actionable !== true) {
                reply.code(404);
                return { error: 'task_not_found' };
            }
            const slaMinutes = Math.min(Math.max(Number(snapshot.settings.operations_sla_minutes ?? 10), 1), 120);
            const defaultAckMinutes = Math.min(Math.max(Number(snapshot.settings.operations_ack_minutes ?? 5), 1), slaMinutes);
            const ackMinutes = Math.min(Math.max(body.data.minutes ?? defaultAckMinutes, 1), slaMinutes);
            const actorId = String(request.user.sub ?? '');
            await claimAdminOperationTask(client, actorId, {
                task_key: task.task_key,
                entity_type: task.entity_type,
                entity_id: task.entity_id,
                category: task.category,
                target_section: task.target_section,
            }, ackMinutes);
            await logAudit(client, actorId, 'CLAIM_ADMIN_OPERATION_TASK', 'admin_operation_task', task.task_key, {
                entity_type: task.entity_type,
                entity_id: task.entity_id,
                category: task.category,
                ack_minutes: ackMinutes,
            });
            return { ok: true };
        });
    });
    app.post('/admin/operations/tasks/:taskKey/acknowledge', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = AdminOperationsTaskActionSchema.safeParse(request.body ?? {});
        if (!body.success) {
            reply.code(400);
            return { error: 'invalid_body', issues: body.error.issues };
        }
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const snapshot = await loadAdminOperationsSnapshot(client, access, {
                includeMessages: false,
                includeWorkforce: false,
                includeAudit: false,
            });
            const task = snapshot.tasks.find((item) => item.task_key === params.taskKey);
            if (!task || task.actionable !== true) {
                reply.code(404);
                return { error: 'task_not_found' };
            }
            const slaMinutes = Math.min(Math.max(Number(snapshot.settings.operations_sla_minutes ?? 10), 1), 120);
            const defaultAckMinutes = Math.min(Math.max(Number(snapshot.settings.operations_ack_minutes ?? 5), 1), slaMinutes);
            const ackMinutes = Math.min(Math.max(body.data.minutes ?? defaultAckMinutes, 1), slaMinutes);
            const actorId = String(request.user.sub ?? '');
            await acknowledgeAdminOperationTask(client, actorId, {
                task_key: task.task_key,
                entity_type: task.entity_type,
                entity_id: task.entity_id,
                category: task.category,
                target_section: task.target_section,
            }, ackMinutes);
            await logAudit(client, actorId, 'ACKNOWLEDGE_ADMIN_OPERATION_TASK', 'admin_operation_task', task.task_key, {
                entity_type: task.entity_type,
                entity_id: task.entity_id,
                category: task.category,
                ack_minutes: ackMinutes,
            });
            return { ok: true };
        });
    });
    app.post('/admin/operations/tasks/:taskKey/release', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            const actorId = String(request.user.sub ?? '');
            const currentState = await loadAdminOperationTaskState(client, params.taskKey);
            if (!currentState) {
                reply.code(404);
                return { error: 'task_not_found' };
            }
            if (currentState.claimed_by_user_id &&
                currentState.claimed_by_user_id !== actorId &&
                !isSuperDashboardAccess(access)) {
                reply.code(403);
                return { error: 'forbidden' };
            }
            await releaseAdminOperationTaskClaim(client, params.taskKey);
            await logAudit(client, actorId, 'RELEASE_ADMIN_OPERATION_TASK', 'admin_operation_task', params.taskKey, {});
            return { ok: true };
        });
    });
    app.post('/admin/operations/messages', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const body = AdminOperationsMessageSchema.safeParse(request.body ?? {});
        if (!body.success) {
            reply.code(400);
            return { error: 'invalid_body', issues: body.error.issues };
        }
        return withTransaction(async (client) => {
            const actorId = String(request.user.sub ?? '');
            const message = await createAdminOperationMessage(client, actorId, body.data.body);
            await logAudit(client, actorId, 'SEND_ADMIN_OPERATION_MESSAGE', 'admin_operation_message', message?.id?.toString() ?? null, {
                length: body.data.body.length,
            });
            return { ok: true, message };
        });
    });
    // ── Admin settings ──────────────────────────────────────────────────────────
    app.get('/admin/settings', { preHandler: [app.adminOnly] }, async () => {
        return withTransaction(async (client) => {
            const res = await client.query('SELECT key, value FROM admin_settings');
            const settings = {
                campaign_approval_mode: 'MANUAL',
                operations_sla_minutes: '10',
                operations_ack_minutes: '5',
            };
            for (const row of res.rows)
                settings[row.key] = row.value;
            return { settings };
        });
    });
    app.patch('/admin/settings', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const body = AdminSettingsPatchSchema.safeParse(request.body);
        if (!body.success) {
            reply.code(400);
            return { error: 'invalid_body', issues: body.error.issues };
        }
        return withTransaction(async (client) => {
            const access = await getLiveDashboardAccess(client, request);
            if (!isSuperDashboardAccess(access) &&
                (body.data.operations_sla_minutes !== undefined ||
                    body.data.operations_ack_minutes !== undefined)) {
                reply.code(403);
                return { error: 'forbidden' };
            }
            if (body.data.operations_sla_minutes !== undefined &&
                body.data.operations_ack_minutes !== undefined &&
                body.data.operations_ack_minutes > body.data.operations_sla_minutes) {
                reply.code(400);
                return { error: 'ack_window_exceeds_sla' };
            }
            if (body.data.campaign_approval_mode !== undefined) {
                await client.query(`INSERT INTO admin_settings (key, value, updated_at)
           VALUES ('campaign_approval_mode', $1, now())
           ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`, [body.data.campaign_approval_mode]);
            }
            if (body.data.operations_sla_minutes !== undefined) {
                await client.query(`INSERT INTO admin_settings (key, value, updated_at)
           VALUES ('operations_sla_minutes', $1, now())
           ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`, [String(body.data.operations_sla_minutes)]);
            }
            if (body.data.operations_ack_minutes !== undefined) {
                const maxAckMinutes = body.data.operations_sla_minutes ?? Number((await client.query(`SELECT value FROM admin_settings WHERE key = 'operations_sla_minutes' LIMIT 1`)).rows[0]?.value ?? 10);
                if (body.data.operations_ack_minutes > maxAckMinutes) {
                    reply.code(400);
                    return { error: 'ack_window_exceeds_sla' };
                }
                await client.query(`INSERT INTO admin_settings (key, value, updated_at)
           VALUES ('operations_ack_minutes', $1, now())
           ON CONFLICT (key) DO UPDATE SET value=$1, updated_at=now()`, [String(body.data.operations_ack_minutes)]);
            }
            const res = await client.query('SELECT key, value FROM admin_settings');
            const settings = {
                campaign_approval_mode: 'MANUAL',
                operations_sla_minutes: '10',
                operations_ack_minutes: '5',
            };
            for (const row of res.rows)
                settings[row.key] = row.value;
            return { settings };
        });
    });
    // ── Campaign approval workflow ───────────────────────────────────────────────
    app.get('/admin/campaigns/pending-approval', { preHandler: [app.adminOnly] }, async (request) => {
        const query = request.query;
        const limit = Math.min(Number(query?.limit ?? 50), 200);
        const offset = Number(query?.offset ?? 0);
        return withTransaction(async (client) => {
            const res = await client.query(`SELECT
           c.id, c.title, c.platform, c.execution_mode, c.delivery_model,
           c.budget_total, c.payout_amount, c.impression_target,
           c.media_url, c.media_text, c.media_type,
           c.terms_requirement, c.terms_keep_hours, c.terms_min_views,
           c.start_date, c.end_date, c.visibility,
           c.approval_status, c.approval_deadline, c.approved_at,
           c.created_at,
           u.id AS business_id,
           u.full_name AS business_name,
           u.email AS business_email
         FROM campaigns c
         JOIN users u ON u.id = c.business_id
         WHERE c.approval_status = 'PENDING_APPROVAL'
         ORDER BY c.approval_deadline ASC NULLS LAST
         LIMIT $1 OFFSET $2`, [limit, offset]);
            return { campaigns: res.rows };
        });
    });
    app.patch('/admin/campaigns/:id/approve', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const adminUserId = request.user.sub;
        return withTransaction(async (client) => {
            const campRes = await client.query(`SELECT c.id, c.business_id, c.title, c.approval_status
         FROM campaigns c WHERE c.id=$1 LIMIT 1`, [params.id]);
            const camp = campRes.rows[0];
            if (!camp) {
                reply.code(404);
                return { error: 'campaign_not_found' };
            }
            await client.query(`UPDATE campaigns
         SET approval_status='APPROVED', approved_at=now(), approved_by_user_id=$2
         WHERE id=$1`, [params.id, adminUserId]);
            await client.query(`INSERT INTO user_signals (id, user_id, type, title, body, created_at)
         VALUES (gen_random_uuid(), $1, 'CAMPAIGN_APPROVED',
                 'Campaign approved',
                 $2, now())
         ON CONFLICT DO NOTHING`, [
                camp.business_id,
                `Your campaign "${camp.title}" has been approved. You can now fund and launch it.`,
            ]);
            await logAudit(client, adminUserId, 'APPROVE_CAMPAIGN', 'campaign', params.id, {});
            await resolveAdminOperationTaskByEntity(client, 'CAMPAIGN_APPROVAL', params.id, adminUserId);
            return { ok: true };
        });
    });
    app.patch('/admin/campaigns/:id/reject', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = z.object({ reason: z.string().trim().min(1).max(500) }).safeParse(request.body);
        if (!body.success) {
            reply.code(400);
            return { error: 'reason_required' };
        }
        const adminUserId = request.user.sub;
        return withTransaction(async (client) => {
            const campRes = await client.query(`SELECT c.id, c.business_id, c.title FROM campaigns c WHERE c.id=$1 LIMIT 1`, [params.id]);
            const camp = campRes.rows[0];
            if (!camp) {
                reply.code(404);
                return { error: 'campaign_not_found' };
            }
            await client.query(`UPDATE campaigns SET approval_status='REJECTED', approved_at=now(), approved_by_user_id=$2 WHERE id=$1`, [params.id, adminUserId]);
            await client.query(`INSERT INTO user_signals (id, user_id, type, title, body, created_at)
         VALUES (gen_random_uuid(), $1, 'CAMPAIGN_REJECTED', 'Campaign rejected', $2, now())
         ON CONFLICT DO NOTHING`, [camp.business_id, `Your campaign "${camp.title}" was rejected: ${body.data.reason}`]);
            await logAudit(client, adminUserId, 'REJECT_CAMPAIGN', 'campaign', params.id, { reason: body.data.reason });
            await resolveAdminOperationTaskByEntity(client, 'CAMPAIGN_APPROVAL', params.id, adminUserId);
            return { ok: true };
        });
    });
    app.patch('/admin/campaigns/:id/return-for-edit', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = z.object({ reason: z.string().trim().min(1).max(500) }).safeParse(request.body);
        if (!body.success) {
            reply.code(400);
            return { error: 'reason_required' };
        }
        const adminUserId = request.user.sub;
        return withTransaction(async (client) => {
            const campRes = await client.query(`SELECT c.id, c.business_id, c.title FROM campaigns c WHERE c.id=$1 LIMIT 1`, [params.id]);
            const camp = campRes.rows[0];
            if (!camp) {
                reply.code(404);
                return { error: 'campaign_not_found' };
            }
            await client.query(`UPDATE campaigns SET approval_status='RETURNED', approved_by_user_id=$2 WHERE id=$1`, [params.id, adminUserId]);
            await client.query(`INSERT INTO user_signals (id, user_id, type, title, body, created_at)
         VALUES (gen_random_uuid(), $1, 'CAMPAIGN_RETURNED', 'Campaign returned for edit', $2, now())
         ON CONFLICT DO NOTHING`, [camp.business_id, `Your campaign "${camp.title}" was returned for editing: ${body.data.reason}. Please update and resubmit.`]);
            await logAudit(client, adminUserId, 'RETURN_CAMPAIGN', 'campaign', params.id, { reason: body.data.reason });
            await resolveAdminOperationTaskByEntity(client, 'CAMPAIGN_APPROVAL', params.id, adminUserId);
            return { ok: true };
        });
    });
    // ── Campaign completion / proof administration ───────────────────────────────
    app.get('/admin/campaign-completions', { preHandler: [app.adminOnly] }, async (request) => {
        const query = request.query;
        const limit = Math.min(Number(query?.limit ?? 50), 200);
        const offset = Number(query?.offset ?? 0);
        const rawStatusFilter = typeof query?.status === 'string' ? query.status : 'PENDING';
        const statusFilter = rawStatusFilter === 'SUBMITTED' ? 'PENDING' : rawStatusFilter;
        return withTransaction(async (client) => {
            const conditions = [];
            const params = [];
            let idx = 1;
            if (statusFilter !== 'ALL') {
                conditions.push(`p.status=$${idx}`);
                params.push(statusFilter);
                idx++;
            }
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const res = await client.query(`SELECT
           p.id AS proof_id,
           p.status AS proof_status,
           p.decision,
           p.video_url,
           p.observed_views,
           p.created_at AS submitted_at,
           p.updated_at,
           p.meta AS proof_meta,
           p.review_reasons,
           c.id AS campaign_id,
           c.public_id AS campaign_public_id,
           c.title AS campaign_title,
           c.platform,
           c.media_type,
           c.media_url,
           c.media_text,
           c.execution_mode,
           c.delivery_model,
           c.payout_amount,
           c.budget_total,
           c.start_date,
           c.end_date,
           c.terms_keep_hours,
           c.terms_min_views,
           c.terms_requirement,
           c.visibility,
           c.execution_meta,
           ambassador.id AS ambassador_id,
           ambassador.full_name AS ambassador_name,
           ambassador.email AS ambassador_email,
           business.id AS business_id,
           business.full_name AS business_name,
           business.email AS business_email,
           vs.script AS verification_script,
           vs.challenge_code,
           vs.challenge_phrase,
           vs.expires_at AS verification_expires_at
         FROM proofs p
         JOIN verification_sessions vs ON vs.id = p.session_id
         JOIN campaigns c ON c.id = vs.campaign_id
         JOIN users ambassador ON ambassador.id = p.user_id
         JOIN users business ON business.id = c.business_id
         ${where}
         ORDER BY p.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]);
            return { completions: res.rows };
        });
    });
    app.patch('/admin/campaign-completions/:proofId/approve', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const adminUserId = request.user.sub;
        return withTransaction(async (client) => {
            // Fetch proof with campaign + users
            const res = await client.query(`SELECT
           p.id, p.user_id AS ambassador_id, p.status, p.decision,
           c.id AS campaign_id, c.title AS campaign_title, c.business_id,
           c.payout_amount
         FROM proofs p
         JOIN verification_sessions vs ON vs.id = p.session_id
         JOIN campaigns c ON c.id = vs.campaign_id
         WHERE p.id=$1 LIMIT 1`, [params.proofId]);
            const proof = res.rows[0];
            if (!proof) {
                reply.code(404);
                return { error: 'proof_not_found' };
            }
            // Mark proof VERIFIED + VERIFIED decision
            await client.query(`UPDATE proofs SET status='VERIFIED', decision='VERIFIED', updated_at=now() WHERE id=$1`, [params.proofId]);
            await markContractCompletedForVerifiedProof(client, params.proofId);
            await jobRepo.enqueue(client, 'PAYOUT_PROOF', { proof_id: params.proofId });
            // Notify ambassador
            await client.query(`INSERT INTO user_signals (id, user_id, type, title, body, created_at)
         VALUES (gen_random_uuid(), $1, 'PROOF_VERIFIED',
                 'Campaign proof approved',
                 $2, now())
         ON CONFLICT DO NOTHING`, [
                proof.ambassador_id,
                `Your proof for "${proof.campaign_title}" has been approved. Your payout of UGX ${proof.payout_amount} is being processed.`,
            ]);
            // Notify business
            await client.query(`INSERT INTO user_signals (id, user_id, type, title, body, created_at)
         VALUES (gen_random_uuid(), $1, 'CAMPAIGN_PROOF_VERIFIED',
                 'Campaign delivery confirmed',
                 $2, now())
         ON CONFLICT DO NOTHING`, [
                proof.business_id,
                `A proof for your campaign "${proof.campaign_title}" has been verified and the ambassador has been paid.`,
            ]);
            await logAudit(client, adminUserId, 'APPROVE_CAMPAIGN_COMPLETION', 'proof', params.proofId, {});
            await resolveAdminOperationTaskByEntity(client, 'CAMPAIGN_COMPLETION', params.proofId, adminUserId);
            return { ok: true };
        });
    });
    app.patch('/admin/campaign-completions/:proofId/reject', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const adminUserId = request.user.sub;
        const body = request.body;
        const reason = (body?.reason ?? '').toString().trim();
        if (reason.length === 0) {
            reply.code(400);
            return { error: 'reason_required' };
        }
        return withTransaction(async (client) => {
            const res = await client.query(`SELECT p.id, p.user_id AS ambassador_id, p.status,
                c.title AS campaign_title, c.business_id
         FROM proofs p
         JOIN verification_sessions vs ON vs.id = p.session_id
         JOIN campaigns c ON c.id = vs.campaign_id
         WHERE p.id=$1 LIMIT 1`, [params.proofId]);
            const proof = res.rows[0];
            if (!proof) {
                reply.code(404);
                return { error: 'proof_not_found' };
            }
            await client.query(`UPDATE proofs SET status='REJECTED', decision='REJECTED', updated_at=now() WHERE id=$1`, [params.proofId]);
            // Notify ambassador
            await client.query(`INSERT INTO user_signals (id, user_id, type, title, body, created_at)
         VALUES (gen_random_uuid(), $1, 'PROOF_REJECTED',
                 'Campaign proof rejected',
                 $2, now())
         ON CONFLICT DO NOTHING`, [
                proof.ambassador_id,
                `Your proof for "${proof.campaign_title}" was rejected: ${reason}. Please re-submit.`,
            ]);
            await logAudit(client, adminUserId, 'REJECT_CAMPAIGN_COMPLETION', 'proof', params.proofId, { reason });
            await resolveAdminOperationTaskByEntity(client, 'CAMPAIGN_COMPLETION', params.proofId, adminUserId);
            return { ok: true };
        });
    });
    app.patch('/admin/campaign-completions/:proofId/request-resubmission', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const adminUserId = request.user.sub;
        const body = request.body;
        const reason = (body?.reason ?? '').toString().trim();
        return withTransaction(async (client) => {
            const res = await client.query(`SELECT p.id, p.user_id AS ambassador_id, p.status,
                c.title AS campaign_title
         FROM proofs p
         JOIN verification_sessions vs ON vs.id = p.session_id
         JOIN campaigns c ON c.id = vs.campaign_id
         WHERE p.id=$1 LIMIT 1`, [params.proofId]);
            const proof = res.rows[0];
            if (!proof) {
                reply.code(404);
                return { error: 'proof_not_found' };
            }
            await client.query(`UPDATE proofs
         SET status='REJECTED',
             decision='REJECTED',
             meta = COALESCE(meta, '{}'::jsonb) || $2::jsonb,
             updated_at=now()
         WHERE id=$1`, [
                params.proofId,
                JSON.stringify({
                    admin_review: {
                        action: 'REQUEST_RESUBMISSION',
                        reason: reason || null,
                        reviewed_at: new Date().toISOString(),
                        reviewed_by_user_id: adminUserId,
                    },
                }),
            ]);
            await client.query(`INSERT INTO user_signals (id, user_id, type, title, body, created_at)
         VALUES (gen_random_uuid(), $1, 'PROOF_RESUBMISSION_REQUESTED',
                 'Proof needs correction',
                 $2, now())
         ON CONFLICT DO NOTHING`, [
                proof.ambassador_id,
                reason.length > 0
                    ? `Your proof for "${proof.campaign_title}" needs correction: ${reason}. Please submit a new mp4 screen recording.`
                    : `Your proof for "${proof.campaign_title}" needs correction. Please submit a new mp4 screen recording.`,
            ]);
            await logAudit(client, adminUserId, 'REQUEST_CAMPAIGN_COMPLETION_RESUBMISSION', 'proof', params.proofId, { reason: reason.length > 0 ? reason : null });
            await resolveAdminOperationTaskByEntity(client, 'CAMPAIGN_COMPLETION', params.proofId, adminUserId);
            return { ok: true };
        });
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
            const state = {
                conditions: [],
                params: [params.id],
                idx: 2,
            };
            appendTenantScope(state, access, {
                country: 'u.country_id',
                division: 'u.division_id',
            });
            const scopeFilter = state.conditions.length
                ? `AND ${state.conditions.join(' AND ')}`
                : '';
            const res = await client.query(`SELECT wt.*
         FROM wallet_txns wt
         JOIN wallets w ON w.id = wt.wallet_id
         JOIN users u ON u.id = w.user_id
         WHERE wt.wallet_id = $1
         ${scopeFilter}
         ORDER BY wt.created_at DESC
         LIMIT 200`, state.params);
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
            const res = await client.query(`SELECT ctr.*, c.title AS campaign_title, u.email AS ambassador_email, adv.email AS business_email FROM contracts ctr JOIN campaigns c ON c.id = ctr.campaign_id JOIN users u ON u.id = ctr.ambassador_id JOIN users adv ON adv.id = c.business_id
         ${where}
         ORDER BY ctr.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]);
            return { contracts: res.rows };
        });
    });
    app.patch('/admin/contracts/:id', { preHandler: [app.adminOnly] }, async (request, reply) => {
        const params = request.params;
        const body = UpdateContractSchema.parse(request.body);
        if (!body.status && !body.ambassador_id) {
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
            if (body.ambassador_id) {
                const ambassadorRes = await client.query(`
          SELECT id, country_id, division_id
          FROM users
          WHERE id = $1
          LIMIT 1
          `, [body.ambassador_id]);
                const ambassador = ambassadorRes.rows[0] ?? null;
                if (!ambassador) {
                    reply.code(404);
                    return { error: 'ambassador_not_found' };
                }
                const sameTenant = String(ambassador.country_id ?? '') ===
                    String(scopedContract.country_id ?? '') &&
                    (!scopedContract.division_id ||
                        String(ambassador.division_id ?? '') ===
                            String(scopedContract.division_id ?? ''));
                if (!sameTenant || !matchesTenantScope(access, ambassador)) {
                    reply.code(409);
                    return { error: 'ambassador_scope_mismatch' };
                }
            }
            const updated = await client.query(`UPDATE contracts
         SET status=COALESCE($2, status),
             ambassador_id=COALESCE($3, ambassador_id)
         WHERE id=$1
         RETURNING *`, [params.id, body.status ?? null, body.ambassador_id ?? null]);
            if (updated.rows[0]) {
                await logAudit(client, request.user.sub, 'UPDATE_CONTRACT', 'contract', params.id, body);
            }
            return updated.rows[0];
        });
        if (res?.error === 'ambassador_not_found' ||
            res?.error === 'ambassador_scope_mismatch') {
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
                if (body.status &&
                    body.status !== 'FAILED' &&
                    body.status !== 'RETRY') {
                    await resolveAdminOperationTaskByEntity(client, 'JOB', params.id, String(request.user.sub ?? ''));
                }
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
                await resolveAdminOperationTaskByEntity(client, 'JOB', params.id, String(request.user.sub ?? ''));
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
                if (body.status !== 'REQUESTED' && body.status !== 'PROCESSING') {
                    await resolveAdminOperationTaskByEntity(client, 'PAYOUT_REQUEST', params.id, String(request.user.sub ?? ''));
                }
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
