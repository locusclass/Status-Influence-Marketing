// routes/marketplace.ts
// Public marketplace — direct (campaign-free) listings + browsing

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction, query } from '../db.js';
import { canAccessBusinessFeatures } from '../services/roles.js';
import { v4 as uuid } from 'uuid';

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
});

const patchListingSchema = createListingSchema.partial().omit({ listing_type_id: true });

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

  // ── POST /marketplace/listings ───────────────────────────────────────────
  app.post('/marketplace/listings', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const userId = (request.user as any)?.sub ?? (request.user as any)?.id;
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

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
    } catch (err) {
      app.log.error(err, 'marketplace.listings.create.roleCheck.error');
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

      await withTransaction(async (client) => {
        await ensureContentBlocksColumn(client);
        await client.query(
          `INSERT INTO advert_listings (
            id, campaign_id, business_id, listing_type_id, slug,
            title, summary, description, price, currency,
            is_negotiable, location_text,
            cta_whatsapp, cta_phone, cta_email, cta_url,
            status, access_state, admin_keep_alive, campaign_end_at,
            listing_quality_score, content_blocks
          ) VALUES (
            $1, NULL, $2, $3, $4,
            $5, $6, $7, $8, $9,
            $10, $11,
            $12, $13, $14, $15,
            'ACTIVE', 'PUBLIC', TRUE, NULL,
            $16, $17
          )`,
          [
            listingId, userId, body.listing_type_id ?? null, slug,
            body.title, body.summary, body.description,
            body.price ?? null, body.currency,
            body.is_negotiable, body.location_text ?? null,
            body.cta_whatsapp ?? null, body.cta_phone ?? null,
            body.cta_email ?? null, body.cta_url ?? null,
            qualityScore,
            JSON.stringify(body.content_blocks),
          ]
        );

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

      return reply.code(201).send({
        ok: true,
        slug,
        listing_url: '/product/' + slug,
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
}
