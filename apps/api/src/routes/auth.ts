import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { withTransaction } from '../db.js';
import { UserRepo } from '../repositories/userRepo.js';
import { hashPassword, verifyPassword } from '../services/auth.js';
import { resolveCountry } from '../countryResolver.js';
import { ensurePublicIdColumns } from '../services/publicId.js';
import {
  ACCOUNT_ROLE_AMBASSADOR,
  ACCOUNT_ROLE_BUSINESS,
  buildAuthClaims,
  buildUserSession,
  isUserAccountActive,
  normalizeRequestedUserRole,
  resolveDisabledAccountErrorCode,
} from '../services/roles.js';
import { ADMIN_ROLE_USER, canAccessAdminDashboard } from '@prime/shared';
import { recordAdminAudit, auditScopeFromAccess } from '../services/adminAudit.js';
import {
  loadDashboardAccessContext,
  touchAdminLogin,
  type DashboardAccessContext,
} from '../services/adminTenant.js';
import {
  getActiveBlockingNotice,
  touchUserPresenceWithClient,
} from '../services/userSignals.js';

const publicRoleSchema = z
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

const registerSchema = z.object({
  full_name: z.string().min(2).max(120),
  email: z.string().email(),
  phone: z.string().min(7).max(20),
  password: z.string().min(8),
  role: publicRoleSchema,
  country: z.string().min(2),
  max_status_viewers_12h: z.number().int().nonnegative().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const googleAuthSchema = z.object({
  id_token: z.string().min(20),
  auth_flow: z.enum(['SIGN_IN', 'SIGN_UP']).default('SIGN_IN'),
  role: publicRoleSchema,
  phone: z.string().trim().min(7).max(20).optional(),
  country: z.string().min(2),
  full_name: z.string().min(2).max(120).optional(),
  avatar_url: z.string().url().max(1024).optional(),
  max_status_viewers_12h: z.number().int().nonnegative().optional(),
});

const googleAdminAuthSchema = z.object({
  id_token: z.string().min(20),
});

function resolveAmbassadorCapacity(body: {
  role: typeof ACCOUNT_ROLE_BUSINESS | typeof ACCOUNT_ROLE_AMBASSADOR;
  max_status_viewers_12h?: number;
}) {
  if (body.role !== ACCOUNT_ROLE_AMBASSADOR) {
    return 0;
  }
  const capacity = Number(body.max_status_viewers_12h ?? 0);
  return Number.isFinite(capacity) && capacity > 0 ? Math.trunc(capacity) : 0;
}

function currentAmbassadorCapacity(user: {
  max_status_viewers_12h?: unknown;
  maxStatusViewers12h?: unknown;
}) {
  const raw = user.max_status_viewers_12h ?? user.maxStatusViewers12h ?? 0;
  const capacity = Number(raw);
  return Number.isFinite(capacity) && capacity > 0 ? Math.trunc(capacity) : 0;
}

async function ensureUserProfilesTable(client: any) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL DEFAULT '',
      avatar_url TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function usersHasColumn(client: any, columnName: string) {
  const res = await client.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='users'
      AND column_name=$1
    LIMIT 1
    `,
    [columnName]
  );
  return Boolean(res.rowCount);
}

async function upsertSocialProfile(
  client: any,
  userId: string,
  fullName: string,
  photoUrl: string
) {
  await ensureUserProfilesTable(client);
  await client.query(
    `
    INSERT INTO user_profiles (user_id, full_name, avatar_url, updated_at)
    VALUES ($1, $2, NULLIF($3, ''), NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET
      full_name = EXCLUDED.full_name,
      avatar_url = COALESCE(EXCLUDED.avatar_url, user_profiles.avatar_url),
      updated_at = NOW()
    `,
    [userId, fullName, photoUrl]
  );

  if (await usersHasColumn(client, 'full_name')) {
    await client.query('UPDATE users SET full_name=$2 WHERE id=$1', [
      userId,
      fullName,
    ]);
  }
}

function buildSyntheticPassword(sub: string, email: string) {
  const seed = crypto
    .createHash('sha256')
    .update(`prime_status_google::${sub}::${email}`)
    .digest('hex');
  return `Gp!${seed.substring(0, 18)}a9`;
}

function isAdminSessionUser(user: Record<string, unknown> | null | undefined) {
  if (canAccessAdminDashboard(user?.admin_role)) {
    return true;
  }
  const role = String(user?.role ?? '')
    .trim()
    .toUpperCase();
  const activeRole = String(user?.active_role ?? user?.role ?? '')
    .trim()
    .toUpperCase();
  return role === 'ADMIN' || activeRole === 'ADMIN';
}

function mergeDashboardAccessIntoSession(
  user: Record<string, unknown>,
  access: DashboardAccessContext | null
) {
  const base = buildUserSession(user);
  if (!access || access.admin_role === ADMIN_ROLE_USER) {
    return base;
  }

  return {
    ...base,
    admin_role: access.admin_role,
    admin_status: access.admin_status,
    permissions: access.permissions,
    module_keys: access.module_keys,
    country_id: access.country_id,
    division_id: access.division_id,
    country_name: access.country_name,
    country_code: access.country_code,
    division_name: access.division_name,
    country_ids: access.country_ids,
    division_ids: access.division_ids,
    country_scopes: access.country_scopes,
    division_scopes: access.division_scopes,
    created_by_super_admin_id: access.created_by_super_admin_id,
    last_admin_login_at: access.last_login_at,
  };
}

export async function authRoutes(app: FastifyInstance) {
  const userRepo = new UserRepo();
  const googleClient = new OAuth2Client();
  const googleAudience = (
    process.env.GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_IDS ?? ''
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  app.get('/auth/register', async () => {
    return {
      ok: true,
      method: 'POST',
      note: 'Use POST /auth/register with JSON body { full_name, email, phone, password, role, country }.',
    };
  });

  app.post('/auth/register', async (request, reply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }
    const body = parsed.data;
    const ambassadorCapacity = resolveAmbassadorCapacity(body);

    const countryData = resolveCountry(body.country);

    const user = await withTransaction(async (client) => {
      await ensurePublicIdColumns(client);
      const existing = await userRepo.findByEmail(client, body.email);
      if (existing) {
        reply.code(400);
        return { error: 'email_taken' } as any;
      }
      const existingByPhone = await client.query(
        'SELECT id FROM users WHERE phone=$1 LIMIT 1',
        [body.phone]
      );
      if (existingByPhone.rows[0]) {
        reply.code(400);
        return { error: 'phone_taken' } as any;
      }

      const created = await userRepo.createUser(
        client,
        body.full_name,
        body.email,
        body.phone,
        hashPassword(body.password),
        body.role,
        countryData.iso2,
        countryData.currency,
        ambassadorCapacity
      );
      await userRepo.ensureWallet(client, created.id, countryData.currency);
      return created;
    });

    if ((user as any).error) return user;

    const token = app.jwt.sign(buildAuthClaims(user));

    return {
      token,
      user: {
        ...buildUserSession(user),
        full_name: user.full_name ?? '',
        dialCode: countryData.dialCode,
        whatsapp_verified: false,
      },
    };
  });

  app.post('/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }
    const body = parsed.data;

    const user = await withTransaction(async (client) =>
      userRepo.findByEmail(client, body.email)
    );

    if (!user || !verifyPassword(body.password, user.password_hash)) {
      reply.code(401);
      return { error: 'invalid_credentials' };
    }
    if (!isUserAccountActive(user.status)) {
      reply.code(403);
      return { error: resolveDisabledAccountErrorCode(user.status) };
    }

    await withTransaction(async (client) => {
      await touchUserPresenceWithClient(client, String(user.id ?? ''), {
        markLogin: true,
      });
    });

    const token = app.jwt.sign(buildAuthClaims(user));
    const dashboardAccess = await withTransaction(async (client) => {
      const current = await loadDashboardAccessContext(client, String(user.id));
      if (
        current &&
        current.admin_role !== ADMIN_ROLE_USER &&
        current.admin_status === 'ACTIVE'
      ) {
        const touched = await touchAdminLogin(client, String(user.id));
        if (touched) {
          await recordAdminAudit(client, {
            actorId: String(user.id),
            action: 'ADMIN_LOGIN',
            targetType: 'admin_user',
            targetId: String(user.id),
            meta: {
              method: 'PASSWORD',
              permissions: touched.permissions,
            },
            ...auditScopeFromAccess(touched),
          });
          return touched;
        }
      }
      return current;
    });
    const activeAdminNotice = await withTransaction(async (client) =>
      getActiveBlockingNotice(client, String(user.id))
    );

    return {
      token,
      user: {
        ...mergeDashboardAccessIntoSession(user, dashboardAccess),
        full_name: user.full_name ?? '',
        active_admin_notice: activeAdminNotice,
      },
    };
  });

  app.post('/auth/google', async (request, reply) => {
    const parsed = googleAuthSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    if (googleAudience.length === 0) {
      reply.code(500);
      return {
        error: 'google_auth_not_configured',
        detail:
          'Set GOOGLE_CLIENT_ID on the API server to the Google OAuth web client ID used by Firebase Auth.',
      };
    }

    const body = parsed.data;
    const ambassadorCapacity = resolveAmbassadorCapacity(body);
    const countryData = resolveCountry(body.country);

    let payload: any;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: body.id_token,
        audience: googleAudience,
      });
      payload = ticket.getPayload();
    } catch {
      reply.code(401);
      return {
        error: 'invalid_google_token',
        detail:
          'The Google ID token could not be verified against the configured client ID.',
      };
    }

    const email = String(payload?.email ?? '').trim().toLowerCase();
    const sub = String(payload?.sub ?? '').trim();
    const verified = Boolean(payload?.email_verified);
    if (!email || !verified || !sub) {
      reply.code(401);
      return { error: 'invalid_google_identity' };
    }

    const fullName =
      (body.full_name?.trim() || String(payload?.name ?? '').trim() || email.split('@')[0] || 'Prime Status User')
        .slice(0, 120);
    const photoUrl = String(
      body.avatar_url?.trim() || payload?.picture || ''
    )
      .trim()
      .slice(0, 1024);

    const user = await withTransaction(async (client) => {
      await ensurePublicIdColumns(client);
      const existing = await userRepo.findByEmail(client, email);
      const typedPhone = body.phone?.trim() ?? '';
      const isGoogleSignUp = body.auth_flow === 'SIGN_UP';
      const hasRealTypedPhone =
        typedPhone.length >= 7 && !typedPhone.startsWith('+999');
      if (existing) {
        if (!isUserAccountActive(existing.status)) {
          reply.code(403);
          return {
            error: resolveDisabledAccountErrorCode(existing.status),
          } as any;
        }
        if (isGoogleSignUp) {
          reply.code(409);
          return { error: 'google_account_exists' } as any;
        }
        const existingAmbassadorCapacity = currentAmbassadorCapacity(existing);

        await upsertSocialProfile(client, existing.id, fullName, photoUrl);
        if (String(existing.role ?? '').trim().toUpperCase() !== body.role) {
          await client.query(
            `
            UPDATE users
            SET role='DUAL_USER',
              active_role=$2,
              max_status_viewers_12h = CASE
                  WHEN $2='AMBASSADOR' AND $3::int > 0
                    THEN $3
                  WHEN $2='AMBASSADOR' AND $4::int > 0
                    THEN $4
                  ELSE COALESCE(max_status_viewers_12h, 0)
                END
            WHERE id=$1
            `,
            [existing.id, body.role, ambassadorCapacity, existingAmbassadorCapacity]
          );
        } else {
          await client.query(
            `
            UPDATE users
            SET active_role=$2,
                max_status_viewers_12h = CASE
                  WHEN $2='AMBASSADOR' AND $3::int > 0
                    THEN $3
                  WHEN $2='AMBASSADOR' AND $4::int > 0
                    THEN $4
                  ELSE COALESCE(max_status_viewers_12h, 0)
                END
            WHERE id=$1
            `,
            [existing.id, body.role, ambassadorCapacity, existingAmbassadorCapacity]
          );
        }
        const refreshed = await userRepo.findByEmail(client, email);
        await touchUserPresenceWithClient(client, existing.id, {
          markLogin: true,
        });
        return refreshed ?? existing;
      }

      if (!isGoogleSignUp) {
        reply.code(404);
        return { error: 'google_account_not_registered' } as any;
      }
      if (!hasRealTypedPhone) {
        reply.code(400);
        return { error: 'phone_required' } as any;
      }
      const phoneOwner = await client.query(
        `SELECT id FROM users WHERE phone=$1 LIMIT 1`,
        [typedPhone]
      );
      if (phoneOwner.rows[0]) {
        reply.code(400);
        return { error: 'phone_taken' } as any;
      }

      const syntheticPassword = buildSyntheticPassword(sub, email);
      const created = await userRepo.createUser(
        client,
        fullName,
        email,
        typedPhone,
        hashPassword(syntheticPassword),
        body.role,
        countryData.iso2,
        countryData.currency,
        ambassadorCapacity
      );
      await userRepo.ensureWallet(client, created.id, countryData.currency);
      await upsertSocialProfile(client, created.id, fullName, photoUrl);
      await touchUserPresenceWithClient(client, created.id, {
        markLogin: true,
      });
      return created;
    });

    if ((user as any)?.error) {
      return user as any;
    }

    const refreshedUser = await withTransaction(async (client) =>
      userRepo.findByEmail(client, email)
    );

    const sessionUser = refreshedUser ?? user;
    const token = app.jwt.sign(buildAuthClaims(sessionUser));
    const dashboardAccess = await withTransaction(async (client) => {
      const current = await loadDashboardAccessContext(
        client,
        String(sessionUser.id)
      );
      if (
        current &&
        current.admin_role !== ADMIN_ROLE_USER &&
        current.admin_status === 'ACTIVE'
      ) {
        const touched = await touchAdminLogin(client, String(sessionUser.id));
        if (touched) {
          await recordAdminAudit(client, {
            actorId: String(sessionUser.id),
            action: 'ADMIN_LOGIN',
            targetType: 'admin_user',
            targetId: String(sessionUser.id),
            meta: {
              method: 'GOOGLE',
              permissions: touched.permissions,
            },
            ...auditScopeFromAccess(touched),
          });
          return touched;
        }
      }
      return current;
    });
    const activeAdminNotice = await withTransaction(async (client) =>
      getActiveBlockingNotice(client, String(sessionUser.id))
    );

    return {
      token,
      user: {
        ...mergeDashboardAccessIntoSession(sessionUser, dashboardAccess),
        full_name: sessionUser.full_name ?? fullName,
        avatar_url: photoUrl || null,
        dialCode: countryData.dialCode,
        active_admin_notice: activeAdminNotice,
      },
    };
  });

  app.post('/auth/google/admin', async (request, reply) => {
    const parsed = googleAdminAuthSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    if (googleAudience.length === 0) {
      reply.code(500);
      return {
        error: 'google_auth_not_configured',
        detail:
          'Set GOOGLE_CLIENT_ID on the API server to the Google OAuth web client ID used by Firebase Auth.',
      };
    }

    let payload: any;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: parsed.data.id_token,
        audience: googleAudience,
      });
      payload = ticket.getPayload();
    } catch {
      reply.code(401);
      return {
        error: 'invalid_google_token',
        detail:
          'The Google ID token could not be verified against the configured client ID.',
      };
    }

    const email = String(payload?.email ?? '').trim().toLowerCase();
    const sub = String(payload?.sub ?? '').trim();
    const verified = Boolean(payload?.email_verified);
    if (!email || !verified || !sub) {
      reply.code(401);
      return { error: 'invalid_google_identity' };
    }

    const fullName = String(payload?.name ?? '')
      .trim()
      .slice(0, 120);
    const photoUrl = String(payload?.picture ?? '')
      .trim()
      .slice(0, 1024);

    const user = await withTransaction(async (client) => {
      await ensurePublicIdColumns(client);
      const existing = await userRepo.findByEmail(client, email);
      if (!existing || !isAdminSessionUser(existing)) {
        reply.code(403);
        return {
          error: 'admin_access_required',
          detail:
            'This Google account has not been enabled for the admin dashboard yet.',
        } as any;
      }
      if (!isUserAccountActive(existing.status)) {
        reply.code(403);
        return {
          error: resolveDisabledAccountErrorCode(existing.status),
        } as any;
      }

      await upsertSocialProfile(client, existing.id, fullName || email, photoUrl);
      await touchUserPresenceWithClient(client, String(existing.id), {
        markLogin: true,
      });
      const access = await touchAdminLogin(client, String(existing.id));
      if (!access || access.admin_role === ADMIN_ROLE_USER) {
        reply.code(403);
        return {
          error: 'admin_access_required',
          detail:
            'This Google account has not been enabled for the admin dashboard yet.',
        } as any;
      }
      if (access.admin_status !== 'ACTIVE') {
        reply.code(403);
        return {
          error:
            access.admin_status === 'SUSPENDED'
              ? 'admin_suspended'
              : 'forbidden',
          detail:
            'This admin account is not currently allowed to access the dashboard.',
        } as any;
      }

      await recordAdminAudit(client, {
        actorId: String(existing.id),
        action: 'ADMIN_LOGIN',
        targetType: 'admin_user',
        targetId: String(existing.id),
        meta: {
          method: 'GOOGLE',
          permissions: access.permissions,
        },
        ...auditScopeFromAccess(access),
      });

      const refreshed = await userRepo.findByEmail(client, email);
      return {
        user: refreshed ?? existing,
        access,
      };
    });

    if ((user as any)?.error) {
      return user as any;
    }

    const sessionUser = (user as any).user ?? user;
    const dashboardAccess = (user as any).access as
      | DashboardAccessContext
      | undefined;
    const token = app.jwt.sign(buildAuthClaims(sessionUser));

    return {
      token,
      user: {
        ...mergeDashboardAccessIntoSession(
          sessionUser,
          dashboardAccess ?? null
        ),
        full_name: String(sessionUser.full_name ?? fullName),
        avatar_url: photoUrl || null,
      },
    };
  });

}

