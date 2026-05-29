// routes/advert.ts
// Smart Advert Listing System — extends campaign creation

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction, query } from '../db.js';
import { canAccessBusinessFeatures } from '../services/roles.js';
import { v4 as uuid } from 'uuid';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import {
  hasYoClientCredentials,
  hasYoEncryptionKey,
} from '../config.js';
import { resolveAvailableYoUgandaCheckoutProfile } from '../services/yoUgandaCheckoutProfile.js';
import {
  buildListingBoostOptions,
  resolveListingBoostPlan,
  activateListingBoost,
  ensureListingBoostSchema,
} from '../services/listingBoosts.js';

const DEFAULT_LISTING_KEEP_HOURS = 12;
const LISTING_LIFETIME_BUFFER_HOURS = 1;
const MILLIS_PER_HOUR = 60 * 60 * 1000;

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

function generateAmbassadorCode(): string {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

async function ensureAdvertSchema(client: any) {
  // Create tables if they don't exist (idempotent startup warmup)
  // This complements the migration file
  await client.query(`
    CREATE TABLE IF NOT EXISTS advert_categories (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      icon TEXT,
      sort_order INTEGER NOT NULL DEFAULT 0,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function ensureActiveListingType(client: any, listingTypeId: string) {
  const typeRow = await client.query(
    `
      SELECT lt.id
      FROM advert_listing_types lt
      JOIN advert_subcategories s ON s.id = lt.subcategory_id
      WHERE lt.id = $1
        AND lt.is_active = TRUE
        AND s.is_active = TRUE
      LIMIT 1
    `,
    [listingTypeId]
  );
  if (!typeRow.rows[0]) {
    throw Object.assign(new Error('invalid_listing_type'), { statusCode: 400 });
  }
}

// ─────────────────────────────────────────────
// QUALITY SCORE CALCULATOR
// ─────────────────────────────────────────────

function calculateListingQuality(data: {
  title: string;
  summary: string;
  description: string;
  price?: number | null;
  location_text?: string | null;
  cta_phone?: string | null;
  cta_whatsapp?: string | null;
  cta_email?: string | null;
  ambassador_media_count: number;
  gallery_media_count: number;
  field_values: Record<string, string>;
}): number {
  let score = 0;
  if (data.title.trim().length >= 10) score += 15;
  if (data.summary.trim().length >= 30) score += 15;
  if (data.description.trim().length >= 100) score += 20;
  if (data.price && data.price > 0) score += 10;
  if (data.location_text && data.location_text.trim()) score += 10;
  if (data.cta_phone || data.cta_whatsapp || data.cta_email) score += 10;
  if (data.ambassador_media_count > 0) score += 10;
  if (data.gallery_media_count >= 2) score += 10;
  const filledFields = Object.values(data.field_values).filter((v) => v && v.trim()).length;
  if (filledFields >= 3) score += 10;
  return Math.min(score, 100);
}

// ─────────────────────────────────────────────
// ROUTE REGISTRATION
// ─────────────────────────────────────────────

export async function advertRoutes(app: FastifyInstance) {

  // ─── TAXONOMY ───────────────────────────────

  // GET /api/advert/categories
  app.get('/advert/categories', async (_request, reply) => {
    try {
      const categories = await query(`
        SELECT id, slug, name, icon, sort_order
        FROM advert_categories
        WHERE is_active = TRUE
        ORDER BY sort_order ASC, name ASC
      `);
      return reply.send({ categories });
    } catch (err) {
      app.log.error(err, 'advert.categories.list.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // GET /api/advert/categories/:categoryId/subcategories
  app.get('/advert/categories/:categoryId/subcategories', async (request, reply) => {
    const { categoryId } = request.params as { categoryId: string };
    try {
      const subcategories = await query(`
        SELECT s.id, s.slug, s.name, s.sort_order, c.name AS category_name
        FROM advert_subcategories s
        JOIN advert_categories c ON c.id = s.category_id
        WHERE s.category_id = $1 AND s.is_active = TRUE
        ORDER BY s.sort_order ASC, s.name ASC
      `, [categoryId]);
      return reply.send({ subcategories });
    } catch (err) {
      app.log.error(err, 'advert.subcategories.list.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // GET /api/advert/categories/:categoryId/listing-types — flat (all subcats merged)
  app.get('/advert/categories/:categoryId/listing-types', async (request, reply) => {
    const { categoryId } = request.params as { categoryId: string };
    try {
      const listing_types = await query(`
        SELECT lt.id, lt.slug, lt.name, lt.sort_order,
               s.id AS subcategory_id, s.name AS subcategory_name
        FROM advert_listing_types lt
        JOIN advert_subcategories s ON s.id = lt.subcategory_id
        WHERE s.category_id = $1 AND lt.is_active = TRUE AND s.is_active = TRUE
        ORDER BY s.sort_order ASC, lt.sort_order ASC, lt.name ASC
      `, [categoryId]);
      return reply.send({ listing_types });
    } catch (err) {
      app.log.error(err, 'advert.listing_types.flat.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // GET /api/advert/subcategories/:subcategoryId/listing-types
  app.get('/advert/subcategories/:subcategoryId/listing-types', async (request, reply) => {
    const { subcategoryId } = request.params as { subcategoryId: string };
    try {
      const listing_types = await query(`
        SELECT lt.id, lt.slug, lt.name, lt.sort_order, s.name AS subcategory_name
        FROM advert_listing_types lt
        JOIN advert_subcategories s ON s.id = lt.subcategory_id
        WHERE lt.subcategory_id = $1 AND lt.is_active = TRUE
        ORDER BY lt.sort_order ASC, lt.name ASC
      `, [subcategoryId]);
      return reply.send({ listing_types });
    } catch (err) {
      app.log.error(err, 'advert.listing_types.list.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // GET /api/advert/listing-types/:listingTypeId/fields
  app.get('/advert/listing-types/:listingTypeId/fields', async (request, reply) => {
    const { listingTypeId } = request.params as { listingTypeId: string };
    try {
      const fieldRows = await query<any>(`
        SELECT
          fd.id, fd.field_key, fd.label, fd.field_type,
          fd.is_required, fd.sort_order, fd.placeholder,
          fd.helper_text, fd.section_group,
          fd.min_length, fd.max_length, fd.min_value, fd.max_value
        FROM advert_field_definitions fd
        WHERE fd.listing_type_id = $1
        ORDER BY fd.sort_order ASC
      `, [listingTypeId]);

      const optionsByField: Record<string, any[]> = {};
      if (fieldRows.length > 0) {
        const fieldIds = fieldRows.map((f: any) => f.id);
        const optionRows = await query<any>(`
          SELECT field_def_id, option_value, option_label, sort_order
          FROM advert_field_options
          WHERE field_def_id = ANY($1)
          ORDER BY sort_order ASC
        `, [fieldIds]);
        for (const opt of optionRows) {
          const fid = opt.field_def_id as string;
          if (!optionsByField[fid]) optionsByField[fid] = [];
          optionsByField[fid]!.push({ value: opt.option_value, label: opt.option_label });
        }
      }

      const fields = fieldRows.map((f: any) => ({ ...f, options: optionsByField[f.id] ?? [] }));
      return reply.send({ fields });
    } catch (err) {
      app.log.error(err, 'advert.fields.list.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ─── LISTINGS ────────────────────────────────

  // POST /api/advert/listings — Create listing (authenticated, BUSINESS only)
  app.post('/advert/listings', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const userId = String((request.user as any)?.sub ?? '').trim();

    const bodySchema = z.object({
      campaign_id: z.string().uuid(),
      listing_type_id: z.string().uuid(),
      title: z.string().min(5).max(150),
      summary: z.string().min(20).max(300),
      description: z.string().min(50).max(5000),
      price: z.number().positive().optional().nullable(),
      currency: z.string().default('UGX'),
      is_negotiable: z.boolean().default(false),
      location_text: z.string().max(200).optional().nullable(),
      latitude: z.number().optional().nullable(),
      longitude: z.number().optional().nullable(),
      cta_whatsapp: z.string().optional().nullable(),
      cta_phone: z.string().optional().nullable(),
      cta_email: z.string().email().optional().nullable(),
      cta_url: z.string().url().optional().nullable(),
      expires_at: z.string().optional().nullable(),
      field_values: z.record(z.string()).default({}),
      ambassador_media: z.array(z.object({
        url: z.string().url(),
        media_type: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']),
        thumbnail_url: z.string().optional(),
        file_name: z.string().optional(),
        mime_type: z.string().optional(),
        file_size_bytes: z.number().optional(),
        duration_secs: z.number().optional(),
      })).max(5).default([]),
      gallery_media: z.array(z.object({
        url: z.string().url(),
        media_type: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']),
        thumbnail_url: z.string().optional(),
        file_name: z.string().optional(),
        mime_type: z.string().optional(),
        file_size_bytes: z.number().optional(),
        duration_secs: z.number().optional(),
        sort_order: z.number().optional(),
      })).default([]),
    });

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch (err: any) {
      return reply.code(400).send({ error: 'validation_error', details: err.errors ?? err.message });
    }

    try {
      const listing = await withTransaction(async (client) => {
        // Verify user is a business
        const userRow = await client.query(
          `SELECT id, role, active_role FROM users WHERE id = $1`,
          [userId]
        );
        if (!userRow.rows[0]) {
          throw Object.assign(new Error('user_not_found'), { statusCode: 404 });
        }
        if (!canAccessBusinessFeatures(userRow.rows[0]?.role)) {
          throw Object.assign(new Error('business_role_required'), { statusCode: 403 });
        }

        // Verify campaign belongs to user and extract its duration window
        const campRow = await client.query(
          `SELECT id, business_id, start_date, end_date, terms_keep_hours, status
           FROM campaigns WHERE id = $1`,
          [body.campaign_id]
        );
        if (!campRow.rows[0]) {
          throw Object.assign(new Error('campaign_not_found'), { statusCode: 404 });
        }
        if (campRow.rows[0].business_id !== userId) {
          throw Object.assign(new Error('forbidden'), { statusCode: 403 });
        }

        await ensureActiveListingType(client, body.listing_type_id);

        // Derive the listing's live window from the campaign's duration
        const camp = campRow.rows[0];
        const keepHours: number = Number(camp.terms_keep_hours ?? DEFAULT_LISTING_KEEP_HOURS);
        // campaign_start_at: use start_date if set, else now
        const campaignStartAt: Date = camp.start_date
          ? new Date(camp.start_date)
          : new Date();
        const baseCampaignEndAt: Date = camp.end_date
          ? new Date(camp.end_date)
          : new Date(campaignStartAt.getTime() + keepHours * MILLIS_PER_HOUR);
        const campaignEndAt = new Date(
          baseCampaignEndAt.getTime() +
              LISTING_LIFETIME_BUFFER_HOURS * MILLIS_PER_HOUR
        );

        // Check no existing listing for this campaign
        const existingListing = await client.query(
          `SELECT id FROM advert_listings WHERE campaign_id = $1`,
          [body.campaign_id]
        );
        if (existingListing.rows.length > 0) {
          // Return existing listing id so client can update instead
          return { id: existingListing.rows[0].id, updated: false, existing: true };
        }

        // Generate unique slug
        let slug = generateListingSlug(body.title);
        const slugCheck = await client.query(
          `SELECT id FROM advert_listings WHERE slug = $1`, [slug]
        );
        if (slugCheck.rows.length > 0) {
          slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
        }

        // Calculate quality score
        const qualityScore = calculateListingQuality({
          title: body.title,
          summary: body.summary,
          description: body.description,
          price: body.price,
          location_text: body.location_text,
          cta_phone: body.cta_phone,
          cta_whatsapp: body.cta_whatsapp,
          cta_email: body.cta_email,
          ambassador_media_count: body.ambassador_media.length,
          gallery_media_count: body.gallery_media.length,
          field_values: body.field_values,
        });

        // Keep the public listing live for the full campaign plus a one-hour
        // buffer, matching the beneficiary posting window.
        const listingRow = await client.query(`
          INSERT INTO advert_listings (
            id, campaign_id, business_id, listing_type_id, slug,
            title, summary, description, price, currency,
            is_negotiable, location_text, latitude, longitude,
            cta_whatsapp, cta_phone, cta_email, cta_url,
            status, expires_at, campaign_start_at, campaign_end_at,
            listing_quality_score
          ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
            $11, $12, $13, $14, $15, $16, $17, $18,
            'ACTIVE', $19, $20, $21, $22
          ) RETURNING *
        `, [
          uuid(), body.campaign_id, userId, body.listing_type_id, slug,
          body.title, body.summary, body.description, body.price ?? null, body.currency,
          body.is_negotiable, body.location_text ?? null,
          body.latitude ?? null, body.longitude ?? null,
          body.cta_whatsapp ?? null, body.cta_phone ?? null,
          body.cta_email ?? null, body.cta_url ?? null,
          campaignEndAt,      // expires_at = campaign end + buffer
          campaignStartAt,    // campaign_start_at
          campaignEndAt,      // campaign_end_at (listing live-until)
          qualityScore,
        ]);

        const listingId = listingRow.rows[0].id;

        // Batch insert field values (single round-trip)
        const fieldEntries = Object.entries(body.field_values).filter(([, v]) => v != null);
        if (fieldEntries.length > 0) {
          const params: any[] = [];
          const rowPlaceholders = fieldEntries.map(([key, value], i) => {
            const b = i * 4;
            params.push(uuid(), listingId, key, String(value));
            return `($${b+1},$${b+2},$${b+3},$${b+4})`;
          });
          await client.query(`
            INSERT INTO advert_listing_field_values (id, listing_id, field_key, field_value)
            VALUES ${rowPlaceholders.join(',')}
            ON CONFLICT (listing_id, field_key) DO UPDATE SET field_value = EXCLUDED.field_value
          `, params);
        }

        // Batch insert all media (ambassador pack + gallery) in one round-trip
        const allMedia = [
          ...body.ambassador_media.slice(0, 5).map((m, i) => ({ ...m, pack: 'AMBASSADOR_PACK', order: i })),
          ...body.gallery_media.map((m, i) => ({ ...m, pack: 'PRODUCT_GALLERY', order: m.sort_order ?? i })),
        ];
        if (allMedia.length > 0) {
          const params: any[] = [];
          const rowPlaceholders = allMedia.map((m, i) => {
            const b = i * 11;
            params.push(
              uuid(), listingId, m.pack, m.media_type, m.url,
              m.thumbnail_url ?? null, m.file_name ?? null,
              m.mime_type ?? null, m.file_size_bytes ?? null,
              m.duration_secs ?? null, m.order
            );
            return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11})`;
          });
          await client.query(`
            INSERT INTO advert_media (
              id, listing_id, media_pack, media_type, url, thumbnail_url,
              file_name, mime_type, file_size_bytes, duration_secs, sort_order
            ) VALUES ${rowPlaceholders.join(',')}
          `, params);
        }

        return { ...listingRow.rows[0], updated: false, existing: false };
      });

      return reply.code(201).send({ listing });
    } catch (err: any) {
      if (err.statusCode) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      app.log.error(err, 'advert.listing.create.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // POST /api/advert/listings/draft — Create DRAFT listing without campaign (authenticated, BUSINESS only)
  app.post('/advert/listings/draft', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const userId = String((request.user as any)?.sub ?? '').trim();

    const bodySchema = z.object({
      listing_type_id: z.string().uuid(),
      title: z.string().min(5).max(150),
      summary: z.string().min(20).max(300),
      description: z.string().min(50).max(5000),
      price: z.number().positive().optional().nullable(),
      currency: z.string().default('UGX'),
      is_negotiable: z.boolean().default(false),
      location_text: z.string().max(200).optional().nullable(),
      latitude: z.number().optional().nullable(),
      longitude: z.number().optional().nullable(),
      cta_whatsapp: z.string().optional().nullable(),
      cta_phone: z.string().optional().nullable(),
      cta_email: z.string().email().optional().nullable(),
      cta_url: z.string().url().optional().nullable(),
      field_values: z.record(z.string()).default({}),
      ambassador_media: z.array(z.object({
        url: z.string().url(),
        media_type: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']),
        thumbnail_url: z.string().optional(),
        file_name: z.string().optional(),
        mime_type: z.string().optional(),
        file_size_bytes: z.number().optional(),
        duration_secs: z.number().optional(),
      })).max(5).default([]),
      gallery_media: z.array(z.object({
        url: z.string().url(),
        media_type: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']),
        thumbnail_url: z.string().optional(),
        file_name: z.string().optional(),
        mime_type: z.string().optional(),
        file_size_bytes: z.number().optional(),
        duration_secs: z.number().optional(),
        sort_order: z.number().optional(),
      })).default([]),
    });

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch (err: any) {
      return reply.code(400).send({ error: 'validation_error', details: err.errors ?? err.message });
    }

    try {
      const listing = await withTransaction(async (client) => {
        const userRow = await client.query(
          `SELECT id, role, active_role FROM users WHERE id = $1`, [userId]
        );
        if (!userRow.rows[0]) throw Object.assign(new Error('user_not_found'), { statusCode: 404 });
        if (!canAccessBusinessFeatures(userRow.rows[0]?.role)) {
          throw Object.assign(new Error('business_role_required'), { statusCode: 403 });
        }

        const draftCount = await client.query(
          `SELECT COUNT(*) FROM advert_listings WHERE business_id = $1 AND status = 'DRAFT'`,
          [userId]
        );
        if (parseInt(draftCount.rows[0].count, 10) >= 3) {
          throw Object.assign(new Error('draft_limit_reached'), { statusCode: 409 });
        }

        await ensureActiveListingType(client, body.listing_type_id);

        let slug = generateListingSlug(body.title);
        const slugCheck = await client.query(`SELECT id FROM advert_listings WHERE slug = $1`, [slug]);
        if (slugCheck.rows.length > 0) {
          slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
        }

        const qualityScore = calculateListingQuality({
          title: body.title, summary: body.summary, description: body.description,
          price: body.price, location_text: body.location_text,
          cta_phone: body.cta_phone, cta_whatsapp: body.cta_whatsapp, cta_email: body.cta_email,
          ambassador_media_count: body.ambassador_media.length,
          gallery_media_count: body.gallery_media.length,
          field_values: body.field_values,
        });

        const listingRow = await client.query(`
          INSERT INTO advert_listings (
            id, campaign_id, business_id, listing_type_id, slug,
            title, summary, description, price, currency,
            is_negotiable, location_text, latitude, longitude,
            cta_whatsapp, cta_phone, cta_email, cta_url,
            status, listing_quality_score
          ) VALUES (
            $1, NULL, $2, $3, $4, $5, $6, $7, $8, $9,
            $10, $11, $12, $13, $14, $15, $16, $17,
            'DRAFT', $18
          ) RETURNING *
        `, [
          uuid(), userId, body.listing_type_id, slug,
          body.title, body.summary, body.description, body.price ?? null, body.currency,
          body.is_negotiable, body.location_text ?? null,
          body.latitude ?? null, body.longitude ?? null,
          body.cta_whatsapp ?? null, body.cta_phone ?? null,
          body.cta_email ?? null, body.cta_url ?? null,
          qualityScore,
        ]);

        const listingId = listingRow.rows[0].id;

        const fieldEntries = Object.entries(body.field_values).filter(([, v]) => v != null);
        if (fieldEntries.length > 0) {
          const params: any[] = [];
          const rowPlaceholders = fieldEntries.map(([key, value], i) => {
            const b = i * 4;
            params.push(uuid(), listingId, key, String(value));
            return `($${b+1},$${b+2},$${b+3},$${b+4})`;
          });
          await client.query(`
            INSERT INTO advert_listing_field_values (id, listing_id, field_key, field_value)
            VALUES ${rowPlaceholders.join(',')}
            ON CONFLICT (listing_id, field_key) DO UPDATE SET field_value = EXCLUDED.field_value
          `, params);
        }

        const allMedia = [
          ...body.ambassador_media.slice(0, 5).map((m, i) => ({ ...m, pack: 'AMBASSADOR_PACK', order: i })),
          ...body.gallery_media.map((m, i) => ({ ...m, pack: 'PRODUCT_GALLERY', order: m.sort_order ?? i })),
        ];
        if (allMedia.length > 0) {
          const params: any[] = [];
          const rowPlaceholders = allMedia.map((m, i) => {
            const b = i * 11;
            params.push(
              uuid(), listingId, m.pack, m.media_type, m.url,
              (m as any).thumbnail_url ?? null, (m as any).file_name ?? null,
              (m as any).mime_type ?? null, (m as any).file_size_bytes ?? null,
              (m as any).duration_secs ?? null, m.order
            );
            return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11})`;
          });
          await client.query(`
            INSERT INTO advert_media (
              id, listing_id, media_pack, media_type, url, thumbnail_url,
              file_name, mime_type, file_size_bytes, duration_secs, sort_order
            ) VALUES ${rowPlaceholders.join(',')}
          `, params);
        }

        return listingRow.rows[0];
      });

      return reply.code(201).send({ listing });
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      app.log.error(err, 'advert.listing.draft.create.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // PATCH /api/advert/listings/:slug/attach-campaign — Link a DRAFT listing to a campaign
  // If the campaign already has another draft listing attached, replace it so
  // the business can change the product page before funding.
  app.patch('/advert/listings/:slug/attach-campaign', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const userId = String((request.user as any)?.sub ?? '').trim();
    const { slug } = request.params as { slug: string };

    const bodySchema = z.object({ campaign_id: z.string().uuid() });
    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch (err: any) {
      return reply.code(400).send({ error: 'validation_error', details: err.errors ?? err.message });
    }

    try {
      const listing = await withTransaction(async (client) => {
        const listingRow = await client.query(
          `SELECT id, business_id, status FROM advert_listings WHERE slug = $1`, [slug]
        );
        if (!listingRow.rows[0]) throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
        if (listingRow.rows[0].business_id !== userId) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
        if (listingRow.rows[0].status !== 'DRAFT') throw Object.assign(new Error('listing_already_active'), { statusCode: 409 });

        const campRow = await client.query(
          `SELECT id, business_id FROM campaigns WHERE id = $1`, [body.campaign_id]
        );
        if (!campRow.rows[0]) throw Object.assign(new Error('campaign_not_found'), { statusCode: 404 });
        if (campRow.rows[0].business_id !== userId) throw Object.assign(new Error('forbidden'), { statusCode: 403 });

        const existing = await client.query(
          `SELECT id, status FROM advert_listings WHERE campaign_id = $1 AND id != $2`,
          [body.campaign_id, listingRow.rows[0].id]
        );
        if (existing.rows.length > 0) {
          const blocking = existing.rows.find(
            (row) => String(row.status ?? '').trim().toUpperCase() !== 'DRAFT'
          );
          if (blocking) {
            throw Object.assign(new Error('campaign_already_has_listing'), { statusCode: 409 });
          }
          await client.query(
            `UPDATE advert_listings
             SET campaign_id = NULL,
                 updated_at = now()
             WHERE campaign_id = $1
               AND id != $2
               AND status = 'DRAFT'`,
            [body.campaign_id, listingRow.rows[0].id]
          );
        }

        const updated = await client.query(
          `UPDATE advert_listings SET campaign_id = $1, updated_at = now() WHERE id = $2 RETURNING *`,
          [body.campaign_id, listingRow.rows[0].id]
        );
        return updated.rows[0];
      });
      return reply.send({ listing });
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      app.log.error(err, 'advert.listing.attach.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // PATCH /api/advert/listings/:slug — Update listing content (owner only, DRAFT or ACTIVE)
  app.patch('/advert/listings/:slug', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const userId = String((request.user as any)?.sub ?? '').trim();
    const { slug } = request.params as { slug: string };

    const bodySchema = z.object({
      title: z.string().min(5).max(150).optional(),
      summary: z.string().min(20).max(300).optional(),
      description: z.string().min(50).max(5000).optional(),
      price: z.number().positive().optional().nullable(),
      currency: z.string().optional(),
      is_negotiable: z.boolean().optional(),
      location_text: z.string().max(200).optional().nullable(),
      latitude: z.number().optional().nullable(),
      longitude: z.number().optional().nullable(),
      cta_whatsapp: z.string().optional().nullable(),
      cta_phone: z.string().optional().nullable(),
      cta_email: z.string().email().optional().nullable(),
      cta_url: z.string().optional().nullable(),
      field_values: z.record(z.string()).optional(),
    });

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch (err: any) {
      return reply.code(400).send({ error: 'validation_error', details: err.errors ?? err.message });
    }

    try {
      const listing = await withTransaction(async (client) => {
        const existingRow = await client.query(
          `SELECT id, business_id, status, title, summary, description,
                  price, currency, is_negotiable, location_text,
                  cta_whatsapp, cta_phone, cta_email, cta_url
           FROM advert_listings WHERE slug = $1`,
          [slug]
        );
        if (!existingRow.rows[0]) throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
        if (existingRow.rows[0].business_id !== userId) throw Object.assign(new Error('forbidden'), { statusCode: 403 });

        const existing = existingRow.rows[0];

        // Build SET clause dynamically for only provided fields
        const setClauses: string[] = ['updated_at = now()'];
        const params: any[] = [];
        let idx = 1;

        if (body.title !== undefined)        { setClauses.push(`title = $${idx++}`);         params.push(body.title); }
        if (body.summary !== undefined)      { setClauses.push(`summary = $${idx++}`);       params.push(body.summary); }
        if (body.description !== undefined)  { setClauses.push(`description = $${idx++}`);   params.push(body.description); }
        if ('price' in body)                 { setClauses.push(`price = $${idx++}`);         params.push(body.price ?? null); }
        if (body.currency !== undefined)     { setClauses.push(`currency = $${idx++}`);      params.push(body.currency); }
        if (body.is_negotiable !== undefined){ setClauses.push(`is_negotiable = $${idx++}`); params.push(body.is_negotiable); }
        if ('location_text' in body)         { setClauses.push(`location_text = $${idx++}`); params.push(body.location_text ?? null); }
        if ('latitude' in body)              { setClauses.push(`latitude = $${idx++}`);      params.push(body.latitude ?? null); }
        if ('longitude' in body)             { setClauses.push(`longitude = $${idx++}`);     params.push(body.longitude ?? null); }
        if ('cta_whatsapp' in body)          { setClauses.push(`cta_whatsapp = $${idx++}`);  params.push(body.cta_whatsapp ?? null); }
        if ('cta_phone' in body)             { setClauses.push(`cta_phone = $${idx++}`);     params.push(body.cta_phone ?? null); }
        if ('cta_email' in body)             { setClauses.push(`cta_email = $${idx++}`);     params.push(body.cta_email ?? null); }
        if ('cta_url' in body)               { setClauses.push(`cta_url = $${idx++}`);       params.push(body.cta_url ?? null); }

        // Recalculate quality score with merged values
        const merged = {
          title:       body.title ?? existing.title,
          summary:     body.summary ?? existing.summary,
          description: body.description ?? existing.description,
          price:       'price' in body ? body.price : existing.price,
          location_text: 'location_text' in body ? body.location_text : existing.location_text,
          cta_phone:   'cta_phone' in body ? body.cta_phone : existing.cta_phone,
          cta_whatsapp:'cta_whatsapp' in body ? body.cta_whatsapp : existing.cta_whatsapp,
          cta_email:   'cta_email' in body ? body.cta_email : existing.cta_email,
        };
        const mediaCountRow = await client.query(
          `SELECT
             COUNT(*) FILTER (WHERE media_pack = 'AMBASSADOR_PACK') AS ambassador_count,
             COUNT(*) FILTER (WHERE media_pack = 'PRODUCT_GALLERY') AS gallery_count
           FROM advert_media WHERE listing_id = $1`,
          [existing.id]
        );
        const fvRow = await client.query(
          `SELECT field_key, field_value FROM advert_listing_field_values WHERE listing_id = $1`,
          [existing.id]
        );
        const existingFieldValues: Record<string, string> = {};
        for (const fv of fvRow.rows) { existingFieldValues[fv.field_key] = fv.field_value; }
        const mergedFields = body.field_values ? { ...existingFieldValues, ...body.field_values } : existingFieldValues;

        const newScore = calculateListingQuality({
          ...merged,
          ambassador_media_count: Number(mediaCountRow.rows[0]?.ambassador_count ?? 0),
          gallery_media_count: Number(mediaCountRow.rows[0]?.gallery_count ?? 0),
          field_values: mergedFields,
        });
        setClauses.push(`listing_quality_score = $${idx++}`);
        params.push(newScore);

        params.push(existing.id);
        const updatedRow = await client.query(
          `UPDATE advert_listings SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`,
          params
        );

        // Upsert field values if provided
        if (body.field_values) {
          const entries = Object.entries(body.field_values).filter(([, v]) => v != null);
          if (entries.length > 0) {
            const fvParams: any[] = [];
            const fvPlaceholders = entries.map(([key, value], i) => {
              const b = i * 4;
              fvParams.push(uuid(), existing.id, key, String(value));
              return `($${b+1},$${b+2},$${b+3},$${b+4})`;
            });
            await client.query(`
              INSERT INTO advert_listing_field_values (id, listing_id, field_key, field_value)
              VALUES ${fvPlaceholders.join(',')}
              ON CONFLICT (listing_id, field_key) DO UPDATE SET field_value = EXCLUDED.field_value
            `, fvParams);
          }
        }

        return updatedRow.rows[0];
      });

      return reply.send({ listing });
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      app.log.error(err, 'advert.listing.update.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // POST /api/advert/listings/:slug/media — Add a media item to an existing listing
  app.post('/advert/listings/:slug/media', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const userId = String((request.user as any)?.sub ?? '').trim();
    const { slug } = request.params as { slug: string };

    const bodySchema = z.object({
      media_pack: z.enum(['AMBASSADOR_PACK', 'PRODUCT_GALLERY']),
      url: z.string().url(),
      media_type: z.enum(['IMAGE', 'VIDEO', 'DOCUMENT']),
      thumbnail_url: z.string().optional().nullable(),
      file_name: z.string().optional().nullable(),
      mime_type: z.string().optional().nullable(),
      file_size_bytes: z.number().optional().nullable(),
      duration_secs: z.number().optional().nullable(),
    });

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch (err: any) {
      return reply.code(400).send({ error: 'validation_error', details: err.errors ?? err.message });
    }

    try {
      const media = await withTransaction(async (client) => {
        const listingRow = await client.query(
          `SELECT id, business_id FROM advert_listings WHERE slug = $1`, [slug]
        );
        if (!listingRow.rows[0]) throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
        if (listingRow.rows[0].business_id !== userId) throw Object.assign(new Error('forbidden'), { statusCode: 403 });
        const listingId = listingRow.rows[0].id;

        if (body.media_pack === 'AMBASSADOR_PACK') {
          const countRow = await client.query(
            `SELECT COUNT(*) FROM advert_media WHERE listing_id = $1 AND media_pack = 'AMBASSADOR_PACK'`,
            [listingId]
          );
          if (Number(countRow.rows[0].count) >= 5) {
            throw Object.assign(new Error('ambassador_pack_limit_reached'), { statusCode: 400 });
          }
        }

        const sortRow = await client.query(
          `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM advert_media WHERE listing_id = $1 AND media_pack = $2`,
          [listingId, body.media_pack]
        );
        const sortOrder = Number(sortRow.rows[0]?.next_order ?? 0);

        const inserted = await client.query(`
          INSERT INTO advert_media (id, listing_id, media_pack, media_type, url, thumbnail_url, file_name, mime_type, file_size_bytes, duration_secs, sort_order)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *
        `, [
          uuid(), listingId, body.media_pack, body.media_type, body.url,
          body.thumbnail_url ?? null, body.file_name ?? null, body.mime_type ?? null,
          body.file_size_bytes ?? null, body.duration_secs ?? null, sortOrder,
        ]);
        return inserted.rows[0];
      });
      return reply.code(201).send({ media });
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      app.log.error(err, 'advert.listing.media.add.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // DELETE /api/advert/listings/:slug/media/:mediaId — Remove a media item
  app.delete('/advert/listings/:slug/media/:mediaId', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const userId = String((request.user as any)?.sub ?? '').trim();
    const { slug, mediaId } = request.params as { slug: string; mediaId: string };

    try {
      await withTransaction(async (client) => {
        const listingRow = await client.query(
          `SELECT id, business_id FROM advert_listings WHERE slug = $1`, [slug]
        );
        if (!listingRow.rows[0]) throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
        if (listingRow.rows[0].business_id !== userId) throw Object.assign(new Error('forbidden'), { statusCode: 403 });

        const deleted = await client.query(
          `DELETE FROM advert_media WHERE id = $1 AND listing_id = $2 RETURNING id`,
          [mediaId, listingRow.rows[0].id]
        );
        if (!deleted.rows[0]) throw Object.assign(new Error('media_not_found'), { statusCode: 404 });
      });
      return reply.send({ success: true });
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      app.log.error(err, 'advert.listing.media.delete.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // DELETE /api/advert/listings/:slug — Remove a draft listing owned by the business
  app.delete('/advert/listings/:slug', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const userId = String((request.user as any)?.sub ?? '').trim();
    const { slug } = request.params as { slug: string };

    try {
      await withTransaction(async (client) => {
        const listingRow = await client.query(
          `SELECT id, business_id, status, campaign_id FROM advert_listings WHERE slug = $1`,
          [slug]
        );
        if (!listingRow.rows[0]) {
          throw Object.assign(new Error('listing_not_found'), {
            statusCode: 404,
          });
        }
        if (listingRow.rows[0].business_id !== userId) {
          throw Object.assign(new Error('forbidden'), { statusCode: 403 });
        }
        if (String(listingRow.rows[0].status ?? '').trim().toUpperCase() !== 'DRAFT') {
          throw Object.assign(new Error('listing_not_deletable'), {
            statusCode: 409,
          });
        }

        const linkedCampaignId: string | null = listingRow.rows[0].campaign_id ?? null;

        if (linkedCampaignId) {
          const escrowCheck = await client.query(
            `SELECT status FROM escrow_ledger WHERE campaign_id = $1 LIMIT 1`,
            [linkedCampaignId]
          );
          const escrowStatus = String(escrowCheck.rows[0]?.status ?? 'PENDING').toUpperCase();
          if (escrowStatus !== 'PENDING') {
            throw Object.assign(new Error('listing_not_deletable'), { statusCode: 409 });
          }
        }

        // Delete the listing first (cascades through media, offers, sessions, analytics, etc.)
        await client.query(`DELETE FROM advert_listings WHERE id = $1`, [
          listingRow.rows[0].id,
        ]);

        // Delete the linked draft campaign using the same teardown order as the
        // campaign delete endpoint, so no FK constraint is left dangling.
        if (linkedCampaignId) {
          // Collect root + any child campaign IDs
          const allCampaignIdsRes = await client.query(
            `SELECT id FROM campaigns WHERE id = $1 OR parent_campaign_id = $1`,
            [linkedCampaignId]
          );
          const allCampaignIds: string[] = allCampaignIdsRes.rows.map((r: any) => r.id);

          const sessionRes = await client.query(
            `SELECT id FROM verification_sessions WHERE campaign_id = ANY($1::uuid[])`,
            [allCampaignIds]
          );
          const sessionIds: string[] = sessionRes.rows.map((r: any) => r.id);

          const proofRes = await client.query(
            `SELECT id FROM proofs WHERE session_id = ANY($1::uuid[])`,
            [sessionIds.length ? sessionIds : [linkedCampaignId]]
          );
          const proofIds: string[] = proofRes.rows.map((r: any) => r.id);

          if (proofIds.length) {
            await client.query(
              `DELETE FROM payout_requests WHERE proof_id = ANY($1::uuid[])`,
              [proofIds]
            );
          }
          // pesapal_transactions references escrow_ledger — must go before escrow_ledger
          await client.query(
            `DELETE FROM pesapal_transactions
             WHERE escrow_id IN (
               SELECT id FROM escrow_ledger WHERE campaign_id = ANY($1::uuid[])
             )`,
            [allCampaignIds]
          );
          if (proofIds.length || sessionIds.length) {
            await client.query(
              `DELETE FROM proofs WHERE id = ANY($1::uuid[]) OR session_id = ANY($2::uuid[])`,
              [
                proofIds.length ? proofIds : [linkedCampaignId],
                sessionIds.length ? sessionIds : [linkedCampaignId],
              ]
            );
          }
          await client.query(
            `DELETE FROM verification_sessions WHERE campaign_id = ANY($1::uuid[])`,
            [allCampaignIds]
          );
          await client.query(
            `DELETE FROM contracts WHERE campaign_id = ANY($1::uuid[])`,
            [allCampaignIds]
          );
          await client.query(
            `DELETE FROM escrow_ledger WHERE campaign_id = ANY($1::uuid[])`,
            [allCampaignIds]
          );
          await client.query(
            `DELETE FROM campaigns WHERE id = ANY($1::uuid[])`,
            [allCampaignIds]
          );
        }
      });

      return reply.send({ success: true, slug });
    } catch (err: any) {
      if (err.statusCode) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      app.log.error(err, 'advert.listing.delete.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // GET /api/advert/listings/browse — Public marketplace (no auth)
  app.get('/advert/listings/browse', async (request, reply) => {
    const q = request.query as Record<string, string>;
    const page    = Math.max(1, parseInt(q.page  ?? '1',  10));
    const limit   = Math.min(50, Math.max(1, parseInt(q.limit ?? '20', 10)));
    const sort    = ['newest', 'trending', 'expiring'].includes(q.sort ?? '') ? q.sort : 'newest';
    const search  = (q.search   ?? '').trim();
    const catSlug = (q.category ?? '').trim();
    const offset  = (page - 1) * limit;

    try {
      const conditions: string[] = [
        `al.status = 'ACTIVE'`,
        `al.access_state = 'PUBLIC'`,
        // Direct listings (no campaign) and admin/Pro-kept-alive listings always pass.
        `(c.status = 'ACTIVE' OR c.id IS NULL OR al.admin_keep_alive = TRUE)`,
        // Show listing if campaign window is open, OR there is no end date, OR it's kept alive.
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
      const orderBy =
        sort === 'trending' ? 'al.views_total DESC NULLS LAST, al.created_at DESC' :
        sort === 'expiring' ? 'al.campaign_end_at ASC NULLS LAST' :
        'al.created_at DESC';

      const dataParams = [...filterParams, limit, offset];
      const limitN  = dataParams.length - 1;
      const offsetN = dataParams.length;

      const [dataRows, countRows, statsRows] = await Promise.all([
        query(`
          SELECT
            al.id,
            al.slug,
            al.title,
            al.summary,
            al.price,
            al.currency,
            al.is_negotiable,
            al.location_text,
            COALESCE(al.views_total, 0) AS views_total,
            al.listing_quality_score,
            al.campaign_start_at,
            al.campaign_end_at,
            GREATEST(0, EXTRACT(EPOCH FROM (al.campaign_end_at - NOW()))::bigint) AS time_remaining_secs,
            (
              SELECT am.url FROM advert_media am
              WHERE am.listing_id = al.id AND am.media_type = 'IMAGE'
              ORDER BY
                CASE am.media_pack WHEN 'AMBASSADOR_PACK' THEN 0 ELSE 1 END,
                am.sort_order ASC, am.created_at ASC
              LIMIT 1
            ) AS hero_url,
            (
              SELECT COALESCE(am.thumbnail_url, am.url) FROM advert_media am
              WHERE am.listing_id = al.id AND am.media_type = 'IMAGE'
              ORDER BY
                CASE am.media_pack WHEN 'AMBASSADOR_PACK' THEN 0 ELSE 1 END,
                am.sort_order ASC, am.created_at ASC
              LIMIT 1
            ) AS hero_thumbnail_url,
            ac.id     AS category_id,
            ac.name   AS category_name,
            ac.slug   AS category_slug,
            ac.icon   AS category_icon
          FROM advert_listings al
          LEFT  JOIN campaigns c      ON c.id   = al.campaign_id
          LEFT  JOIN advert_listing_types  lt  ON lt.id   = al.listing_type_id
          LEFT  JOIN advert_subcategories  sub ON sub.id  = lt.subcategory_id
          LEFT  JOIN advert_categories     ac  ON ac.id   = sub.category_id
          WHERE ${whereClause}
          ORDER BY ${orderBy}
          LIMIT $${limitN} OFFSET $${offsetN}
        `, dataParams),
        query(`
          SELECT COUNT(*)::int AS total
          FROM advert_listings al
          LEFT  JOIN campaigns c ON c.id = al.campaign_id
          LEFT  JOIN advert_listing_types  lt  ON lt.id  = al.listing_type_id
          LEFT  JOIN advert_subcategories  sub ON sub.id = lt.subcategory_id
          LEFT  JOIN advert_categories     ac  ON ac.id  = sub.category_id
          WHERE ${whereClause}
        `, filterParams),
        query(`
          SELECT COUNT(*)::int AS live_count
          FROM advert_listings al
          LEFT  JOIN campaigns c ON c.id = al.campaign_id
          WHERE al.status = 'ACTIVE'
            AND (c.status = 'ACTIVE' OR c.id IS NULL)
            AND (al.campaign_end_at IS NULL OR al.campaign_end_at > NOW())
        `, []),
      ]);

      const total     = Number((countRows as any[])[0]?.total     ?? 0);
      const liveCount = Number((statsRows as any[])[0]?.live_count ?? 0);

      reply.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
      return {
        listings: dataRows,
        pagination: {
          page,
          limit,
          total,
          total_pages: Math.ceil(total / limit),
          has_next: page * limit < total,
        },
        meta: { live_listing_count: liveCount },
      };
    } catch (err: any) {
      app.log.error(err, 'advert.browse.error');
      reply.code(500);
      return { error: 'internal_server_error' };
    }
  });

  // GET /api/advert/listings/me — Business's own listings
  app.get('/advert/listings/me', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const userId = String((request.user as any)?.sub ?? '').trim();
    const query = request.query as { page?: string; limit?: string; status?: string };
    const page = Math.max(1, parseInt(query.page ?? '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(query.limit ?? '20', 10)));
    const offset = (page - 1) * limit;

    try {
      const result = await withTransaction(async (client) => {
        const listings = await client.query(`
          SELECT
            al.id, al.slug, al.title, al.summary, al.price, al.currency,
            al.is_negotiable, al.location_text, al.status, al.access_state,
            al.is_promoted, al.admin_action_note, al.admin_action_at,
            al.listing_quality_score, al.views_total, al.views_unique,
            al.created_at, al.expires_at, al.preview_token,
            lt.name AS listing_type_name,
            s.name AS subcategory_name,
            c.name AS category_name,
            (SELECT url FROM advert_media
             WHERE listing_id = al.id AND media_pack = 'AMBASSADOR_PACK'
             ORDER BY sort_order LIMIT 1) AS hero_image,
            (SELECT COUNT(*) FROM advert_offers WHERE listing_id = al.id AND status = 'PENDING') AS pending_offers
          FROM advert_listings al
          LEFT JOIN advert_listing_types lt ON lt.id = al.listing_type_id
          LEFT JOIN advert_subcategories s ON s.id = lt.subcategory_id
          LEFT JOIN advert_categories c ON c.id = s.category_id
          WHERE al.business_id = $1
            AND ($4::text IS NULL OR al.status = $4)
          ORDER BY al.created_at DESC
          LIMIT $2 OFFSET $3
        `, [userId, limit, offset, query.status ?? null]);

        const countResult = await client.query(
          `SELECT COUNT(*) FROM advert_listings WHERE business_id = $1`,
          [userId]
        );

        return {
          listings: listings.rows,
          total: parseInt(countResult.rows[0].count, 10),
          page,
          limit,
        };
      });
      return reply.send(result);
    } catch (err) {
      app.log.error(err, 'advert.listings.me.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // GET /api/advert/listings/:slug — Public listing page
  app.get('/advert/listings/:slug', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const query =
      request.query as { preview_token?: string; preview?: string };
    const previewToken = String(
      query.preview_token ?? query.preview ?? ''
    ).trim();

    try {
      const result = await withTransaction(async (client) => {
        const row = await client.query(`
          SELECT
            al.*,
            lt.name AS listing_type_name, lt.slug AS listing_type_slug,
            s.name AS subcategory_name, s.slug AS subcategory_slug,
            c.name AS category_name, c.slug AS category_slug, c.icon AS category_icon,
            EXTRACT(EPOCH FROM (al.campaign_end_at - now()))::bigint AS time_remaining_secs
          FROM advert_listings al
          LEFT JOIN advert_listing_types lt ON lt.id = al.listing_type_id
          LEFT JOIN advert_subcategories s ON s.id = lt.subcategory_id
          LEFT JOIN advert_categories c ON c.id = s.category_id
          WHERE al.slug = $1
        `, [slug]);

        if (!row.rows[0]) return { gone: false, notFound: true };

        const listing = row.rows[0];
        const listingId = listing.id;
        const accessState = String(listing.access_state ?? 'PUBLIC').toUpperCase();

        if (accessState !== 'PUBLIC') {
          return {
            gone: false,
            notFound: false,
            blocked: true,
            blockedState: accessState,
            title: listing.title,
          };
        }

        if (listing.status === 'DRAFT') {
          const expectedPreviewToken = String(
            listing.preview_token ?? ''
          ).trim();
          if (
            !expectedPreviewToken ||
            previewToken !== expectedPreviewToken
          ) {
            return { gone: false, notFound: true };
          }
          const [mediaRows, fieldRows] = await Promise.all([
            client.query(`
              SELECT id, media_pack, media_type, url, thumbnail_url, file_name,
                     mime_type, duration_secs, sort_order
              FROM advert_media WHERE listing_id = $1 ORDER BY media_pack, sort_order
            `, [listingId]),
            client.query(`
              SELECT fv.field_key, fv.field_value, fd.field_type
              FROM advert_listing_field_values fv
              LEFT JOIN advert_field_definitions fd
                ON fd.listing_type_id = $2 AND fd.field_key = fv.field_key
              WHERE fv.listing_id = $1
            `, [listingId, listing.listing_type_id]),
          ]);
          const ambassadorMedia = mediaRows.rows.filter((m: any) => m.media_pack === 'AMBASSADOR_PACK');
          const galleryMedia = mediaRows.rows.filter((m: any) => m.media_pack === 'PRODUCT_GALLERY');
          const fieldValues: Record<string, string> = {};
          const fieldTypes: Record<string, string> = {};
          for (const fv of fieldRows.rows) {
            fieldValues[fv.field_key] = fv.field_value;
            if (fv.field_type) fieldTypes[fv.field_key] = fv.field_type;
          }
          return {
            gone: false, notFound: false,
            listing: {
              ...listing, is_draft: true,
              ambassador_media: ambassadorMedia,
              gallery_media: galleryMedia,
              field_values: fieldValues,
              field_types: fieldTypes,
              time_remaining_secs: 0,
              business_id: undefined,
            },
          };
        }

        // Enforce the buffered campaign window:
        // listing is inaccessible once campaign_end_at has passed,
        // unless admin_keep_alive is set.
        const timeRemainingSecs = Number(listing.time_remaining_secs ?? -1);
        const isExpired = !listing.admin_keep_alive && timeRemainingSecs <= 0;

        // Auto-expire in DB if needed
        if (isExpired && listing.status === 'ACTIVE') {
          await client.query(
            `UPDATE advert_listings SET status = 'EXPIRED', updated_at = now()
             WHERE id = $1`,
            [listingId]
          );
          listing.status = 'EXPIRED';
        }

        if (isExpired) {
          return {
            gone: true,
            notFound: false,
            expired_at: listing.campaign_end_at,
            title: listing.title,
          };
        }

        const [mediaRows, fieldRows] = await Promise.all([
          client.query(`
            SELECT id, media_pack, media_type, url, thumbnail_url, file_name,
                   mime_type, duration_secs, sort_order, views, plays, watch_time_secs
            FROM advert_media
            WHERE listing_id = $1
            ORDER BY media_pack, sort_order
          `, [listingId]),
          client.query(`
            SELECT fv.field_key, fv.field_value, fd.field_type
            FROM advert_listing_field_values fv
            LEFT JOIN advert_field_definitions fd
              ON fd.listing_type_id = $2 AND fd.field_key = fv.field_key
            WHERE fv.listing_id = $1
          `, [listingId, listing.listing_type_id]),
        ]);

        const ambassadorMedia = mediaRows.rows.filter((m: any) => m.media_pack === 'AMBASSADOR_PACK');
        const galleryMedia = mediaRows.rows.filter((m: any) => m.media_pack === 'PRODUCT_GALLERY');
        const fieldValues: Record<string, string> = {};
        const fieldTypes: Record<string, string> = {};
        for (const fv of fieldRows.rows) {
          fieldValues[fv.field_key] = fv.field_value;
          if (fv.field_type) fieldTypes[fv.field_key] = fv.field_type;
        }

        return {
          gone: false,
          notFound: false,
          listing: {
            ...listing,
            ambassador_media: ambassadorMedia,
            gallery_media: galleryMedia,
            field_values: fieldValues,
            field_types: fieldTypes,
            time_remaining_secs: Math.max(0, timeRemainingSecs),
            business_id: undefined,
          },
        };
      });

      if (!result) return reply.code(500).send({ error: 'internal_server_error' });
      if (result.notFound) return reply.code(404).send({ error: 'listing_not_found' });
      if ((result as any).blocked) {
        return reply.code(404).send({
          error: 'listing_access_restricted',
          state: (result as any).blockedState,
          title: result.title,
        });
      }
      if (result.gone) {
        return reply.code(410).send({
          error: 'listing_expired',
          message: 'This listing has ended. The campaign that powered it has concluded.',
          expired_at: result.expired_at,
          title: result.title,
        });
      }
      return reply.send({ listing: result.listing });
    } catch (err) {
      app.log.error(err, 'advert.listing.get.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // GET /api/advert/listings/:slug/time-status — Live time poll (lightweight, no session)
  app.get('/advert/listings/:slug/time-status', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const query =
      request.query as { preview_token?: string; preview?: string };
    const previewToken = String(
      query.preview_token ?? query.preview ?? ''
    ).trim();
    try {
      const result = await withTransaction(async (client) => {
        const row = await client.query(`
          SELECT
            al.id, al.business_id, al.status, al.admin_keep_alive, al.access_state,
            al.preview_token,
            al.campaign_start_at, al.campaign_end_at,
            EXTRACT(EPOCH FROM (al.campaign_end_at - now()))::bigint AS time_remaining_secs
          FROM advert_listings al
          WHERE al.slug = $1
        `, [slug]);
        const r = row.rows[0];
        if (!r) return null;
        return r;
      });
      if (!result) return reply.code(404).send({ error: 'listing_not_found' });
      if (String(result.status ?? '').toUpperCase() === 'DRAFT') {
        const expectedPreviewToken = String(
          result.preview_token ?? ''
        ).trim();
        if (
          !expectedPreviewToken ||
          previewToken !== expectedPreviewToken
        ) {
          return reply.code(404).send({ error: 'listing_not_found' });
        }
      }
      const accessState = String(result.access_state ?? 'PUBLIC').toUpperCase();
      const remaining = Number(result.time_remaining_secs ?? -1);
      const isLive = accessState === 'PUBLIC' && (
        result.status === 'DRAFT' ||
        result.admin_keep_alive ||
        remaining > 0
      );
      return reply.send({
        is_live: isLive,
        time_remaining_secs: Math.max(0, remaining),
        campaign_start_at: result.campaign_start_at,
        campaign_end_at: result.campaign_end_at,
        status: result.status,
        access_state: accessState,
      });
    } catch (err) {
      app.log.error(err, 'advert.time_status.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // GET /api/advert/listings/:slug/by-campaign — Get listing by campaign (auth)
  app.get('/advert/campaigns/:campaignId/listing', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const { campaignId } = request.params as { campaignId: string };
    const userId = String((request.user as any)?.sub ?? '').trim();

    try {
      const result = await withTransaction(async (client) => {
        const row = await client.query(`
          SELECT al.*, lt.name AS listing_type_name,
                 s.name AS subcategory_name, c.name AS category_name
          FROM advert_listings al
          JOIN advert_listing_types lt ON lt.id = al.listing_type_id
          JOIN advert_subcategories s ON s.id = lt.subcategory_id
          JOIN advert_categories c ON c.id = s.category_id
          WHERE al.campaign_id = $1 AND al.business_id = $2
        `, [campaignId, userId]);

        return row.rows[0] ?? null;
      });

      if (!result) return reply.code(404).send({ error: 'listing_not_found' });
      return reply.send({ listing: result });
    } catch (err) {
      app.log.error(err, 'advert.listing.by-campaign.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ─── TRACKING LINKS ──────────────────────────

  // POST /api/advert/listings/:slug/tracking-link — Generate/get ambassador tracking link
  app.post('/advert/listings/:slug/tracking-link', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const userId = String((request.user as any)?.sub ?? '').trim();

    try {
      const result = await withTransaction(async (client) => {
        const listingRow = await client.query(
          `SELECT id FROM advert_listings WHERE slug = $1 AND status = 'ACTIVE'`,
          [slug]
        );
        if (!listingRow.rows[0]) {
          throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
        }
        const listingId = listingRow.rows[0].id;

        // Upsert tracking link
        const existing = await client.query(
          `SELECT id, ambassador_code FROM advert_tracking_links WHERE listing_id = $1 AND ambassador_id = $2`,
          [listingId, userId]
        );

        if (existing.rows[0]) {
          return existing.rows[0];
        }

        const code = generateAmbassadorCode();
        const newLink = await client.query(`
          INSERT INTO advert_tracking_links (id, listing_id, ambassador_id, ambassador_code)
          VALUES ($1, $2, $3, $4) RETURNING id, ambassador_code
        `, [uuid(), listingId, userId, code]);

        return newLink.rows[0];
      });

      return reply.send({ tracking_link: result });
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      app.log.error(err, 'advert.tracking_link.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ─── ANALYTICS ───────────────────────────────

  // POST /api/advert/sessions — Record page session start
  app.post('/advert/sessions', async (request, reply) => {
    const bodySchema = z.object({
      listing_id: z.string().uuid(),
      ambassador_code: z.string().optional().nullable(),
      visitor_fingerprint: z.string().optional().nullable(),
      device_type: z.string().optional().nullable(),
      country_code: z.string().optional().nullable(),
      referrer: z.string().optional().nullable(),
    });

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch (err: any) {
      return reply.code(400).send({ error: 'validation_error' });
    }

    try {
      const sessionId = await withTransaction(async (client) => {
        // Check listing exists
        const listing = await client.query(
          `SELECT id FROM advert_listings WHERE id = $1`,
          [body.listing_id]
        );
        if (!listing.rows[0]) {
          throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
        }

        // Check if return visitor
        let isReturn = false;
        if (body.visitor_fingerprint) {
          const prior = await client.query(`
            SELECT id FROM advert_page_sessions
            WHERE listing_id = $1 AND visitor_fingerprint = $2
            LIMIT 1
          `, [body.listing_id, body.visitor_fingerprint]);
          isReturn = prior.rows.length > 0;
        }

        const sId = uuid();
        await client.query(`
          INSERT INTO advert_page_sessions
            (id, listing_id, ambassador_code, visitor_fingerprint,
             device_type, country_code, referrer, is_return_visitor)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [
          sId, body.listing_id, body.ambassador_code ?? null,
          body.visitor_fingerprint ?? null, body.device_type ?? null,
          body.country_code ?? null, body.referrer ?? null, isReturn,
        ]);

        // Increment listing view counts
        await client.query(`
          UPDATE advert_listings
          SET views_total = views_total + 1,
              views_unique = views_unique + CASE WHEN $2 THEN 0 ELSE 1 END
          WHERE id = $1
        `, [body.listing_id, isReturn]);

        // Increment tracking link visits if code provided
        if (body.ambassador_code) {
          await client.query(`
            UPDATE advert_tracking_links
            SET visits = visits + 1,
                unique_visitors = unique_visitors + CASE WHEN $2 THEN 0 ELSE 1 END
            WHERE ambassador_code = $1
          `, [body.ambassador_code, isReturn]);
        }

        return sId;
      });

      return reply.code(201).send({ session_id: sessionId });
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      app.log.error(err, 'advert.sessions.create.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // PATCH /api/advert/sessions/:sessionId — Close session with duration/scroll data
  app.patch('/advert/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    const bodySchema = z.object({
      session_duration_secs: z.number().int().nonnegative().optional(),
      scroll_depth_pct: z.number().int().min(0).max(100).optional(),
    });

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch {
      return reply.code(400).send({ error: 'validation_error' });
    }

    try {
      await withTransaction(async (client) => {
        await client.query(`
          UPDATE advert_page_sessions
          SET session_end = now(),
              session_duration_secs = $2,
              scroll_depth_pct = $3
          WHERE id = $1
        `, [sessionId, body.session_duration_secs ?? null, body.scroll_depth_pct ?? null]);
      });
      return reply.send({ ok: true });
    } catch (err) {
      app.log.error(err, 'advert.sessions.close.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // POST /api/advert/events — Track engagement event
  app.post('/advert/events', async (request, reply) => {
    const validEventTypes = [
      'PAGE_VIEW','CTA_TAP','WHATSAPP_TAP','PHONE_TAP','EMAIL_TAP',
      'MAP_OPEN','GALLERY_OPEN','OFFER_START','NEGOTIATION_START',
      'OUTBOUND_TAP','SHARE_TAP','CONVERSION_INTENT',
    ];
    const bodySchema = z.object({
      listing_id: z.string().uuid(),
      session_id: z.string().uuid().optional().nullable(),
      ambassador_code: z.string().optional().nullable(),
      event_type: z.enum(validEventTypes as [string, ...string[]]),
      event_meta: z.record(z.unknown()).optional().nullable(),
    });

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch (err: any) {
      return reply.code(400).send({ error: 'validation_error' });
    }

    try {
      await withTransaction(async (client) => {
        await client.query(`
          INSERT INTO advert_engagement_events
            (id, session_id, listing_id, ambassador_code, event_type, event_meta)
          VALUES ($1,$2,$3,$4,$5,$6)
        `, [
          uuid(), body.session_id ?? null, body.listing_id,
          body.ambassador_code ?? null, body.event_type,
          body.event_meta ? JSON.stringify(body.event_meta) : null,
        ]);

        // Update tracking link CTA counter
        if (body.ambassador_code && ['CTA_TAP','WHATSAPP_TAP','PHONE_TAP'].includes(body.event_type)) {
          await client.query(`
            UPDATE advert_tracking_links
            SET cta_taps = cta_taps + 1
            WHERE ambassador_code = $1
          `, [body.ambassador_code]);
        }
      });
      return reply.code(201).send({ ok: true });
    } catch (err) {
      app.log.error(err, 'advert.events.create.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // POST /api/advert/media-interactions — Track media interaction
  app.post('/advert/media-interactions', async (request, reply) => {
    const bodySchema = z.object({
      media_id: z.string().uuid(),
      listing_id: z.string().uuid(),
      session_id: z.string().uuid().optional().nullable(),
      ambassador_code: z.string().optional().nullable(),
      interaction_type: z.enum(['IMAGE_VIEW','VIDEO_PLAY','VIDEO_PAUSE','VIDEO_COMPLETE','DOCUMENT_OPEN']),
      watch_duration_secs: z.number().nonnegative().optional().nullable(),
      completion_pct: z.number().min(0).max(100).optional().nullable(),
    });

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch {
      return reply.code(400).send({ error: 'validation_error' });
    }

    try {
      await withTransaction(async (client) => {
        await client.query(`
          INSERT INTO advert_media_interactions
            (id, session_id, media_id, listing_id, ambassador_code,
             interaction_type, watch_duration_secs, completion_pct)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        `, [
          uuid(), body.session_id ?? null, body.media_id, body.listing_id,
          body.ambassador_code ?? null, body.interaction_type,
          body.watch_duration_secs ?? null, body.completion_pct ?? null,
        ]);

        // Update media counters
        if (body.interaction_type === 'IMAGE_VIEW') {
          await client.query(
            `UPDATE advert_media SET views = views + 1 WHERE id = $1`,
            [body.media_id]
          );
        } else if (body.interaction_type === 'VIDEO_PLAY') {
          await client.query(
            `UPDATE advert_media SET plays = plays + 1 WHERE id = $1`,
            [body.media_id]
          );
        } else if (body.interaction_type === 'VIDEO_COMPLETE' && body.watch_duration_secs) {
          await client.query(
            `UPDATE advert_media SET watch_time_secs = watch_time_secs + $2 WHERE id = $1`,
            [body.media_id, body.watch_duration_secs]
          );
        }
      });
      return reply.code(201).send({ ok: true });
    } catch (err) {
      app.log.error(err, 'advert.media_interactions.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ─── ANALYTICS DASHBOARD ─────────────────────

  // GET /api/advert/listings/:slug/analytics — Business analytics (auth)
  app.get('/advert/listings/:slug/analytics', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const userId = String((request.user as any)?.sub ?? '').trim();
    const query = request.query as { days?: string };
    const days = Math.min(90, Math.max(1, parseInt(query.days ?? '30', 10)));

    try {
      const data = await withTransaction(async (client) => {
        const listingRow = await client.query(
          `SELECT id, title, status, views_total, views_unique, listing_quality_score,
                  created_at, expires_at
           FROM advert_listings WHERE slug = $1 AND business_id = $2`,
          [slug, userId]
        );
        if (!listingRow.rows[0]) {
          throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
        }
        const listing = listingRow.rows[0];
        const listingId = listing.id;
        const since = new Date();
        since.setDate(since.getDate() - days);

        const [
          engagementSummary,
          ambassadorPerf,
          mediaPerf,
          deviceBreakdown,
          returnVsNew,
          offersSummary,
        ] = await Promise.all([
          // Engagement summary
          client.query(`
            SELECT event_type, COUNT(*) AS count
            FROM advert_engagement_events
            WHERE listing_id = $1 AND occurred_at >= $2
            GROUP BY event_type
          `, [listingId, since]),

          // Ambassador performance
          client.query(`
            SELECT
              tl.ambassador_code,
              u.full_name AS ambassador_name,
              tl.visits, tl.unique_visitors, tl.cta_taps, tl.offers_generated
            FROM advert_tracking_links tl
            LEFT JOIN users u ON u.id = tl.ambassador_id
            WHERE tl.listing_id = $1
            ORDER BY tl.visits DESC
            LIMIT 20
          `, [listingId]),

          // Media performance
          client.query(`
            SELECT
              m.id, m.media_type, m.url, m.media_pack,
              m.views, m.plays, m.watch_time_secs
            FROM advert_media m
            WHERE m.listing_id = $1
            ORDER BY m.views DESC, m.plays DESC
          `, [listingId]),

          // Device breakdown
          client.query(`
            SELECT device_type, COUNT(*) AS sessions
            FROM advert_page_sessions
            WHERE listing_id = $1 AND session_start >= $2
            GROUP BY device_type
          `, [listingId, since]),

          // Return vs new
          client.query(`
            SELECT is_return_visitor, COUNT(*) AS count
            FROM advert_page_sessions
            WHERE listing_id = $1 AND session_start >= $2
            GROUP BY is_return_visitor
          `, [listingId, since]),

          // Offers summary
          client.query(`
            SELECT status, COUNT(*) AS count
            FROM advert_offers WHERE listing_id = $1
            GROUP BY status
          `, [listingId]),
        ]);

        const engagementMap: Record<string, number> = {};
        for (const row of engagementSummary.rows) {
          engagementMap[row.event_type] = parseInt(row.count, 10);
        }

        const returnCount = returnVsNew.rows.find((r: any) => r.is_return_visitor)?.count ?? 0;
        const newCount = returnVsNew.rows.find((r: any) => !r.is_return_visitor)?.count ?? 0;

        return {
          listing: {
            title: listing.title,
            status: listing.status,
            views_total: listing.views_total,
            views_unique: listing.views_unique,
            quality_score: listing.listing_quality_score,
            created_at: listing.created_at,
            expires_at: listing.expires_at,
          },
          engagement: {
            cta_taps: engagementMap['CTA_TAP'] ?? 0,
            whatsapp_taps: engagementMap['WHATSAPP_TAP'] ?? 0,
            phone_taps: engagementMap['PHONE_TAP'] ?? 0,
            gallery_opens: engagementMap['GALLERY_OPEN'] ?? 0,
            map_opens: engagementMap['MAP_OPEN'] ?? 0,
            offer_starts: engagementMap['OFFER_START'] ?? 0,
            share_taps: engagementMap['SHARE_TAP'] ?? 0,
          },
          ambassadors: ambassadorPerf.rows,
          media: mediaPerf.rows,
          audience: {
            devices: deviceBreakdown.rows,
            return_visitors: parseInt(returnCount, 10),
            new_visitors: parseInt(newCount, 10),
          },
          offers: offersSummary.rows,
        };
      });

      return reply.send(data);
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      app.log.error(err, 'advert.analytics.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ─── OFFERS / NEGOTIATIONS ────────────────────

  // POST /api/advert/listings/:slug/offers
  app.post('/advert/listings/:slug/offers', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const bodySchema = z.object({
      offeror_name: z.string().min(2).max(100),
      offeror_phone: z.string().optional().nullable(),
      offeror_email: z.string().email().optional().nullable(),
      offer_amount: z.number().positive().optional().nullable(),
      offer_message: z.string().min(5).max(1000),
      visitor_fingerprint: z.string().optional().nullable(),
      ambassador_code: z.string().optional().nullable(),
    });

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch (err: any) {
      return reply.code(400).send({ error: 'validation_error', details: err.errors });
    }

    try {
      const offer = await withTransaction(async (client) => {
        const listingRow = await client.query(
          `SELECT id, currency, is_negotiable
           FROM advert_listings
           WHERE slug = $1
             AND status = 'ACTIVE'
             AND access_state = 'PUBLIC'`,
          [slug]
        );
        if (!listingRow.rows[0]) {
          throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
        }
        const listingId = listingRow.rows[0].id;

        const offerId = uuid();
        const offerRow = await client.query(`
          INSERT INTO advert_offers
            (id, listing_id, offeror_name, offeror_phone, offeror_email,
             offer_amount, currency, offer_message, visitor_fingerprint)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          RETURNING id, status, created_at
        `, [
          offerId, listingId, body.offeror_name,
          body.offeror_phone ?? null, body.offeror_email ?? null,
          body.offer_amount ?? null, listingRow.rows[0].currency,
          body.offer_message, body.visitor_fingerprint ?? null,
        ]);

        // Track offer in ambassador link
        if (body.ambassador_code) {
          await client.query(`
            UPDATE advert_tracking_links
            SET offers_generated = offers_generated + 1
            WHERE ambassador_code = $1
          `, [body.ambassador_code]);
        }

        return offerRow.rows[0];
      });

      return reply.code(201).send({ offer });
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      app.log.error(err, 'advert.offers.create.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // GET /api/advert/listings/:slug/offers — Business view of offers
  app.get('/advert/listings/:slug/offers', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const userId = String((request.user as any)?.sub ?? '').trim();

    try {
      const offers = await withTransaction(async (client) => {
        const listingRow = await client.query(
          `SELECT id FROM advert_listings WHERE slug = $1 AND business_id = $2`,
          [slug, userId]
        );
        if (!listingRow.rows[0]) {
          throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
        }

        const result = await client.query(`
          SELECT o.*,
            (SELECT JSON_AGG(m ORDER BY m.sent_at)
             FROM advert_offer_messages m
             WHERE m.offer_id = o.id) AS messages
          FROM advert_offers o
          WHERE o.listing_id = $1
          ORDER BY o.created_at DESC
        `, [listingRow.rows[0].id]);

        return result.rows;
      });

      return reply.send({ offers });
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      app.log.error(err, 'advert.offers.list.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // PATCH /api/advert/offers/:offerId — Business responds to offer
  app.patch('/advert/offers/:offerId', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const { offerId } = request.params as { offerId: string };
    const userId = String((request.user as any)?.sub ?? '').trim();

    const bodySchema = z.object({
      status: z.enum(['ACCEPTED','REJECTED','COUNTERED','CONTACTED','CLOSED']),
      counter_amount: z.number().positive().optional().nullable(),
      counter_message: z.string().max(500).optional().nullable(),
      business_note: z.string().max(500).optional().nullable(),
    });

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch (err: any) {
      return reply.code(400).send({ error: 'validation_error' });
    }

    try {
      const updated = await withTransaction(async (client) => {
        // Verify ownership
        const row = await client.query(`
          SELECT o.id FROM advert_offers o
          JOIN advert_listings al ON al.id = o.listing_id
          WHERE o.id = $1 AND al.business_id = $2
        `, [offerId, userId]);
        if (!row.rows[0]) {
          throw Object.assign(new Error('offer_not_found'), { statusCode: 404 });
        }

        const updated = await client.query(`
          UPDATE advert_offers
          SET status = $2, counter_amount = $3, counter_message = $4,
              business_note = $5, updated_at = now()
          WHERE id = $1
          RETURNING *
        `, [
          offerId, body.status,
          body.counter_amount ?? null, body.counter_message ?? null,
          body.business_note ?? null,
        ]);

        return updated.rows[0];
      });

      return reply.send({ offer: updated });
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      app.log.error(err, 'advert.offers.update.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // POST /api/advert/offers/:offerId/messages — Add message to offer thread
  app.post('/advert/offers/:offerId/messages', async (request, reply) => {
    const { offerId } = request.params as { offerId: string };
    const bodySchema = z.object({
      sender_role: z.enum(['BUYER','BUSINESS']),
      message: z.string().min(1).max(1000),
      visitor_fingerprint: z.string().optional().nullable(),
    });

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch {
      return reply.code(400).send({ error: 'validation_error' });
    }

    try {
      const msg = await withTransaction(async (client) => {
        const offerRow = await client.query(
          `SELECT id FROM advert_offers WHERE id = $1`,
          [offerId]
        );
        if (!offerRow.rows[0]) {
          throw Object.assign(new Error('offer_not_found'), { statusCode: 404 });
        }

        const result = await client.query(`
          INSERT INTO advert_offer_messages (id, offer_id, sender_role, message)
          VALUES ($1,$2,$3,$4) RETURNING *
        `, [uuid(), offerId, body.sender_role, body.message]);

        return result.rows[0];
      });

      return reply.code(201).send({ message: msg });
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      app.log.error(err, 'advert.offer_messages.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ─── ADMIN: LISTINGS LIST ────────────────────────────────────────────────

  // GET /api/admin/advert/listings — Admin: list all listings across all businesses
  app.get('/admin/advert/listings', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const query = request.query as {
      page?: string; limit?: string; status?: string; search?: string;
    };
    const page  = Math.max(1, parseInt(query.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '30', 10)));
    const offset = (page - 1) * limit;

    try {
      const result = await withTransaction(async (client) => {
        // 'DRAFT' is not a status value — drafts are identified by is_draft=TRUE
        const isDraftFilter = query.status === 'DRAFT';
        const statusParam   = isDraftFilter ? null : (query.status ?? null);

        const rows = await client.query(`
          SELECT
            al.id, al.slug, al.title, al.status, al.access_state,
            al.is_draft,
            al.is_promoted, al.admin_keep_alive, al.admin_action_note, al.admin_action_at,
            al.views_total, al.views_unique, al.listing_quality_score,
            al.campaign_start_at, al.campaign_end_at,
            al.created_at,
            EXTRACT(EPOCH FROM (al.campaign_end_at - now()))::bigint AS time_remaining_secs,
            u.full_name AS business_name, u.email AS business_email,
            COALESCE(c.id, al.campaign_id) AS campaign_id,
            COALESCE(lt.name, '—')  AS listing_type_name,
            COALESCE(s.name,  '—')  AS subcategory_name,
            COALESCE(cat.name,'—')  AS category_name,
            (SELECT COUNT(*) FROM advert_offers o WHERE o.listing_id = al.id AND o.status = 'PENDING') AS pending_offers
          FROM advert_listings al
          JOIN users u ON u.id = al.business_id
          LEFT JOIN campaigns c ON c.id = al.campaign_id
          LEFT JOIN advert_listing_types lt  ON lt.id  = al.listing_type_id
          LEFT JOIN advert_subcategories s   ON s.id   = lt.subcategory_id
          LEFT JOIN advert_categories cat    ON cat.id = s.category_id
          WHERE ($3::boolean IS NULL OR al.is_draft = $3)
            AND ($4::text IS NULL OR al.status = $4)
            AND ($5::text IS NULL OR
                 al.title      ILIKE '%' || $5 || '%' OR
                 u.full_name   ILIKE '%' || $5 || '%' OR
                 al.slug       ILIKE '%' || $5 || '%')
          ORDER BY al.is_promoted DESC, al.created_at DESC
          LIMIT $1 OFFSET $2
        `, [limit, offset,
            isDraftFilter ? true : null,
            statusParam,
            query.search ?? null]);

        const countRow = await client.query(`
          SELECT COUNT(*) FROM advert_listings al
          JOIN users u ON u.id = al.business_id
          WHERE ($1::boolean IS NULL OR al.is_draft = $1)
            AND ($2::text IS NULL OR al.status = $2)
            AND ($3::text IS NULL OR
                 al.title      ILIKE '%' || $3 || '%' OR
                 u.full_name   ILIKE '%' || $3 || '%' OR
                 al.slug       ILIKE '%' || $3 || '%')
        `, [isDraftFilter ? true : null, statusParam, query.search ?? null]);

        return {
          listings: rows.rows,
          total: parseInt(countRow.rows[0]?.count ?? '0', 10),
          page,
          limit,
        };
      });
      return reply.send(result);
    } catch (err: any) {
      if (err?.code === '42P01') return reply.send({ listings: [], total: 0, page, limit });
      app.log.error(err, 'admin.advert.listings.list.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ─── ADMIN: KEEP-ALIVE OVERRIDE ──────────────────────────────────────────

  app.patch('/admin/advert/listings/:slug/actions', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const adminUserId = String((request.user as any)?.sub ?? '').trim();
    const bodySchema = z.object({
      action: z.enum([
        'REVOKE_URL',
        'RESTORE_URL',
        'BAN',
        'UNBAN',
        'CLOSE',
        'REOPEN',
        'PROMOTE',
        'DEMOTE',
      ]),
      note: z.string().max(500).optional().nullable(),
    });

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch {
      return reply.code(400).send({ error: 'validation_error' });
    }

    try {
      const updated = await withTransaction(async (client) => {
        const row = await client.query(
          `SELECT slug, access_state, is_promoted FROM advert_listings WHERE slug = $1`,
          [slug]
        );
        if (!row.rows[0]) {
          throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
        }

        const action = body.action;
        const nextAccessState =
          action === 'REVOKE_URL'
            ? 'REVOKED'
            : action === 'BAN'
              ? 'BANNED'
              : action === 'CLOSE'
                ? 'CLOSED'
                : action === 'RESTORE_URL' || action === 'UNBAN' || action === 'REOPEN'
                  ? 'PUBLIC'
                  : String(row.rows[0].access_state ?? 'PUBLIC');
        const nextPromoted =
          action === 'PROMOTE'
            ? true
            : action === 'DEMOTE'
              ? false
              : Boolean(row.rows[0].is_promoted);

        const result = await client.query(`
          UPDATE advert_listings
          SET access_state = $2,
              is_promoted = $3,
              admin_action_note = $4,
              admin_action_at = now(),
              admin_action_by_user_id = $5,
              updated_at = now()
          WHERE slug = $1
          RETURNING id, slug, status, access_state, is_promoted, admin_action_note, admin_action_at, admin_keep_alive, campaign_end_at
        `, [
          slug,
          nextAccessState,
          nextPromoted,
          body.note ?? null,
          adminUserId || null,
        ]);
        return result.rows[0];
      });

      return reply.send({ listing: updated });
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      app.log.error(err, 'advert.admin_action.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // PATCH /api/advert/listings/:slug/admin-keep-alive
  // Allows admins to keep a listing accessible after its campaign has ended.
  app.patch('/advert/listings/:slug/admin-keep-alive', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const bodySchema = z.object({
      keep_alive: z.boolean(),
      extend_until: z.string().optional().nullable(), // ISO date, optional new deadline
    });

    let body: z.infer<typeof bodySchema>;
    try {
      body = bodySchema.parse(request.body);
    } catch {
      return reply.code(400).send({ error: 'validation_error' });
    }

    try {
      const updated = await withTransaction(async (client) => {
        const row = await client.query(
          `SELECT id FROM advert_listings WHERE slug = $1`,
          [slug]
        );
        if (!row.rows[0]) {
          throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
        }

        const result = await client.query(`
          UPDATE advert_listings
          SET
            admin_keep_alive = $2,
            status = CASE
              WHEN $2 = TRUE THEN 'ACTIVE'
              ELSE status
            END,
            campaign_end_at = CASE
              WHEN $3::timestamptz IS NOT NULL THEN $3::timestamptz
              ELSE campaign_end_at
            END,
            expires_at = CASE
              WHEN $3::timestamptz IS NOT NULL THEN $3::timestamptz
              ELSE expires_at
            END,
            updated_at = now()
          WHERE slug = $1
          RETURNING id, slug, status, admin_keep_alive, campaign_end_at
        `, [slug, body.keep_alive, body.extend_until ?? null]);

        return result.rows[0];
      });

      return reply.send({ listing: updated });
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      app.log.error(err, 'advert.admin_keep_alive.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ─── ADMIN: SINGLE LISTING DETAIL ────────────────────────────────────────
  app.get('/admin/advert/listings/:slug', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    try {
      const result = await withTransaction(async (client) => {
        const row = await client.query(`
          SELECT
            al.*,
            u.full_name AS business_name, u.email AS business_email, u.phone AS business_phone,
            lt.name AS listing_type_name,
            s.name AS subcategory_name,
            cat.name AS category_name, cat.id AS category_id,
            s.id AS subcategory_id,
            EXTRACT(EPOCH FROM (al.campaign_end_at - now()))::bigint AS time_remaining_secs,
            c.id AS campaign_id, c.status AS campaign_status,
            c.budget_total AS campaign_budget, c.payout_amount AS campaign_payout,
            (SELECT COUNT(*) FROM advert_offers o WHERE o.listing_id = al.id) AS total_offers,
            (SELECT COUNT(*) FROM advert_offers o WHERE o.listing_id = al.id AND o.status = 'PENDING') AS pending_offers,
            (SELECT COUNT(*) FROM advert_media am WHERE am.listing_id = al.id) AS media_count,
            (SELECT COUNT(*) FROM advert_tracking_links tl WHERE tl.listing_id = al.id) AS tracking_links_count,
            (SELECT COUNT(*) FROM advert_page_sessions ps WHERE ps.listing_id = al.id) AS session_count
          FROM advert_listings al
          JOIN users u ON u.id = al.business_id
          LEFT JOIN campaigns c ON c.id = al.campaign_id
          LEFT JOIN advert_listing_types lt ON lt.id = al.listing_type_id
          LEFT JOIN advert_subcategories s ON s.id = lt.subcategory_id
          LEFT JOIN advert_categories cat ON cat.id = s.category_id
          WHERE al.slug = $1
        `, [slug]);
        if (!row.rows[0]) throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
        const media = await client.query(
          `SELECT id, media_pack, media_type, url, thumbnail_url, file_name, mime_type, file_size_bytes, sort_order, created_at
           FROM advert_media WHERE listing_id = $1 ORDER BY media_pack, sort_order`,
          [row.rows[0].id]
        );
        return { listing: row.rows[0], media: media.rows };
      });
      return reply.send(result);
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      app.log.error(err, 'admin.advert.listing.detail.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ─── ADMIN: PLATFORM-WIDE ANALYTICS ──────────────────────────────────────
  app.get('/admin/advert/analytics', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const query = request.query as { days?: string };
    const days = Math.min(90, Math.max(1, parseInt(query.days ?? '30', 10)));
    try {
      const result = await withTransaction(async (client) => {
        const [overview, topListings, categoryBreakdown, eventBreakdown, offerStats] = await Promise.all([
          client.query(`
            SELECT
              (SELECT COUNT(*) FROM advert_listings) AS total_listings,
              (SELECT COUNT(*) FROM advert_listings WHERE status = 'ACTIVE') AS active_listings,
              (SELECT COUNT(*) FROM advert_listings WHERE status = 'DRAFT') AS draft_listings,
              (SELECT COUNT(*) FROM advert_listings WHERE status = 'EXPIRED') AS expired_listings,
              (SELECT COALESCE(SUM(views_total),0) FROM advert_listings) AS total_views,
              (SELECT COALESCE(SUM(views_unique),0) FROM advert_listings) AS total_unique_views,
              (SELECT COUNT(*) FROM advert_offers) AS total_offers,
              (SELECT COUNT(*) FROM advert_offers WHERE status = 'PENDING') AS pending_offers,
              (SELECT COUNT(*) FROM advert_offers WHERE status = 'ACCEPTED') AS accepted_offers,
              (SELECT COUNT(*) FROM advert_page_sessions WHERE session_start > now() - ($1::int * interval '1 day')) AS recent_sessions,
              (SELECT COUNT(*) FROM advert_engagement_events WHERE event_type = 'WHATSAPP_TAP' AND occurred_at > now() - ($1::int * interval '1 day')) AS whatsapp_taps,
              (SELECT COUNT(*) FROM advert_engagement_events WHERE event_type = 'PHONE_TAP' AND occurred_at > now() - ($1::int * interval '1 day')) AS phone_taps,
              (SELECT COUNT(*) FROM advert_engagement_events WHERE event_type = 'EMAIL_TAP' AND occurred_at > now() - ($1::int * interval '1 day')) AS email_taps,
              (SELECT COUNT(*) FROM advert_engagement_events WHERE event_type = 'OUTBOUND_TAP' AND occurred_at > now() - ($1::int * interval '1 day')) AS outbound_taps,
              (SELECT COUNT(*) FROM advert_engagement_events WHERE occurred_at > now() - ($1::int * interval '1 day')) AS total_events,
              (SELECT COUNT(*) FROM advert_media) AS total_media_assets,
              (SELECT COUNT(*) FROM advert_tracking_links) AS total_tracking_links
          `, [days]),
          client.query(`
            SELECT al.id, al.slug, al.title, al.views_total, al.views_unique, al.listing_quality_score, al.status,
              (SELECT COUNT(*) FROM advert_offers o WHERE o.listing_id = al.id) AS offer_count,
              u.full_name AS business_name
            FROM advert_listings al
            JOIN users u ON u.id = al.business_id
            ORDER BY al.views_total DESC LIMIT 10
          `),
          client.query(`
            SELECT cat.name AS category, COUNT(al.id) AS listing_count, COALESCE(SUM(al.views_total),0) AS views
            FROM advert_listings al
            JOIN advert_listing_types lt ON lt.id = al.listing_type_id
            JOIN advert_subcategories s ON s.id = lt.subcategory_id
            JOIN advert_categories cat ON cat.id = s.category_id
            GROUP BY cat.name ORDER BY listing_count DESC
          `),
          client.query(`
            SELECT event_type, COUNT(*) AS count
            FROM advert_engagement_events
            WHERE occurred_at > now() - ($1::int * interval '1 day')
            GROUP BY event_type ORDER BY count DESC
          `, [days]),
          client.query(`
            SELECT
              COUNT(*) FILTER (WHERE status = 'PENDING') AS pending,
              COUNT(*) FILTER (WHERE status = 'ACCEPTED') AS accepted,
              COUNT(*) FILTER (WHERE status = 'REJECTED') AS rejected,
              COUNT(*) FILTER (WHERE status = 'COUNTERED') AS countered,
              COUNT(*) FILTER (WHERE status = 'CLOSED') AS closed,
              COALESCE(AVG(offer_amount) FILTER (WHERE offer_amount IS NOT NULL), 0)::numeric(12,2) AS avg_offer_amount
            FROM advert_offers
            WHERE created_at > now() - ($1::int * interval '1 day')
          `, [days]),
        ]);
        return {
          overview: overview.rows[0],
          top_listings: topListings.rows,
          category_breakdown: categoryBreakdown.rows,
          event_breakdown: eventBreakdown.rows,
          offer_stats: offerStats.rows[0],
          period_days: days,
        };
      });
      return reply.send(result);
    } catch (err: any) {
      // 42P01 = undefined_table — advert schema not yet migrated; return zeroed data
      if (err?.code === '42P01') {
        return reply.send({
          overview: {
            total_listings: 0, active_listings: 0, draft_listings: 0, expired_listings: 0,
            total_views: 0, total_unique_views: 0, total_offers: 0, pending_offers: 0,
            accepted_offers: 0, recent_sessions: 0, whatsapp_taps: 0, phone_taps: 0,
            email_taps: 0, outbound_taps: 0, total_events: 0, total_media_assets: 0,
            total_tracking_links: 0,
          },
          top_listings: [],
          category_breakdown: [],
          event_breakdown: [],
          offer_stats: { pending: 0, accepted: 0, rejected: 0, countered: 0, closed: 0, avg_offer_amount: '0.00' },
          period_days: days,
        });
      }
      app.log.error(err, 'admin.advert.analytics.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ─── ADMIN: PER-LISTING ANALYTICS ────────────────────────────────────────
  app.get('/admin/advert/listings/:slug/analytics', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const query = request.query as { days?: string };
    const days = Math.min(90, Math.max(1, parseInt(query.days ?? '30', 10)));
    try {
      const result = await withTransaction(async (client) => {
        const listingRow = await client.query(
          `SELECT id, title, views_total, views_unique FROM advert_listings WHERE slug = $1`,
          [slug]
        );
        if (!listingRow.rows[0]) throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
        const listingId = listingRow.rows[0].id;
        const [sessions, events, offers, mediaInteractions, trackingLinks] = await Promise.all([
          client.query(`
            SELECT COUNT(*) AS total_sessions,
              COUNT(DISTINCT visitor_fingerprint) FILTER (WHERE visitor_fingerprint IS NOT NULL) AS unique_visitors,
              COALESCE(AVG(session_duration_secs) FILTER (WHERE session_duration_secs > 0), 0)::numeric(10,2) AS avg_duration_secs,
              COALESCE(AVG(scroll_depth_pct) FILTER (WHERE scroll_depth_pct > 0), 0)::numeric(10,2) AS avg_scroll_depth,
              COUNT(*) FILTER (WHERE device_type = 'mobile') AS mobile_sessions,
              COUNT(*) FILTER (WHERE device_type = 'desktop') AS desktop_sessions,
              COUNT(*) FILTER (WHERE device_type = 'tablet') AS tablet_sessions
            FROM advert_page_sessions
            WHERE listing_id = $1 AND session_start > now() - ($2::int * interval '1 day')
          `, [listingId, days]),
          client.query(`
            SELECT event_type, COUNT(*) AS count
            FROM advert_engagement_events
            WHERE listing_id = $1 AND occurred_at > now() - ($2::int * interval '1 day')
            GROUP BY event_type ORDER BY count DESC
          `, [listingId, days]),
          client.query(`
            SELECT status, COUNT(*) AS count, COALESCE(AVG(offer_amount),0)::numeric(12,2) AS avg_amount
            FROM advert_offers WHERE listing_id = $1
            GROUP BY status ORDER BY count DESC
          `, [listingId]),
          client.query(`
            SELECT interaction_type, COUNT(*) AS count
            FROM advert_media_interactions
            WHERE listing_id = $1 AND created_at > now() - ($2::int * interval '1 day')
            GROUP BY interaction_type ORDER BY count DESC
          `, [listingId, days]),
          client.query(`
            SELECT tl.ambassador_code, u.full_name AS ambassador_name,
              (SELECT COUNT(*) FROM advert_page_sessions ps WHERE ps.ambassador_code = tl.ambassador_code AND ps.listing_id = $1) AS sessions,
              (SELECT COUNT(*) FROM advert_offers o WHERE o.ambassador_code = tl.ambassador_code AND o.listing_id = $1) AS offers
            FROM advert_tracking_links tl
            JOIN users u ON u.id = tl.ambassador_id
            WHERE tl.listing_id = $1
          `, [listingId]),
        ]);
        return {
          listing: listingRow.rows[0],
          sessions: sessions.rows[0],
          events: events.rows,
          offers: offers.rows,
          media_interactions: mediaInteractions.rows,
          tracking_links: trackingLinks.rows,
          period_days: days,
        };
      });
      return reply.send(result);
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      app.log.error(err, 'admin.advert.listing.analytics.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ─── ADMIN: LISTING MEDIA ─────────────────────────────────────────────────
  app.get('/admin/advert/listings/:slug/media', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    try {
      const result = await withTransaction(async (client) => {
        const row = await client.query(`SELECT id FROM advert_listings WHERE slug = $1`, [slug]);
        if (!row.rows[0]) throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
        const media = await client.query(
          `SELECT id, media_pack, media_type, url, thumbnail_url, file_name, mime_type, file_size_bytes, sort_order, created_at
           FROM advert_media WHERE listing_id = $1 ORDER BY media_pack, sort_order`,
          [row.rows[0].id]
        );
        return { media: media.rows, listing_id: row.rows[0].id };
      });
      return reply.send(result);
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  app.delete('/admin/advert/listings/:slug/media/:mediaId', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const { slug, mediaId } = request.params as { slug: string; mediaId: string };
    try {
      await withTransaction(async (client) => {
        const row = await client.query(`SELECT id FROM advert_listings WHERE slug = $1`, [slug]);
        if (!row.rows[0]) throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
        await client.query(`DELETE FROM advert_media WHERE id = $1 AND listing_id = $2`, [mediaId, row.rows[0].id]);
      });
      return reply.send({ deleted: true });
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ─── ADMIN: OFFERS ────────────────────────────────────────────────────────
  app.get('/admin/advert/offers', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const query = request.query as { page?: string; limit?: string; status?: string; search?: string };
    const page = Math.max(1, parseInt(query.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '30', 10)));
    const offset = (page - 1) * limit;
    try {
      const result = await withTransaction(async (client) => {
        const rows = await client.query(`
          SELECT o.*, al.slug AS listing_slug, al.title AS listing_title,
            u.full_name AS business_name
          FROM advert_offers o
          JOIN advert_listings al ON al.id = o.listing_id
          JOIN users u ON u.id = al.business_id
          WHERE ($3::text IS NULL OR o.status = $3)
            AND ($4::text IS NULL OR
                 al.title ILIKE '%' || $4 || '%' OR
                 o.offeror_name ILIKE '%' || $4 || '%')
          ORDER BY o.created_at DESC
          LIMIT $1 OFFSET $2
        `, [limit, offset, query.status ?? null, query.search ?? null]);
        const countRow = await client.query(`
          SELECT COUNT(*) FROM advert_offers o
          JOIN advert_listings al ON al.id = o.listing_id
          WHERE ($1::text IS NULL OR o.status = $1)
            AND ($2::text IS NULL OR al.title ILIKE '%' || $2 || '%' OR o.offeror_name ILIKE '%' || $2 || '%')
        `, [query.status ?? null, query.search ?? null]);
        return { offers: rows.rows, total: parseInt(countRow.rows[0]?.count ?? '0', 10), page, limit };
      });
      return reply.send(result);
    } catch (err: any) {
      if (err?.code === '42P01') return reply.send({ offers: [], total: 0, page, limit });
      app.log.error(err, 'admin.advert.offers.list.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  app.patch('/admin/advert/offers/:offerId', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const { offerId } = request.params as { offerId: string };
    const bodySchema = z.object({
      status: z.enum(['PENDING', 'ACCEPTED', 'REJECTED', 'COUNTERED', 'CONTACTED', 'CLOSED']).optional(),
      admin_note: z.string().max(500).optional().nullable(),
    });
    let body: z.infer<typeof bodySchema>;
    try { body = bodySchema.parse(request.body); } catch { return reply.code(400).send({ error: 'validation_error' }); }
    try {
      const result = await withTransaction(async (client) => {
        const fields: string[] = [];
        const vals: unknown[] = [offerId];
        if (body.status) { fields.push(`status = $${vals.length + 1}`); vals.push(body.status); }
        if (body.admin_note !== undefined) { fields.push(`admin_note = $${vals.length + 1}`); vals.push(body.admin_note); }
        if (!fields.length) throw Object.assign(new Error('no_fields'), { statusCode: 400 });
        fields.push(`updated_at = now()`);
        const row = await client.query(
          `UPDATE advert_offers SET ${fields.join(', ')} WHERE id = $1 RETURNING *`,
          vals
        );
        if (!row.rows[0]) throw Object.assign(new Error('offer_not_found'), { statusCode: 404 });
        return { offer: row.rows[0] };
      });
      return reply.send(result);
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ─── ADMIN: TAXONOMY — CATEGORIES ────────────────────────────────────────
  app.get('/admin/advert/categories', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    try {
      const result = await withTransaction(async (client) => {
        const rows = await client.query(`
          SELECT cat.*, COUNT(DISTINCT s.id) AS subcategory_count, COUNT(DISTINCT al.id) AS listing_count
          FROM advert_categories cat
          LEFT JOIN advert_subcategories s ON s.category_id = cat.id
          LEFT JOIN advert_listing_types lt ON lt.subcategory_id = s.id
          LEFT JOIN advert_listings al ON al.listing_type_id = lt.id
          GROUP BY cat.id ORDER BY cat.name
        `);
        return { categories: rows.rows };
      });
      return reply.send(result);
    } catch (err: any) {
      if (err?.code === '42P01') return reply.send({ categories: [] });
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  app.post('/admin/advert/categories', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const bodySchema = z.object({
      name: z.string().min(2).max(80),
      icon: z.string().max(10).optional().nullable(),
      description: z.string().max(300).optional().nullable(),
    });
    let body: z.infer<typeof bodySchema>;
    try { body = bodySchema.parse(request.body); } catch { return reply.code(400).send({ error: 'validation_error' }); }
    try {
      const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const result = await withTransaction(async (client) => {
        const row = await client.query(
          `INSERT INTO advert_categories (name, slug, icon, description) VALUES ($1, $2, $3, $4) RETURNING *`,
          [body.name, slug, body.icon ?? null, body.description ?? null]
        );
        return { category: row.rows[0] };
      });
      return reply.code(201).send(result);
    } catch (err: any) {
      if (String(err.code) === '23505') return reply.code(409).send({ error: 'category_exists' });
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  app.patch('/admin/advert/categories/:categoryId', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const { categoryId } = request.params as { categoryId: string };
    const bodySchema = z.object({
      name: z.string().min(2).max(80).optional(),
      icon: z.string().max(10).optional().nullable(),
      description: z.string().max(300).optional().nullable(),
    });
    let body: z.infer<typeof bodySchema>;
    try { body = bodySchema.parse(request.body); } catch { return reply.code(400).send({ error: 'validation_error' }); }
    try {
      const result = await withTransaction(async (client) => {
        const fields: string[] = [];
        const vals: unknown[] = [categoryId];
        if (body.name) { fields.push(`name = $${vals.length + 1}`); vals.push(body.name); }
        if (body.icon !== undefined) { fields.push(`icon = $${vals.length + 1}`); vals.push(body.icon); }
        if (body.description !== undefined) { fields.push(`description = $${vals.length + 1}`); vals.push(body.description); }
        if (!fields.length) return reply.code(400).send({ error: 'no_fields' });
        const row = await client.query(
          `UPDATE advert_categories SET ${fields.join(', ')} WHERE id = $1 RETURNING *`, vals
        );
        if (!row.rows[0]) throw Object.assign(new Error('not_found'), { statusCode: 404 });
        return { category: row.rows[0] };
      });
      return reply.send(result);
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ─── ADMIN: TAXONOMY — SUBCATEGORIES ─────────────────────────────────────
  app.get('/admin/advert/subcategories', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const query = request.query as { category_id?: string };
    try {
      const result = await withTransaction(async (client) => {
        const rows = await client.query(`
          SELECT s.*, cat.name AS category_name,
            COUNT(DISTINCT lt.id) AS listing_type_count
          FROM advert_subcategories s
          JOIN advert_categories cat ON cat.id = s.category_id
          LEFT JOIN advert_listing_types lt ON lt.subcategory_id = s.id
          WHERE ($1::uuid IS NULL OR s.category_id = $1::uuid)
          GROUP BY s.id, cat.name ORDER BY cat.name, s.name
        `, [query.category_id ?? null]);
        return { subcategories: rows.rows };
      });
      return reply.send(result);
    } catch (err: any) {
      if (err?.code === '42P01') return reply.send({ subcategories: [] });
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  app.post('/admin/advert/subcategories', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const bodySchema = z.object({
      category_id: z.string().uuid(),
      name: z.string().min(2).max(80),
      description: z.string().max(300).optional().nullable(),
    });
    let body: z.infer<typeof bodySchema>;
    try { body = bodySchema.parse(request.body); } catch { return reply.code(400).send({ error: 'validation_error' }); }
    try {
      const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const result = await withTransaction(async (client) => {
        const row = await client.query(
          `INSERT INTO advert_subcategories (category_id, name, slug) VALUES ($1, $2, $3) RETURNING *`,
          [body.category_id, body.name, slug]
        );
        return { subcategory: row.rows[0] };
      });
      return reply.code(201).send(result);
    } catch (err: any) {
      if (String(err.code) === '23505') return reply.code(409).send({ error: 'subcategory_exists' });
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  app.patch('/admin/advert/subcategories/:subcategoryId', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const { subcategoryId } = request.params as { subcategoryId: string };
    const bodySchema = z.object({ name: z.string().min(2).max(80).optional() });
    let body: z.infer<typeof bodySchema>;
    try { body = bodySchema.parse(request.body); } catch { return reply.code(400).send({ error: 'validation_error' }); }
    try {
      const result = await withTransaction(async (client) => {
        const row = await client.query(
          `UPDATE advert_subcategories SET name = COALESCE($2, name) WHERE id = $1 RETURNING *`,
          [subcategoryId, body.name ?? null]
        );
        if (!row.rows[0]) throw Object.assign(new Error('not_found'), { statusCode: 404 });
        return { subcategory: row.rows[0] };
      });
      return reply.send(result);
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ─── ADMIN: TAXONOMY — LISTING TYPES ─────────────────────────────────────
  app.get('/admin/advert/listing-types', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const query = request.query as { subcategory_id?: string };
    try {
      const result = await withTransaction(async (client) => {
        const rows = await client.query(`
          SELECT lt.*, s.name AS subcategory_name, cat.name AS category_name,
            COUNT(DISTINCT fd.id) AS field_count,
            COUNT(DISTINCT al.id) AS listing_count
          FROM advert_listing_types lt
          JOIN advert_subcategories s ON s.id = lt.subcategory_id
          JOIN advert_categories cat ON cat.id = s.category_id
          LEFT JOIN advert_field_definitions fd ON fd.listing_type_id = lt.id
          LEFT JOIN advert_listings al ON al.listing_type_id = lt.id
          WHERE ($1::uuid IS NULL OR lt.subcategory_id = $1::uuid)
          GROUP BY lt.id, s.name, cat.name ORDER BY cat.name, s.name, lt.name
        `, [query.subcategory_id ?? null]);
        return { listing_types: rows.rows };
      });
      return reply.send(result);
    } catch (err: any) {
      if (err?.code === '42P01') return reply.send({ listing_types: [] });
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  app.post('/admin/advert/listing-types', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const bodySchema = z.object({
      subcategory_id: z.string().uuid(),
      name: z.string().min(2).max(80),
      description: z.string().max(300).optional().nullable(),
    });
    let body: z.infer<typeof bodySchema>;
    try { body = bodySchema.parse(request.body); } catch { return reply.code(400).send({ error: 'validation_error' }); }
    try {
      const slug = body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const result = await withTransaction(async (client) => {
        const row = await client.query(
          `INSERT INTO advert_listing_types (subcategory_id, name, slug) VALUES ($1, $2, $3) RETURNING *`,
          [body.subcategory_id, body.name, slug]
        );
        return { listing_type: row.rows[0] };
      });
      return reply.code(201).send(result);
    } catch (err: any) {
      if (String(err.code) === '23505') return reply.code(409).send({ error: 'type_exists' });
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  app.patch('/admin/advert/listing-types/:typeId', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const { typeId } = request.params as { typeId: string };
    const bodySchema = z.object({ name: z.string().min(2).max(80).optional() });
    let body: z.infer<typeof bodySchema>;
    try { body = bodySchema.parse(request.body); } catch { return reply.code(400).send({ error: 'validation_error' }); }
    try {
      const result = await withTransaction(async (client) => {
        const row = await client.query(
          `UPDATE advert_listing_types SET name = COALESCE($2, name) WHERE id = $1 RETURNING *`,
          [typeId, body.name ?? null]
        );
        if (!row.rows[0]) throw Object.assign(new Error('not_found'), { statusCode: 404 });
        return { listing_type: row.rows[0] };
      });
      return reply.send(result);
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ─── ADMIN: TAXONOMY — FIELD DEFINITIONS ─────────────────────────────────
  app.get('/admin/advert/field-definitions', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const query = request.query as { listing_type_id?: string };
    try {
      const result = await withTransaction(async (client) => {
        const rows = await client.query(`
          SELECT fd.*, lt.name AS listing_type_name
          FROM advert_field_definitions fd
          JOIN advert_listing_types lt ON lt.id = fd.listing_type_id
          WHERE ($1::uuid IS NULL OR fd.listing_type_id = $1::uuid)
          ORDER BY fd.listing_type_id, fd.sort_order
        `, [query.listing_type_id ?? null]);
        return { field_definitions: rows.rows };
      });
      return reply.send(result);
    } catch (err: any) {
      if (err?.code === '42P01') return reply.send({ field_definitions: [] });
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  app.post('/admin/advert/field-definitions', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const bodySchema = z.object({
      listing_type_id: z.string().uuid(),
      field_key: z.string().min(2).max(60),
      label: z.string().min(2).max(80),
      field_type: z.enum(['TEXT', 'NUMBER', 'SELECT', 'MULTISELECT', 'BOOLEAN', 'DATE']),
      is_required: z.boolean().default(false),
      sort_order: z.number().int().min(0).default(0),
      options_json: z.any().optional().nullable(),
    });
    let body: z.infer<typeof bodySchema>;
    try { body = bodySchema.parse(request.body); } catch { return reply.code(400).send({ error: 'validation_error' }); }
    try {
      const result = await withTransaction(async (client) => {
        const row = await client.query(
          `INSERT INTO advert_field_definitions (listing_type_id, field_key, label, field_type, is_required, sort_order, options_json)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [body.listing_type_id, body.field_key, body.label, body.field_type, body.is_required, body.sort_order, body.options_json ? JSON.stringify(body.options_json) : null]
        );
        return { field_definition: row.rows[0] };
      });
      return reply.code(201).send(result);
    } catch (err: any) {
      if (String(err.code) === '23505') return reply.code(409).send({ error: 'field_exists' });
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  app.patch('/admin/advert/field-definitions/:fieldId', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const { fieldId } = request.params as { fieldId: string };
    const bodySchema = z.object({
      label: z.string().min(2).max(80).optional(),
      is_required: z.boolean().optional(),
      sort_order: z.number().int().min(0).optional(),
      options_json: z.any().optional().nullable(),
    });
    let body: z.infer<typeof bodySchema>;
    try { body = bodySchema.parse(request.body); } catch { return reply.code(400).send({ error: 'validation_error' }); }
    try {
      const result = await withTransaction(async (client) => {
        const fields: string[] = [];
        const vals: unknown[] = [fieldId];
        if (body.label !== undefined) { fields.push(`label = $${vals.length + 1}`); vals.push(body.label); }
        if (body.is_required !== undefined) { fields.push(`is_required = $${vals.length + 1}`); vals.push(body.is_required); }
        if (body.sort_order !== undefined) { fields.push(`sort_order = $${vals.length + 1}`); vals.push(body.sort_order); }
        if (body.options_json !== undefined) { fields.push(`options_json = $${vals.length + 1}`); vals.push(body.options_json ? JSON.stringify(body.options_json) : null); }
        if (!fields.length) return reply.code(400).send({ error: 'no_fields' });
        const row = await client.query(
          `UPDATE advert_field_definitions SET ${fields.join(', ')} WHERE id = $1 RETURNING *`, vals
        );
        if (!row.rows[0]) throw Object.assign(new Error('not_found'), { statusCode: 404 });
        return { field_definition: row.rows[0] };
      });
      return reply.send(result);
    } catch (err: any) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message });
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  app.delete('/admin/advert/field-definitions/:fieldId', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const { fieldId } = request.params as { fieldId: string };
    try {
      await withTransaction(async (client) => {
        await client.query(`DELETE FROM advert_field_definitions WHERE id = $1`, [fieldId]);
      });
      return reply.send({ deleted: true });
    } catch (err) {
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ─── ADMIN: TRACKING LINKS ────────────────────────────────────────────────
  app.get('/admin/advert/tracking-links', {
    preHandler: [(app as any).adminOnly],
  }, async (request, reply) => {
    const query = request.query as { page?: string; limit?: string; search?: string };
    const page = Math.max(1, parseInt(query.page ?? '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '30', 10)));
    const offset = (page - 1) * limit;
    try {
      const result = await withTransaction(async (client) => {
        const rows = await client.query(`
          SELECT tl.id, tl.ambassador_code, tl.created_at,
            al.slug AS listing_slug, al.title AS listing_title,
            u.full_name AS ambassador_name, u.phone AS ambassador_phone,
            (SELECT COUNT(*) FROM advert_page_sessions ps WHERE ps.ambassador_code = tl.ambassador_code AND ps.listing_id = tl.listing_id) AS sessions,
            (SELECT COUNT(*) FROM advert_offers o WHERE o.ambassador_code = tl.ambassador_code AND o.listing_id = tl.listing_id) AS offers_generated
          FROM advert_tracking_links tl
          JOIN advert_listings al ON al.id = tl.listing_id
          JOIN users u ON u.id = tl.ambassador_id
          WHERE ($3::text IS NULL OR u.full_name ILIKE '%' || $3 || '%' OR al.title ILIKE '%' || $3 || '%' OR tl.ambassador_code ILIKE '%' || $3 || '%')
          ORDER BY tl.created_at DESC
          LIMIT $1 OFFSET $2
        `, [limit, offset, query.search ?? null]);
        const countRow = await client.query(`
          SELECT COUNT(*) FROM advert_tracking_links tl
          JOIN advert_listings al ON al.id = tl.listing_id
          JOIN users u ON u.id = tl.ambassador_id
          WHERE ($1::text IS NULL OR u.full_name ILIKE '%' || $1 || '%' OR al.title ILIKE '%' || $1 || '%' OR tl.ambassador_code ILIKE '%' || $1 || '%')
        `, [query.search ?? null]);
        return { tracking_links: rows.rows, total: parseInt(countRow.rows[0]?.count ?? '0', 10), page, limit };
      });
      return reply.send(result);
    } catch (err: any) {
      if (err?.code === '42P01') return reply.send({ tracking_links: [], total: 0, page, limit });
      app.log.error(err, 'admin.advert.tracking_links.error');
      return reply.code(500).send({ error: 'internal_server_error' });
    }
  });

  // ── Live bid / price-negotiation system ───────────────────────────────────

  // POST /advert/listings/:slug/bids/session  — buyer opens a negotiation
  app.post('/advert/listings/:slug/bids/session', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const { opening_offer } = request.body as { opening_offer: number };
    if (!opening_offer || Number(opening_offer) <= 0)
      return reply.code(400).send({ error: 'opening_offer must be a positive number' });

    return withTransaction(async (client) => {
      const lr = await client.query(
        `SELECT id, title, price, currency, is_negotiable, status, access_state
         FROM advert_listings WHERE slug=$1 AND access_state='PUBLIC'`, [slug]);
      if (!lr.rows[0]) return reply.code(404).send({ error: 'listing_not_found' });
      const l = lr.rows[0];
      if (!l.is_negotiable) return reply.code(400).send({ error: 'listing_not_negotiable' });
      if (l.status !== 'ACTIVE') return reply.code(400).send({ error: 'listing_not_active' });

      const token = uuid().replace(/-/g,'') + uuid().replace(/-/g,'').slice(0,16);
      const sr = await client.query(
        `INSERT INTO listing_bid_sessions (listing_id, buyer_token, listing_price, currency)
         VALUES ($1,$2,$3,$4)
         RETURNING id, buyer_token, status, listing_price, currency, expires_at, created_at`,
        [l.id, token, l.price, l.currency || 'UGX']);
      const session = sr.rows[0];

      await client.query(
        `INSERT INTO listing_bids (session_id, party, amount) VALUES ($1,'buyer',$2)`,
        [session.id, Number(opening_offer)]);
      await client.query(
        `UPDATE listing_bid_sessions SET last_activity_at=NOW() WHERE id=$1`, [session.id]);

      return reply.code(201).send({
        session_token: session.buyer_token,
        session_id:    session.id,
        listing_price: parseFloat(session.listing_price ?? 0),
        currency:      session.currency,
        listing_title: l.title,
        expires_at:    session.expires_at,
      });
    });
  });

  // GET /advert/listings/:slug/bids/session/:token  — poll session state
  app.get('/advert/listings/:slug/bids/session/:token', async (request, reply) => {
    const { slug, token } = request.params as { slug: string; token: string };

    return withTransaction(async (client) => {
      const sr = await client.query(
        `SELECT lbs.*, al.title AS listing_title
         FROM listing_bid_sessions lbs
         JOIN advert_listings al ON al.id=lbs.listing_id
         WHERE al.slug=$1 AND lbs.buyer_token=$2`, [slug, token]);
      if (!sr.rows[0]) return reply.code(404).send({ error: 'session_not_found' });
      const s = sr.rows[0];

      if (s.status === 'active' && new Date(s.expires_at) < new Date()) {
        await client.query(
          `UPDATE listing_bid_sessions SET status='expired' WHERE id=$1`, [s.id]);
        s.status = 'expired';
      }

      const br = await client.query(
        `SELECT id, party, amount::float, is_accepted, created_at
         FROM listing_bids WHERE session_id=$1 ORDER BY created_at ASC`, [s.id]);

      let quotation = null;
      if (s.status === 'agreed') {
        const qr = await client.query(
          `SELECT id, quote_number, agreed_price::float, currency, buyer_name,
                  buyer_phone, buyer_email, bid_count, valid_until, created_at
           FROM listing_quotations WHERE session_id=$1`, [s.id]);
        quotation = qr.rows[0] ?? null;
      }

      return reply.send({
        session: {
          id: s.id, status: s.status,
          listing_price: parseFloat(s.listing_price ?? 0),
          agreed_price:  s.agreed_price ? parseFloat(s.agreed_price) : null,
          currency: s.currency, listing_title: s.listing_title,
          expires_at: s.expires_at, last_activity_at: s.last_activity_at,
        },
        bids: br.rows,
        quotation,
      });
    });
  });

  // POST /advert/listings/:slug/bids/offer  — buyer counter-offer
  app.post('/advert/listings/:slug/bids/offer', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const { session_token, amount } = request.body as { session_token: string; amount: number };
    if (!amount || Number(amount) <= 0)
      return reply.code(400).send({ error: 'amount must be positive' });

    return withTransaction(async (client) => {
      const sr = await client.query(
        `SELECT lbs.* FROM listing_bid_sessions lbs
         JOIN advert_listings al ON al.id=lbs.listing_id
         WHERE al.slug=$1 AND lbs.buyer_token=$2 AND lbs.status='active'`,
        [slug, session_token]);
      if (!sr.rows[0]) return reply.code(404).send({ error: 'session_not_found_or_closed' });
      const s = sr.rows[0];

      const br = await client.query(
        `INSERT INTO listing_bids (session_id, party, amount) VALUES ($1,'buyer',$2)
         RETURNING id, party, amount::float, is_accepted, created_at`,
        [s.id, Number(amount)]);
      await client.query(
        `UPDATE listing_bid_sessions SET last_activity_at=NOW() WHERE id=$1`, [s.id]);

      return reply.code(201).send({ bid: br.rows[0] });
    });
  });

  // POST /advert/listings/:slug/bids/accept  — buyer accepts latest bid
  app.post('/advert/listings/:slug/bids/accept', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const { session_token } = request.body as { session_token: string };

    return withTransaction(async (client) => {
      const sr = await client.query(
        `SELECT lbs.* FROM listing_bid_sessions lbs
         JOIN advert_listings al ON al.id=lbs.listing_id
         WHERE al.slug=$1 AND lbs.buyer_token=$2 AND lbs.status='active'`,
        [slug, session_token]);
      if (!sr.rows[0]) return reply.code(404).send({ error: 'session_not_found_or_closed' });
      const s = sr.rows[0];

      const lb = await client.query(
        `SELECT * FROM listing_bids WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [s.id]);
      if (!lb.rows[0]) return reply.code(400).send({ error: 'no_bids' });
      const bid = lb.rows[0];

      await client.query(`UPDATE listing_bids SET is_accepted=TRUE WHERE id=$1`, [bid.id]);
      await client.query(
        `UPDATE listing_bid_sessions SET status='agreed', agreed_price=$2, last_activity_at=NOW()
         WHERE id=$1`, [s.id, bid.amount]);

      return reply.send({ agreed: true, agreed_price: parseFloat(bid.amount), currency: s.currency });
    });
  });

  // POST /advert/listings/:slug/bids/withdraw  — buyer withdraws
  app.post('/advert/listings/:slug/bids/withdraw', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const { session_token } = request.body as { session_token: string };

    return withTransaction(async (client) => {
      const r = await client.query(
        `UPDATE listing_bid_sessions lbs SET status='withdrawn'
         FROM advert_listings al
         WHERE al.id=lbs.listing_id AND al.slug=$1 AND lbs.buyer_token=$2 AND lbs.status='active'
         RETURNING lbs.id`,
        [slug, session_token]);
      if (!r.rows[0]) return reply.code(404).send({ error: 'session_not_found_or_closed' });
      return reply.send({ ok: true });
    });
  });

  // POST /advert/listings/:slug/bids/quote  — generate quotation after agreement
  app.post('/advert/listings/:slug/bids/quote', async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const { session_token, buyer_name, buyer_phone, buyer_email } = request.body as {
      session_token: string; buyer_name: string; buyer_phone: string; buyer_email?: string;
    };
    if (!buyer_name?.trim()) return reply.code(400).send({ error: 'buyer_name required' });
    if (!buyer_phone?.trim()) return reply.code(400).send({ error: 'buyer_phone required' });

    return withTransaction(async (client) => {
      const sr = await client.query(
        `SELECT lbs.*, al.title, al.cta_phone, al.cta_whatsapp, al.cta_email,
                al.location_text, al.category_name,
                u.full_name AS seller_name
         FROM listing_bid_sessions lbs
         JOIN advert_listings al ON al.id=lbs.listing_id
         LEFT JOIN campaigns c ON c.id=al.campaign_id
         LEFT JOIN users u ON u.id=c.user_id
         WHERE al.slug=$1 AND lbs.buyer_token=$2 AND lbs.status='agreed'`,
        [slug, session_token]);
      if (!sr.rows[0]) return reply.code(400).send({ error: 'session_not_agreed_or_not_found' });
      const s = sr.rows[0];

      const existing = await client.query(
        `SELECT * FROM listing_quotations WHERE session_id=$1`, [s.id]);
      if (existing.rows[0]) {
        return reply.send({
          quotation: existing.rows[0],
          seller_contacts: { phone: s.cta_phone, whatsapp: s.cta_whatsapp, email: s.cta_email, name: s.seller_name },
        });
      }

      const countR = await client.query(
        `SELECT COUNT(*)::int AS c FROM listing_bids WHERE session_id=$1`, [s.id]);
      const bidCount = countR.rows[0]?.c ?? 0;

      const now = new Date();
      const ymd = now.toISOString().slice(2,10).replace(/-/g,'');
      const rand = Math.random().toString(36).toUpperCase().slice(2,6);
      const quoteNumber = `PSQ-${ymd}-${rand}`;

      const qr = await client.query(
        `INSERT INTO listing_quotations
           (session_id, listing_id, quote_number, agreed_price, currency,
            buyer_name, buyer_phone, buyer_email, bid_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING *`,
        [s.id, s.listing_id, quoteNumber, s.agreed_price, s.currency,
         buyer_name.trim(), buyer_phone.trim(), buyer_email?.trim() ?? null, bidCount]);

      return reply.code(201).send({
        quotation: qr.rows[0],
        seller_contacts: { phone: s.cta_phone, whatsapp: s.cta_whatsapp, email: s.cta_email, name: s.seller_name },
      });
    });
  });

  // GET /advert/listings/:slug/bids/quote/:quoteId  — retrieve quotation (shareable)
  app.get('/advert/listings/:slug/bids/quote/:quoteId', async (request, reply) => {
    const { slug, quoteId } = request.params as { slug: string; quoteId: string };

    return withTransaction(async (client) => {
      const r = await client.query(
        `SELECT lq.*, al.title AS listing_title, al.location_text,
                al.cta_phone, al.cta_whatsapp, al.cta_email,
                lbs.listing_price::float,
                u.full_name AS seller_name
         FROM listing_quotations lq
         JOIN advert_listings al ON al.id=lq.listing_id
         JOIN listing_bid_sessions lbs ON lbs.id=lq.session_id
         LEFT JOIN campaigns c ON c.id=al.campaign_id
         LEFT JOIN users u ON u.id=c.user_id
         WHERE al.slug=$1 AND lq.id=$2`,
        [slug, quoteId]);
      if (!r.rows[0]) return reply.code(404).send({ error: 'quotation_not_found' });
      const q = r.rows[0];
      return reply.send({
        quotation: q,
        listing: { title: q.listing_title, location: q.location_text },
        seller_contacts: { phone: q.cta_phone, whatsapp: q.cta_whatsapp, email: q.cta_email, name: q.seller_name },
      });
    });
  });

  // GET /advert/listings/:slug/bids/incoming  — seller: view active sessions
  app.get('/advert/listings/:slug/bids/incoming', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const userId = String((request.user as any)?.sub ?? '').trim();

    return withTransaction(async (client) => {
      const r = await client.query(
        `SELECT lbs.id, lbs.status,
                lbs.listing_price::float, lbs.agreed_price::float,
                lbs.currency, lbs.last_activity_at, lbs.expires_at, lbs.created_at,
                (SELECT amount::float FROM listing_bids WHERE session_id=lbs.id ORDER BY created_at DESC LIMIT 1) AS latest_amount,
                (SELECT party        FROM listing_bids WHERE session_id=lbs.id ORDER BY created_at DESC LIMIT 1) AS latest_party,
                (SELECT COUNT(*)::int FROM listing_bids WHERE session_id=lbs.id) AS bid_count
         FROM listing_bid_sessions lbs
         JOIN advert_listings al ON al.id=lbs.listing_id
         JOIN campaigns c ON c.id=al.campaign_id
         WHERE al.slug=$1 AND c.user_id=$2 AND lbs.status='active'
         ORDER BY lbs.last_activity_at DESC`,
        [slug, userId]);
      return reply.send({ sessions: r.rows });
    });
  });

  // POST /advert/listings/:slug/bids/seller-offer  — seller counter-offer
  app.post('/advert/listings/:slug/bids/seller-offer', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const { session_id, amount } = request.body as { session_id: string; amount: number };
    const userId = String((request.user as any)?.sub ?? '').trim();
    if (!amount || Number(amount) <= 0)
      return reply.code(400).send({ error: 'amount must be positive' });

    return withTransaction(async (client) => {
      const own = await client.query(
        `SELECT lbs.id FROM listing_bid_sessions lbs
         JOIN advert_listings al ON al.id=lbs.listing_id
         JOIN campaigns c ON c.id=al.campaign_id
         WHERE al.slug=$1 AND lbs.id=$2 AND c.user_id=$3 AND lbs.status='active'`,
        [slug, session_id, userId]);
      if (!own.rows[0]) return reply.code(403).send({ error: 'forbidden_or_not_found' });

      const br = await client.query(
        `INSERT INTO listing_bids (session_id, party, amount) VALUES ($1,'seller',$2)
         RETURNING id, party, amount::float, is_accepted, created_at`,
        [session_id, Number(amount)]);
      await client.query(
        `UPDATE listing_bid_sessions SET last_activity_at=NOW() WHERE id=$1`, [session_id]);

      return reply.code(201).send({ bid: br.rows[0] });
    });
  });

  // ── Admin bid management ──────────────────────────────────────────────────

  // GET /admin/advert/bids  — paginated list of all sessions across all listings
  app.get('/admin/advert/bids', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const q = request.query as {
      status?: string; search?: string; page?: string; limit?: string;
    };
    const page  = Math.max(1, parseInt(q.page  ?? '1',  10));
    const limit = Math.min(100, Math.max(1, parseInt(q.limit ?? '40', 10)));
    const offset = (page - 1) * limit;
    const status = q.status && q.status !== 'all' ? q.status : null;
    const search = q.search?.trim() || null;

    return withTransaction(async (client) => {
      const where = `
        WHERE ($1::text IS NULL OR lbs.status = $1)
          AND ($2::text IS NULL
               OR al.title ILIKE '%' || $2 || '%'
               OR al.slug  ILIKE '%' || $2 || '%'
               OR lq.buyer_name  ILIKE '%' || $2 || '%'
               OR lq.buyer_phone ILIKE '%' || $2 || '%')
      `;
      const params = [status, search];

      const rows = await client.query(`
        SELECT lbs.id, lbs.status, lbs.currency,
               lbs.listing_price::float, lbs.agreed_price::float,
               lbs.last_activity_at, lbs.expires_at, lbs.created_at,
               al.title  AS listing_title,
               al.slug   AS listing_slug,
               u.full_name AS seller_name,
               (SELECT COUNT(*)::int  FROM listing_bids WHERE session_id=lbs.id) AS bid_count,
               (SELECT amount::float  FROM listing_bids WHERE session_id=lbs.id ORDER BY created_at DESC LIMIT 1) AS latest_amount,
               (SELECT party          FROM listing_bids WHERE session_id=lbs.id ORDER BY created_at DESC LIMIT 1) AS latest_party,
               lq.id           AS quote_id,
               lq.quote_number,
               lq.buyer_name,
               lq.buyer_phone
        FROM listing_bid_sessions lbs
        JOIN advert_listings al ON al.id=lbs.listing_id
        LEFT JOIN campaigns c ON c.id=al.campaign_id
        LEFT JOIN users u ON u.id=c.user_id
        LEFT JOIN listing_quotations lq ON lq.session_id=lbs.id
        ${where}
        ORDER BY lbs.last_activity_at DESC
        LIMIT $3 OFFSET $4
      `, [...params, limit, offset]);

      const countRow = await client.query(`
        SELECT COUNT(*)::int AS total
        FROM listing_bid_sessions lbs
        JOIN advert_listings al ON al.id=lbs.listing_id
        LEFT JOIN listing_quotations lq ON lq.session_id=lbs.id
        ${where}
      `, params);

      return reply.send({
        sessions: rows.rows,
        total: countRow.rows[0]?.total ?? 0,
        page, limit,
        has_next: offset + rows.rows.length < (countRow.rows[0]?.total ?? 0),
      });
    });
  });

  // GET /admin/advert/bids/stats  — aggregate statistics
  app.get('/admin/advert/bids/stats', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    return withTransaction(async (client) => {
      const r = await client.query(`
        SELECT
          COUNT(*)                                          AS total,
          COUNT(*) FILTER (WHERE status='active')          AS active,
          COUNT(*) FILTER (WHERE status='agreed')          AS agreed,
          COUNT(*) FILTER (WHERE status='withdrawn')       AS withdrawn,
          COUNT(*) FILTER (WHERE status='expired')         AS expired,
          COALESCE(SUM(agreed_price) FILTER (WHERE status='agreed'), 0)::float AS total_agreed_value,
          ROUND(AVG(sub.cnt)::numeric, 1)::float           AS avg_bid_rounds
        FROM listing_bid_sessions lbs
        LEFT JOIN (
          SELECT session_id, COUNT(*)::int AS cnt FROM listing_bids GROUP BY session_id
        ) sub ON sub.session_id=lbs.id
      `);
      return reply.send(r.rows[0] ?? {});
    });
  });

  // GET /admin/advert/bids/:sessionId/thread  — full bid thread for any session
  app.get('/admin/advert/bids/:sessionId/thread', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    return withTransaction(async (client) => {
      const sr = await client.query(
        `SELECT lbs.*, al.title AS listing_title, al.slug AS listing_slug,
                al.cta_phone, al.cta_whatsapp, al.cta_email,
                u.full_name AS seller_name
         FROM listing_bid_sessions lbs
         JOIN advert_listings al ON al.id=lbs.listing_id
         LEFT JOIN campaigns c ON c.id=al.campaign_id
         LEFT JOIN users u ON u.id=c.user_id
         WHERE lbs.id=$1`, [sessionId]);
      if (!sr.rows[0]) return reply.code(404).send({ error: 'session_not_found' });
      const s = sr.rows[0];

      const br = await client.query(
        `SELECT id, party, amount::float, is_accepted, created_at
         FROM listing_bids WHERE session_id=$1 ORDER BY created_at ASC`, [sessionId]);

      const qr = await client.query(
        `SELECT * FROM listing_quotations WHERE session_id=$1`, [sessionId]);

      return reply.send({
        session: {
          id: s.id, status: s.status, currency: s.currency,
          listing_price: parseFloat(s.listing_price ?? 0),
          agreed_price: s.agreed_price ? parseFloat(s.agreed_price) : null,
          listing_title: s.listing_title, listing_slug: s.listing_slug,
          seller_name: s.seller_name,
          cta_phone: s.cta_phone, cta_whatsapp: s.cta_whatsapp, cta_email: s.cta_email,
          last_activity_at: s.last_activity_at, expires_at: s.expires_at, created_at: s.created_at,
        },
        bids: br.rows,
        quotation: qr.rows[0] ?? null,
      });
    });
  });

  // PATCH /admin/advert/bids/:sessionId/close  — admin force-closes a session
  app.patch('/admin/advert/bids/:sessionId/close', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const { sessionId } = request.params as { sessionId: string };
    return withTransaction(async (client) => {
      const r = await client.query(
        `UPDATE listing_bid_sessions SET status='expired', last_activity_at=NOW()
         WHERE id=$1 AND status='active' RETURNING id`, [sessionId]);
      if (!r.rows[0]) return reply.code(404).send({ error: 'session_not_active' });
      return reply.send({ ok: true });
    });
  });

  // GET /advert/my-listings-with-bids  — seller: all own listings + their active sessions
  app.get('/advert/my-listings-with-bids', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const userId = String((request.user as any)?.sub ?? '').trim();
    return withTransaction(async (client) => {
      const lr = await client.query(
        `SELECT al.id, al.slug, al.title, al.status
         FROM advert_listings al
         JOIN campaigns c ON c.id=al.campaign_id
         WHERE c.business_id=$1 AND al.status='ACTIVE' AND al.is_negotiable=TRUE
         ORDER BY al.created_at DESC`,
        [userId]);
      const listings = await Promise.all(lr.rows.map(async (l: any) => {
        const sr = await client.query(
          `SELECT lbs.id, lbs.status, lbs.listing_price::float, lbs.agreed_price::float,
                  lbs.currency, lbs.last_activity_at, lbs.expires_at, lbs.created_at,
                  (SELECT amount::float FROM listing_bids WHERE session_id=lbs.id ORDER BY created_at DESC LIMIT 1) AS latest_amount,
                  (SELECT party        FROM listing_bids WHERE session_id=lbs.id ORDER BY created_at DESC LIMIT 1) AS latest_party,
                  (SELECT COUNT(*)::int FROM listing_bids WHERE session_id=lbs.id) AS bid_count
           FROM listing_bid_sessions lbs WHERE lbs.listing_id=$1 AND lbs.status='active'
           ORDER BY lbs.last_activity_at DESC`,
          [l.id]);
        return { ...l, bid_sessions: sr.rows };
      }));
      return reply.send({ listings });
    });
  });

  // GET /advert/listings/:slug/bids/session-by-id/:sessionId  — seller fetch session by ID
  app.get('/advert/listings/:slug/bids/session-by-id/:sessionId', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const { slug, sessionId } = request.params as { slug: string; sessionId: string };
    const userId = String((request.user as any)?.sub ?? '').trim();
    return withTransaction(async (client) => {
      const sr = await client.query(
        `SELECT lbs.* FROM listing_bid_sessions lbs
         JOIN advert_listings al ON al.id=lbs.listing_id
         JOIN campaigns c ON c.id=al.campaign_id
         WHERE al.slug=$1 AND lbs.id=$2 AND c.user_id=$3`,
        [slug, sessionId, userId]);
      if (!sr.rows[0]) return reply.code(404).send({ error: 'not_found' });
      const s = sr.rows[0];
      const br = await client.query(
        `SELECT id, party, amount::float, is_accepted, created_at
         FROM listing_bids WHERE session_id=$1 ORDER BY created_at ASC`, [s.id]);
      return reply.send({
        session: { id: s.id, status: s.status, currency: s.currency,
                   listing_price: parseFloat(s.listing_price ?? 0),
                   agreed_price: s.agreed_price ? parseFloat(s.agreed_price) : null },
        bids: br.rows,
      });
    });
  });

  // POST /advert/listings/:slug/bids/seller-accept  — seller accepts buyer's latest bid
  app.post('/advert/listings/:slug/bids/seller-accept', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const { session_id } = request.body as { session_id: string };
    const userId = String((request.user as any)?.sub ?? '').trim();

    return withTransaction(async (client) => {
      const own = await client.query(
        `SELECT lbs.* FROM listing_bid_sessions lbs
         JOIN advert_listings al ON al.id=lbs.listing_id
         JOIN campaigns c ON c.id=al.campaign_id
         WHERE al.slug=$1 AND lbs.id=$2 AND c.user_id=$3 AND lbs.status='active'`,
        [slug, session_id, userId]);
      if (!own.rows[0]) return reply.code(403).send({ error: 'forbidden_or_not_found' });

      const lb = await client.query(
        `SELECT * FROM listing_bids WHERE session_id=$1 ORDER BY created_at DESC LIMIT 1`,
        [session_id]);
      if (!lb.rows[0]) return reply.code(400).send({ error: 'no_bids' });
      const bid = lb.rows[0];

      await client.query(`UPDATE listing_bids SET is_accepted=TRUE WHERE id=$1`, [bid.id]);
      await client.query(
        `UPDATE listing_bid_sessions SET status='agreed', agreed_price=$2, last_activity_at=NOW()
         WHERE id=$1`, [session_id, bid.amount]);

      return reply.send({ agreed: true, agreed_price: parseFloat(bid.amount) });
    });
  });

  // ── LISTING BOOSTS ────────────────────────────────────────────────────────

  // GET /advert/listings/:slug/boost-options — returns available boost plans
  app.get('/advert/listings/:slug/boost-options', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const userId = String((request.user as any)?.sub ?? '').trim();
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

    return withTransaction(async (client) => {
      await ensureListingBoostSchema(client);
      const listingRes = await client.query(
        `SELECT al.id, al.status, al.access_state, al.boost_plan, al.boost_expires_at,
                c.user_id AS business_id
         FROM advert_listings al
         JOIN campaigns c ON c.id = al.campaign_id
         WHERE al.slug = $1
         LIMIT 1`,
        [slug]
      );
      const listing = listingRes.rows[0];
      if (!listing) return reply.code(404).send({ error: 'listing_not_found' });
      if (listing.business_id !== userId) return reply.code(403).send({ error: 'forbidden' });

      const options = buildListingBoostOptions(false);
      const boostExpiresAt = listing.boost_expires_at ? new Date(listing.boost_expires_at) : null;
      const isCurrentlyBoosted = boostExpiresAt != null && boostExpiresAt.getTime() > Date.now();

      return {
        is_pro: false,
        is_currently_boosted: isCurrentlyBoosted,
        boost_expires_at: listing.boost_expires_at ?? null,
        current_boost_plan: listing.boost_plan ?? null,
        options,
      };
    });
  });

  // POST /advert/listings/:slug/boost — initiates a boost payment
  app.post('/advert/listings/:slug/boost', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const userId = String((request.user as any)?.sub ?? '').trim();
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

    if (!hasYoClientCredentials()) {
      reply.code(503);
      return { error: 'yo_uganda_not_configured' };
    }

    const body = (request.body as any) ?? {};
    const planCode = String(body.plan_code ?? '').trim().toUpperCase();
    const plan = resolveListingBoostPlan(planCode);
    if (!plan) return reply.code(400).send({ error: 'invalid_boost_plan' });

    const merchantReference = uuid();

    return withTransaction(async (client) => {
      const listingRes = await client.query(
        `SELECT al.id, al.status, al.access_state, c.user_id AS business_id
         FROM advert_listings al
         JOIN campaigns c ON c.id = al.campaign_id
         WHERE al.slug = $1
         LIMIT 1`,
        [slug]
      );
      const listing = listingRes.rows[0];
      if (!listing) return reply.code(404).send({ error: 'listing_not_found' });
      if (listing.business_id !== userId) return reply.code(403).send({ error: 'forbidden' });

      const status = String(listing.status ?? '').trim().toUpperCase();
      const accessState = String(listing.access_state ?? 'PUBLIC').trim().toUpperCase();
      if (status !== 'ACTIVE' || accessState !== 'PUBLIC') {
        return reply.code(400).send({ error: 'listing_boost_requires_active_listing' });
      }

      const { amount_ugx: amountUgx } = resolveListingBoostPlan(planCode)!;
      const discountedAmount = amountUgx;

      const userRes = await client.query(
        'SELECT email, phone, country, full_name FROM users WHERE id=$1 LIMIT 1',
        [userId]
      );
      const user = userRes.rows[0];
      const userCountry = (user?.country as string | undefined) ?? 'UG';
      const userEmail = (user?.email as string | undefined) ?? '';
      const userPhone = (user?.phone as string | undefined) ?? null;
      const userName = (user?.full_name as string | undefined) ?? 'Business';

      const checkoutProfile = resolveAvailableYoUgandaCheckoutProfile(
        userCountry,
        { cardEnabled: hasYoEncryptionKey() }
      );

      const rawPayload = {
        kind: 'LISTING_BOOST',
        user_id: userId,
        listing_id: listing.id as string,
        listing_slug: slug,
        plan_code: planCode,
        amount: discountedAmount,
        currency: 'UGX',
        country: checkoutProfile.country,
        payment_options: checkoutProfile.paymentOptions,
        supported_payment_methods: checkoutProfile.supportedPaymentMethods,
        mobile_money_networks: checkoutProfile.mobileMoneyNetworks,
        phone_country_code: checkoutProfile.phoneCountryCode,
        availability_notes: checkoutProfile.availabilityNotes,
        customer: { email: userEmail, name: userName, phone_number: userPhone },
      };

      const paymentRepo = new PaymentRepo();
      await paymentRepo.createPesaPalTransaction(client, {
        escrow_id: undefined,
        type: 'FUNDING',
        amount: discountedAmount,
        merchant_reference: merchantReference,
        raw_payload: rawPayload,
      });

      const checkoutPayload = {
        provider: 'YO_UGANDA',
        mode: 'DIRECT_CHARGE',
        tx_ref: merchantReference,
        amount: discountedAmount,
        currency: 'UGX',
        payment_options: checkoutProfile.paymentOptions,
        supported_payment_methods: checkoutProfile.supportedPaymentMethods,
        mobile_money_networks: checkoutProfile.mobileMoneyNetworks,
        phone_country_code: checkoutProfile.phoneCountryCode,
        availability_notes: checkoutProfile.availabilityNotes,
        country: checkoutProfile.country,
        customer: { email: userEmail, name: userName, phone_number: userPhone },
        meta: {
          merchant_reference: merchantReference,
          kind: 'LISTING_BOOST',
          user_id: userId,
          listing_id: listing.id as string,
          plan_code: planCode,
        },
      };

      return {
        ok: true,
        tx_ref: merchantReference,
        amount: discountedAmount,
        currency: 'UGX',
        plan: plan,
        is_pro_discounted: false,
        checkout_payload: checkoutPayload,
      };
    });
  });

  // POST /advert/listings/:slug/boost/confirm — activates boost after payment
  app.post('/advert/listings/:slug/boost/confirm', {
    preHandler: [(app as any).authenticate],
  }, async (request, reply) => {
    const { slug } = request.params as { slug: string };
    const userId = String((request.user as any)?.sub ?? '').trim();
    if (!userId) return reply.code(401).send({ error: 'unauthorized' });

    const body = (request.body as any) ?? {};
    const paymentReference = String(body.payment_reference ?? '').trim();
    if (!paymentReference) return reply.code(400).send({ error: 'payment_reference_required' });

    return withTransaction(async (client) => {
      const txnRes = await client.query(
        `SELECT raw_payload FROM pesapal_transactions WHERE merchant_reference=$1 LIMIT 1`,
        [paymentReference]
      );
      const rawPayload = (txnRes.rows[0]?.raw_payload ?? {}) as Record<string, unknown>;
      const listingId = String(rawPayload.listing_id ?? '').trim();
      const planCode = String(rawPayload.plan_code ?? '').trim();
      const amountUgx = Number(rawPayload.amount ?? 0);

      if (!listingId || !planCode) {
        return reply.code(400).send({ error: 'invalid_payment_reference' });
      }

      const result = await activateListingBoost(client, {
        listingId,
        businessId: userId,
        paymentReference,
        planCode,
        amountUgx,
      });

      const paymentRepo = new PaymentRepo();
      try {
        await paymentRepo.updatePesaPalTxnStatus(client, paymentReference, 'COMPLETED', paymentReference);
      } catch (_) { /* non-fatal */ }

      return { ok: true, boost: result };
    });
  });
}
