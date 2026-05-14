// routes/advert.ts
// Smart Advert Listing System — extends campaign creation
import { z } from 'zod';
import { withTransaction, query } from '../db.js';
import { canAccessBusinessFeatures } from '../services/roles.js';
import { v4 as uuid } from 'uuid';
// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function slugify(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
}
function generateListingSlug(title) {
    const base = slugify(title).slice(0, 40);
    const suffix = Math.random().toString(36).slice(2, 8);
    return `${base}-${suffix}`;
}
function generateAmbassadorCode() {
    return Math.random().toString(36).slice(2, 10).toUpperCase();
}
async function ensureAdvertSchema(client) {
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
// ─────────────────────────────────────────────
// QUALITY SCORE CALCULATOR
// ─────────────────────────────────────────────
function calculateListingQuality(data) {
    let score = 0;
    if (data.title.trim().length >= 10)
        score += 15;
    if (data.summary.trim().length >= 30)
        score += 15;
    if (data.description.trim().length >= 100)
        score += 20;
    if (data.price && data.price > 0)
        score += 10;
    if (data.location_text && data.location_text.trim())
        score += 10;
    if (data.cta_phone || data.cta_whatsapp || data.cta_email)
        score += 10;
    if (data.ambassador_media_count > 0)
        score += 10;
    if (data.gallery_media_count >= 2)
        score += 10;
    const filledFields = Object.values(data.field_values).filter((v) => v && v.trim()).length;
    if (filledFields >= 3)
        score += 10;
    return Math.min(score, 100);
}
// ─────────────────────────────────────────────
// ROUTE REGISTRATION
// ─────────────────────────────────────────────
export async function advertRoutes(app) {
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
        }
        catch (err) {
            app.log.error(err, 'advert.categories.list.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // GET /api/advert/categories/:categoryId/subcategories
    app.get('/advert/categories/:categoryId/subcategories', async (request, reply) => {
        const { categoryId } = request.params;
        try {
            const subcategories = await query(`
        SELECT s.id, s.slug, s.name, s.sort_order, c.name AS category_name
        FROM advert_subcategories s
        JOIN advert_categories c ON c.id = s.category_id
        WHERE s.category_id = $1 AND s.is_active = TRUE
        ORDER BY s.sort_order ASC, s.name ASC
      `, [categoryId]);
            return reply.send({ subcategories });
        }
        catch (err) {
            app.log.error(err, 'advert.subcategories.list.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // GET /api/advert/categories/:categoryId/listing-types — flat (all subcats merged)
    app.get('/advert/categories/:categoryId/listing-types', async (request, reply) => {
        const { categoryId } = request.params;
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
        }
        catch (err) {
            app.log.error(err, 'advert.listing_types.flat.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // GET /api/advert/subcategories/:subcategoryId/listing-types
    app.get('/advert/subcategories/:subcategoryId/listing-types', async (request, reply) => {
        const { subcategoryId } = request.params;
        try {
            const listing_types = await query(`
        SELECT lt.id, lt.slug, lt.name, lt.sort_order, s.name AS subcategory_name
        FROM advert_listing_types lt
        JOIN advert_subcategories s ON s.id = lt.subcategory_id
        WHERE lt.subcategory_id = $1 AND lt.is_active = TRUE
        ORDER BY lt.sort_order ASC, lt.name ASC
      `, [subcategoryId]);
            return reply.send({ listing_types });
        }
        catch (err) {
            app.log.error(err, 'advert.listing_types.list.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // GET /api/advert/listing-types/:listingTypeId/fields
    app.get('/advert/listing-types/:listingTypeId/fields', async (request, reply) => {
        const { listingTypeId } = request.params;
        try {
            const fieldRows = await query(`
        SELECT
          fd.id, fd.field_key, fd.label, fd.field_type,
          fd.is_required, fd.sort_order, fd.placeholder,
          fd.helper_text, fd.section_group,
          fd.min_length, fd.max_length, fd.min_value, fd.max_value
        FROM advert_field_definitions fd
        WHERE fd.listing_type_id = $1
        ORDER BY fd.sort_order ASC
      `, [listingTypeId]);
            const optionsByField = {};
            if (fieldRows.length > 0) {
                const fieldIds = fieldRows.map((f) => f.id);
                const optionRows = await query(`
          SELECT field_def_id, option_value, option_label, sort_order
          FROM advert_field_options
          WHERE field_def_id = ANY($1)
          ORDER BY sort_order ASC
        `, [fieldIds]);
                for (const opt of optionRows) {
                    const fid = opt.field_def_id;
                    if (!optionsByField[fid])
                        optionsByField[fid] = [];
                    optionsByField[fid].push({ value: opt.option_value, label: opt.option_label });
                }
            }
            const fields = fieldRows.map((f) => ({ ...f, options: optionsByField[f.id] ?? [] }));
            return reply.send({ fields });
        }
        catch (err) {
            app.log.error(err, 'advert.fields.list.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // ─── LISTINGS ────────────────────────────────
    // POST /api/advert/listings — Create listing (authenticated, BUSINESS only)
    app.post('/advert/listings', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
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
        let body;
        try {
            body = bodySchema.parse(request.body);
        }
        catch (err) {
            return reply.code(400).send({ error: 'validation_error', details: err.errors ?? err.message });
        }
        try {
            const listing = await withTransaction(async (client) => {
                // Verify user is a business
                const userRow = await client.query(`SELECT id, role, active_role FROM users WHERE id = $1`, [userId]);
                if (!userRow.rows[0]) {
                    throw Object.assign(new Error('user_not_found'), { statusCode: 404 });
                }
                if (!canAccessBusinessFeatures(userRow.rows[0]?.role)) {
                    throw Object.assign(new Error('business_role_required'), { statusCode: 403 });
                }
                // Verify campaign belongs to user and extract its duration window
                const campRow = await client.query(`SELECT id, business_id, start_date, end_date, terms_keep_hours, status
           FROM campaigns WHERE id = $1`, [body.campaign_id]);
                if (!campRow.rows[0]) {
                    throw Object.assign(new Error('campaign_not_found'), { statusCode: 404 });
                }
                if (campRow.rows[0].business_id !== userId) {
                    throw Object.assign(new Error('forbidden'), { statusCode: 403 });
                }
                // Derive the listing's live window from the campaign's duration
                const camp = campRow.rows[0];
                const keepHours = camp.terms_keep_hours ?? 12;
                // campaign_start_at: use start_date if set, else now
                const campaignStartAt = camp.start_date
                    ? new Date(camp.start_date)
                    : new Date();
                // campaign_end_at: use explicit end_date, else start + keep_hours
                const campaignEndAt = camp.end_date
                    ? new Date(camp.end_date)
                    : new Date(campaignStartAt.getTime() + keepHours * 60 * 60 * 1000);
                // Check no existing listing for this campaign
                const existingListing = await client.query(`SELECT id FROM advert_listings WHERE campaign_id = $1`, [body.campaign_id]);
                if (existingListing.rows.length > 0) {
                    // Return existing listing id so client can update instead
                    return { id: existingListing.rows[0].id, updated: false, existing: true };
                }
                // Generate unique slug
                let slug = generateListingSlug(body.title);
                const slugCheck = await client.query(`SELECT id FROM advert_listings WHERE slug = $1`, [slug]);
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
                // Insert listing — expires_at is always derived from campaign duration
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
                    campaignEndAt, // expires_at = campaign end
                    campaignStartAt, // campaign_start_at
                    campaignEndAt, // campaign_end_at
                    qualityScore,
                ]);
                const listingId = listingRow.rows[0].id;
                // Batch insert field values (single round-trip)
                const fieldEntries = Object.entries(body.field_values).filter(([, v]) => v != null);
                if (fieldEntries.length > 0) {
                    const params = [];
                    const rowPlaceholders = fieldEntries.map(([key, value], i) => {
                        const b = i * 4;
                        params.push(uuid(), listingId, key, String(value));
                        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4})`;
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
                    const params = [];
                    const rowPlaceholders = allMedia.map((m, i) => {
                        const b = i * 11;
                        params.push(uuid(), listingId, m.pack, m.media_type, m.url, m.thumbnail_url ?? null, m.file_name ?? null, m.mime_type ?? null, m.file_size_bytes ?? null, m.duration_secs ?? null, m.order);
                        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11})`;
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
        }
        catch (err) {
            if (err.statusCode) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            app.log.error(err, 'advert.listing.create.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // POST /api/advert/listings/draft — Create DRAFT listing without campaign (authenticated, BUSINESS only)
    app.post('/advert/listings/draft', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
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
        let body;
        try {
            body = bodySchema.parse(request.body);
        }
        catch (err) {
            return reply.code(400).send({ error: 'validation_error', details: err.errors ?? err.message });
        }
        try {
            const listing = await withTransaction(async (client) => {
                const userRow = await client.query(`SELECT id, role, active_role FROM users WHERE id = $1`, [userId]);
                if (!userRow.rows[0])
                    throw Object.assign(new Error('user_not_found'), { statusCode: 404 });
                if (!canAccessBusinessFeatures(userRow.rows[0]?.role)) {
                    throw Object.assign(new Error('business_role_required'), { statusCode: 403 });
                }
                const draftCount = await client.query(`SELECT COUNT(*) FROM advert_listings WHERE business_id = $1 AND status = 'DRAFT'`, [userId]);
                if (parseInt(draftCount.rows[0].count, 10) >= 3) {
                    throw Object.assign(new Error('draft_limit_reached'), { statusCode: 409 });
                }
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
                    const params = [];
                    const rowPlaceholders = fieldEntries.map(([key, value], i) => {
                        const b = i * 4;
                        params.push(uuid(), listingId, key, String(value));
                        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4})`;
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
                    const params = [];
                    const rowPlaceholders = allMedia.map((m, i) => {
                        const b = i * 11;
                        params.push(uuid(), listingId, m.pack, m.media_type, m.url, m.thumbnail_url ?? null, m.file_name ?? null, m.mime_type ?? null, m.file_size_bytes ?? null, m.duration_secs ?? null, m.order);
                        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9},$${b + 10},$${b + 11})`;
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
        }
        catch (err) {
            if (err.statusCode)
                return reply.code(err.statusCode).send({ error: err.message });
            app.log.error(err, 'advert.listing.draft.create.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // PATCH /api/advert/listings/:slug/attach-campaign — Link a DRAFT listing to a campaign
    // If the campaign already has another draft listing attached, replace it so
    // the business can change the product page before funding.
    app.patch('/advert/listings/:slug/attach-campaign', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
        const { slug } = request.params;
        const bodySchema = z.object({ campaign_id: z.string().uuid() });
        let body;
        try {
            body = bodySchema.parse(request.body);
        }
        catch (err) {
            return reply.code(400).send({ error: 'validation_error', details: err.errors ?? err.message });
        }
        try {
            const listing = await withTransaction(async (client) => {
                const listingRow = await client.query(`SELECT id, business_id, status FROM advert_listings WHERE slug = $1`, [slug]);
                if (!listingRow.rows[0])
                    throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
                if (listingRow.rows[0].business_id !== userId)
                    throw Object.assign(new Error('forbidden'), { statusCode: 403 });
                if (listingRow.rows[0].status !== 'DRAFT')
                    throw Object.assign(new Error('listing_already_active'), { statusCode: 409 });
                const campRow = await client.query(`SELECT id, business_id FROM campaigns WHERE id = $1`, [body.campaign_id]);
                if (!campRow.rows[0])
                    throw Object.assign(new Error('campaign_not_found'), { statusCode: 404 });
                if (campRow.rows[0].business_id !== userId)
                    throw Object.assign(new Error('forbidden'), { statusCode: 403 });
                const existing = await client.query(`SELECT id, status FROM advert_listings WHERE campaign_id = $1 AND id != $2`, [body.campaign_id, listingRow.rows[0].id]);
                if (existing.rows.length > 0) {
                    const blocking = existing.rows.find((row) => String(row.status ?? '').trim().toUpperCase() !== 'DRAFT');
                    if (blocking) {
                        throw Object.assign(new Error('campaign_already_has_listing'), { statusCode: 409 });
                    }
                    await client.query(`UPDATE advert_listings
             SET campaign_id = NULL,
                 updated_at = now()
             WHERE campaign_id = $1
               AND id != $2
               AND status = 'DRAFT'`, [body.campaign_id, listingRow.rows[0].id]);
                }
                const updated = await client.query(`UPDATE advert_listings SET campaign_id = $1, updated_at = now() WHERE id = $2 RETURNING *`, [body.campaign_id, listingRow.rows[0].id]);
                return updated.rows[0];
            });
            return reply.send({ listing });
        }
        catch (err) {
            if (err.statusCode)
                return reply.code(err.statusCode).send({ error: err.message });
            app.log.error(err, 'advert.listing.attach.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // PATCH /api/advert/listings/:slug — Update listing content (owner only, DRAFT or ACTIVE)
    app.patch('/advert/listings/:slug', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
        const { slug } = request.params;
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
        let body;
        try {
            body = bodySchema.parse(request.body);
        }
        catch (err) {
            return reply.code(400).send({ error: 'validation_error', details: err.errors ?? err.message });
        }
        try {
            const listing = await withTransaction(async (client) => {
                const existingRow = await client.query(`SELECT id, business_id, status, title, summary, description,
                  price, currency, is_negotiable, location_text,
                  cta_whatsapp, cta_phone, cta_email, cta_url
           FROM advert_listings WHERE slug = $1`, [slug]);
                if (!existingRow.rows[0])
                    throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
                if (existingRow.rows[0].business_id !== userId)
                    throw Object.assign(new Error('forbidden'), { statusCode: 403 });
                const existing = existingRow.rows[0];
                // Build SET clause dynamically for only provided fields
                const setClauses = ['updated_at = now()'];
                const params = [];
                let idx = 1;
                if (body.title !== undefined) {
                    setClauses.push(`title = $${idx++}`);
                    params.push(body.title);
                }
                if (body.summary !== undefined) {
                    setClauses.push(`summary = $${idx++}`);
                    params.push(body.summary);
                }
                if (body.description !== undefined) {
                    setClauses.push(`description = $${idx++}`);
                    params.push(body.description);
                }
                if ('price' in body) {
                    setClauses.push(`price = $${idx++}`);
                    params.push(body.price ?? null);
                }
                if (body.currency !== undefined) {
                    setClauses.push(`currency = $${idx++}`);
                    params.push(body.currency);
                }
                if (body.is_negotiable !== undefined) {
                    setClauses.push(`is_negotiable = $${idx++}`);
                    params.push(body.is_negotiable);
                }
                if ('location_text' in body) {
                    setClauses.push(`location_text = $${idx++}`);
                    params.push(body.location_text ?? null);
                }
                if ('latitude' in body) {
                    setClauses.push(`latitude = $${idx++}`);
                    params.push(body.latitude ?? null);
                }
                if ('longitude' in body) {
                    setClauses.push(`longitude = $${idx++}`);
                    params.push(body.longitude ?? null);
                }
                if ('cta_whatsapp' in body) {
                    setClauses.push(`cta_whatsapp = $${idx++}`);
                    params.push(body.cta_whatsapp ?? null);
                }
                if ('cta_phone' in body) {
                    setClauses.push(`cta_phone = $${idx++}`);
                    params.push(body.cta_phone ?? null);
                }
                if ('cta_email' in body) {
                    setClauses.push(`cta_email = $${idx++}`);
                    params.push(body.cta_email ?? null);
                }
                if ('cta_url' in body) {
                    setClauses.push(`cta_url = $${idx++}`);
                    params.push(body.cta_url ?? null);
                }
                // Recalculate quality score with merged values
                const merged = {
                    title: body.title ?? existing.title,
                    summary: body.summary ?? existing.summary,
                    description: body.description ?? existing.description,
                    price: 'price' in body ? body.price : existing.price,
                    location_text: 'location_text' in body ? body.location_text : existing.location_text,
                    cta_phone: 'cta_phone' in body ? body.cta_phone : existing.cta_phone,
                    cta_whatsapp: 'cta_whatsapp' in body ? body.cta_whatsapp : existing.cta_whatsapp,
                    cta_email: 'cta_email' in body ? body.cta_email : existing.cta_email,
                };
                const mediaCountRow = await client.query(`SELECT
             COUNT(*) FILTER (WHERE media_pack = 'AMBASSADOR_PACK') AS ambassador_count,
             COUNT(*) FILTER (WHERE media_pack = 'PRODUCT_GALLERY') AS gallery_count
           FROM advert_media WHERE listing_id = $1`, [existing.id]);
                const fvRow = await client.query(`SELECT field_key, field_value FROM advert_listing_field_values WHERE listing_id = $1`, [existing.id]);
                const existingFieldValues = {};
                for (const fv of fvRow.rows) {
                    existingFieldValues[fv.field_key] = fv.field_value;
                }
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
                const updatedRow = await client.query(`UPDATE advert_listings SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`, params);
                // Upsert field values if provided
                if (body.field_values) {
                    const entries = Object.entries(body.field_values).filter(([, v]) => v != null);
                    if (entries.length > 0) {
                        const fvParams = [];
                        const fvPlaceholders = entries.map(([key, value], i) => {
                            const b = i * 4;
                            fvParams.push(uuid(), existing.id, key, String(value));
                            return `($${b + 1},$${b + 2},$${b + 3},$${b + 4})`;
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
        }
        catch (err) {
            if (err.statusCode)
                return reply.code(err.statusCode).send({ error: err.message });
            app.log.error(err, 'advert.listing.update.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // POST /api/advert/listings/:slug/media — Add a media item to an existing listing
    app.post('/advert/listings/:slug/media', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
        const { slug } = request.params;
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
        let body;
        try {
            body = bodySchema.parse(request.body);
        }
        catch (err) {
            return reply.code(400).send({ error: 'validation_error', details: err.errors ?? err.message });
        }
        try {
            const media = await withTransaction(async (client) => {
                const listingRow = await client.query(`SELECT id, business_id FROM advert_listings WHERE slug = $1`, [slug]);
                if (!listingRow.rows[0])
                    throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
                if (listingRow.rows[0].business_id !== userId)
                    throw Object.assign(new Error('forbidden'), { statusCode: 403 });
                const listingId = listingRow.rows[0].id;
                if (body.media_pack === 'AMBASSADOR_PACK') {
                    const countRow = await client.query(`SELECT COUNT(*) FROM advert_media WHERE listing_id = $1 AND media_pack = 'AMBASSADOR_PACK'`, [listingId]);
                    if (Number(countRow.rows[0].count) >= 5) {
                        throw Object.assign(new Error('ambassador_pack_limit_reached'), { statusCode: 400 });
                    }
                }
                const sortRow = await client.query(`SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM advert_media WHERE listing_id = $1 AND media_pack = $2`, [listingId, body.media_pack]);
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
        }
        catch (err) {
            if (err.statusCode)
                return reply.code(err.statusCode).send({ error: err.message });
            app.log.error(err, 'advert.listing.media.add.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // DELETE /api/advert/listings/:slug/media/:mediaId — Remove a media item
    app.delete('/advert/listings/:slug/media/:mediaId', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
        const { slug, mediaId } = request.params;
        try {
            await withTransaction(async (client) => {
                const listingRow = await client.query(`SELECT id, business_id FROM advert_listings WHERE slug = $1`, [slug]);
                if (!listingRow.rows[0])
                    throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
                if (listingRow.rows[0].business_id !== userId)
                    throw Object.assign(new Error('forbidden'), { statusCode: 403 });
                const deleted = await client.query(`DELETE FROM advert_media WHERE id = $1 AND listing_id = $2 RETURNING id`, [mediaId, listingRow.rows[0].id]);
                if (!deleted.rows[0])
                    throw Object.assign(new Error('media_not_found'), { statusCode: 404 });
            });
            return reply.send({ success: true });
        }
        catch (err) {
            if (err.statusCode)
                return reply.code(err.statusCode).send({ error: err.message });
            app.log.error(err, 'advert.listing.media.delete.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // DELETE /api/advert/listings/:slug — Remove a draft listing owned by the business
    app.delete('/advert/listings/:slug', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
        const { slug } = request.params;
        try {
            await withTransaction(async (client) => {
                const listingRow = await client.query(`SELECT id, business_id, status, campaign_id FROM advert_listings WHERE slug = $1`, [slug]);
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
                const linkedCampaignId = listingRow.rows[0].campaign_id ?? null;
                if (linkedCampaignId) {
                    const escrowCheck = await client.query(`SELECT status FROM escrow_ledger WHERE campaign_id = $1 LIMIT 1`, [linkedCampaignId]);
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
                    const allCampaignIdsRes = await client.query(`SELECT id FROM campaigns WHERE id = $1 OR parent_campaign_id = $1`, [linkedCampaignId]);
                    const allCampaignIds = allCampaignIdsRes.rows.map((r) => r.id);
                    const sessionRes = await client.query(`SELECT id FROM verification_sessions WHERE campaign_id = ANY($1::uuid[])`, [allCampaignIds]);
                    const sessionIds = sessionRes.rows.map((r) => r.id);
                    const proofRes = await client.query(`SELECT id FROM proofs WHERE session_id = ANY($1::uuid[])`, [sessionIds.length ? sessionIds : [linkedCampaignId]]);
                    const proofIds = proofRes.rows.map((r) => r.id);
                    if (proofIds.length) {
                        await client.query(`DELETE FROM payout_requests WHERE proof_id = ANY($1::uuid[])`, [proofIds]);
                    }
                    // pesapal_transactions references escrow_ledger — must go before escrow_ledger
                    await client.query(`DELETE FROM pesapal_transactions
             WHERE escrow_id IN (
               SELECT id FROM escrow_ledger WHERE campaign_id = ANY($1::uuid[])
             )`, [allCampaignIds]);
                    if (proofIds.length || sessionIds.length) {
                        await client.query(`DELETE FROM proofs WHERE id = ANY($1::uuid[]) OR session_id = ANY($2::uuid[])`, [
                            proofIds.length ? proofIds : [linkedCampaignId],
                            sessionIds.length ? sessionIds : [linkedCampaignId],
                        ]);
                    }
                    await client.query(`DELETE FROM verification_sessions WHERE campaign_id = ANY($1::uuid[])`, [allCampaignIds]);
                    await client.query(`DELETE FROM contracts WHERE campaign_id = ANY($1::uuid[])`, [allCampaignIds]);
                    await client.query(`DELETE FROM escrow_ledger WHERE campaign_id = ANY($1::uuid[])`, [allCampaignIds]);
                    await client.query(`DELETE FROM campaigns WHERE id = ANY($1::uuid[])`, [allCampaignIds]);
                }
            });
            return reply.send({ success: true, slug });
        }
        catch (err) {
            if (err.statusCode) {
                return reply.code(err.statusCode).send({ error: err.message });
            }
            app.log.error(err, 'advert.listing.delete.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // GET /api/advert/listings/me — Business's own listings
    app.get('/advert/listings/me', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
        const query = request.query;
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
          JOIN advert_listing_types lt ON lt.id = al.listing_type_id
          JOIN advert_subcategories s ON s.id = lt.subcategory_id
          JOIN advert_categories c ON c.id = s.category_id
          WHERE al.business_id = $1
            AND ($4::text IS NULL OR al.status = $4)
          ORDER BY al.created_at DESC
          LIMIT $2 OFFSET $3
        `, [userId, limit, offset, query.status ?? null]);
                const countResult = await client.query(`SELECT COUNT(*) FROM advert_listings WHERE business_id = $1`, [userId]);
                return {
                    listings: listings.rows,
                    total: parseInt(countResult.rows[0].count, 10),
                    page,
                    limit,
                };
            });
            return reply.send(result);
        }
        catch (err) {
            app.log.error(err, 'advert.listings.me.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // GET /api/advert/listings/:slug — Public listing page
    app.get('/advert/listings/:slug', async (request, reply) => {
        const { slug } = request.params;
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
          JOIN advert_listing_types lt ON lt.id = al.listing_type_id
          JOIN advert_subcategories s ON s.id = lt.subcategory_id
          JOIN advert_categories c ON c.id = s.category_id
          WHERE al.slug = $1
        `, [slug]);
                if (!row.rows[0])
                    return { gone: false, notFound: true };
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
                    const [mediaRows, fieldRows] = await Promise.all([
                        client.query(`
              SELECT id, media_pack, media_type, url, thumbnail_url, file_name,
                     mime_type, duration_secs, sort_order
              FROM advert_media WHERE listing_id = $1 ORDER BY media_pack, sort_order
            `, [listingId]),
                        client.query(`SELECT field_key, field_value FROM advert_listing_field_values WHERE listing_id = $1`, [listingId]),
                    ]);
                    const ambassadorMedia = mediaRows.rows.filter((m) => m.media_pack === 'AMBASSADOR_PACK');
                    const galleryMedia = mediaRows.rows.filter((m) => m.media_pack === 'PRODUCT_GALLERY');
                    const fieldValues = {};
                    for (const fv of fieldRows.rows) {
                        fieldValues[fv.field_key] = fv.field_value;
                    }
                    return {
                        gone: false, notFound: false,
                        listing: {
                            ...listing, is_draft: true,
                            ambassador_media: ambassadorMedia,
                            gallery_media: galleryMedia,
                            field_values: fieldValues,
                            time_remaining_secs: 0,
                            business_id: undefined,
                        },
                    };
                }
                // Enforce campaign-duration access control:
                // listing is inaccessible once campaign_end_at has passed,
                // unless admin_keep_alive is set.
                const timeRemainingSecs = Number(listing.time_remaining_secs ?? -1);
                const isExpired = !listing.admin_keep_alive && timeRemainingSecs <= 0;
                // Auto-expire in DB if needed
                if (isExpired && listing.status === 'ACTIVE') {
                    await client.query(`UPDATE advert_listings SET status = 'EXPIRED', updated_at = now()
             WHERE id = $1`, [listingId]);
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
            SELECT field_key, field_value
            FROM advert_listing_field_values
            WHERE listing_id = $1
          `, [listingId]),
                ]);
                const ambassadorMedia = mediaRows.rows.filter((m) => m.media_pack === 'AMBASSADOR_PACK');
                const galleryMedia = mediaRows.rows.filter((m) => m.media_pack === 'PRODUCT_GALLERY');
                const fieldValues = {};
                for (const fv of fieldRows.rows) {
                    fieldValues[fv.field_key] = fv.field_value;
                }
                return {
                    gone: false,
                    notFound: false,
                    listing: {
                        ...listing,
                        ambassador_media: ambassadorMedia,
                        gallery_media: galleryMedia,
                        field_values: fieldValues,
                        time_remaining_secs: Math.max(0, timeRemainingSecs),
                        business_id: undefined,
                    },
                };
            });
            if (!result)
                return reply.code(500).send({ error: 'internal_server_error' });
            if (result.notFound)
                return reply.code(404).send({ error: 'listing_not_found' });
            if (result.blocked) {
                return reply.code(404).send({
                    error: 'listing_access_restricted',
                    state: result.blockedState,
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
        }
        catch (err) {
            app.log.error(err, 'advert.listing.get.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // GET /api/advert/listings/:slug/time-status — Live time poll (lightweight, no session)
    app.get('/advert/listings/:slug/time-status', async (request, reply) => {
        const { slug } = request.params;
        try {
            const result = await withTransaction(async (client) => {
                const row = await client.query(`
          SELECT
            id, status, admin_keep_alive, access_state,
            campaign_start_at, campaign_end_at,
            EXTRACT(EPOCH FROM (campaign_end_at - now()))::bigint AS time_remaining_secs
          FROM advert_listings WHERE slug = $1
        `, [slug]);
                return row.rows[0] ?? null;
            });
            if (!result)
                return reply.code(404).send({ error: 'listing_not_found' });
            const accessState = String(result.access_state ?? 'PUBLIC').toUpperCase();
            const remaining = Number(result.time_remaining_secs ?? -1);
            const isLive = accessState === 'PUBLIC' && (result.status === 'DRAFT' ||
                result.admin_keep_alive ||
                remaining > 0);
            return reply.send({
                is_live: isLive,
                time_remaining_secs: Math.max(0, remaining),
                campaign_start_at: result.campaign_start_at,
                campaign_end_at: result.campaign_end_at,
                status: result.status,
                access_state: accessState,
            });
        }
        catch (err) {
            app.log.error(err, 'advert.time_status.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // GET /api/advert/listings/:slug/by-campaign — Get listing by campaign (auth)
    app.get('/advert/campaigns/:campaignId/listing', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const { campaignId } = request.params;
        const userId = String(request.user?.sub ?? '').trim();
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
            if (!result)
                return reply.code(404).send({ error: 'listing_not_found' });
            return reply.send({ listing: result });
        }
        catch (err) {
            app.log.error(err, 'advert.listing.by-campaign.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // ─── TRACKING LINKS ──────────────────────────
    // POST /api/advert/listings/:slug/tracking-link — Generate/get ambassador tracking link
    app.post('/advert/listings/:slug/tracking-link', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const { slug } = request.params;
        const userId = String(request.user?.sub ?? '').trim();
        try {
            const result = await withTransaction(async (client) => {
                const listingRow = await client.query(`SELECT id FROM advert_listings WHERE slug = $1 AND status = 'ACTIVE'`, [slug]);
                if (!listingRow.rows[0]) {
                    throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
                }
                const listingId = listingRow.rows[0].id;
                // Upsert tracking link
                const existing = await client.query(`SELECT id, ambassador_code FROM advert_tracking_links WHERE listing_id = $1 AND ambassador_id = $2`, [listingId, userId]);
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
        }
        catch (err) {
            if (err.statusCode)
                return reply.code(err.statusCode).send({ error: err.message });
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
        let body;
        try {
            body = bodySchema.parse(request.body);
        }
        catch (err) {
            return reply.code(400).send({ error: 'validation_error' });
        }
        try {
            const sessionId = await withTransaction(async (client) => {
                // Check listing exists
                const listing = await client.query(`SELECT id FROM advert_listings WHERE id = $1`, [body.listing_id]);
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
        }
        catch (err) {
            if (err.statusCode)
                return reply.code(err.statusCode).send({ error: err.message });
            app.log.error(err, 'advert.sessions.create.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // PATCH /api/advert/sessions/:sessionId — Close session with duration/scroll data
    app.patch('/advert/sessions/:sessionId', async (request, reply) => {
        const { sessionId } = request.params;
        const bodySchema = z.object({
            session_duration_secs: z.number().int().nonnegative().optional(),
            scroll_depth_pct: z.number().int().min(0).max(100).optional(),
        });
        let body;
        try {
            body = bodySchema.parse(request.body);
        }
        catch {
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
        }
        catch (err) {
            app.log.error(err, 'advert.sessions.close.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // POST /api/advert/events — Track engagement event
    app.post('/advert/events', async (request, reply) => {
        const validEventTypes = [
            'PAGE_VIEW', 'CTA_TAP', 'WHATSAPP_TAP', 'PHONE_TAP', 'EMAIL_TAP',
            'MAP_OPEN', 'GALLERY_OPEN', 'OFFER_START', 'NEGOTIATION_START',
            'OUTBOUND_TAP', 'SHARE_TAP', 'CONVERSION_INTENT',
        ];
        const bodySchema = z.object({
            listing_id: z.string().uuid(),
            session_id: z.string().uuid().optional().nullable(),
            ambassador_code: z.string().optional().nullable(),
            event_type: z.enum(validEventTypes),
            event_meta: z.record(z.unknown()).optional().nullable(),
        });
        let body;
        try {
            body = bodySchema.parse(request.body);
        }
        catch (err) {
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
                if (body.ambassador_code && ['CTA_TAP', 'WHATSAPP_TAP', 'PHONE_TAP'].includes(body.event_type)) {
                    await client.query(`
            UPDATE advert_tracking_links
            SET cta_taps = cta_taps + 1
            WHERE ambassador_code = $1
          `, [body.ambassador_code]);
                }
            });
            return reply.code(201).send({ ok: true });
        }
        catch (err) {
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
            interaction_type: z.enum(['IMAGE_VIEW', 'VIDEO_PLAY', 'VIDEO_PAUSE', 'VIDEO_COMPLETE', 'DOCUMENT_OPEN']),
            watch_duration_secs: z.number().nonnegative().optional().nullable(),
            completion_pct: z.number().min(0).max(100).optional().nullable(),
        });
        let body;
        try {
            body = bodySchema.parse(request.body);
        }
        catch {
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
                    await client.query(`UPDATE advert_media SET views = views + 1 WHERE id = $1`, [body.media_id]);
                }
                else if (body.interaction_type === 'VIDEO_PLAY') {
                    await client.query(`UPDATE advert_media SET plays = plays + 1 WHERE id = $1`, [body.media_id]);
                }
                else if (body.interaction_type === 'VIDEO_COMPLETE' && body.watch_duration_secs) {
                    await client.query(`UPDATE advert_media SET watch_time_secs = watch_time_secs + $2 WHERE id = $1`, [body.media_id, body.watch_duration_secs]);
                }
            });
            return reply.code(201).send({ ok: true });
        }
        catch (err) {
            app.log.error(err, 'advert.media_interactions.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // ─── ANALYTICS DASHBOARD ─────────────────────
    // GET /api/advert/listings/:slug/analytics — Business analytics (auth)
    app.get('/advert/listings/:slug/analytics', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const { slug } = request.params;
        const userId = String(request.user?.sub ?? '').trim();
        const query = request.query;
        const days = Math.min(90, Math.max(1, parseInt(query.days ?? '30', 10)));
        try {
            const data = await withTransaction(async (client) => {
                const listingRow = await client.query(`SELECT id, title, status, views_total, views_unique, listing_quality_score,
                  created_at, expires_at
           FROM advert_listings WHERE slug = $1 AND business_id = $2`, [slug, userId]);
                if (!listingRow.rows[0]) {
                    throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
                }
                const listing = listingRow.rows[0];
                const listingId = listing.id;
                const since = new Date();
                since.setDate(since.getDate() - days);
                const [engagementSummary, ambassadorPerf, mediaPerf, deviceBreakdown, returnVsNew, offersSummary,] = await Promise.all([
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
                const engagementMap = {};
                for (const row of engagementSummary.rows) {
                    engagementMap[row.event_type] = parseInt(row.count, 10);
                }
                const returnCount = returnVsNew.rows.find((r) => r.is_return_visitor)?.count ?? 0;
                const newCount = returnVsNew.rows.find((r) => !r.is_return_visitor)?.count ?? 0;
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
        }
        catch (err) {
            if (err.statusCode)
                return reply.code(err.statusCode).send({ error: err.message });
            app.log.error(err, 'advert.analytics.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // ─── OFFERS / NEGOTIATIONS ────────────────────
    // POST /api/advert/listings/:slug/offers
    app.post('/advert/listings/:slug/offers', async (request, reply) => {
        const { slug } = request.params;
        const bodySchema = z.object({
            offeror_name: z.string().min(2).max(100),
            offeror_phone: z.string().optional().nullable(),
            offeror_email: z.string().email().optional().nullable(),
            offer_amount: z.number().positive().optional().nullable(),
            offer_message: z.string().min(5).max(1000),
            visitor_fingerprint: z.string().optional().nullable(),
            ambassador_code: z.string().optional().nullable(),
        });
        let body;
        try {
            body = bodySchema.parse(request.body);
        }
        catch (err) {
            return reply.code(400).send({ error: 'validation_error', details: err.errors });
        }
        try {
            const offer = await withTransaction(async (client) => {
                const listingRow = await client.query(`SELECT id, currency, is_negotiable
           FROM advert_listings
           WHERE slug = $1
             AND status = 'ACTIVE'
             AND access_state = 'PUBLIC'`, [slug]);
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
        }
        catch (err) {
            if (err.statusCode)
                return reply.code(err.statusCode).send({ error: err.message });
            app.log.error(err, 'advert.offers.create.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // GET /api/advert/listings/:slug/offers — Business view of offers
    app.get('/advert/listings/:slug/offers', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const { slug } = request.params;
        const userId = String(request.user?.sub ?? '').trim();
        try {
            const offers = await withTransaction(async (client) => {
                const listingRow = await client.query(`SELECT id FROM advert_listings WHERE slug = $1 AND business_id = $2`, [slug, userId]);
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
        }
        catch (err) {
            if (err.statusCode)
                return reply.code(err.statusCode).send({ error: err.message });
            app.log.error(err, 'advert.offers.list.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // PATCH /api/advert/offers/:offerId — Business responds to offer
    app.patch('/advert/offers/:offerId', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const { offerId } = request.params;
        const userId = String(request.user?.sub ?? '').trim();
        const bodySchema = z.object({
            status: z.enum(['ACCEPTED', 'REJECTED', 'COUNTERED', 'CONTACTED', 'CLOSED']),
            counter_amount: z.number().positive().optional().nullable(),
            counter_message: z.string().max(500).optional().nullable(),
            business_note: z.string().max(500).optional().nullable(),
        });
        let body;
        try {
            body = bodySchema.parse(request.body);
        }
        catch (err) {
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
        }
        catch (err) {
            if (err.statusCode)
                return reply.code(err.statusCode).send({ error: err.message });
            app.log.error(err, 'advert.offers.update.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // POST /api/advert/offers/:offerId/messages — Add message to offer thread
    app.post('/advert/offers/:offerId/messages', async (request, reply) => {
        const { offerId } = request.params;
        const bodySchema = z.object({
            sender_role: z.enum(['BUYER', 'BUSINESS']),
            message: z.string().min(1).max(1000),
            visitor_fingerprint: z.string().optional().nullable(),
        });
        let body;
        try {
            body = bodySchema.parse(request.body);
        }
        catch {
            return reply.code(400).send({ error: 'validation_error' });
        }
        try {
            const msg = await withTransaction(async (client) => {
                const offerRow = await client.query(`SELECT id FROM advert_offers WHERE id = $1`, [offerId]);
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
        }
        catch (err) {
            if (err.statusCode)
                return reply.code(err.statusCode).send({ error: err.message });
            app.log.error(err, 'advert.offer_messages.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // ─── ADMIN: LISTINGS LIST ────────────────────────────────────────────────
    // GET /api/admin/advert/listings — Admin: list all listings across all businesses
    app.get('/admin/advert/listings', {
        preHandler: [app.adminOnly],
    }, async (request, reply) => {
        const query = request.query;
        const page = Math.max(1, parseInt(query.page ?? '1', 10));
        const limit = Math.min(100, Math.max(1, parseInt(query.limit ?? '30', 10)));
        const offset = (page - 1) * limit;
        try {
            const result = await withTransaction(async (client) => {
                const rows = await client.query(`
          SELECT
            al.id, al.slug, al.title, al.status, al.access_state,
            al.is_promoted, al.admin_keep_alive, al.admin_action_note, al.admin_action_at,
            al.views_total, al.views_unique, al.listing_quality_score,
            al.campaign_start_at, al.campaign_end_at,
            al.created_at,
            EXTRACT(EPOCH FROM (al.campaign_end_at - now()))::bigint AS time_remaining_secs,
            u.full_name AS business_name, u.email AS business_email,
            COALESCE(c.id, al.campaign_id) AS campaign_id,
            lt.name AS listing_type_name,
            s.name AS subcategory_name,
            cat.name AS category_name,
            (SELECT COUNT(*) FROM advert_offers o WHERE o.listing_id = al.id AND o.status = 'PENDING') AS pending_offers
          FROM advert_listings al
          JOIN users u ON u.id = al.business_id
          LEFT JOIN campaigns c ON c.id = al.campaign_id
          JOIN advert_listing_types lt ON lt.id = al.listing_type_id
          JOIN advert_subcategories s ON s.id = lt.subcategory_id
          JOIN advert_categories cat ON cat.id = s.category_id
          WHERE ($3::text IS NULL OR al.status = $3)
            AND ($4::text IS NULL OR
                 al.title ILIKE '%' || $4 || '%' OR
                 u.full_name ILIKE '%' || $4 || '%' OR
                 al.slug ILIKE '%' || $4 || '%')
          ORDER BY al.is_promoted DESC, al.created_at DESC
          LIMIT $1 OFFSET $2
        `, [limit, offset, query.status ?? null, query.search ?? null]);
                const countRow = await client.query(`
          SELECT COUNT(*) FROM advert_listings al
          JOIN users u ON u.id = al.business_id
          WHERE ($1::text IS NULL OR al.status = $1)
            AND ($2::text IS NULL OR
                 al.title ILIKE '%' || $2 || '%' OR
                 u.full_name ILIKE '%' || $2 || '%' OR
                 al.slug ILIKE '%' || $2 || '%')
        `, [query.status ?? null, query.search ?? null]);
                return {
                    listings: rows.rows,
                    total: parseInt(countRow.rows[0]?.count ?? '0', 10),
                    page,
                    limit,
                };
            });
            return reply.send(result);
        }
        catch (err) {
            app.log.error(err, 'admin.advert.listings.list.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // ─── ADMIN: KEEP-ALIVE OVERRIDE ──────────────────────────────────────────
    app.patch('/admin/advert/listings/:slug/actions', {
        preHandler: [app.adminOnly],
    }, async (request, reply) => {
        const { slug } = request.params;
        const adminUserId = String(request.user?.sub ?? '').trim();
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
        let body;
        try {
            body = bodySchema.parse(request.body);
        }
        catch {
            return reply.code(400).send({ error: 'validation_error' });
        }
        try {
            const updated = await withTransaction(async (client) => {
                const row = await client.query(`SELECT slug, access_state, is_promoted FROM advert_listings WHERE slug = $1`, [slug]);
                if (!row.rows[0]) {
                    throw Object.assign(new Error('listing_not_found'), { statusCode: 404 });
                }
                const action = body.action;
                const nextAccessState = action === 'REVOKE_URL'
                    ? 'REVOKED'
                    : action === 'BAN'
                        ? 'BANNED'
                        : action === 'CLOSE'
                            ? 'CLOSED'
                            : action === 'RESTORE_URL' || action === 'UNBAN' || action === 'REOPEN'
                                ? 'PUBLIC'
                                : String(row.rows[0].access_state ?? 'PUBLIC');
                const nextPromoted = action === 'PROMOTE'
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
        }
        catch (err) {
            if (err.statusCode)
                return reply.code(err.statusCode).send({ error: err.message });
            app.log.error(err, 'advert.admin_action.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // PATCH /api/advert/listings/:slug/admin-keep-alive
    // Allows admins to keep a listing accessible after its campaign has ended.
    app.patch('/advert/listings/:slug/admin-keep-alive', {
        preHandler: [app.adminOnly],
    }, async (request, reply) => {
        const { slug } = request.params;
        const bodySchema = z.object({
            keep_alive: z.boolean(),
            extend_until: z.string().optional().nullable(), // ISO date, optional new deadline
        });
        let body;
        try {
            body = bodySchema.parse(request.body);
        }
        catch {
            return reply.code(400).send({ error: 'validation_error' });
        }
        try {
            const updated = await withTransaction(async (client) => {
                const row = await client.query(`SELECT id FROM advert_listings WHERE slug = $1`, [slug]);
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
        }
        catch (err) {
            if (err.statusCode)
                return reply.code(err.statusCode).send({ error: err.message });
            app.log.error(err, 'advert.admin_keep_alive.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
}
