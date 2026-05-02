import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import countries from 'i18n-iso-countries';
import { buildAuthClaims, buildUserSession } from '../services/roles.js';
import {
  ADMIN_MODULE_CAMPAIGNS,
  ADMIN_MODULE_COUNTRIES,
  ADMIN_MODULE_DIVISIONS,
  ADMIN_MODULE_MANAGER_PAYOUTS,
  ADMIN_MODULE_OVERVIEW,
  ADMIN_MODULE_USERS,
  ADMIN_ROLE_COUNTRY_ADMIN,
  ADMIN_ROLE_DIVISION_ADMIN,
  ADMIN_ROLE_SUPER_ADMIN,
} from '@prime/shared';
import { withTransaction } from '../db.js';
import {
  appendDashboardTenantScope,
  assignCountryAdmin,
  assignDivisionAdmin,
  getRequestDashboardAccess,
  hasAdminModuleAccess,
  isSuperDashboardAccess,
  loadDashboardAccessContext,
  matchesDashboardTenantScope,
  requireRole,
  type DashboardAccessContext,
} from '../services/adminTenant.js';
import { auditScopeFromAccess, recordAdminAudit } from '../services/adminAudit.js';

const CreateCountrySchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().min(2).max(20),
  status: z.enum(['ACTIVE', 'INACTIVE']).default('ACTIVE'),
});

const AssignCountryAdminSchema = z
  .object({
    user_id: z.string().uuid().optional(),
    full_name: z.string().trim().min(2).max(120).optional(),
    email: z.string().email().optional(),
    phone: z.string().trim().min(7).max(20).optional(),
    password: z.string().min(8).optional(),
    role: z.enum(['PRIMARY', 'SECONDARY']).default('PRIMARY'),
  })
  .refine(
    (value) =>
      Boolean(
        value.user_id ||
          (value.full_name && value.email && value.phone && value.password)
      ),
    {
      message: 'user_id or full_name/email/phone/password is required',
    }
  );

const CreateDivisionSchema = z.object({
  name: z.string().trim().min(2).max(120),
  type: z.enum(['CITY', 'UNIVERSITY', 'DISTRICT', 'OTHER']),
});

const AssignDivisionAdminSchema = z
  .object({
    user_id: z.string().uuid().optional(),
    full_name: z.string().trim().min(2).max(120).optional(),
    email: z.string().email().optional(),
    phone: z.string().trim().min(7).max(20).optional(),
    password: z.string().min(8).optional(),
    role: z.string().trim().min(2).max(40).default('MANAGER'),
  })
  .refine(
    (value) =>
      Boolean(
        value.user_id ||
          (value.full_name && value.email && value.phone && value.password)
      ),
    {
      message: 'user_id or full_name/email/phone/password is required',
    }
  );

const ModerateDivisionCampaignSchema = z.object({
  status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED']),
});

function parsePaging(query: any) {
  const limitRaw = Number(query?.limit ?? 50);
  const offsetRaw = Number(query?.offset ?? 0);
  return {
    limit: Number.isFinite(limitRaw)
      ? Math.min(Math.max(limitRaw, 1), 200)
      : 50,
    offset: Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0,
  };
}

async function getLiveAccess(client: any, request: any) {
  const access = getRequestDashboardAccess(request);
  if (!access.user_id || access.user_id === 'ariaka-access') {
    return access;
  }
  return (await loadDashboardAccessContext(client, access.user_id)) ?? access;
}

type ScopeState = {
  conditions: string[];
  params: any[];
  idx: number;
};

function appendTenantScope(
  state: ScopeState,
  access: DashboardAccessContext,
  scope: {
    country: string;
    division?: string | null;
  }
) {
  appendDashboardTenantScope(state, access, scope);
}

function matchesTenantScope(
  access: DashboardAccessContext,
  row: {
    country_id?: unknown;
    division_id?: unknown;
  } | null | undefined
) {
  return matchesDashboardTenantScope(access, row);
}

async function requireModuleAccess(
  client: any,
  request: any,
  reply: any,
  moduleKey: string
) {
  const access = await getLiveAccess(client, request);
  if (!hasAdminModuleAccess(access, moduleKey)) {
    reply.code(403);
    return null;
  }
  return access;
}

async function resolveAccessibleCountryId(
  client: any,
  request: any,
  reply: any,
  access: DashboardAccessContext
) {
  const requestedCountryId = String((request.query as any)?.country_id ?? '')
    .trim();
  if (requestedCountryId) {
    if (
      !isSuperDashboardAccess(access) &&
      !access.country_ids.includes(requestedCountryId)
    ) {
      reply.code(403);
      return null;
    }
    const countryRes = await client.query(
      `SELECT id FROM countries WHERE id = $1 LIMIT 1`,
      [requestedCountryId]
    );
    if (!countryRes.rows[0]) {
      reply.code(404);
      return null;
    }
    return requestedCountryId;
  }

  if (access.country_id) {
    return access.country_id;
  }

  if (isSuperDashboardAccess(access)) {
    reply.code(400);
    return null;
  }

  reply.code(400);
  return null;
}

async function resolveAccessibleDivisionId(
  client: any,
  request: any,
  reply: any,
  access: DashboardAccessContext
) {
  const requestedDivisionId = String((request.query as any)?.division_id ?? '')
    .trim();
  if (requestedDivisionId) {
    if (
      !isSuperDashboardAccess(access) &&
      !access.division_ids.includes(requestedDivisionId)
    ) {
      reply.code(403);
      return null;
    }
    const divisionRes = await client.query(
      `SELECT id FROM divisions WHERE id = $1 LIMIT 1`,
      [requestedDivisionId]
    );
    if (!divisionRes.rows[0]) {
      reply.code(404);
      return null;
    }
    return requestedDivisionId;
  }

  if (access.division_id) {
    return access.division_id;
  }

  if (isSuperDashboardAccess(access)) {
    reply.code(400);
    return null;
  }

  reply.code(400);
  return null;
}

async function ensureWalletForUser(client: any, userId: string) {
  const existing = await client.query(
    `SELECT * FROM wallets WHERE user_id = $1 LIMIT 1`,
    [userId]
  );
  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const userRes = await client.query(
    `
    SELECT preferred_currency
    FROM users
    WHERE id = $1
    LIMIT 1
    `,
    [userId]
  );
  const currency = String(userRes.rows[0]?.preferred_currency ?? 'UGX')
    .trim()
    .toUpperCase();
  const created = await client.query(
    `
    INSERT INTO wallets (user_id, currency, balance_available, balance_escrow, balance)
    VALUES ($1,$2,0,0,0)
    RETURNING *
    `,
    [userId, currency]
  );
  return created.rows[0];
}

export async function tenantAdminRoutes(app: FastifyInstance) {
  app.get(
    '/admin/available-countries',
    { preHandler: [requireRole([ADMIN_ROLE_SUPER_ADMIN])] },
    async () => {
      return {
        countries: Object.entries(
          countries.getNames('en', { select: 'official' })
        ).map(([code, name]) => ({ code, name })),
      };
    }
  );

  app.post(
    '/admin/countries/:id/access',
    { preHandler: [requireRole([ADMIN_ROLE_SUPER_ADMIN])] },
    async (request, reply) => {
      const params = request.params as { id: string };
      return withTransaction(async (client) => {
        const countryRes = await client.query(
          'SELECT id, name, code FROM countries WHERE id = $1 LIMIT 1',
          [params.id]
        );
        const country = countryRes.rows[0];
        if (!country) {
          reply.code(404);
          return { error: 'country_not_found' };
        }

                const access = getRequestDashboardAccess(request);
        let user: any;
        if (access.user_id === 'ariaka-access') {
          user = {
            id: 'ariaka-access',
            email: 'ariaka-access@local',
            role: 'ADMIN',
            active_role: 'ADMIN',
            admin_role: ADMIN_ROLE_SUPER_ADMIN,
          };
        } else {
          const userRes = await client.query(
            'SELECT * FROM users WHERE id = $1 LIMIT 1',
            [access.user_id]
          );
          user = userRes.rows[0];
          if (!user) {
            reply.code(404);
            return { error: 'user_not_found' };
          }
        }

        const claims: any = buildAuthClaims(user);
        claims.country_id = country.id;
        claims.admin_role = ADMIN_ROLE_COUNTRY_ADMIN;

        const token = app.jwt.sign(claims);
        return {
          token,
          user: {
            ...buildUserSession(user),
            admin_role: ADMIN_ROLE_COUNTRY_ADMIN,
            country_id: country.id,
            country_name: country.name,
            country_code: country.code,
          },
        };
      });
    }
  );
  app.get(
    '/dashboard/access',
    { preHandler: [app.adminOnly] },
    async (request) => {
      return withTransaction(async (client) => {
        const access = await getLiveAccess(client, request);
        return { access };
      });
    }
  );

  app.post(
    '/admin/countries',
    { preHandler: [requireRole([ADMIN_ROLE_SUPER_ADMIN])] },
    async (request, reply) => {
      const body = CreateCountrySchema.parse(request.body);
      return withTransaction(async (client) => {
        const existing = await client.query(
          `SELECT id FROM countries WHERE UPPER(code) = $1 LIMIT 1`,
          [body.code.trim().toUpperCase()]
        );
        if (existing.rows[0]) {
          reply.code(409);
          return { error: 'country_code_taken' };
        }

        const inserted = await client.query(
          `
          INSERT INTO countries (name, code, status)
          VALUES ($1,$2,$3)
          RETURNING *
          `,
          [
            body.name.trim(),
            body.code.trim().toUpperCase(),
            body.status,
          ]
        );

        return { country: inserted.rows[0] };
      });
    }
  );

  app.get(
    '/admin/countries',
    { preHandler: [app.adminOnly] },
    async (request, reply) => {
      return withTransaction(async (client) => {
        const access = await getLiveAccess(client, request);
        if (!hasAdminModuleAccess(access, ADMIN_MODULE_COUNTRIES)) {
          reply.code(403);
          return { error: 'forbidden' };
        }
        const state: ScopeState = {
          conditions: [],
          params: [],
          idx: 1,
        };
        appendTenantScope(state, access, {
          country: 'c.id',
        });
        const where = state.conditions.length
          ? `WHERE ${state.conditions.join(' AND ')}`
          : '';
        const res = await client.query(
          `
          SELECT
            c.*,
            COALESCE(user_stats.user_count, 0)::int AS user_count,
            COALESCE(campaign_stats.campaign_count, 0)::int AS campaign_count,
            COALESCE(division_stats.division_count, 0)::int AS division_count,
            COALESCE(revenue_stats.gross_revenue, 0)::numeric AS gross_revenue,
            COALESCE(revenue_stats.net_platform_revenue, 0)::numeric AS net_platform_revenue
          FROM countries c
          LEFT JOIN (
            SELECT country_id, COUNT(*)::int AS user_count
            FROM users
            WHERE country_id IS NOT NULL
            GROUP BY country_id
          ) user_stats ON user_stats.country_id = c.id
          LEFT JOIN (
            SELECT country_id, COUNT(*)::int AS campaign_count
            FROM campaigns
            WHERE country_id IS NOT NULL
            GROUP BY country_id
          ) campaign_stats ON campaign_stats.country_id = c.id
          LEFT JOIN (
            SELECT country_id, COUNT(*)::int AS division_count
            FROM divisions
            GROUP BY country_id
          ) division_stats ON division_stats.country_id = c.id
          LEFT JOIN (
            SELECT
              country_id,
              ROUND(SUM(gross_amount)::numeric, 2) AS gross_revenue,
              ROUND(SUM(net_platform_revenue)::numeric, 2) AS net_platform_revenue
            FROM earnings_ledger
            GROUP BY country_id
          ) revenue_stats ON revenue_stats.country_id = c.id
          ${where}
          ORDER BY c.created_at DESC, c.name ASC
          `
          ,
          state.params
        );

        return { countries: res.rows };
      });
    }
  );

  app.post(
    '/admin/countries/:id/assign-admin',
    { preHandler: [requireRole([ADMIN_ROLE_SUPER_ADMIN])] },
    async (request, reply) => {
      const params = request.params as { id: string };
      const body = AssignCountryAdminSchema.parse(request.body);

      return withTransaction(async (client) => {
        try {
          const result = await assignCountryAdmin(
            client,
            params.id,
            body,
            body.role,
            {
              createdBySuperAdminId: String((request.user as any)?.sub ?? ''),
            }
          );
          if (result.access) {
            await recordAdminAudit(client, {
              actorId: String((request.user as any)?.sub ?? ''),
              action: 'ASSIGN_COUNTRY_ADMIN',
              targetType: 'admin_user',
              targetId: String(result.access.user_id),
              meta: {
                country_id: params.id,
                assignment_role: body.role,
                permissions: result.access.permissions,
              },
              ...auditScopeFromAccess(result.access),
            });
          }
          return result;
        } catch (error) {
          const message = String((error as Error)?.message ?? 'assignment_failed');
          reply.code(
            message === 'country_not_found'
              ? 404
              : message === 'user_not_found'
                ? 404
                : message === 'user_country_mismatch'
                  ? 409
                  : message === 'email_taken' || message === 'phone_taken'
                    ? 409
                    : 400
          );
          return { error: message };
        }
      });
    }
  );

  app.get(
    '/admin/global-stats',
    { preHandler: [requireRole([ADMIN_ROLE_SUPER_ADMIN])] },
    async () => {
      return withTransaction(async (client) => {
        const summary = await client.query(
          `
          SELECT
            (SELECT COUNT(*)::int FROM countries) AS total_countries,
            (SELECT COUNT(*)::int FROM users) AS total_users,
            (SELECT COUNT(*)::int FROM campaigns) AS total_campaigns,
            COALESCE((SELECT ROUND(SUM(gross_amount)::numeric, 2) FROM earnings_ledger), 0)::numeric AS gross_revenue,
            COALESCE((SELECT ROUND(SUM(platform_fee)::numeric, 2) FROM earnings_ledger), 0)::numeric AS platform_fee,
            COALESCE((SELECT ROUND(SUM(net_platform_revenue)::numeric, 2) FROM earnings_ledger), 0)::numeric AS net_platform_revenue
          `
        );
        const revenueByCountry = await client.query(
          `
          SELECT
            c.id AS country_id,
            c.name AS country_name,
            c.code AS country_code,
            COALESCE(ROUND(SUM(el.gross_amount)::numeric, 2), 0)::numeric AS gross_revenue,
            COALESCE(ROUND(SUM(el.platform_fee)::numeric, 2), 0)::numeric AS platform_fee,
            COALESCE(ROUND(SUM(el.net_platform_revenue)::numeric, 2), 0)::numeric AS net_platform_revenue
          FROM countries c
          LEFT JOIN earnings_ledger el ON el.country_id = c.id
          GROUP BY c.id, c.name, c.code
          ORDER BY gross_revenue DESC, c.name ASC
          `
        );
        const usersByCountry = await client.query(
          `
          SELECT
            c.id AS country_id,
            c.name AS country_name,
            c.code AS country_code,
            COUNT(u.id)::int AS user_count
          FROM countries c
          LEFT JOIN users u ON u.country_id = c.id
          GROUP BY c.id, c.name, c.code
          ORDER BY user_count DESC, c.name ASC
          `
        );
        const campaignsByCountry = await client.query(
          `
          SELECT
            c.id AS country_id,
            c.name AS country_name,
            c.code AS country_code,
            COUNT(cam.id)::int AS campaign_count
          FROM countries c
          LEFT JOIN campaigns cam ON cam.country_id = c.id
          GROUP BY c.id, c.name, c.code
          ORDER BY campaign_count DESC, c.name ASC
          `
        );

        return {
          summary: summary.rows[0] ?? {},
          revenue_by_country: revenueByCountry.rows,
          users_by_country: usersByCountry.rows,
          campaigns_by_country: campaignsByCountry.rows,
        };
      });
    }
  );

  app.get(
    '/admin/payouts',
    {
      preHandler: [
        requireRole([
          ADMIN_ROLE_SUPER_ADMIN,
          ADMIN_ROLE_COUNTRY_ADMIN,
          ADMIN_ROLE_DIVISION_ADMIN,
        ]),
      ],
    },
    async (request, reply) => {
      const query = request.query as any;
      const { limit, offset } = parsePaging(query);
      return withTransaction(async (client) => {
        const access = await getLiveAccess(client, request);
        if (!hasAdminModuleAccess(access, ADMIN_MODULE_MANAGER_PAYOUTS)) {
          reply.code(403);
          return { error: 'forbidden' };
        }
        const state: ScopeState = {
          conditions: [],
          params: [],
          idx: 1,
        };
        appendTenantScope(state, access, {
          country: 'p.country_id',
          division: 'p.division_id',
        });
        const where = state.conditions.length
          ? `WHERE ${state.conditions.join(' AND ')}`
          : '';
        const res = await client.query(
          `
          SELECT
            p.*,
            u.email,
            u.full_name,
            c.name AS country_name,
            c.code AS country_code,
            d.name AS division_name
          FROM payouts p
          JOIN users u ON u.id = p.user_id
          LEFT JOIN countries c ON c.id = p.country_id
          LEFT JOIN divisions d ON d.id = p.division_id
          ${where}
          ORDER BY p.created_at DESC
          LIMIT $${state.idx} OFFSET $${state.idx + 1}
          `,
          [...state.params, limit, offset]
        );
        return { payouts: res.rows };
      });
    }
  );

  app.post(
    '/admin/payouts/:id/pay',
    {
      preHandler: [
        requireRole([
          ADMIN_ROLE_SUPER_ADMIN,
          ADMIN_ROLE_COUNTRY_ADMIN,
          ADMIN_ROLE_DIVISION_ADMIN,
        ]),
      ],
    },
    async (request, reply) => {
      const params = request.params as { id: string };
      return withTransaction(async (client) => {
        const access = await getLiveAccess(client, request);
        if (!hasAdminModuleAccess(access, ADMIN_MODULE_MANAGER_PAYOUTS)) {
          reply.code(403);
          return { error: 'forbidden' };
        }
        const payoutRes = await client.query(
          `
          SELECT *
          FROM payouts
          WHERE id = $1
          FOR UPDATE
          `,
          [params.id]
        );
        const payout = payoutRes.rows[0];
        if (!payout) {
          reply.code(404);
          return { error: 'payout_not_found' };
        }
        if (!matchesTenantScope(access, payout)) {
          reply.code(404);
          return { error: 'payout_not_found' };
        }

        if (String(payout.status).toUpperCase() !== 'PAID') {
          const creditAmount = Math.round(Number(payout.amount ?? 0));
          if (creditAmount <= 0) {
            reply.code(400);
            return { error: 'payout_amount_invalid' };
          }
          const wallet = await ensureWalletForUser(client, String(payout.user_id));
          await client.query(
            `
            UPDATE wallets
            SET balance_available = balance_available + $2,
                balance = balance + $2
            WHERE id = $1
            `,
            [wallet.id, creditAmount]
          );
          await client.query(
            `
            INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
            VALUES ($1,$2,'CREDIT',$3)
            `,
            [wallet.id, creditAmount, `MANAGER_PAYOUT:${payout.id}`]
          );
          await client.query(
            `
            UPDATE payouts
            SET status = 'PAID',
                paid_at = NOW(),
                paid_by = $2
            WHERE id = $1
            `,
            [params.id, (access.user_id === 'ariaka-access' ? null : (access.user_id || null))]
          );
        }

        const updated = await client.query(
          `
          SELECT *
          FROM payouts
          WHERE id = $1
          LIMIT 1
          `,
          [params.id]
        );
        return { payout: updated.rows[0] };
      });
    }
  );

  app.get(
    '/country/analytics',
    { preHandler: [requireRole([ADMIN_ROLE_COUNTRY_ADMIN])] },
    async (request, reply) => {
      return withTransaction(async (client) => {
        const access = await requireModuleAccess(
          client,
          request,
          reply,
          ADMIN_MODULE_OVERVIEW
        );
        if (!access) {
          return { error: 'forbidden' };
        }
        const countryId = await resolveAccessibleCountryId(
          client,
          request,
          reply,
          access
        );
        if (!countryId) {
          return {
            error:
              reply.statusCode === 404 ? 'country_not_found' : 'country_scope_missing',
          };
        }

        const summary = await client.query(
          `
          SELECT
            (SELECT COUNT(*)::int FROM users WHERE country_id = $1) AS total_users,
            (SELECT COUNT(*)::int FROM users WHERE country_id = $1 AND status = 'ACTIVE') AS active_users,
            (SELECT COUNT(*)::int FROM campaigns WHERE country_id = $1) AS total_campaigns,
            COALESCE((SELECT ROUND(SUM(gross_amount)::numeric, 2) FROM earnings_ledger WHERE country_id = $1), 0)::numeric AS gross_revenue,
            COALESCE((SELECT ROUND(SUM(platform_fee)::numeric, 2) FROM earnings_ledger WHERE country_id = $1), 0)::numeric AS platform_fee,
            COALESCE((SELECT ROUND(SUM(net_platform_revenue)::numeric, 2) FROM earnings_ledger WHERE country_id = $1), 0)::numeric AS net_platform_revenue
          `,
          [countryId]
        );
        const divisions = await client.query(
          `
          SELECT
            d.id,
            d.name,
            d.type,
            COUNT(DISTINCT u.id)::int AS user_count,
            COUNT(DISTINCT c.id)::int AS campaign_count,
            COALESCE(ROUND(SUM(el.division_share)::numeric, 2), 0)::numeric AS division_revenue
          FROM divisions d
          LEFT JOIN users u ON u.division_id = d.id
          LEFT JOIN campaigns c ON c.division_id = d.id
          LEFT JOIN earnings_ledger el ON el.division_id = d.id
          WHERE d.country_id = $1
          GROUP BY d.id, d.name, d.type
          ORDER BY d.created_at DESC
          `,
          [countryId]
        );
        const country = await client.query(
          `SELECT id, name, code, status FROM countries WHERE id = $1 LIMIT 1`,
          [countryId]
        );
        if (!country.rows[0]) {
          reply.code(404);
          return { error: 'country_not_found' };
        }

        return {
          country: country.rows[0] ?? null,
          analytics: summary.rows[0] ?? {},
          divisions: divisions.rows,
        };
      });
    }
  );

  app.get(
    '/country/users',
    { preHandler: [requireRole([ADMIN_ROLE_COUNTRY_ADMIN])] },
    async (request, reply) => {
      const query = request.query as any;
      const { limit, offset } = parsePaging(query);
      return withTransaction(async (client) => {
        const access = await requireModuleAccess(
          client,
          request,
          reply,
          ADMIN_MODULE_USERS
        );
        if (!access) {
          return { error: 'forbidden' };
        }
        const countryId = await resolveAccessibleCountryId(
          client,
          request,
          reply,
          access
        );
        if (!countryId) {
          reply.code(400);
          return { error: 'country_scope_missing' };
        }

        return {
          users: (
            await client.query(
          `
          SELECT
            u.id,
            u.full_name,
            u.email,
            u.phone,
            u.status,
            u.admin_role,
            u.role,
            d.name AS division_name,
            u.created_at
          FROM users u
          LEFT JOIN divisions d ON d.id = u.division_id
          WHERE u.country_id = $1
          ORDER BY u.created_at DESC
          LIMIT $2 OFFSET $3
          `,
              [countryId, limit, offset]
            )
          ).rows,
        };
      });
    }
  );

  app.get(
    '/country/campaigns',
    { preHandler: [requireRole([ADMIN_ROLE_COUNTRY_ADMIN])] },
    async (request, reply) => {
      const query = request.query as any;
      const { limit, offset } = parsePaging(query);
      return withTransaction(async (client) => {
        const access = await requireModuleAccess(
          client,
          request,
          reply,
          ADMIN_MODULE_CAMPAIGNS
        );
        if (!access) {
          return { error: 'forbidden' };
        }
        const countryId = await resolveAccessibleCountryId(
          client,
          request,
          reply,
          access
        );
        if (!countryId) {
          reply.code(400);
          return { error: 'country_scope_missing' };
        }

        const res = await client.query(
          `
          SELECT
            c.id,
            c.public_id,
            c.title,
            c.status,
            c.platform,
            c.budget_total,
            c.payout_amount,
            c.start_date,
            c.end_date,
            d.name AS division_name,
            adv.email AS advertiser_email,
            c.created_at
          FROM campaigns c
          JOIN users adv ON adv.id = c.advertiser_id
          LEFT JOIN divisions d ON d.id = c.division_id
          WHERE c.country_id = $1
          ORDER BY c.created_at DESC
          LIMIT $2 OFFSET $3
          `,
          [countryId, limit, offset]
        );
        return { campaigns: res.rows };
      });
    }
  );

  app.get(
    '/country/divisions',
    { preHandler: [requireRole([ADMIN_ROLE_COUNTRY_ADMIN])] },
    async (request, reply) => {
      return withTransaction(async (client) => {
        const access = await requireModuleAccess(
          client,
          request,
          reply,
          ADMIN_MODULE_DIVISIONS
        );
        if (!access) {
          return { error: 'forbidden' };
        }
        const countryId = await resolveAccessibleCountryId(
          client,
          request,
          reply,
          access
        );
        if (!countryId) {
          reply.code(400);
          return { error: 'country_scope_missing' };
        }

        const res = await client.query(
          `
          SELECT
            d.*,
            COUNT(DISTINCT u.id)::int AS user_count,
            COUNT(DISTINCT c.id)::int AS campaign_count,
            COUNT(DISTINCT da.user_id)::int AS admin_count
          FROM divisions d
          LEFT JOIN users u ON u.division_id = d.id
          LEFT JOIN campaigns c ON c.division_id = d.id
          LEFT JOIN division_admins da ON da.division_id = d.id
          WHERE d.country_id = $1
          GROUP BY d.id
          ORDER BY d.created_at DESC
          `,
          [countryId]
        );
        return { divisions: res.rows };
      });
    }
  );

  app.post(
    '/country/divisions',
    { preHandler: [requireRole([ADMIN_ROLE_COUNTRY_ADMIN])] },
    async (request, reply) => {
      const body = CreateDivisionSchema.parse(request.body);
      return withTransaction(async (client) => {
        const access = await requireModuleAccess(
          client,
          request,
          reply,
          ADMIN_MODULE_DIVISIONS
        );
        if (!access) {
          return { error: 'forbidden' };
        }
        const countryId = await resolveAccessibleCountryId(
          client,
          request,
          reply,
          access
        );
        if (!countryId) {
          reply.code(400);
          return { error: 'country_scope_missing' };
        }

        const inserted = await client.query(
          `
          INSERT INTO divisions (country_id, name, type, created_by)
          VALUES ($1,$2,$3,$4)
          RETURNING *
          `,
          [
            countryId,
            body.name.trim(),
            body.type,
            (access.user_id === 'ariaka-access' ? null : (access.user_id || null)),
          ]
        );
        return { division: inserted.rows[0] };
      });
    }
  );

  app.post(
    '/country/divisions/:id/assign-admin',
    { preHandler: [requireRole([ADMIN_ROLE_SUPER_ADMIN])] },
    async (request, reply) => {
      const params = request.params as { id: string };
      const body = AssignDivisionAdminSchema.parse(request.body);
      return withTransaction(async (client) => {
        const division = await client.query(
          `
          SELECT id, country_id
          FROM divisions
          WHERE id = $1
          LIMIT 1
          `,
          [params.id]
        );
        if (!division.rows[0]) {
          reply.code(404);
          return { error: 'division_not_found' };
        }

        try {
          const result = await assignDivisionAdmin(
            client,
            params.id,
            body,
            body.role,
            {
              createdBySuperAdminId: String((request.user as any)?.sub ?? ''),
            }
          );
          if (result.access) {
            await recordAdminAudit(client, {
              actorId: String((request.user as any)?.sub ?? ''),
              action: 'ASSIGN_DIVISION_ADMIN',
              targetType: 'admin_user',
              targetId: String(result.access.user_id),
              meta: {
                division_id: params.id,
                country_id: String(division.rows[0].country_id),
                assignment_role: body.role,
                permissions: result.access.permissions,
              },
              ...auditScopeFromAccess(result.access),
            });
          }
          return result;
        } catch (error) {
          const message = String((error as Error)?.message ?? 'assignment_failed');
          reply.code(
            message === 'division_not_found'
              ? 404
              : message === 'user_not_found'
                ? 404
                : message === 'user_country_mismatch'
                  ? 409
                  : message === 'email_taken' || message === 'phone_taken'
                    ? 409
                    : 400
          );
          return { error: message };
        }
      });
    }
  );

  app.get(
    '/division/overview',
    { preHandler: [requireRole([ADMIN_ROLE_DIVISION_ADMIN])] },
    async (request, reply) => {
      return withTransaction(async (client) => {
        const access = await requireModuleAccess(
          client,
          request,
          reply,
          ADMIN_MODULE_OVERVIEW
        );
        if (!access) {
          return { error: 'forbidden' };
        }
        const divisionId = await resolveAccessibleDivisionId(
          client,
          request,
          reply,
          access
        );
        if (!divisionId) {
          reply.code(400);
          return { error: 'division_scope_missing' };
        }

        const division = await client.query(
          `
          SELECT
            d.id,
            d.name,
            d.type,
            c.name AS country_name,
            c.code AS country_code
          FROM divisions d
          JOIN countries c ON c.id = d.country_id
          WHERE d.id = $1
          LIMIT 1
          `,
          [divisionId]
        );
        const analytics = await client.query(
          `
          SELECT
            (SELECT COUNT(*)::int FROM users WHERE division_id = $1) AS total_users,
            (SELECT COUNT(*)::int FROM users WHERE division_id = $1 AND status = 'ACTIVE') AS active_users,
            (SELECT COUNT(*)::int FROM campaigns WHERE division_id = $1) AS total_campaigns,
            COALESCE((SELECT ROUND(SUM(gross_amount)::numeric, 2) FROM earnings_ledger WHERE division_id = $1), 0)::numeric AS gross_revenue,
            COALESCE((SELECT ROUND(SUM(division_share)::numeric, 2) FROM earnings_ledger WHERE division_id = $1), 0)::numeric AS division_manager_earnings
          `,
          [divisionId]
        );

        return {
          division: division.rows[0] ?? null,
          analytics: analytics.rows[0] ?? {},
        };
      });
    }
  );

  app.get(
    '/division/users',
    { preHandler: [requireRole([ADMIN_ROLE_DIVISION_ADMIN])] },
    async (request, reply) => {
      const query = request.query as any;
      const { limit, offset } = parsePaging(query);
      return withTransaction(async (client) => {
        const access = await requireModuleAccess(
          client,
          request,
          reply,
          ADMIN_MODULE_USERS
        );
        if (!access) {
          return { error: 'forbidden' };
        }
        const divisionId = await resolveAccessibleDivisionId(
          client,
          request,
          reply,
          access
        );
        if (!divisionId) {
          reply.code(400);
          return { error: 'division_scope_missing' };
        }

        const res = await client.query(
          `
          SELECT
            id,
            full_name,
            email,
            phone,
            status,
            admin_role,
            role,
            created_at
          FROM users
          WHERE division_id = $1
          ORDER BY created_at DESC
          LIMIT $2 OFFSET $3
          `,
          [divisionId, limit, offset]
        );
        return { users: res.rows };
      });
    }
  );

  app.get(
    '/division/campaigns',
    { preHandler: [requireRole([ADMIN_ROLE_DIVISION_ADMIN])] },
    async (request, reply) => {
      const query = request.query as any;
      const { limit, offset } = parsePaging(query);
      return withTransaction(async (client) => {
        const access = await requireModuleAccess(
          client,
          request,
          reply,
          ADMIN_MODULE_CAMPAIGNS
        );
        if (!access) {
          return { error: 'forbidden' };
        }
        const divisionId = await resolveAccessibleDivisionId(
          client,
          request,
          reply,
          access
        );
        if (!divisionId) {
          reply.code(400);
          return { error: 'division_scope_missing' };
        }

        const res = await client.query(
          `
          SELECT
            c.id,
            c.public_id,
            c.title,
            c.status,
            c.platform,
            c.budget_total,
            c.payout_amount,
            c.start_date,
            c.end_date,
            adv.email AS advertiser_email,
            c.created_at
          FROM campaigns c
          JOIN users adv ON adv.id = c.advertiser_id
          WHERE c.division_id = $1
          ORDER BY c.created_at DESC
          LIMIT $2 OFFSET $3
          `,
          [divisionId, limit, offset]
        );
        return { campaigns: res.rows };
      });
    }
  );

  app.post(
    '/division/campaigns/:id/moderate',
    { preHandler: [requireRole([ADMIN_ROLE_DIVISION_ADMIN])] },
    async (request, reply) => {
      const params = request.params as { id: string };
      const body = ModerateDivisionCampaignSchema.parse(request.body);
      return withTransaction(async (client) => {
        const access = await requireModuleAccess(
          client,
          request,
          reply,
          ADMIN_MODULE_CAMPAIGNS
        );
        if (!access) {
          return { error: 'forbidden' };
        }
        const divisionId = await resolveAccessibleDivisionId(
          client,
          request,
          reply,
          access
        );
        if (!divisionId) {
          reply.code(400);
          return { error: 'division_scope_missing' };
        }

        const updated = await client.query(
          `
          UPDATE campaigns
          SET status = $2
          WHERE id = $1
            AND division_id = $3
          RETURNING *
          `,
          [params.id, body.status, divisionId]
        );

        if (!updated.rows[0]) {
          reply.code(404);
          return { error: 'campaign_not_found' };
        }

        return { campaign: updated.rows[0] };
      });
    }
  );
}
