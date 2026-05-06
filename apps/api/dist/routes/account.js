import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { withTransaction } from '../db.js';
import { hashPassword, verifyPassword } from '../services/auth.js';
import { requestPayout, } from '../services/yoUganda.js';
import { resolveAvailableYoUgandaCheckoutProfile } from '../services/yoUgandaCheckoutProfile.js';
import { whatsappVerificationService } from '../services/whatsappVerification.js';
import { deleteFromFirebaseStorage, extractFirebaseObjectNameFromUrl, } from '../services/firebaseStorage.js';
import { resolveMediaUploadError, storeMultipartMediaFile, } from '../services/mediaUploads.js';
import { ensurePublicIdColumns } from '../services/publicId.js';
import { ACCOUNT_ROLE_BUSINESS, buildAuthClaims, buildUserSession, canAccessBusinessFeatures, canAccessAmbassadorFeatures, normalizeAccountRole, normalizeActiveRole, normalizeRequestedUserRole, } from '../services/roles.js';
import { deleteUserNotification, ensureUserSignalSchema, listUserNotifications, markAllUserNotificationsRead, updateUserNotificationReadState, } from '../services/userSignals.js';
import { buildCurrentPolicyDocuments, buildPolicyAcceptanceState, CURRENT_PLATFORM_POLICY_VERSION, CURRENT_PRIVACY_POLICY_VERSION, ensurePolicyAcceptanceColumns, policyAcceptanceSelectSql, } from '../services/policies.js';
import { config, hasYoClientCredentials, hasYoEncryptionKey, } from '../config.js';
const roleInputSchema = z
    .string()
    .trim()
    .transform((value, ctx) => {
    const normalized = normalizeRequestedUserRole(value);
    if (normalized != null) {
        return normalized;
    }
    ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Invalid role.',
    });
    return z.NEVER;
});
const accountProfileSchema = z
    .object({
    full_name: z.string().trim().min(2).max(120),
    country: z.string().trim().min(2).max(3).optional(),
    current_advertiser_viewers: z.number().int().min(0).optional(),
    current_business_viewers: z.number().int().min(0).optional(),
    private_contract_rate_ugx: z.number().int().min(0).optional(),
    private_contract_rate_24h_ugx: z.number().int().min(0).optional(),
    price_privacy_mode: z.enum(['NEGOTIABLE', 'FIXED']).optional(),
    beneficiary_listing_mode: z.enum(['LISTED', 'DIRECT_ONLY']).optional(),
})
    .transform((body) => ({
    ...body,
    current_business_viewers: body.current_business_viewers ?? body.current_business_viewers,
}));
const accountPasswordSchema = z.object({
    current_password: z.string().min(8),
    new_password: z.string().min(8),
});
const accountAvatarSchema = z.object({
    avatar_url: z.string().url().max(1024),
});
const accountRoleSchema = z.object({
    role: roleInputSchema,
    max_status_viewers_12h: z.number().int().nonnegative().optional(),
});
const ambassadorCapacitySchema = z.object({
    max_status_viewers_12h: z.number().int().positive(),
    rate_12h_ugx: z.number().int().min(0).optional(),
    rate_24h_ugx: z.number().int().min(0).optional(),
});
const accountWhatsappVerifySchema = z.object({
    phone: z.string().trim().min(7).max(20).optional(),
});
const accountPolicyAcceptanceSchema = z.object({
    privacy_policy_version: z.string().trim().min(1),
    platform_policy_version: z.string().trim().min(1),
    accept_privacy_policy: z.boolean().optional(),
    accept_platform_policy: z.boolean().optional(),
});
const accountNotificationUpdateSchema = z.object({
    read: z.boolean(),
});
const walletWithdrawSchema = z.object({
    amount: z.number().int().positive(),
    phone: z.string().trim().min(7).max(20).optional(),
    network: z.enum(['MTN', 'AIRTEL']).optional(),
});
const walletDepositSchema = z.object({
    amount: z.number().int().positive(),
    return_url: z.string().trim().min(1).optional(),
    cancel_url: z.string().trim().min(1).optional(),
    network: z.enum(['MTN', 'AIRTEL']).optional(),
});
const MIN_WALLET_WITHDRAW_UGX = 1;
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
            // Ignore invalid configuration and fall through.
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
function normalizeStringList(values) {
    return Array.from(new Set(values
        .map((value) => String(value ?? '').trim())
        .filter((value) => value.length > 0)));
}
async function deleteAccountMedia(urls) {
    const objectNames = Array.from(new Set(urls
        .map((url) => extractFirebaseObjectNameFromUrl(url))
        .filter((value) => Boolean(value))));
    let deletedCount = 0;
    for (const objectName of objectNames) {
        try {
            const deleted = await deleteFromFirebaseStorage(objectName);
            if (deleted) {
                deletedCount += 1;
            }
        }
        catch {
            // Database deletion is authoritative; media cleanup is best-effort.
        }
    }
    return deletedCount;
}
async function ensureUserProfilesTable(client) {
    await client.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL DEFAULT '',
      avatar_url TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
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
async function ensureWhatsappColumns(client) {
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS whatsapp_verified BOOLEAN NOT NULL DEFAULT FALSE;
  `);
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS whatsapp_verified_at TIMESTAMPTZ;
  `);
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS whatsapp_jid TEXT;
  `);
}
async function ensureWalletTables(client) {
    await client.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      currency TEXT NOT NULL DEFAULT 'UGX',
      balance_available INTEGER NOT NULL DEFAULT 0,
      balance_escrow INTEGER NOT NULL DEFAULT 0,
      balance INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await client.query(`
    ALTER TABLE wallets
      ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'UGX'
  `);
    await client.query(`
    ALTER TABLE wallets
      ADD COLUMN IF NOT EXISTS balance_available INTEGER NOT NULL DEFAULT 0
  `);
    await client.query(`
    ALTER TABLE wallets
      ADD COLUMN IF NOT EXISTS balance_escrow INTEGER NOT NULL DEFAULT 0
  `);
    await client.query(`
    ALTER TABLE wallets
      ADD COLUMN IF NOT EXISTS balance INTEGER NOT NULL DEFAULT 0
  `);
    await client.query(`
    UPDATE wallets
    SET balance_available = COALESCE(balance_available, balance, 0),
        balance = COALESCE(balance, balance_available, 0)
    WHERE balance_available <> COALESCE(balance, balance_available, 0)
       OR balance <> COALESCE(balance_available, balance, 0)
  `);
    await client.query(`
    CREATE TABLE IF NOT EXISTS wallet_txns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('CREDIT', 'DEBIT')),
      reference TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await client.query(`
    CREATE TABLE IF NOT EXISTS wallet_withdrawals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'UGX',
      receiver_phone TEXT NOT NULL,
      mobile_money_network TEXT,
      status payout_status NOT NULL DEFAULT 'PROCESSING',
      pesapal_reference TEXT UNIQUE,
      failure_reason TEXT,
      paid_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await client.query(`
    ALTER TABLE wallet_withdrawals
      ADD COLUMN IF NOT EXISTS mobile_money_network TEXT
  `);
}
async function ensureAccountSchema(client) {
    await ensurePublicIdColumns(client);
    await ensureUserSignalSchema(client);
    await ensureWhatsappColumns(client);
    await ensureUserProfilesTable(client);
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS full_name TEXT NOT NULL DEFAULT ''
  `);
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS country TEXT NOT NULL DEFAULT 'UG'
  `);
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS preferred_currency TEXT NOT NULL DEFAULT 'UGX'
  `);
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS can_multi_contract BOOLEAN NOT NULL DEFAULT FALSE
  `);
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS active_role TEXT NOT NULL DEFAULT 'AMBASSADOR'
  `);
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS max_status_viewers_12h INTEGER NOT NULL DEFAULT 0
  `);
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS private_contract_rate_ugx INTEGER NOT NULL DEFAULT 0
  `);
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS private_contract_rate_24h_ugx INTEGER NOT NULL DEFAULT 0
  `);
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS current_business_viewers INTEGER NOT NULL DEFAULT 0
  `);
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS price_privacy_mode TEXT NOT NULL DEFAULT 'NEGOTIABLE'
  `);
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS beneficiary_listing_mode TEXT NOT NULL DEFAULT 'LISTED'
  `);
    await client.query(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check
  `);
    await client.query(`
    ALTER TABLE users
      ADD CONSTRAINT users_role_check CHECK (role IN ('BUSINESS', 'AMBASSADOR', 'DUAL_USER', 'ADMIN'))
  `);
    await client.query(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_active_role_check
  `);
    await client.query(`
    ALTER TABLE users
      ADD CONSTRAINT users_active_role_check CHECK (active_role IN ('BUSINESS', 'AMBASSADOR', 'ADMIN'))
  `);
    await client.query(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_price_privacy_mode_check
  `);
    await client.query(`
    ALTER TABLE users
      ADD CONSTRAINT users_price_privacy_mode_check CHECK (price_privacy_mode IN ('NEGOTIABLE', 'FIXED'))
  `);
    await client.query(`
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_beneficiary_listing_mode_check
  `);
    await client.query(`
    ALTER TABLE users
      ADD CONSTRAINT users_beneficiary_listing_mode_check CHECK (beneficiary_listing_mode IN ('LISTED', 'DIRECT_ONLY'))
  `);
    await client.query(`
    UPDATE users
    SET active_role = CASE
      WHEN role='ADMIN' THEN 'ADMIN'
      WHEN role='BUSINESS' THEN 'BUSINESS'
      WHEN role='DUAL_USER' AND (active_role IS NULL OR btrim(active_role)='') THEN 'AMBASSADOR'
      ELSE COALESCE(NULLIF(active_role, ''), 'AMBASSADOR')
    END
    WHERE active_role IS NULL
       OR btrim(active_role)=''
       OR (role='ADMIN' AND active_role<>'ADMIN')
       OR (role='BUSINESS' AND active_role NOT IN ('BUSINESS', 'ADMIN'))
       OR (role='AMBASSADOR' AND active_role NOT IN ('AMBASSADOR', 'ADMIN'))
  `);
    await ensureWalletTables(client);
}
async function ensureWalletForUser(client, userId) {
    const existing = await client.query(`SELECT * FROM wallets WHERE user_id=$1 LIMIT 1`, [userId]);
    if (existing.rows[0]) {
        return existing.rows[0];
    }
    const userRes = await client.query(`SELECT preferred_currency FROM users WHERE id=$1 LIMIT 1`, [userId]);
    const currency = (userRes.rows[0]?.preferred_currency ?? 'UGX')
        .toString()
        .trim()
        .toUpperCase();
    const created = await client.query(`
    INSERT INTO wallets (user_id, currency, balance_available, balance_escrow, balance)
    VALUES ($1,$2,0,0,0)
    RETURNING *
    `, [userId, currency]);
    return created.rows[0];
}
async function refundWalletWithdrawal(client, withdrawal, reason) {
    if (!withdrawal || withdrawal.status === 'FAILED') {
        return withdrawal;
    }
    await client.query(`
    UPDATE wallets
    SET balance_available = balance_available + $2,
        balance = balance + $2
    WHERE id=$1
    `, [withdrawal.wallet_id, withdrawal.amount]);
    await client.query(`
    INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
    VALUES ($1,$2,'CREDIT',$3)
    `, [
        withdrawal.wallet_id,
        withdrawal.amount,
        `${withdrawal.pesapal_reference ?? withdrawal.id}:REFUND`,
    ]);
    const updated = await client.query(`
    UPDATE wallet_withdrawals
    SET status='FAILED',
        failure_reason=$2,
        failed_at=NOW()
    WHERE id=$1
    RETURNING *
    `, [withdrawal.id, reason]);
    return updated.rows[0] ?? withdrawal;
}
export async function accountRoutes(app) {
    let schemaReadyPromise = null;
    const ensureAccountRoutesSchema = () => {
        if (!schemaReadyPromise) {
            schemaReadyPromise = withTransaction(async (client) => {
                await ensureAccountSchema(client);
                await ensurePolicyAcceptanceColumns(client);
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
            await ensureAccountRoutesSchema();
        }
        catch (error) {
            app.log.error({ err: error }, 'startup warmup failed for account schema');
        }
    });
    app.addHook('preHandler', async () => {
        await ensureAccountRoutesSchema();
    });
    const parsePaging = (query) => {
        const limitRaw = Number(query?.limit ?? 50);
        const offsetRaw = Number(query?.offset ?? 0);
        const limit = Number.isFinite(limitRaw)
            ? Math.min(Math.max(limitRaw, 1), 200)
            : 50;
        const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
        return { limit, offset };
    };
    app.get('/account/me', { preHandler: [app.authenticate] }, async (request) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        return withTransaction(async (client) => {
            const hasFullName = await usersHasColumn(client, 'full_name');
            const fullNameSelect = hasFullName
                ? 'COALESCE(NULLIF(u.full_name, \'\'), p.full_name, \'\')'
                : 'COALESCE(p.full_name, \'\')';
            const res = await client.query(`
        SELECT
          u.id,
          u.public_id,
          u.email,
          u.status,
          u.status_reason,
          u.status_reason_updated_at,
          u.role,
          u.active_role,
          u.admin_role,
          u.phone,
          COALESCE(u.whatsapp_verified, FALSE) AS whatsapp_verified,
          u.country,
          u.country_id,
          u.division_id,
          country_meta.code AS country_code,
          country_meta.name AS country_name,
          division_meta.name AS division_name,
          u.preferred_currency AS currency,
          COALESCE(u.max_status_viewers_12h, 0)::int AS max_status_viewers_12h,
          COALESCE(u.private_contract_rate_ugx, 0)::int AS private_contract_rate_ugx,
          COALESCE(u.private_contract_rate_24h_ugx, 0)::int AS private_contract_rate_24h_ugx,
          COALESCE(u.current_business_viewers, 0)::int AS current_business_viewers,
          COALESCE(NULLIF(u.price_privacy_mode, ''), 'NEGOTIABLE') AS price_privacy_mode,
          COALESCE(NULLIF(u.beneficiary_listing_mode, ''), 'LISTED') AS beneficiary_listing_mode,
          ${policyAcceptanceSelectSql('u')},
          u.last_login_at,
          u.last_seen_at,
          CASE
            WHEN COALESCE(u.last_seen_at, '-infinity'::timestamptz) >= NOW() - interval '5 minutes'
              THEN TRUE
            ELSE FALSE
          END AS is_online,
          COALESCE(engagements.engagements_24h, 0)::int AS proven_engagements_24h,
          ${fullNameSelect} AS full_name,
          p.avatar_url,
          p.updated_at
        FROM users u
        LEFT JOIN user_profiles p ON p.user_id = u.id
        LEFT JOIN countries country_meta ON country_meta.id = u.country_id
        LEFT JOIN divisions division_meta ON division_meta.id = u.division_id
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(COALESCE(pr.observed_views, 0)), 0)::int AS engagements_24h
          FROM proofs pr
          JOIN verification_sessions vs ON vs.id = pr.session_id
          WHERE pr.user_id = u.id
            AND pr.status = 'VERIFIED'
            AND pr.decision = 'VERIFIED'
            AND pr.created_at >= now() - interval '24 hours'
        ) engagements ON TRUE
        WHERE u.id = $1
        LIMIT 1
        `, [userId]);
            const ambassadorPlatforms = [
                {
                    platform: 'WHATSAPP_STATUS',
                    active: true,
                    qualified: true,
                    profile_url: null,
                    handle: null,
                },
            ];
            return {
                profile: res.rows[0]
                    ? {
                        ...res.rows[0],
                        ...buildPolicyAcceptanceState(res.rows[0]),
                        ambassador_platforms: ambassadorPlatforms,
                    }
                    : null,
            };
        });
    });
    app.get('/account/policies', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access'
            ? '00000000-0000-0000-0000-000000000000'
            : userSub;
        return withTransaction(async (client) => {
            await ensurePolicyAcceptanceColumns(client);
            const res = await client.query(`
        SELECT
          id,
          ${policyAcceptanceSelectSql('u')}
        FROM users u
        WHERE id = $1
        LIMIT 1
        `, [userId]);
            const user = res.rows[0];
            if (!user) {
                reply.code(404);
                return { error: 'user_not_found' };
            }
            return {
                policies: buildCurrentPolicyDocuments(),
                acceptance: buildPolicyAcceptanceState(user),
            };
        });
    });
    app.post('/account/policies/accept', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access'
            ? '00000000-0000-0000-0000-000000000000'
            : userSub;
        const parsed = accountPolicyAcceptanceSchema.safeParse(request.body ?? {});
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        if (parsed.data.privacy_policy_version !== CURRENT_PRIVACY_POLICY_VERSION ||
            parsed.data.platform_policy_version !== CURRENT_PLATFORM_POLICY_VERSION) {
            reply.code(409);
            return {
                error: 'policy_version_mismatch',
                policies: buildCurrentPolicyDocuments(),
            };
        }
        return withTransaction(async (client) => {
            await ensurePolicyAcceptanceColumns(client);
            const updated = await client.query(`
          UPDATE users
          SET privacy_policy_accepted_version = $2,
              privacy_policy_accepted_at = NOW(),
              platform_policy_accepted_version = $3,
              platform_policy_accepted_at = NOW()
          WHERE id = $1
          RETURNING *
          `, [
                userId,
                CURRENT_PRIVACY_POLICY_VERSION,
                CURRENT_PLATFORM_POLICY_VERSION,
            ]);
            const user = updated.rows[0];
            if (!user) {
                reply.code(404);
                return { error: 'user_not_found' };
            }
            const acceptance = buildPolicyAcceptanceState(user);
            const token = app.jwt.sign(buildAuthClaims(user));
            return {
                ok: true,
                token,
                user: {
                    ...buildUserSession(user),
                    ...acceptance,
                },
                acceptance,
            };
        });
    });
    app.patch('/account/me', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        const parsed = accountProfileSchema.safeParse(request.body);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        const body = parsed.data;
        return withTransaction(async (client) => {
            await client.query(`
          INSERT INTO user_profiles (user_id, full_name, updated_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (user_id)
          DO UPDATE SET
            full_name = EXCLUDED.full_name,
            updated_at = NOW()
          `, [userId, body.full_name]);
            if (body.country && body.country.trim().length > 0) {
                await client.query('UPDATE users SET country=$2 WHERE id=$1', [
                    userId,
                    body.country.trim().toUpperCase(),
                ]);
            }
            if (typeof body.current_business_viewers === 'number') {
                const roleRes = await client.query(`
            SELECT role, active_role
            FROM users
            WHERE id=$1
            LIMIT 1
            `, [userId]);
                const user = roleRes.rows[0];
                const activeRole = normalizeActiveRole(user?.active_role, user?.role);
                if (!canAccessBusinessFeatures(user?.role) || activeRole !== ACCOUNT_ROLE_BUSINESS) {
                    reply.code(403);
                    return { error: 'business_profile_required' };
                }
                await client.query('UPDATE users SET current_business_viewers=$2 WHERE id=$1', [userId, Math.max(0, body.current_business_viewers)]);
            }
            if (typeof body.private_contract_rate_ugx === 'number') {
                const roleRes = await client.query(`
            SELECT role
            FROM users
            WHERE id=$1
            LIMIT 1
            `, [userId]);
                const user = roleRes.rows[0];
                if (!canAccessAmbassadorFeatures(user?.role)) {
                    reply.code(403);
                    return { error: 'ambassador_profile_required' };
                }
                await client.query('UPDATE users SET private_contract_rate_ugx=$2 WHERE id=$1', [userId, Math.max(0, body.private_contract_rate_ugx)]);
            }
            if (typeof body.private_contract_rate_24h_ugx === 'number') {
                const roleRes = await client.query(`
            SELECT role
            FROM users
            WHERE id=$1
            LIMIT 1
            `, [userId]);
                const user = roleRes.rows[0];
                if (!canAccessAmbassadorFeatures(user?.role)) {
                    reply.code(403);
                    return { error: 'ambassador_profile_required' };
                }
                await client.query('UPDATE users SET private_contract_rate_24h_ugx=$2 WHERE id=$1', [userId, Math.max(0, body.private_contract_rate_24h_ugx)]);
            }
            if (typeof body.price_privacy_mode === 'string') {
                await client.query('UPDATE users SET price_privacy_mode=$2 WHERE id=$1', [userId, body.price_privacy_mode]);
            }
            if (typeof body.beneficiary_listing_mode === 'string') {
                await client.query('UPDATE users SET beneficiary_listing_mode=$2 WHERE id=$1', [userId, body.beneficiary_listing_mode]);
            }
            return { ok: true };
        });
    });
    app.patch('/account/avatar', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        const isMultipart = String(request.headers['content-type'] ?? '')
            .toLowerCase()
            .includes('multipart/form-data');
        let avatarUrl = '';
        if (isMultipart) {
            try {
                const part = await request.file();
                const uploaded = await storeMultipartMediaFile({
                    part,
                    prefix: 'avatar',
                    kind: 'image',
                    maxBytes: 10 * 1024 * 1024,
                });
                avatarUrl = uploaded.fileUrl;
            }
            catch (error) {
                const handled = resolveMediaUploadError(error);
                if (handled) {
                    reply.code(handled.statusCode);
                    return handled.payload;
                }
                throw error;
            }
        }
        else {
            const parsed = accountAvatarSchema.safeParse(request.body);
            if (!parsed.success) {
                reply.code(400);
                return { error: 'validation_failed', issues: parsed.error.issues };
            }
            avatarUrl = parsed.data.avatar_url;
        }
        return withTransaction(async (client) => {
            await client.query(`
          INSERT INTO user_profiles (user_id, avatar_url, updated_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (user_id)
          DO UPDATE SET
            avatar_url = EXCLUDED.avatar_url,
            updated_at = NOW()
          `, [userId, avatarUrl]);
            return { ok: true, avatar_url: avatarUrl };
        });
    });
    app.patch('/account/whatsapp/verify', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        const parsed = accountWhatsappVerifySchema.safeParse(request.body ?? {});
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        return withTransaction(async (client) => {
            const userRes = await client.query(`SELECT id, phone FROM users WHERE id=$1 LIMIT 1`, [userId]);
            const user = userRes.rows[0];
            if (!user) {
                reply.code(404);
                return { error: 'user_not_found' };
            }
            const incomingPhone = parsed.data.phone?.trim() ?? '';
            const candidatePhone = incomingPhone.length > 0 ? incomingPhone : String(user.phone ?? '').trim();
            if (candidatePhone.length === 0) {
                reply.code(400);
                return { error: 'invalid_phone_number' };
            }
            const verification = await whatsappVerificationService.verifyPhone(candidatePhone);
            if (!verification.ok) {
                if (verification.reason === 'invalid_phone') {
                    reply.code(400);
                    return { error: 'invalid_phone_number' };
                }
                if (verification.reason === 'pairing_required') {
                    reply.code(202);
                    return {
                        status: 'pending_whatsapp_link',
                        pairing_code: verification.pairingCode ?? null,
                        pairing_phone: verification.pairingPhone ?? null,
                        detail: verification.detail,
                    };
                }
                if (verification.reason === 'provider_unavailable') {
                    reply.code(503);
                    return {
                        error: 'whatsapp_verification_unavailable',
                        detail: verification.detail,
                    };
                }
                reply.code(404);
                return {
                    error: 'whatsapp_number_not_registered',
                    detail: verification.detail,
                };
            }
            const owner = await client.query(`SELECT id FROM users WHERE phone=$1 LIMIT 1`, [verification.normalizedPhone]);
            const ownerId = String(owner.rows[0]?.id ?? '');
            if (ownerId && ownerId != userId) {
                reply.code(400);
                return { error: 'phone_taken' };
            }
            await client.query(`
          UPDATE users
          SET
            phone = $2,
            whatsapp_verified = TRUE,
            whatsapp_verified_at = NOW(),
            whatsapp_jid = $3
          WHERE id = $1
          `, [userId, verification.normalizedPhone, verification.jid]);
            return {
                ok: true,
                whatsapp_verified: true,
                phone: verification.normalizedPhone,
                jid: verification.jid,
            };
        });
    });
    app.patch('/account/password', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        const parsed = accountPasswordSchema.safeParse(request.body);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        const body = parsed.data;
        return withTransaction(async (client) => {
            const userRes = await client.query(`SELECT id, password_hash FROM users WHERE id=$1 LIMIT 1`, [userId]);
            const user = userRes.rows[0];
            if (!user || !verifyPassword(body.current_password, user.password_hash)) {
                reply.code(401);
                return { error: 'invalid_credentials' };
            }
            await client.query('UPDATE users SET password_hash=$2 WHERE id=$1', [
                userId,
                hashPassword(body.new_password),
            ]);
            return { ok: true };
        });
    });
    app.patch('/account/role', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        const parsed = accountRoleSchema.safeParse(request.body);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        const body = parsed.data;
        const nextCapacity = typeof body.max_status_viewers_12h === 'number' &&
            Number.isFinite(body.max_status_viewers_12h) &&
            body.max_status_viewers_12h > 0
            ? Math.trunc(body.max_status_viewers_12h)
            : null;
        return withTransaction(async (client) => {
            const currentRes = await client.query(`
          SELECT
            id,
            role,
            active_role
          FROM users
          WHERE id=$1
          LIMIT 1
          `, [userId]);
            const currentUser = currentRes.rows[0];
            if (!currentUser) {
                reply.code(404);
                return { error: 'user_not_found' };
            }
            const currentRole = normalizeAccountRole(currentUser.role);
            const nextActiveRole = normalizeActiveRole(body.role, body.role);
            const nextRole = currentRole === 'ADMIN'
                ? 'ADMIN'
                : currentRole === body.role
                    ? currentRole
                    : currentRole === 'DUAL_USER'
                        ? 'DUAL_USER'
                        : 'DUAL_USER';
            await client.query(`
          UPDATE users
          SET role=$2,
              active_role=$3,
              max_status_viewers_12h = CASE
                WHEN $4::int IS NOT NULL THEN $4
                ELSE max_status_viewers_12h
              END
          WHERE id=$1
          `, [userId, nextRole, nextActiveRole, nextCapacity]);
            const hasCanMultiContract = await usersHasColumn(client, 'can_multi_contract');
            const canMultiSelect = hasCanMultiContract
                ? 'can_multi_contract'
                : 'false::boolean AS can_multi_contract';
            const res = await client.query(`
          SELECT
            id,
            public_id,
            email,
            status,
            status_reason,
            status_reason_updated_at,
            role,
            active_role,
            phone,
            country,
            preferred_currency AS currency,
            ${canMultiSelect},
            COALESCE(max_status_viewers_12h, 0)::int AS max_status_viewers_12h,
            COALESCE(private_contract_rate_ugx, 0)::int AS private_contract_rate_ugx,
            COALESCE(private_contract_rate_24h_ugx, 0)::int AS private_contract_rate_24h_ugx,
            ${policyAcceptanceSelectSql('users')}
          FROM users
          WHERE id=$1
          LIMIT 1
          `, [userId]);
            const user = res.rows[0];
            if (!user) {
                reply.code(404);
                return { error: 'user_not_found' };
            }
            const token = app.jwt.sign(buildAuthClaims(user));
            return {
                ok: true,
                token,
                user: buildUserSession(user),
            };
        });
    });
    const handleAmbassadorCapacityUpdate = async (request, reply) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        const parsed = ambassadorCapacitySchema.safeParse(request.body);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        return withTransaction(async (client) => {
            const updated = await client.query(`
          UPDATE users
          SET max_status_viewers_12h=$2,
              private_contract_rate_ugx    = COALESCE($3, private_contract_rate_ugx),
              private_contract_rate_24h_ugx = COALESCE($4, private_contract_rate_24h_ugx)
          WHERE id=$1
          RETURNING id, public_id, email, status, status_reason, status_reason_updated_at, role, active_role, phone, country, preferred_currency AS currency, can_multi_contract, max_status_viewers_12h, private_contract_rate_ugx, private_contract_rate_24h_ugx, privacy_policy_accepted_version, privacy_policy_accepted_at, platform_policy_accepted_version, platform_policy_accepted_at
          `, [
                userId,
                parsed.data.max_status_viewers_12h,
                parsed.data.rate_12h_ugx ?? null,
                parsed.data.rate_24h_ugx ?? null,
            ]);
            const user = updated.rows[0];
            if (!user) {
                reply.code(404);
                return { error: 'user_not_found' };
            }
            const token = app.jwt.sign(buildAuthClaims(user));
            return {
                ok: true,
                token,
                user: buildUserSession(user),
            };
        });
    };
    app.patch('/account/ambassador-capacity', { preHandler: [app.authenticate] }, handleAmbassadorCapacityUpdate);
    // ── Ambassador account verification recording ─────────────────────────────────
    // Ambassadors submit a WhatsApp status screen recording for admin to review
    // and set their verified 12h viewer count (max_status_viewers_12h).
    app.post('/account/verification/recording', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = request.user.sub;
        const isMultipart = String(request.headers['content-type'] ?? '')
            .toLowerCase()
            .includes('multipart/form-data');
        let videoUrl = '';
        if (isMultipart) {
            const pending = await withTransaction(async (client) => {
                const existing = await client.query(`SELECT id FROM ambassador_verification_recordings
             WHERE user_id=$1 AND status='PENDING' LIMIT 1`, [userId]);
                return existing.rows[0] ?? null;
            });
            if (pending) {
                reply.code(409);
                return { error: 'verification_recording_pending' };
            }
            try {
                const part = await request.file();
                const uploaded = await storeMultipartMediaFile({
                    part,
                    prefix: 'verification',
                    kind: 'video',
                    maxBytes: 0,
                    allowedMimeTypes: ['video/mp4'],
                });
                videoUrl = uploaded.fileUrl;
            }
            catch (error) {
                const handled = resolveMediaUploadError(error);
                if (handled) {
                    reply.code(handled.statusCode);
                    return handled.payload;
                }
                throw error;
            }
        }
        else {
            const body = z
                .object({
                video_url: z
                    .string()
                    .url()
                    .max(2048)
                    .refine((value) => {
                    try {
                        const parsed = new URL(value);
                        return (parsed.pathname.includes('/uploads/files/') &&
                            String(parsed.searchParams.get('mime') ?? '')
                                .trim()
                                .toLowerCase() === 'video/mp4');
                    }
                    catch {
                        return false;
                    }
                }, 'video_url must point to an uploaded mp4 file'),
            })
                .safeParse(request.body);
            if (!body.success) {
                reply.code(400);
                return { error: 'validation_failed', issues: body.error.issues };
            }
            videoUrl = body.data.video_url;
        }
        return withTransaction(async (client) => {
            // One pending submission at a time per user
            const existing = await client.query(`SELECT id FROM ambassador_verification_recordings
           WHERE user_id=$1 AND status='PENDING' LIMIT 1`, [userId]);
            if (existing.rows[0]) {
                reply.code(409);
                return { error: 'verification_recording_pending' };
            }
            const res = await client.query(`INSERT INTO ambassador_verification_recordings (user_id, video_url)
           VALUES ($1, $2)
           RETURNING id, status, created_at`, [userId, videoUrl]);
            return { recording: res.rows[0], video_url: videoUrl };
        });
    });
    app.get('/account/verification/recording', { preHandler: [app.authenticate] }, async (request) => {
        const userId = request.user.sub;
        return withTransaction(async (client) => {
            const res = await client.query(`SELECT id, status, approved_viewer_count, admin_note, reviewed_at, created_at
           FROM ambassador_verification_recordings
           WHERE user_id=$1
           ORDER BY created_at DESC LIMIT 5`, [userId]);
            return { recordings: res.rows };
        });
    });
    app.delete('/account/me', { preHandler: [app.authenticate] }, async (request) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        const deletion = await withTransaction(async (client) => {
            await ensureUserProfilesTable(client);
            const rootCampaignRes = await client.query(`
        SELECT id
        FROM campaigns
        WHERE business_id=$1
        `, [userId]);
            const rootCampaignIds = normalizeStringList(rootCampaignRes.rows.map((row) => row.id));
            let ownedCampaignIds = [...rootCampaignIds];
            if (rootCampaignIds.length > 0) {
                const ownedCampaignRes = await client.query(`
          WITH RECURSIVE owned_campaign_tree AS (
            SELECT id
            FROM campaigns
            WHERE id = ANY($1::uuid[])
            UNION
            SELECT c.id
            FROM campaigns c
            JOIN owned_campaign_tree t ON c.parent_campaign_id = t.id
          )
          SELECT id
          FROM owned_campaign_tree
          `, [rootCampaignIds]);
                ownedCampaignIds = normalizeStringList(ownedCampaignRes.rows.map((row) => row.id));
            }
            const assignedCampaignRes = await client.query(`
        SELECT id, parent_campaign_id
        FROM campaigns
        WHERE assigned_ambassador_id=$1
        `, [userId]);
            const assignedChildCampaignIds = normalizeStringList(assignedCampaignRes.rows
                .filter((row) => row.parent_campaign_id)
                .map((row) => row.id));
            const campaignIds = normalizeStringList([
                ...ownedCampaignIds,
                ...assignedChildCampaignIds,
            ]);
            const sessionRes = await client.query(`
        SELECT id
        FROM verification_sessions
        WHERE user_id=$1 OR campaign_id = ANY($2::uuid[])
        `, [userId, campaignIds]);
            const sessionIds = normalizeStringList(sessionRes.rows.map((row) => row.id));
            const proofRes = await client.query(`
        SELECT id, video_url
        FROM proofs
        WHERE user_id=$1 OR session_id = ANY($2::uuid[])
        `, [userId, sessionIds]);
            const proofIds = normalizeStringList(proofRes.rows.map((row) => row.id));
            const walletRes = await client.query('SELECT id FROM wallets WHERE user_id=$1', [userId]);
            const walletIds = normalizeStringList(walletRes.rows.map((row) => row.id));
            const profileMediaRes = await client.query(`
        SELECT avatar_url
        FROM user_profiles
        WHERE user_id=$1
        `, [userId]);
            const campaignMediaRes = await client.query(`
        SELECT media_url
        FROM campaigns
        WHERE id = ANY($1::uuid[])
        `, [campaignIds]);
            const mediaUrls = normalizeStringList([
                ...proofRes.rows.map((row) => row.video_url),
                ...profileMediaRes.rows.map((row) => row.avatar_url),
                ...campaignMediaRes.rows.map((row) => row.media_url),
            ]);
            await client.query(`
        DELETE FROM payout_requests
        WHERE user_id=$1 OR proof_id = ANY($2::uuid[])
        `, [userId, proofIds]);
            await client.query(`
        DELETE FROM pesapal_transactions
        WHERE escrow_id IN (
          SELECT id FROM escrow_ledger WHERE campaign_id = ANY($1::uuid[])
        )
        `, [campaignIds]);
            await client.query(`
        DELETE FROM escrow_ledger
        WHERE campaign_id = ANY($1::uuid[])
        `, [campaignIds]);
            await client.query(`
        DELETE FROM wallet_withdrawals
        WHERE user_id=$1 OR wallet_id = ANY($2::uuid[])
        `, [userId, walletIds]);
            await client.query(`
        DELETE FROM wallet_txns
        WHERE wallet_id = ANY($1::uuid[])
        `, [walletIds]);
            await client.query(`
        DELETE FROM proofs
        WHERE id = ANY($1::uuid[]) OR user_id=$2 OR session_id = ANY($3::uuid[])
        `, [proofIds, userId, sessionIds]);
            await client.query(`
        DELETE FROM verification_sessions
        WHERE id = ANY($1::uuid[]) OR user_id=$2 OR campaign_id = ANY($3::uuid[])
        `, [sessionIds, userId, campaignIds]);
            await client.query(`
        DELETE FROM contracts
        WHERE ambassador_id=$1 OR campaign_id = ANY($2::uuid[])
        `, [userId, campaignIds]);
            await client.query(`
        DELETE FROM campaigns
        WHERE id = ANY($1::uuid[])
        `, [campaignIds]);
            await client.query(`
        UPDATE campaigns
        SET assigned_ambassador_id = NULL,
            assigned_phone = NULL
        WHERE assigned_ambassador_id=$1
        `, [userId]);
            await client.query('DELETE FROM trust_events WHERE user_id=$1', [userId]);
            await client.query('DELETE FROM trust_scores WHERE user_id=$1', [userId]);
            await client.query('DELETE FROM device_fingerprints WHERE user_id=$1', [userId]);
            await client.query('DELETE FROM user_profiles WHERE user_id=$1', [userId]);
            await client.query('DELETE FROM wallets WHERE user_id=$1', [userId]);
            await client.query(`
        DELETE FROM admin_audit_logs
        WHERE actor_id=$1 OR target_id=$1
        `, [userId]);
            await client.query('DELETE FROM users WHERE id=$1', [userId]);
            return { mediaUrls };
        });
        const deletedMediaObjects = await deleteAccountMedia(deletion.mediaUrls);
        const response = {
            ok: true,
            deleted: true,
            deleted_media_objects: deletedMediaObjects,
        };
        return response;
    });
    app.get('/wallet', { preHandler: [app.authenticate] }, async (request) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        const accountRole = request.user.role;
        const activeRole = normalizeActiveRole(request.user.active_role, accountRole);
        const data = await withTransaction(async (client) => {
            await ensureWalletForUser(client, userId);
            const walletRes = await client.query('SELECT * FROM wallets WHERE user_id=$1', [userId]);
            const wallet = walletRes.rows[0];
            const txnsRes = await client.query(`SELECT * FROM wallet_txns WHERE wallet_id=$1 ORDER BY created_at DESC LIMIT 20`, [wallet?.id]);
            const withdrawalsRes = await client.query(`
        SELECT *
        FROM wallet_withdrawals
        WHERE wallet_id=$1
        ORDER BY created_at DESC
        LIMIT 20
        `, [wallet?.id]);
            return {
                wallet: wallet
                    ? {
                        ...wallet,
                        minimum_withdrawal_amount: MIN_WALLET_WITHDRAW_UGX,
                        wallet_mode: activeRole === ACCOUNT_ROLE_BUSINESS ? 'CAMPAIGN_ONLY' : 'STANDARD',
                        wallet_notice: activeRole === ACCOUNT_ROLE_BUSINESS
                            ? 'Use wallet balance for YO Uganda deposits, campaign funding, and withdrawals.'
                            : 'Withdraw any available wallet balance from UGX 1 upward.',
                    }
                    : wallet,
                txns: txnsRes.rows,
                withdrawals: withdrawalsRes.rows,
            };
        });
        return data;
    });
    app.post('/wallet/deposit', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        const parsed = walletDepositSchema.safeParse(request.body);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        const browserOrigin = getBrowserOrigin(request);
        const webReturnUrl = resolveWebRedirectUrl(parsed.data.return_url, browserOrigin, '/payment/success');
        const webCancelUrl = resolveWebRedirectUrl(parsed.data.cancel_url, browserOrigin, '/payment/cancel');
        const callbackUrl = buildPaymentCallbackUrl(request, '/payments/return', webReturnUrl);
        const cancellationUrl = buildPaymentCallbackUrl(request, '/payments/cancel', webCancelUrl);
        if (!webReturnUrl || !webCancelUrl || !callbackUrl || !cancellationUrl) {
            reply.code(400);
            return { error: 'payment_redirect_urls_invalid' };
        }
        if (!hasYoClientCredentials()) {
            reply.code(503);
            return { error: 'yo_uganda_not_configured' };
        }
        const result = await withTransaction(async (client) => {
            const userRes = await client.query('SELECT email, phone, preferred_currency, country FROM users WHERE id=$1 LIMIT 1', [userId]);
            const user = userRes.rows[0];
            if (!user?.email) {
                reply.code(400);
                return { error: 'user_email_missing' };
            }
            const checkoutProfile = resolveAvailableYoUgandaCheckoutProfile(user.country, { cardEnabled: hasYoEncryptionKey() });
            const wallet = await ensureWalletForUser(client, userId);
            const reference = `WDP-${uuid()}`;
            const txn = await client.query(`
        INSERT INTO pesapal_transactions (
          escrow_id,
          type,
          amount,
          status,
          merchant_reference,
          raw_payload
        )
        VALUES ($1,'FUNDING',$2,'PENDING',$3,$4)
        RETURNING *
        `, [
                null,
                parsed.data.amount,
                reference,
                {
                    kind: 'WALLET_DEPOSIT',
                    user_id: userId,
                    wallet_id: wallet.id,
                    country: checkoutProfile.country,
                    payment_currency: checkoutProfile.currency,
                    return_url: callbackUrl,
                    cancel_url: cancellationUrl,
                },
            ]);
            const firstName = String(user.email).split('@')[0] || 'User';
            const checkoutMeta = {
                merchant_reference: reference,
                kind: 'WALLET_DEPOSIT',
                wallet_id: wallet.id,
                country: checkoutProfile.country,
                payment_currency: checkoutProfile.currency,
                return_url: callbackUrl,
                cancel_url: cancellationUrl,
            };
            await client.query(`UPDATE pesapal_transactions
         SET raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb
         WHERE merchant_reference=$1`, [
                reference,
                JSON.stringify({
                    ...checkoutMeta,
                    payment_options: checkoutProfile.paymentOptions,
                    supported_payment_methods: checkoutProfile.supportedPaymentMethods,
                    mobile_money_networks: checkoutProfile.mobileMoneyNetworks,
                    phone_country_code: checkoutProfile.phoneCountryCode,
                    availability_notes: checkoutProfile.availabilityNotes,
                    customer: {
                        email: String(user.email),
                        name: `${firstName} User`.trim(),
                        phone_number: user.phone?.toString() || null,
                    },
                }),
            ]);
            const checkoutPayload = {
                provider: 'YO_UGANDA',
                mode: 'DIRECT_CHARGE',
                tx_ref: reference,
                amount: parsed.data.amount,
                currency: checkoutProfile.currency,
                payment_options: checkoutProfile.paymentOptions,
                supported_payment_methods: checkoutProfile.supportedPaymentMethods,
                mobile_money_networks: checkoutProfile.mobileMoneyNetworks,
                phone_country_code: checkoutProfile.phoneCountryCode,
                availability_notes: checkoutProfile.availabilityNotes,
                country: checkoutProfile.country,
                redirect_url: callbackUrl,
                customer: {
                    email: String(user.email),
                    name: `${firstName} User`.trim(),
                    phone_number: user.phone?.toString() || null,
                },
                meta: checkoutMeta,
            };
            return { checkout_payload: checkoutPayload, txn: txn.rows[0] };
        });
        if (result?.error) {
            return result;
        }
        return {
            checkout_payload: result.checkout_payload,
            deposit: {
                amount: parsed.data.amount,
                reference: result.txn.merchant_reference,
            },
        };
    });
    app.post('/wallet/withdraw', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        const parsed = walletWithdrawSchema.safeParse(request.body);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        let payoutPayload = null;
        const result = await withTransaction(async (client) => {
            await ensureWhatsappColumns(client);
            const wallet = await ensureWalletForUser(client, userId);
            const userRes = await client.query(`SELECT email, phone, preferred_currency FROM users WHERE id=$1 LIMIT 1`, [userId]);
            const user = userRes.rows[0];
            if (!user) {
                reply.code(404);
                return { error: 'user_not_found' };
            }
            const receiverPhone = (parsed.data.phone?.trim() || String(user.phone ?? '').trim());
            const receiverNetwork = parsed.data.network?.trim().toUpperCase() ??
                undefined;
            if (!receiverPhone) {
                reply.code(400);
                return { error: 'missing_payout_phone' };
            }
            if (!receiverNetwork) {
                reply.code(400);
                return { error: 'missing_mobile_money_network' };
            }
            const amount = parsed.data.amount;
            const lockedWalletRes = await client.query(`SELECT * FROM wallets WHERE id=$1 FOR UPDATE`, [wallet.id]);
            const lockedWallet = lockedWalletRes.rows[0];
            const balanceAvailable = Number(lockedWallet?.balance_available ?? 0);
            if (!lockedWallet || balanceAvailable < amount) {
                reply.code(400);
                return { error: 'insufficient_wallet_balance' };
            }
            const currency = (user.preferred_currency ?? lockedWallet.currency ?? 'UGX')
                .toString()
                .trim()
                .toUpperCase();
            const reference = `WD-${uuid()}`;
            const updatedWalletRes = await client.query(`
        UPDATE wallets
        SET balance_available = balance_available - $2,
            balance = GREATEST(balance - $2, 0)
        WHERE id=$1 AND balance_available >= $2
        RETURNING *
        `, [wallet.id, amount]);
            if (!updatedWalletRes.rows[0]) {
                reply.code(400);
                return { error: 'insufficient_wallet_balance' };
            }
            await client.query(`
        INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
        VALUES ($1,$2,'DEBIT',$3)
        `, [wallet.id, amount, reference]);
            const withdrawalRes = await client.query(`
        INSERT INTO wallet_withdrawals (
          wallet_id,
          user_id,
          amount,
          currency,
          receiver_phone,
          mobile_money_network,
          status,
          pesapal_reference
        )
        VALUES ($1,$2,$3,$4,$5,$6,'PROCESSING',$7)
        RETURNING *
        `, [wallet.id, userId, amount, currency, receiverPhone, receiverNetwork, reference]);
            payoutPayload = {
                amount,
                currency,
                reference,
                receiverName: user.email?.split('@')[0] ?? 'User',
                receiverPhone,
                receiverNetwork,
            };
            return {
                ok: true,
                withdrawal: withdrawalRes.rows[0],
                wallet: updatedWalletRes.rows[0],
            };
        });
        if (!result?.ok || !payoutPayload) {
            return result;
        }
        const payout = payoutPayload;
        try {
            const payoutResponse = await requestPayout({
                amount: payout.amount,
                currency: payout.currency,
                narration: `Wallet withdrawal ${payout.reference}`,
                reference: payout.reference,
                receiverName: payout.receiverName,
                receiverPhone: payout.receiverPhone,
                receiverNetwork: payout.receiverNetwork,
            });
            const payoutStatus = String(payoutResponse.transactionStatus ??
                payoutResponse.status ??
                '')
                .trim()
                .toUpperCase();
            if (payoutStatus === 'SUCCEEDED' ||
                payoutStatus === 'SUCCESSFUL' ||
                payoutStatus === 'COMPLETED' ||
                payoutStatus === 'OK') {
                await withTransaction(async (client) => {
                    await ensureWalletTables(client);
                    await client.query(`
            UPDATE wallet_withdrawals
            SET status='PAID',
                paid_at=NOW(),
                failure_reason=NULL
            WHERE pesapal_reference=$1
            `, [payout.reference]);
                });
            }
            else if (payoutStatus === 'FAILED' ||
                payoutStatus === 'FAILURE' ||
                payoutStatus === 'ERROR' ||
                payoutStatus === 'CANCELLED' ||
                payoutStatus === 'CANCELED' ||
                payoutStatus === 'REJECTED') {
                await withTransaction(async (client) => {
                    await ensureWalletTables(client);
                    const withdrawalRes = await client.query(`SELECT * FROM wallet_withdrawals WHERE pesapal_reference=$1 LIMIT 1`, [payout.reference]);
                    const withdrawal = withdrawalRes.rows[0];
                    if (!withdrawal)
                        return;
                    await refundWalletWithdrawal(client, withdrawal, payoutResponse.errorMessage ?? 'withdrawal_request_failed');
                });
                reply.code(502);
                return {
                    error: 'withdrawal_request_failed',
                    detail: payoutResponse.errorMessage ??
                        payoutResponse.statusMessage ??
                        'Withdrawal provider rejected the request.',
                };
            }
            return {
                ...result,
                provider_status: payoutStatus || 'PROCESSING',
            };
        }
        catch (error) {
            await withTransaction(async (client) => {
                await ensureWalletTables(client);
                const withdrawalRes = await client.query(`SELECT * FROM wallet_withdrawals WHERE pesapal_reference=$1 LIMIT 1`, [payout.reference]);
                const withdrawal = withdrawalRes.rows[0];
                if (!withdrawal)
                    return;
                await refundWalletWithdrawal(client, withdrawal, error?.message ?? 'withdrawal_request_failed');
            });
            reply.code(502);
            return {
                error: 'withdrawal_request_failed',
                detail: error?.message ?? 'Withdrawal provider rejected the request.',
            };
        }
    });
    app.get('/proofs', { preHandler: [app.authenticate] }, async (request) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const proofs = await withTransaction(async (client) => {
            const res = await client.query(`SELECT p.id,
                p.status,
                p.decision,
                p.observed_views,
                p.observed_post_hash,
                p.challenge_seen,
                p.confidence,
                p.video_url,
                p.meta,
                p.created_at,
                s.platform,
                c.title AS campaign_title
         FROM proofs p
         JOIN verification_sessions s ON s.id = p.session_id
         JOIN campaigns c ON c.id = s.campaign_id
         WHERE p.user_id=$1
         ORDER BY p.created_at DESC
         LIMIT $2 OFFSET $3`, [userId, limit, offset]);
            return res.rows;
        });
        return { proofs };
    });
    app.get('/dashboard/summary', { preHandler: [app.authenticate] }, async (request) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        const accountRole = request.user.role;
        const activeRole = normalizeActiveRole(request.user.active_role, accountRole);
        if (userId === 'ariaka-access') {
            return {
                business_campaigns: [],
                ambassador: { pending_or_review_count: 0 }
            };
        }
        return withTransaction(async (client) => {
            if (activeRole === ACCOUNT_ROLE_BUSINESS && canAccessBusinessFeatures(accountRole)) {
                const campaignsRes = await client.query(`SELECT c.id,
                  c.title,
                  c.created_at,
                  latest.latest_created_at
           FROM campaigns c
           LEFT JOIN LATERAL (
             SELECT MAX(p.created_at) AS latest_created_at
             FROM proofs p
             JOIN verification_sessions s ON s.id = p.session_id
             WHERE s.campaign_id = c.id
           ) latest ON true
           WHERE c.business_id=$1
           ORDER BY c.created_at DESC
           LIMIT 200`, [userId]);
                return { business_campaigns: campaignsRes.rows };
            }
            const ambassadorRes = await client.query(`SELECT
           COUNT(*) FILTER (WHERE status='PENDING' OR status='MANUAL_REVIEW')::int AS pending_or_review_count
         FROM proofs
         WHERE user_id=$1`, [userId]);
            return {
                ambassador: {
                    pending_or_review_count: ambassadorRes.rows[0]?.pending_or_review_count ?? 0
                }
            };
        });
    });
    app.get('/account/notifications', { preHandler: [app.authenticate] }, async (request) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        const query = request.query;
        const limit = Math.min(Math.max(Number(query?.limit ?? 20), 1), 100);
        const unreadOnly = String(query?.unread_only ?? '').trim() === 'true';
        return withTransaction(async (client) => {
            const result = await listUserNotifications(client, userId, {
                limit,
                unreadOnly,
            });
            return {
                notifications: result.notifications,
                unread_count: result.unreadCount,
            };
        });
    });
    app.post('/account/notifications/read-all', { preHandler: [app.authenticate] }, async (request) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        return withTransaction(async (client) => {
            const updated = await markAllUserNotificationsRead(client, userId);
            return { ok: true, updated, unread_count: 0 };
        });
    });
    app.patch('/account/notifications/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        const params = request.params;
        const parsed = accountNotificationUpdateSchema.safeParse(request.body);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        return withTransaction(async (client) => {
            const notification = await updateUserNotificationReadState(client, userId, params.id, parsed.data.read);
            if (!notification) {
                reply.code(404);
                return { error: 'notification_not_found' };
            }
            const result = await listUserNotifications(client, userId, {
                limit: 1,
            });
            return {
                ok: true,
                notification,
                unread_count: result.unreadCount,
            };
        });
    });
    app.delete('/account/notifications/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        const params = request.params;
        return withTransaction(async (client) => {
            const deletedId = await deleteUserNotification(client, userId, params.id);
            if (!deletedId) {
                reply.code(404);
                return { error: 'notification_not_found' };
            }
            const result = await listUserNotifications(client, userId, {
                limit: 1,
            });
            return {
                ok: true,
                id: deletedId,
                unread_count: result.unreadCount,
            };
        });
    });
    app.get('/proofs/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        const params = request.params;
        const proof = await withTransaction(async (client) => {
            const res = await client.query(`SELECT p.id,
                p.status,
                p.decision,
                p.observed_views,
                p.observed_post_hash,
                p.challenge_seen,
                p.confidence,
                p.video_url,
                p.meta,
                p.created_at,
                s.platform,
                c.title AS campaign_title
         FROM proofs p
         JOIN verification_sessions s ON s.id = p.session_id
         JOIN campaigns c ON c.id = s.campaign_id
         WHERE p.user_id=$1 AND p.id=$2
         LIMIT 1`, [userId, params.id]);
            return res.rows[0];
        });
        if (!proof) {
            reply.code(404);
            return { error: 'proof_not_found' };
        }
        return { proof };
    });
    app.get('/contracts/me', { preHandler: [app.authenticate] }, async (request) => {
        const userSub = request.user.sub;
        const userId = userSub === 'ariaka-access' ? '00000000-0000-0000-0000-000000000000' : userSub;
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const status = (query?.status ?? '').toString().toUpperCase();
        return withTransaction(async (client) => {
            const params = [userId];
            let where = 'WHERE ctr.ambassador_id=$1';
            if (status) {
                params.push(status);
                where += ` AND ctr.status=$${params.length}`;
            }
            params.push(limit, offset);
            const res = await client.query(`SELECT ctr.*,
                c.title AS campaign_title,
                c.platform,
                c.delivery_model,
                c.media_type,
                c.media_text,
                c.media_url,
                c.execution_meta,
                c.campaign_burst_mode,
                c.payout_amount,
                c.terms_keep_hours,
                c.terms_min_views,
                c.terms_requirement,
                c.status AS campaign_status,
                COALESCE(e.status, 'PENDING') AS escrow_status,
                p.status AS latest_proof_status,
                p.decision AS latest_proof_decision
         FROM contracts ctr
         JOIN campaigns c ON c.id = ctr.campaign_id
         LEFT JOIN escrow_ledger e ON e.campaign_id = COALESCE(c.parent_campaign_id, c.id)
         LEFT JOIN LATERAL (
           SELECT p.status, p.decision
           FROM proofs p
           JOIN verification_sessions s ON s.id = p.session_id
           WHERE s.campaign_id = ctr.campaign_id
             AND p.user_id = ctr.ambassador_id
           ORDER BY p.created_at DESC
           LIMIT 1
         ) p ON TRUE
         ${where}
         ORDER BY ctr.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
            return {
                contracts: res.rows.map((row) => {
                    const proofStatus = !row.latest_proof_status
                        ? 'NOT_SUBMITTED'
                        : row.latest_proof_status === 'VERIFIED' && row.latest_proof_decision === 'VERIFIED'
                            ? 'VERIFIED'
                            : row.latest_proof_decision === 'REJECTED' || row.latest_proof_status === 'REJECTED'
                                ? 'REJECTED'
                                : row.latest_proof_status === 'MANUAL_REVIEW' || row.latest_proof_decision === 'MANUAL_REVIEW'
                                    ? 'UNDER_REVIEW'
                                    : 'PENDING_REVIEW';
                    return {
                        ...row,
                        status_summary: {
                            contract_status: row.status,
                            campaign_status: row.campaign_status,
                            escrow_status: row.escrow_status,
                            proof_status: proofStatus,
                            settlement_status: row.status === 'COMPLETED'
                                ? row.escrow_status === 'COMPLETED'
                                    ? 'PAID_OUT'
                                    : 'PAYOUT_IN_PROGRESS'
                                : row.escrow_status === 'PENDING'
                                    ? 'AWAITING_FUNDING'
                                    : 'LOCKED_IN_ESCROW',
                        },
                    };
                }),
            };
        });
    });
}
