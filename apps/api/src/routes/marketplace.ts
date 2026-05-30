// routes/marketplace.ts
// Public marketplace — direct (campaign-free) listings + browsing

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction, query } from '../db.js';
import { canAccessBusinessFeatures } from '../services/roles.js';
import { v4 as uuid } from 'uuid';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import { hasYoClientCredentials, hasYoEncryptionKey } from '../config.js';
import { resolveAvailableYoUgandaCheckoutProfile } from '../services/yoUgandaCheckoutProfile.js';
import {
  PRIME_REQUEST_ACCESS_PASS_PLANS,
  PRIME_REQUEST_PRICING,
  PRIME_REQUEST_UNLOCK_PRICE_UGX,
  adminPrimeRequestDto,
  debitPrimeRequestWallet,
  ensurePrimeRequestsSchema,
  expireOldPrimeRequests,
  fullPrimeRequestDto,
  getActivePrimeRequestPass,
  hasPrimeRequestAccess,
  insertPrimeRequestAccessPass,
  insertPrimeRequestUnlock,
  loadPrimeRequest,
  normalizePrimeRequestCreateInput,
  normalizePrimeRequestPassType,
  publicPrimeRequestDto,
  validatePrimeRequestCreateInput,
} from '../services/primeRequests.js';

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function generateListingSlug(title: string): string {
  const base = slugify(title).slice(0, 40);
  const suffix = Math.random().toString(36).slice(2, 8);
  return `${base}-${suffix}`;
}

function calcQualityScore(data: {
  title: string;
  summary: string;
  description: string;
  price?: number | null;
  location_text?: string | null;
  cta_phone?: string | null;
  cta_whatsapp?: string | null;
  cta_email?: string | null;
  image_count: number;
}): number {
  let score = 0;
  if (data.title.trim().length >= 10) score += 15;
  if (data.summary.trim().length >= 30) score += 15;
  if (data.description.trim().length >= 100) score += 20;
  if (data.price && data.price > 0) score += 10;
  if (data.location_text && data.location_text.trim()) score += 10;
  if (data.cta_phone || data.cta_whatsapp || data.cta_email) score += 10;
  if (data.image_count >= 1) score += 10;
  if (data.image_count >= 3) score += 10;
  return Math.min(score, 100);
}

// ─────────────────────────────────────────────
// VALIDATION SCHEMAS
// ─────────────────────────────────────────────

const createListingSchema = z.object({
  listing_type_id: z.string().uuid().optional(),
  listing_kind: z.enum(['PRODUCT', 'SERVICE']).optional().default('PRODUCT'),
  title: z.string().min(5).max(150),
  summary: z.string().min(10).max(300),
  description: z.string().min(10).max(5000),
  price: z.number().positive().optional().nullable(),
  currency: z.string().default('UGX'),
  is_negotiable: z.boolean().default(false),
  location_text: z.string().max(200).optional().nullable(),
  cta_whatsapp: z.string().max(30).optional().nullable(),
  cta_phone: z.string().max(30).optional().nullable(),
  cta_email: z.string().email().optional().nullable(),
  cta_url: z.string().url().optional().nullable(),
  images: z
    .array(
      z.object({
        url: z.string().url(),
        media_type: z.literal('IMAGE').default('IMAGE'),
      })
    )
    .default([]),
  content_blocks: z.array(z.record(z.any())).optional().default([]),
  draft_mode: z.boolean().optional().default(false),
});

const patchListingSchema = createListingSchema.partial().omit({ listing_type_id: true });

const primeRequestUnlockSchema = z.object({
  fund_source: z.enum(['YO_UGANDA', 'WALLET']).optional().default('YO_UGANDA'),
});

const primeRequestPassSchema = z.object({
  pass_type: z.enum(['daily', 'weekly', 'monthly']),
  fund_source: z.enum(['YO_UGANDA', 'WALLET']).optional().default('YO_UGANDA'),
});

function parsePositiveInt(value: unknown, fallback: number, max: number) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(1, parsed));
}

function normalizeQueryText(value: unknown, max = 120) {
  return String(value ?? '').trim().slice(0, max);
}

function buildPrimeRequestCheckoutPayload(input: {
  txRef: string;
  amount: number;
  userId: string;
  user: any;
  kind: 'PRIME_REQUEST_UNLOCK' | 'PRIME_REQUEST_ACCESS_PASS';
  country: string;
  checkoutProfile: ReturnType<typeof resolveAvailableYoUgandaCheckoutProfile>;
  requestId?: string;
  passType?: string;
}) {
  return {
    provider: 'YO_UGANDA',
    mode: 'DIRECT_CHARGE',
    tx_ref: input.txRef,
    amount: input.amount,
    currency: 'UGX',
    payment_options: input.checkoutProfile.paymentOptions,
    supported_payment_methods: input.checkoutProfile.supportedPaymentMethods,
    mobile_money_networks: input.checkoutProfile.mobileMoneyNetworks,
    phone_country_code: input.checkoutProfile.phoneCountryCode,
    availability_notes: input.checkoutProfile.availabilityNotes,
    country: input.checkoutProfile.country,
    customer: {
      email: input.user?.email ?? '',
      name: input.user?.full_name ?? 'Prime Status User',
      phone_number: input.user?.phone ?? null,
    },
    meta: {
      merchant_reference: input.txRef,
      kind: input.kind,
      user_id: input.userId,
      ...(input.requestId ? { request_id: input.requestId } : {}),
      ...(input.passType ? { pass_type: input.passType } : {}),
    },
  };
}

// ─────────────────────────────────────────────
// ROUTE REGISTRATION
// ─────────────────────────────────────────────

let schemaEnsured = false;
async function ensureContentBlocksColumn(client: any) {
  if (schemaEnsured) return;
  await client.query(`ALTER TABLE advert_listings ADD COLUMN IF NOT EXISTS content_blocks JSONB`);
  await client.query(`ALTER TABLE advert_listings ALTER COLUMN listing_type_id DROP NOT NULL`);
  schemaEnsured = true;
}

export async function marketplaceRoutes(app: FastifyInstance) {

  // ── GET /marketplace/categories ─────────────────────────────────────────
  app.get('/marketplace/categories', async (_request, reply) => {
    try {
      const rows = await query(
        `SELECT id, slug, name, icon, sort_order
         FROM advert_categories
         WHERE is_active = TRUE
         ORDER BY sort_order ASC, name ASC`,
        []
      );
      reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
      return { categories: rows };
    } catch (err) {
      app.log.error(err, 'marketplace.categories.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PRIME REQUESTS
  // ═══════════════════════════════════════════════════════════════════════════

  app.get('/marketplace/prime-requests/pricing', async (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    return { pricing: PRIME_REQUEST_PRICING };
  });

  app.post('/marketplace/prime-requests', async (request, reply) => {
    const input = normalizePrimeRequestCreateInput(request.body ?? {});
    const issues = validatePrimeRequestCreateInput(input);
    if (issues.length > 0) {
      return reply.code(400).send({ error: 'validation_error', issues });
    }

    try {
      const id = uuid();
      const created = await withTransaction(async (client) => {
        await ensurePrimeRequestsSchema(client);
        const authUserId = String((request.user as any)?.sub ?? '').trim() || null;
        const res = await client.query(
          `INSERT INTO prime_requests
             (id, requester_user_id, requester_name, requester_phone, requester_whatsapp,
              preferred_contact_method, title, description, category, subcategory,
              location, exact_location, budget_min, budget_max, urgency, status,
              attachments, consent_provider_contact, expires_at)
           VALUES
             ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
              $11, $12, $13, $14, $15, 'pending', $16::jsonb, $17, now() + interval '30 days')
           RETURNING *`,
          [
            id,
            authUserId,
            input.requester_name,
            input.requester_phone,
            input.requester_whatsapp,
            input.preferred_contact_method,
            input.title,
            input.description,
            input.category,
            input.subcategory,
            input.location,
            input.exact_location,
            input.budget_min,
            input.budget_max,
            input.urgency,
            JSON.stringify(input.attachments),
            input.consent_provider_contact,
          ]
        );
        return res.rows[0];
      });

      return reply.code(201).send({
        ok: true,
        request: publicPrimeRequestDto(created),
        message: 'Prime Request submitted for review.',
      });
    } catch (err) {
      app.log.error(err, 'marketplace.primeRequests.create.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  app.get('/marketplace/prime-requests', async (request, reply) => {
    const q = request.query as Record<string, unknown>;
    const page = parsePositiveInt(q.page, 1, 10_000);
    const limit = parsePositiveInt(q.limit, 20, 50);
    const offset = (page - 1) * limit;
    const search = normalizeQueryText(q.search, 100);
    const category = normalizeQueryText(q.category, 80);
    const location = normalizeQueryText(q.location, 100);
    const urgency = normalizeQueryText(q.urgency, 80);
    const budgetMin = q.budget_min == null || q.budget_min === '' ? null : Number(q.budget_min);
    const budgetMax = q.budget_max == null || q.budget_max === '' ? null : Number(q.budget_max);

    try {
      const result = await withTransaction(async (client) => {
        await ensurePrimeRequestsSchema(client);
        await expireOldPrimeRequests(client);
        const conditions = [
          `(status IN ('approved', 'active'))`,
          `(expires_at IS NULL OR expires_at > now())`,
        ];
        const params: unknown[] = [];
        if (search) {
          params.push(`%${search}%`);
          conditions.push(`(title ILIKE $${params.length} OR description ILIKE $${params.length})`);
        }
        if (category) {
          params.push(category);
          conditions.push(`category ILIKE $${params.length}`);
        }
        if (location) {
          params.push(`%${location}%`);
          conditions.push(`location ILIKE $${params.length}`);
        }
        if (urgency) {
          params.push(urgency);
          conditions.push(`urgency ILIKE $${params.length}`);
        }
        if (Number.isFinite(budgetMin)) {
          params.push(Number(budgetMin));
          conditions.push(`(budget_max IS NULL OR budget_max >= $${params.length})`);
        }
        if (Number.isFinite(budgetMax)) {
          params.push(Number(budgetMax));
          conditions.push(`(budget_min IS NULL OR budget_min <= $${params.length})`);
        }
        const where = conditions.join(' AND ');
        const [rows, countRows] = await Promise.all([
          client.query(
            `SELECT *
             FROM prime_requests
             WHERE ${where}
             ORDER BY created_at DESC
             LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
            [...params, limit, offset]
          ),
          client.query(`SELECT COUNT(*)::int AS total FROM prime_requests WHERE ${where}`, params),
        ]);
        const total = Number(countRows.rows[0]?.total ?? 0);
        return { rows: rows.rows, total };
      });

      reply.header('Cache-Control', 'public, max-age=20, stale-while-revalidate=40');
      return {
        requests: result.rows.map(publicPrimeRequestDto),
        pricing: PRIME_REQUEST_PRICING,
        page,
        limit,
        total: result.total,
        total_pages: Math.ceil(result.total / limit),
      };
    } catch (err) {
      app.log.error(err, 'marketplace.primeRequests.list.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  app.get('/marketplace/prime-requests/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const row = await withTransaction(async (client) => {
        await ensurePrimeRequestsSchema(client);
        await expireOldPrimeRequests(client);
        return loadPrimeRequest(client, id);
      });
      if (!row || !['approved', 'active'].includes(String(row.status))) {
        return reply.code(404).send({ error: 'prime_request_not_found' });
      }
      return { request: publicPrimeRequestDto(row), pricing: PRIME_REQUEST_PRICING };
    } catch (err) {
      app.log.error(err, 'marketplace.primeRequests.summary.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  app.get('/marketplace/prime-requests/:id/full', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = String((request.user as any)?.sub ?? '').trim();
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

    try {
      const result = await withTransaction(async (client) => {
        await ensurePrimeRequestsSchema(client);
        await expireOldPrimeRequests(client);
        const row = await loadPrimeRequest(client, id);
        if (!row) return { error: 'prime_request_not_found' } as const;
        const status = String(row.status ?? '');
        const owner = String(row.requester_user_id ?? '') === userId;
        if (!owner && !['approved', 'active'].includes(status)) {
          return { error: 'prime_request_not_found' } as const;
        }
        const hasAccess = await hasPrimeRequestAccess(client, id, userId);
        if (!hasAccess) {
          return {
            request: publicPrimeRequestDto(row),
            access_required: true,
            pricing: PRIME_REQUEST_PRICING,
          };
        }
        return {
          request: fullPrimeRequestDto(row),
          access_required: false,
          pricing: PRIME_REQUEST_PRICING,
        };
      });

      if ('error' in result) return reply.code(404).send({ error: result.error });
      return result;
    } catch (err) {
      app.log.error(err, 'marketplace.primeRequests.full.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  app.post('/marketplace/prime-requests/:id/unlock', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const userId = String((request.user as any)?.sub ?? '').trim();
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = primeRequestUnlockSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', issues: parsed.error.issues });
    }

    try {
      const result = await withTransaction(async (client) => {
        await ensurePrimeRequestsSchema(client);
        await expireOldPrimeRequests(client);
        const row = await loadPrimeRequest(client, id);
        if (!row || !['approved', 'active'].includes(String(row.status))) {
          return { error: 'prime_request_not_found' } as const;
        }
        if (await hasPrimeRequestAccess(client, id, userId)) {
          return {
            ok: true,
            already_unlocked: true,
            request: fullPrimeRequestDto(row),
            pricing: PRIME_REQUEST_PRICING,
          };
        }

        if (parsed.data.fund_source === 'WALLET') {
          const debited = await debitPrimeRequestWallet(client, {
            userId,
            amount: PRIME_REQUEST_UNLOCK_PRICE_UGX,
            reference: `PRIME_REQUEST_UNLOCK:${id}`,
          });
          if ('error' in debited) return debited;
          await insertPrimeRequestUnlock(client, {
            requestId: id,
            userId,
            amountPaid: PRIME_REQUEST_UNLOCK_PRICE_UGX,
            paymentReference: `WALLET:${id}:${Date.now()}`,
          });
          return {
            ok: true,
            funded: true,
            fund_source: 'WALLET',
            request: fullPrimeRequestDto(row),
            pricing: PRIME_REQUEST_PRICING,
          };
        }

        if (!hasYoClientCredentials()) return { error: 'yo_uganda_not_configured' } as const;
        const userRes = await client.query(
          `SELECT email, phone, country, full_name FROM users WHERE id=$1 LIMIT 1`,
          [userId]
        );
        const user = userRes.rows[0] ?? {};
        const checkoutProfile = resolveAvailableYoUgandaCheckoutProfile(user.country ?? 'UG', {
          cardEnabled: hasYoEncryptionKey(),
        });
        const txRef = uuid();
        const rawPayload = {
          kind: 'PRIME_REQUEST_UNLOCK',
          user_id: userId,
          request_id: id,
          amount: PRIME_REQUEST_UNLOCK_PRICE_UGX,
          currency: 'UGX',
          customer: { email: user.email ?? '', name: user.full_name ?? 'Prime Status User', phone_number: user.phone ?? null },
          supported_payment_methods: checkoutProfile.supportedPaymentMethods,
          mobile_money_networks: checkoutProfile.mobileMoneyNetworks,
          phone_country_code: checkoutProfile.phoneCountryCode,
        };
        await new PaymentRepo().createPesaPalTransaction(client, {
          escrow_id: undefined,
          type: 'FUNDING',
          amount: PRIME_REQUEST_UNLOCK_PRICE_UGX,
          merchant_reference: txRef,
          raw_payload: rawPayload,
        });
        return {
          ok: true,
          tx_ref: txRef,
          amount: PRIME_REQUEST_UNLOCK_PRICE_UGX,
          currency: 'UGX',
          checkout_payload: buildPrimeRequestCheckoutPayload({
            txRef,
            amount: PRIME_REQUEST_UNLOCK_PRICE_UGX,
            userId,
            user,
            kind: 'PRIME_REQUEST_UNLOCK',
            country: checkoutProfile.country,
            checkoutProfile,
            requestId: id,
          }),
          pricing: PRIME_REQUEST_PRICING,
        };
      });

      if ('error' in result) {
        const status = result.error === 'prime_request_not_found'
          ? 404
          : result.error === 'insufficient_wallet_balance'
            ? 400
            : result.error === 'yo_uganda_not_configured'
              ? 503
              : 400;
        return reply.code(status).send(result);
      }
      return result;
    } catch (err) {
      app.log.error(err, 'marketplace.primeRequests.unlock.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  app.post('/marketplace/prime-requests/access-passes', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const userId = String((request.user as any)?.sub ?? '').trim();
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    const parsed = primeRequestPassSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', issues: parsed.error.issues });
    }
    const passType = normalizePrimeRequestPassType(parsed.data.pass_type)!;
    const plan = PRIME_REQUEST_ACCESS_PASS_PLANS[passType];

    try {
      const result = await withTransaction(async (client) => {
        await ensurePrimeRequestsSchema(client);
        await expireOldPrimeRequests(client);
        const activePass = await getActivePrimeRequestPass(client, userId);
        if (activePass) {
          return {
            ok: true,
            already_active: true,
            access_pass: activePass,
            pricing: PRIME_REQUEST_PRICING,
          };
        }

        if (parsed.data.fund_source === 'WALLET') {
          const reference = `PRIME_REQUEST_PASS:${passType}:${Date.now()}`;
          const debited = await debitPrimeRequestWallet(client, {
            userId,
            amount: plan.amount_ugx,
            reference,
          });
          if ('error' in debited) return debited;
          const accessPass = await insertPrimeRequestAccessPass(client, {
            userId,
            passType,
            amountPaid: plan.amount_ugx,
            paymentReference: reference,
          });
          return {
            ok: true,
            funded: true,
            fund_source: 'WALLET',
            access_pass: accessPass,
            pricing: PRIME_REQUEST_PRICING,
          };
        }

        if (!hasYoClientCredentials()) return { error: 'yo_uganda_not_configured' } as const;
        const userRes = await client.query(
          `SELECT email, phone, country, full_name FROM users WHERE id=$1 LIMIT 1`,
          [userId]
        );
        const user = userRes.rows[0] ?? {};
        const checkoutProfile = resolveAvailableYoUgandaCheckoutProfile(user.country ?? 'UG', {
          cardEnabled: hasYoEncryptionKey(),
        });
        const txRef = uuid();
        const rawPayload = {
          kind: 'PRIME_REQUEST_ACCESS_PASS',
          user_id: userId,
          pass_type: passType,
          amount: plan.amount_ugx,
          currency: 'UGX',
          customer: { email: user.email ?? '', name: user.full_name ?? 'Prime Status User', phone_number: user.phone ?? null },
          supported_payment_methods: checkoutProfile.supportedPaymentMethods,
          mobile_money_networks: checkoutProfile.mobileMoneyNetworks,
          phone_country_code: checkoutProfile.phoneCountryCode,
        };
        await new PaymentRepo().createPesaPalTransaction(client, {
          escrow_id: undefined,
          type: 'FUNDING',
          amount: plan.amount_ugx,
          merchant_reference: txRef,
          raw_payload: rawPayload,
        });
        return {
          ok: true,
          tx_ref: txRef,
          amount: plan.amount_ugx,
          currency: 'UGX',
          pass_type: passType,
          checkout_payload: buildPrimeRequestCheckoutPayload({
            txRef,
            amount: plan.amount_ugx,
            userId,
            user,
            kind: 'PRIME_REQUEST_ACCESS_PASS',
            country: checkoutProfile.country,
            checkoutProfile,
            passType,
          }),
          pricing: PRIME_REQUEST_PRICING,
        };
      });

      if ('error' in result) {
        const status = result.error === 'insufficient_wallet_balance'
          ? 400
          : result.error === 'yo_uganda_not_configured'
            ? 503
            : 400;
        return reply.code(status).send(result);
      }
      return result;
    } catch (err) {
      app.log.error(err, 'marketplace.primeRequests.pass.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ── GET /marketplace/categories/:categoryId/listing-types ───────────────
  app.get('/marketplace/categories/:categoryId/listing-types', async (request, reply) => {
    const { categoryId } = request.params as { categoryId: string };
    try {
      const rows = await query(
        `SELECT lt.id, lt.name, lt.slug, lt.icon, lt.sort_order,
                sub.id AS subcategory_id, sub.name AS subcategory_name
         FROM advert_listing_types lt
         JOIN advert_subcategories sub ON sub.id = lt.subcategory_id
         JOIN advert_categories ac ON ac.id = sub.category_id
         WHERE ac.id = $1
           AND lt.is_active = TRUE
           AND sub.is_active = TRUE
           AND ac.is_active = TRUE
         ORDER BY sub.sort_order ASC, lt.sort_order ASC, lt.name ASC`,
        [categoryId]
      );
      reply.header('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
      return { listing_types: rows };
    } catch (err) {
      app.log.error(err, 'marketplace.listingTypes.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ── GET /marketplace/listings ────────────────────────────────────────────
  app.get('/marketplace/listings', async (request, reply) => {
    const q = request.query as Record<string, string>;
    const page    = Math.max(1, parseInt(q.page  ?? '1', 10));
    const limit   = Math.min(50, Math.max(1, parseInt(q.limit ?? '20', 10)));
    const search  = (q.search        ?? '').trim();
    const catSlug = (q.category_slug ?? '').trim();
    const offset  = (page - 1) * limit;

    try {
      const conditions: string[] = [
        `al.status = 'ACTIVE'`,
        `al.access_state = 'PUBLIC'`,
        `(c.status = 'ACTIVE' OR c.id IS NULL)`,
        `(al.campaign_end_at IS NULL OR al.campaign_end_at > NOW() OR al.admin_keep_alive = TRUE)`,
      ];
      const filterParams: unknown[] = [];

      if (search) {
        filterParams.push(`%${search}%`);
        const n = filterParams.length;
        conditions.push(`(al.title ILIKE $${n} OR al.summary ILIKE $${n})`);
      }
      if (catSlug) {
        filterParams.push(catSlug);
        conditions.push(`ac.slug = $${filterParams.length}`);
      }

      const whereClause = conditions.map(c => `(${c})`).join(' AND ');
      const dataParams  = [...filterParams, limit, offset];
      const limitN      = dataParams.length - 1;
      const offsetN     = dataParams.length;

      const [dataRows, countRows] = await Promise.all([
        query(
          `SELECT
            al.id,
            al.slug,
            al.title,
            al.summary,
            al.price,
            al.currency,
            al.is_negotiable,
            COALESCE(al.views_total, 0) AS views_total,
            al.campaign_end_at,
            al.created_at,
            al.status,
            ac.name  AS category_name,
            ac.icon  AS category_icon,
            ac.slug  AS category_slug,
            (
              SELECT am.url FROM advert_media am
              WHERE am.listing_id = al.id AND am.media_type = 'IMAGE'
              ORDER BY
                CASE am.media_pack WHEN 'AMBASSADOR_PACK' THEN 0 ELSE 1 END,
                am.sort_order ASC, am.created_at ASC
              LIMIT 1
            ) AS hero_url
          FROM advert_listings al
          LEFT JOIN campaigns c      ON c.id   = al.campaign_id
          LEFT JOIN advert_listing_types  lt  ON lt.id   = al.listing_type_id
          LEFT JOIN advert_subcategories  sub ON sub.id  = lt.subcategory_id
          LEFT JOIN advert_categories     ac  ON ac.id   = sub.category_id
          WHERE ${whereClause}
          ORDER BY al.created_at DESC
          LIMIT $${limitN} OFFSET $${offsetN}`,
          dataParams
        ),
        query(
          `SELECT COUNT(*)::int AS total
          FROM advert_listings al
          LEFT JOIN campaigns c      ON c.id   = al.campaign_id
          LEFT JOIN advert_listing_types  lt  ON lt.id  = al.listing_type_id
          LEFT JOIN advert_subcategories  sub ON sub.id = lt.subcategory_id
          LEFT JOIN advert_categories     ac  ON ac.id  = sub.category_id
          WHERE ${whereClause}`,
          filterParams
        ),
      ]);

      const total = Number((countRows as any[])[0]?.total ?? 0);

      reply.header('Cache-Control', 'public, max-age=20, stale-while-revalidate=40');
      return {
        listings: dataRows,
        total,
        page,
        limit,
        total_pages: Math.ceil(total / limit),
      };
    } catch (err) {
      app.log.error(err, 'marketplace.listings.browse.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ── GET /marketplace/listings/:slug ─────────────────────────────────────
  app.get('/marketplace/listings/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    try {
      const rows = await query<any>(
        `SELECT
          al.*,
          u.full_name AS business_name,
          lt.name  AS listing_type_name,
          sub.name AS subcategory_name,
          cat.name AS category_name,
          cat.id   AS category_id,
          cat.icon AS category_icon,
          sub.id   AS subcategory_id,
          EXTRACT(EPOCH FROM (al.campaign_end_at - now()))::bigint AS time_remaining_secs,
          vp.id           AS vendor_profile_id,
          vp.vendor_name  AS vendor_name,
          vp.slug         AS vendor_slug,
          vp.logo_url     AS vendor_logo_url,
          vp.whatsapp_number AS vendor_whatsapp,
          vp.phone_number    AS vendor_phone,
          vp.business_location AS vendor_location
        FROM advert_listings al
        JOIN  users u                       ON u.id   = al.business_id
        LEFT JOIN advert_listing_types  lt  ON lt.id  = al.listing_type_id
        LEFT JOIN advert_subcategories  sub ON sub.id = lt.subcategory_id
        LEFT JOIN advert_categories     cat ON cat.id = sub.category_id
        LEFT JOIN vendor_profiles       vp  ON vp.id  = al.vendor_id
        WHERE al.slug = $1
          AND al.status = 'ACTIVE'
          AND al.access_state = 'PUBLIC'`,
        [slug]
      );
      if (!rows[0]) return reply.code(404).send({ error: 'listing_not_found' });

      const listing = rows[0];
      const media = await query<any>(
        `SELECT id, media_pack, media_type, url, thumbnail_url, file_name, sort_order
         FROM advert_media WHERE listing_id = $1
         ORDER BY CASE media_pack WHEN 'AMBASSADOR_PACK' THEN 0 ELSE 1 END, sort_order ASC`,
        [listing.id]
      );

      reply.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
      return { listing, media };
    } catch (err) {
      app.log.error(err, 'marketplace.listings.detail.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ── POST /marketplace/listings ───────────────────────────────────────────
  app.post('/marketplace/listings', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const userId = String(
      (request.user as any)?.sub ?? (request.user as any)?.id ?? ''
    ).trim();
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });
    let businessId = userId;

    try {
      // Check user role
      const userRows = await query<any>(
        `SELECT id, role FROM users WHERE id = $1 LIMIT 1`,
        [userId]
      );
      const user = userRows[0];
      if (!user) return reply.code(401).send({ error: 'user_not_found' });
      if (!canAccessBusinessFeatures(user.role)) {
        return reply.code(403).send({ error: 'business_account_required' });
      }
      businessId = String(user.id ?? '').trim() || userId;
    } catch (err) {
      app.log.error(err, 'marketplace.listings.create.roleCheck.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }

    // Only registered vendors may create listings
    let vendorId: string | null = null;
    try {
      const vendorRows = await query<any>(
        `SELECT id FROM vendor_profiles WHERE user_id = $1 AND status = 'ACTIVE' LIMIT 1`,
        [businessId]
      );
      if (!vendorRows[0]) {
        return reply.code(403).send({
          error: 'vendor_registration_required',
          message: 'Register a vendor stall before creating listings.',
        });
      }
      vendorId = vendorRows[0].id as string;
    } catch (err) {
      app.log.error(err, 'marketplace.listings.create.vendorCheck.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }

    const parsed = createListingSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', issues: parsed.error.issues });
    }
    const body = parsed.data;

    try {
      const qualityScore = calcQualityScore({
        title: body.title,
        summary: body.summary,
        description: body.description,
        price: body.price,
        location_text: body.location_text,
        cta_phone: body.cta_phone,
        cta_whatsapp: body.cta_whatsapp,
        cta_email: body.cta_email,
        image_count: body.images.length,
      });

      const listingId = uuid();
      const slug      = generateListingSlug(body.title);
      const draftMode = body.draft_mode === true;
      let createdListing: Record<string, unknown> | null = null;

      await withTransaction(async (client) => {
        await ensureContentBlocksColumn(client);
        const inserted = await client.query(
          `INSERT INTO advert_listings (
            id, campaign_id, business_id, vendor_id, listing_type_id, slug,
            title, summary, description, price, currency,
            is_negotiable, location_text,
            cta_whatsapp, cta_phone, cta_email, cta_url,
            status, access_state, admin_keep_alive, campaign_end_at,
            listing_quality_score, content_blocks, listing_kind
          ) VALUES (
            $1, NULL, $2, $3, $4, $5,
            $6, $7, $8, $9, $10,
            $11, $12,
            $13, $14, $15, $16,
            $17, 'PUBLIC', $18, NULL,
            $19, $20, $21
          )
          RETURNING *`,
          [
            listingId, businessId, vendorId, body.listing_type_id ?? null, slug,
            body.title, body.summary, body.description,
            body.price ?? null, body.currency,
            body.is_negotiable, body.location_text ?? null,
            body.cta_whatsapp ?? null, body.cta_phone ?? null,
            body.cta_email ?? null, body.cta_url ?? null,
            draftMode ? 'DRAFT' : 'ACTIVE',
            draftMode ? false : true,
            qualityScore,
            JSON.stringify(body.content_blocks),
            body.listing_kind ?? 'PRODUCT',
          ]
        );
        createdListing = inserted.rows[0] ?? null;

        if (createdListing) {
          createdListing = {
            ...createdListing,
            is_draft: draftMode,
            preview_token: createdListing.preview_token ?? null,
            content_blocks: body.content_blocks,
          };
        }

        if (body.images.length > 0) {
          const imgParams: any[] = [];
          const imgPlaceholders = body.images.map((img, i) => {
            const b = i * 6;
            imgParams.push(uuid(), listingId, 'PRODUCT_GALLERY', img.media_type, img.url, i);
            return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6})`;
          });
          await client.query(
            `INSERT INTO advert_media (id, listing_id, media_pack, media_type, url, sort_order)
             VALUES ${imgPlaceholders.join(',')}`,
            imgParams
          );
        }
      });

      const listing = createdListing == null
        ? null
        : {
            ...(createdListing as Record<string, unknown>),
            gallery_media: body.images.map((img, index) => ({
              ...img,
              sort_order: index,
            })),
            ambassador_media: [],
            field_values: {},
            field_types: {},
          };

      return reply.code(201).send({
        ok: true,
        id: listingId,
        slug,
        listing_url: '/product/' + slug,
        listing,
      });
    } catch (err) {
      app.log.error(err, 'marketplace.listings.create.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ── GET /marketplace/listings/mine ──────────────────────────────────────
  app.get('/marketplace/listings/mine', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const userId = (request.user as any)?.sub ?? (request.user as any)?.id;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

    try {
      const rows = await query(
        `SELECT
          al.id,
          al.slug,
          al.title,
          al.summary,
          al.price,
          al.currency,
          al.is_negotiable,
          al.status,
          al.access_state,
          al.admin_keep_alive,
          al.campaign_end_at,
          al.created_at,
          al.updated_at,
          COALESCE(al.views_total, 0) AS views_total,
          al.listing_quality_score,
          al.location_text,
          ac.name AS category_name,
          ac.icon AS category_icon,
          (
            SELECT am.url FROM advert_media am
            WHERE am.listing_id = al.id AND am.media_type = 'IMAGE'
            ORDER BY am.sort_order ASC, am.created_at ASC
            LIMIT 1
          ) AS hero_url
        FROM advert_listings al
        LEFT JOIN advert_listing_types  lt  ON lt.id   = al.listing_type_id
        LEFT JOIN advert_subcategories  sub ON sub.id  = lt.subcategory_id
        LEFT JOIN advert_categories     ac  ON ac.id   = sub.category_id
        WHERE al.business_id = $1
        ORDER BY al.created_at DESC`,
        [userId]
      );

      return { listings: rows };
    } catch (err) {
      app.log.error(err, 'marketplace.listings.mine.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ── PATCH /marketplace/listings/:slug ───────────────────────────────────
  app.patch('/marketplace/listings/:slug', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const userId = (request.user as any)?.sub ?? (request.user as any)?.id;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

    const { slug } = request.params as { slug: string };

    const parsed = patchListingSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'validation_error', issues: parsed.error.issues });
    }
    const body = parsed.data;

    try {
      const existingRows = await query<any>(
        `SELECT id, business_id FROM advert_listings WHERE slug = $1 LIMIT 1`,
        [slug]
      );
      const listing = existingRows[0];
      if (!listing) return reply.code(404).send({ error: 'listing_not_found' });
      if (listing.business_id !== userId) return reply.code(403).send({ error: 'forbidden' });

      const sets: string[] = [];
      const vals: unknown[] = [];

      function addField(col: string, val: unknown) {
        vals.push(val);
        sets.push(`${col} = $${vals.length}`);
      }

      if (body.title !== undefined)         addField('title', body.title);
      if (body.summary !== undefined)       addField('summary', body.summary);
      if (body.description !== undefined)   addField('description', body.description);
      if (body.price !== undefined)         addField('price', body.price ?? null);
      if (body.currency !== undefined)      addField('currency', body.currency);
      if (body.is_negotiable !== undefined) addField('is_negotiable', body.is_negotiable);
      if (body.location_text !== undefined) addField('location_text', body.location_text ?? null);
      if (body.cta_whatsapp !== undefined)  addField('cta_whatsapp', body.cta_whatsapp ?? null);
      if (body.cta_phone !== undefined)     addField('cta_phone', body.cta_phone ?? null);
      if (body.cta_email !== undefined)     addField('cta_email', body.cta_email ?? null);
      if (body.cta_url !== undefined)       addField('cta_url', body.cta_url ?? null);
      if (body.content_blocks !== undefined) addField('content_blocks', JSON.stringify(body.content_blocks));

      sets.push(`updated_at = NOW()`);

      if (sets.length > 1) {
        vals.push(listing.id);
        await query(
          `UPDATE advert_listings SET ${sets.join(', ')} WHERE id = $${vals.length}`,
          vals as any[]
        );
      }

      if (body.images !== undefined) {
        await withTransaction(async (client) => {
          await client.query(
            `DELETE FROM advert_media WHERE listing_id = $1 AND media_pack = 'PRODUCT_GALLERY'`,
            [listing.id]
          );
          if (body.images!.length > 0) {
            const imgParams: any[] = [];
            const imgPlaceholders = body.images!.map((img, i) => {
              const b = i * 6;
              imgParams.push(uuid(), listing.id, 'PRODUCT_GALLERY', img.media_type, img.url, i);
              return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6})`;
            });
            await client.query(
              `INSERT INTO advert_media (id, listing_id, media_pack, media_type, url, sort_order)
               VALUES ${imgPlaceholders.join(',')}`,
              imgParams
            );
          }
        });
      }

      return { ok: true };
    } catch (err) {
      app.log.error(err, 'marketplace.listings.patch.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ── DELETE /marketplace/listings/:slug ──────────────────────────────────
  app.delete('/marketplace/listings/:slug', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const userId = (request.user as any)?.sub ?? (request.user as any)?.id;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

    const { slug } = request.params as { slug: string };

    try {
      const existingRows = await query<any>(
        `SELECT id, business_id FROM advert_listings WHERE slug = $1 LIMIT 1`,
        [slug]
      );
      const listing = existingRows[0];
      if (!listing) return reply.code(404).send({ error: 'listing_not_found' });
      if (listing.business_id !== userId) return reply.code(403).send({ error: 'forbidden' });

      await withTransaction(async (client) => {
        await client.query(`DELETE FROM advert_media WHERE listing_id = $1`, [listing.id]);
        await client.query(`DELETE FROM advert_listings WHERE id = $1`, [listing.id]);
      });

      return { ok: true };
    } catch (err) {
      app.log.error(err, 'marketplace.listings.delete.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // VENDOR STOREFRONT & DISCOVERY (public, no auth required)
  // ═══════════════════════════════════════════════════════════════════════════

  // ── GET /marketplace/vendors ─────────────────────────────────────────────
  // Browse/search vendors with optional filters
  app.get('/marketplace/vendors', async (request, reply) => {
    const q      = request.query as Record<string, string>;
    const page   = Math.max(1, parseInt(q.page   ?? '1',  10));
    const limit  = Math.min(50, Math.max(1, parseInt(q.limit ?? '20', 10)));
    const search = (q.search   ?? '').trim();
    const cat    = (q.category ?? '').trim();
    const offset = (page - 1) * limit;

    try {
      const conditions = [`vp.status = 'ACTIVE'`];
      const params: unknown[] = [];

      if (search) {
        params.push(`%${search}%`);
        const n = params.length;
        conditions.push(`(vp.vendor_name ILIKE $${n} OR vp.description ILIKE $${n} OR vp.business_location ILIKE $${n})`);
      }
      if (cat) {
        params.push(cat);
        conditions.push(`vp.business_category ILIKE $${params.length}`);
      }

      const where = conditions.join(' AND ');
      const [rows, countRows] = await Promise.all([
        query<any>(`
          SELECT
            vp.id, vp.slug, vp.vendor_name, vp.logo_url, vp.banner_url,
            vp.description, vp.business_location, vp.business_category,
            vp.verification_status, vp.trust_badges, vp.is_featured,
            vp.total_views, vp.follower_count, vp.created_at,
            (SELECT COUNT(*)::int FROM advert_listings al
             WHERE al.vendor_id = vp.id AND al.status = 'ACTIVE') AS listing_count,
            (SELECT COUNT(*)::int FROM vendor_boosts vb
             WHERE vb.vendor_id = vp.id AND vb.status = 'ACTIVE' AND vb.ends_at > NOW()) AS active_boost_count
          FROM vendor_profiles vp
          WHERE ${where}
          ORDER BY vp.is_featured DESC, vp.total_views DESC, vp.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        query<any>(`SELECT COUNT(*)::int AS total FROM vendor_profiles vp WHERE ${where}`, params),
      ]);

      reply.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
      return {
        vendors:     rows,
        total:       Number(countRows[0]?.total ?? 0),
        page,
        limit,
        total_pages: Math.ceil(Number(countRows[0]?.total ?? 0) / limit),
      };
    } catch (err) {
      app.log.error(err, 'marketplace.vendors.list.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ── GET /marketplace/vendors/:slug ───────────────────────────────────────
  // Full vendor storefront page data
  app.get('/marketplace/vendors/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };

    try {
      const vendorRows = await query<any>(
        `SELECT vp.*,
           u.full_name AS owner_name,
           (SELECT COUNT(*)::int FROM advert_listings al WHERE al.vendor_id = vp.id AND al.status = 'ACTIVE') AS listing_count,
           (SELECT COUNT(*)::int FROM vendor_boosts vb
            WHERE vb.vendor_id = vp.id AND vb.status = 'ACTIVE' AND vb.ends_at > NOW()) AS active_boost_count
         FROM vendor_profiles vp
         JOIN users u ON u.id = vp.user_id
         WHERE vp.slug = $1 AND vp.status = 'ACTIVE'
         LIMIT 1`,
        [slug]
      );
      const vendor = vendorRows[0];
      if (!vendor) return reply.code(404).send({ error: 'vendor_not_found' });

      const [listings, featured] = await Promise.all([
        query<any>(`
          SELECT
            al.id, al.slug, al.title, al.summary, al.price, al.currency,
            al.is_negotiable, al.listing_kind, al.stock_status, al.condition,
            al.tags, al.views_total, al.qr_scan_count, al.created_at,
            (SELECT am.url FROM advert_media am
             WHERE am.listing_id = al.id AND am.media_type = 'IMAGE'
             ORDER BY am.sort_order LIMIT 1) AS hero_url
          FROM advert_listings al
          WHERE al.vendor_id = $1 AND al.status = 'ACTIVE' AND al.access_state = 'PUBLIC'
          ORDER BY al.created_at DESC
          LIMIT 50`, [vendor.id]),

        query<any>(`
          SELECT
            al.id, al.slug, al.title, al.price, al.currency, al.listing_kind,
            (SELECT am.url FROM advert_media am
             WHERE am.listing_id = al.id AND am.media_type = 'IMAGE'
             ORDER BY am.sort_order LIMIT 1) AS hero_url
          FROM vendor_boosts vb
          JOIN advert_listings al ON al.id = vb.listing_id
          WHERE vb.vendor_id = $1 AND vb.status = 'ACTIVE' AND vb.ends_at > NOW()
            AND al.status = 'ACTIVE'
          ORDER BY vb.created_at DESC
          LIMIT 6`, [vendor.id]),
      ]);

      // Fire an async storefront view event (best-effort)
      query(
        `INSERT INTO vendor_analytics_events (id, vendor_id, event_type, source, ip_address, user_agent)
         VALUES (gen_random_uuid(), $1, 'STOREFRONT_VIEW', 'MARKETPLACE', $2, $3)`,
        [vendor.id, request.ip, request.headers['user-agent'] ?? null]
      ).then(() =>
        query(`UPDATE vendor_profiles SET total_views = total_views + 1 WHERE id = $1`, [vendor.id])
      ).catch(() => {});

      reply.header('Cache-Control', 'public, max-age=20, stale-while-revalidate=40');
      return { vendor, listings, featured_listings: featured };
    } catch (err) {
      app.log.error(err, 'marketplace.vendors.storefront.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ── GET /marketplace/vendors/:slug/listings ──────────────────────────────
  app.get('/marketplace/vendors/:slug/listings', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const q      = request.query as Record<string, string>;
    const page   = Math.max(1, parseInt(q.page ?? '1', 10));
    const limit  = Math.min(50, parseInt(q.limit ?? '20', 10));
    const kind   = (q.kind ?? '').trim() || null;
    const offset = (page - 1) * limit;

    try {
      const vendorRows = await query<any>(
        `SELECT id FROM vendor_profiles WHERE slug = $1 AND status = 'ACTIVE' LIMIT 1`, [slug]
      );
      if (!vendorRows[0]) return reply.code(404).send({ error: 'vendor_not_found' });
      const vendorId = vendorRows[0].id;

      const conditions = [`al.vendor_id = $1`, `al.status = 'ACTIVE'`, `al.access_state = 'PUBLIC'`];
      const params: unknown[] = [vendorId];
      if (kind) { params.push(kind); conditions.push(`al.listing_kind = $${params.length}`); }

      const where = conditions.join(' AND ');
      const [rows, countRows] = await Promise.all([
        query<any>(`
          SELECT al.id, al.slug, al.title, al.summary, al.price, al.currency,
            al.is_negotiable, al.listing_kind, al.stock_status, al.condition, al.tags,
            al.views_total, al.created_at,
            (SELECT am.url FROM advert_media am
             WHERE am.listing_id = al.id AND am.media_type = 'IMAGE'
             ORDER BY am.sort_order LIMIT 1) AS hero_url
          FROM advert_listings al
          WHERE ${where}
          ORDER BY al.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, limit, offset]
        ),
        query<any>(`SELECT COUNT(*)::int AS total FROM advert_listings al WHERE ${where}`, params),
      ]);

      reply.header('Cache-Control', 'public, max-age=20, stale-while-revalidate=40');
      return {
        listings:    rows,
        total:       Number(countRows[0]?.total ?? 0),
        page,
        limit,
        total_pages: Math.ceil(Number(countRows[0]?.total ?? 0) / limit),
      };
    } catch (err) {
      app.log.error(err, 'marketplace.vendors.listings.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ── POST /marketplace/inquiries ──────────────────────────────────────────
  // Submit a buyer inquiry (public — no auth required)
  app.post('/marketplace/inquiries', async (request, reply) => {
    const body = request.body as any;
    const {
      vendor_id, listing_id,
      buyer_name, buyer_phone, buyer_whatsapp, buyer_email,
      message, source,
    } = body ?? {};

    const safeBuyerName = String(buyer_name ?? '').trim();
    const safeBuyerPhone = String(buyer_phone ?? buyer_whatsapp ?? '').trim();
    const safeBuyerEmail = String(buyer_email ?? '').trim();
    if (!vendor_id || !safeBuyerName || !message?.trim() || (!safeBuyerPhone && !safeBuyerEmail)) {
      return reply.code(400).send({ error: 'buyer_name_contact_vendor_id_and_message_required' });
    }
    if (String(message).trim().length < 5) {
      return reply.code(400).send({ error: 'message_too_short' });
    }
    if (safeBuyerPhone && !/^\+?[0-9\s().-]{7,30}$/.test(safeBuyerPhone)) {
      return reply.code(400).send({ error: 'invalid_buyer_phone' });
    }
    if (safeBuyerEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(safeBuyerEmail)) {
      return reply.code(400).send({ error: 'invalid_buyer_email' });
    }

    try {
      const vendorRows = await query<any>(
        `SELECT id FROM vendor_profiles WHERE id = $1 AND status = 'ACTIVE' LIMIT 1`, [vendor_id]
      );
      if (!vendorRows[0]) return reply.code(404).send({ error: 'vendor_not_found' });
      if (listing_id) {
        const listingRows = await query<any>(
          `SELECT id FROM advert_listings
           WHERE id = $1 AND vendor_id = $2 AND status = 'ACTIVE' AND access_state = 'PUBLIC'
           LIMIT 1`,
          [listing_id, vendor_id]
        );
        if (!listingRows[0]) return reply.code(400).send({ error: 'listing_vendor_mismatch' });
      }

      const validSources = ['MARKETPLACE', 'STOREFRONT', 'QR', 'LINK', 'DIRECT'];
      const safeSource = validSources.includes(source) ? source : 'MARKETPLACE';

      const inquiryId = uuid();
      await query(
        `INSERT INTO vendor_inquiries
           (id, vendor_id, listing_id, buyer_name, buyer_phone, buyer_whatsapp, buyer_email,
            message, source, ip_address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          inquiryId, vendor_id, listing_id ?? null,
          safeBuyerName, safeBuyerPhone || null, (buyer_whatsapp ?? safeBuyerPhone) || null, safeBuyerEmail || null,
          String(message).trim(), safeSource, request.ip,
        ]
      );

      // Fire analytics event
      query(
        `INSERT INTO vendor_analytics_events (id, vendor_id, listing_id, event_type, source, ip_address)
         VALUES (gen_random_uuid(), $1, $2, 'INQUIRY_SENT', $3, $4)`,
        [vendor_id, listing_id ?? null, safeSource, request.ip]
      ).catch(() => {});

      return reply.code(201).send({ ok: true, inquiry_id: inquiryId });
    } catch (err) {
      app.log.error(err, 'marketplace.inquiries.create.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ── POST /marketplace/negotiations ──────────────────────────────────────
  // Start a negotiation thread on a negotiable listing
  app.post('/marketplace/negotiations', async (request, reply) => {
    const body = request.body as any;
    const { listing_id, buyer_name, buyer_phone, offer_amount, message } = body ?? {};

    if (!listing_id || !offer_amount || !buyer_name) {
      return reply.code(400).send({ error: 'listing_id, offer_amount, and buyer_name are required' });
    }

    try {
      const listingRows = await query<any>(
        `SELECT al.id, al.vendor_id, al.price, al.currency, al.is_negotiable
         FROM advert_listings al
         WHERE al.id = $1 AND al.status = 'ACTIVE' AND al.access_state = 'PUBLIC' LIMIT 1`,
        [listing_id]
      );
      const listing = listingRows[0];
      if (!listing) return reply.code(404).send({ error: 'listing_not_found' });
      if (!listing.is_negotiable) return reply.code(409).send({ error: 'listing_not_negotiable' });
      if (!listing.vendor_id) return reply.code(409).send({ error: 'listing_has_no_vendor' });

      const threadId = uuid();
      const buyerToken = `${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

      await withTransaction(async (client) => {
        await client.query(
          `INSERT INTO negotiation_threads
             (id, listing_id, vendor_id, buyer_name, buyer_phone, buyer_token,
              listing_price, currency, last_message_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())`,
          [threadId, listing_id, listing.vendor_id, buyer_name, buyer_phone ?? null,
           buyerToken, listing.price ?? null, listing.currency ?? 'UGX']
        );

        const initMessage = message?.trim() || `Opening offer: ${listing.currency ?? 'UGX'} ${Number(offer_amount).toLocaleString()}`;
        await client.query(
          `INSERT INTO negotiation_messages
             (id, thread_id, party, message_type, content, offer_amount, currency)
           VALUES ($1, $2, 'BUYER', 'OFFER', $3, $4, $5)`,
          [uuid(), threadId, initMessage, Number(offer_amount), listing.currency ?? 'UGX']
        );

        await client.query(
          `UPDATE negotiation_threads SET message_count = 1 WHERE id = $1`, [threadId]
        );
      });

      // Fire analytics event
      query(
        `INSERT INTO vendor_analytics_events (id, vendor_id, listing_id, event_type, ip_address)
         VALUES (gen_random_uuid(), $1, $2, 'NEGOTIATION_STARTED', $3)`,
        [listing.vendor_id, listing_id, request.ip]
      ).catch(() => {});

      return reply.code(201).send({ ok: true, thread_id: threadId, buyer_token: buyerToken });
    } catch (err) {
      app.log.error(err, 'marketplace.negotiations.create.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ── GET /marketplace/homepage ────────────────────────────────────────────
  // All data needed for the redesigned marketplace homepage
  app.get('/marketplace/homepage', async (request, reply) => {
    try {
      const [
        featuredVendors,
        trendingListings,
        boostedListings,
        recentListings,
        negotiableDeals,
        categories,
      ] = await Promise.all([

        // Featured / boosted vendors
        query<any>(`
          SELECT vp.id, vp.slug, vp.vendor_name, vp.logo_url, vp.banner_url,
            vp.description, vp.business_location, vp.business_category,
            vp.verification_status, vp.trust_badges, vp.total_views,
            (SELECT COUNT(*)::int FROM advert_listings al
             WHERE al.vendor_id = vp.id AND al.status = 'ACTIVE') AS listing_count
          FROM vendor_profiles vp
          WHERE vp.status = 'ACTIVE'
          ORDER BY vp.is_featured DESC, vp.total_views DESC
          LIMIT 8`),

        // Trending listings (most viewed this week)
        query<any>(`
          SELECT al.id, al.slug, al.title, al.summary, al.price, al.currency,
            al.is_negotiable, al.listing_kind, al.views_total, al.created_at,
            vp.vendor_name, vp.slug AS vendor_slug, vp.verification_status,
            (SELECT am.url FROM advert_media am
             WHERE am.listing_id = al.id AND am.media_type = 'IMAGE'
             ORDER BY am.sort_order LIMIT 1) AS hero_url
          FROM advert_listings al
          LEFT JOIN vendor_profiles vp ON vp.id = al.vendor_id
          WHERE al.status = 'ACTIVE' AND al.access_state = 'PUBLIC'
          ORDER BY al.views_total DESC, al.created_at DESC
          LIMIT 12`),

        // Boosted listings (active boost, highest spend first)
        query<any>(`
          SELECT DISTINCT ON (al.id)
            al.id, al.slug, al.title, al.summary, al.price, al.currency,
            al.is_negotiable, al.listing_kind,
            vp.vendor_name, vp.slug AS vendor_slug, vp.verification_status,
            (SELECT am.url FROM advert_media am
             WHERE am.listing_id = al.id AND am.media_type = 'IMAGE'
             ORDER BY am.sort_order LIMIT 1) AS hero_url
          FROM vendor_boosts vb
          JOIN advert_listings al ON al.id = vb.listing_id
          LEFT JOIN vendor_profiles vp ON vp.id = al.vendor_id
          WHERE vb.status = 'ACTIVE' AND vb.ends_at > NOW()
            AND al.status = 'ACTIVE' AND al.access_state = 'PUBLIC'
            AND vb.boost_type = 'LISTING'
          ORDER BY al.id, vb.cost_ugx DESC
          LIMIT 8`),

        // Recently added
        query<any>(`
          SELECT al.id, al.slug, al.title, al.summary, al.price, al.currency,
            al.is_negotiable, al.listing_kind, al.created_at,
            vp.vendor_name, vp.slug AS vendor_slug,
            (SELECT am.url FROM advert_media am
             WHERE am.listing_id = al.id AND am.media_type = 'IMAGE'
             ORDER BY am.sort_order LIMIT 1) AS hero_url
          FROM advert_listings al
          LEFT JOIN vendor_profiles vp ON vp.id = al.vendor_id
          WHERE al.status = 'ACTIVE' AND al.access_state = 'PUBLIC'
          ORDER BY al.created_at DESC
          LIMIT 12`),

        // Negotiation-friendly deals
        query<any>(`
          SELECT al.id, al.slug, al.title, al.price, al.currency, al.listing_kind,
            vp.vendor_name, vp.slug AS vendor_slug,
            (SELECT am.url FROM advert_media am
             WHERE am.listing_id = al.id AND am.media_type = 'IMAGE'
             ORDER BY am.sort_order LIMIT 1) AS hero_url
          FROM advert_listings al
          LEFT JOIN vendor_profiles vp ON vp.id = al.vendor_id
          WHERE al.status = 'ACTIVE' AND al.access_state = 'PUBLIC'
            AND al.is_negotiable = TRUE
          ORDER BY al.created_at DESC
          LIMIT 8`),

        // Active categories with listing counts
        query<any>(`
          SELECT ac.id, ac.slug, ac.name, ac.icon,
            (SELECT COUNT(*)::int FROM advert_listings al
             LEFT JOIN advert_listing_types lt ON lt.id = al.listing_type_id
             LEFT JOIN advert_subcategories sub ON sub.id = lt.subcategory_id
             WHERE sub.category_id = ac.id AND al.status = 'ACTIVE') AS listing_count
          FROM advert_categories ac
          WHERE ac.is_active = TRUE
          ORDER BY ac.sort_order ASC, listing_count DESC`),
      ]);

      reply.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
      return {
        featured_vendors:  featuredVendors,
        trending_listings: trendingListings,
        boosted_listings:  boostedListings,
        recent_listings:   recentListings,
        negotiable_deals:  negotiableDeals,
        categories,
      };
    } catch (err) {
      app.log.error(err, 'marketplace.homepage.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });
}
