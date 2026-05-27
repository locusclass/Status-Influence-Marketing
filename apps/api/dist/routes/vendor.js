// routes/vendor.ts
// Vendor Commerce Ecosystem — authenticated vendor management
// All routes under /vendor/* require JWT auth
import { z } from 'zod';
import { withTransaction, query } from '../db.js';
import { v4 as uuid } from 'uuid';
// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function slugifyVendor(text) {
    return text
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 48);
}
async function ensureUniqueVendorSlug(base) {
    let slug = base;
    let attempt = 0;
    while (attempt < 10) {
        const rows = await query(`SELECT id FROM vendor_profiles WHERE slug = $1 LIMIT 1`, [slug]);
        if (!rows[0])
            return slug;
        attempt++;
        slug = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    }
    return `${base}-${Date.now().toString(36)}`;
}
async function getVendorForUser(userId) {
    const rows = await query(`SELECT * FROM vendor_profiles WHERE user_id = $1 LIMIT 1`, [userId]);
    return rows[0] ?? null;
}
// ─────────────────────────────────────────────
// VALIDATION SCHEMAS
// ─────────────────────────────────────────────
const registerVendorSchema = z.object({
    vendor_name: z.string().min(2).max(100),
    description: z.string().min(10).max(2000).optional().nullable(),
    phone_number: z.string().max(30).optional().nullable(),
    whatsapp_number: z.string().max(30).optional().nullable(),
    email: z.string().email().optional().nullable(),
    business_location: z.string().max(300).optional().nullable(),
    business_category: z.string().max(100).optional().nullable(),
    logo_url: z.string().url().optional().nullable(),
    banner_url: z.string().url().optional().nullable(),
    social_instagram: z.string().max(200).optional().nullable(),
    social_facebook: z.string().max(200).optional().nullable(),
    social_twitter: z.string().max(200).optional().nullable(),
    social_tiktok: z.string().max(200).optional().nullable(),
    website_url: z.string().url().optional().nullable(),
});
const updateVendorSchema = registerVendorSchema.partial();
const replyInquirySchema = z.object({
    reply: z.string().min(1).max(2000),
});
const negotiationResponseSchema = z.object({
    action: z.enum(['COUNTER', 'ACCEPT', 'REJECT']),
    offer_amount: z.number().positive().optional(),
    message: z.string().max(1000).optional(),
});
const createBoostSchema = z.object({
    plan_id: z.string().uuid(),
    listing_id: z.string().uuid().optional().nullable(),
});
// ─────────────────────────────────────────────
// ROUTE REGISTRATION
// ─────────────────────────────────────────────
export async function vendorRoutes(app) {
    // ── POST /vendor/register ────────────────────────────────────────────────
    // Create a vendor profile for the authenticated user
    app.post('/vendor/register', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
        if (!userId)
            return reply.code(401).send({ error: 'unauthorized' });
        const parsed = registerVendorSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'validation_error', issues: parsed.error.issues });
        }
        const body = parsed.data;
        // Check not already registered
        const existing = await getVendorForUser(userId);
        if (existing) {
            return reply.code(409).send({ error: 'vendor_already_registered', vendor: existing });
        }
        const slug = await ensureUniqueVendorSlug(slugifyVendor(body.vendor_name));
        const vendorId = uuid();
        try {
            const rows = await query(`INSERT INTO vendor_profiles (
          id, user_id, vendor_name, slug, description,
          phone_number, whatsapp_number, email,
          business_location, business_category,
          logo_url, banner_url,
          social_instagram, social_facebook, social_twitter, social_tiktok, website_url
        ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8,
          $9, $10,
          $11, $12,
          $13, $14, $15, $16, $17
        ) RETURNING *`, [
                vendorId, userId, body.vendor_name, slug, body.description ?? null,
                body.phone_number ?? null, body.whatsapp_number ?? null, body.email ?? null,
                body.business_location ?? null, body.business_category ?? null,
                body.logo_url ?? null, body.banner_url ?? null,
                body.social_instagram ?? null, body.social_facebook ?? null,
                body.social_twitter ?? null, body.social_tiktok ?? null, body.website_url ?? null,
            ]);
            return reply.code(201).send({ ok: true, vendor: rows[0] });
        }
        catch (err) {
            app.log.error(err, 'vendor.register.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // ── GET /vendor/profile ──────────────────────────────────────────────────
    app.get('/vendor/profile', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
        if (!userId)
            return reply.code(401).send({ error: 'unauthorized' });
        try {
            const vendor = await getVendorForUser(userId);
            if (!vendor)
                return reply.code(404).send({ error: 'vendor_not_found' });
            const listingCount = await query(`SELECT COUNT(*)::int AS total FROM advert_listings WHERE vendor_id = $1 AND status = 'ACTIVE'`, [vendor.id]);
            return { vendor, listing_count: Number(listingCount[0]?.total ?? 0) };
        }
        catch (err) {
            app.log.error(err, 'vendor.profile.get.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // ── PATCH /vendor/profile ────────────────────────────────────────────────
    app.patch('/vendor/profile', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
        if (!userId)
            return reply.code(401).send({ error: 'unauthorized' });
        const parsed = updateVendorSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'validation_error', issues: parsed.error.issues });
        }
        const body = parsed.data;
        try {
            const vendor = await getVendorForUser(userId);
            if (!vendor)
                return reply.code(404).send({ error: 'vendor_not_found' });
            const sets = [];
            const vals = [];
            const add = (col, val) => { vals.push(val); sets.push(`${col} = $${vals.length}`); };
            if (body.vendor_name !== undefined)
                add('vendor_name', body.vendor_name);
            if (body.description !== undefined)
                add('description', body.description ?? null);
            if (body.phone_number !== undefined)
                add('phone_number', body.phone_number ?? null);
            if (body.whatsapp_number !== undefined)
                add('whatsapp_number', body.whatsapp_number ?? null);
            if (body.email !== undefined)
                add('email', body.email ?? null);
            if (body.business_location !== undefined)
                add('business_location', body.business_location ?? null);
            if (body.business_category !== undefined)
                add('business_category', body.business_category ?? null);
            if (body.logo_url !== undefined)
                add('logo_url', body.logo_url ?? null);
            if (body.banner_url !== undefined)
                add('banner_url', body.banner_url ?? null);
            if (body.social_instagram !== undefined)
                add('social_instagram', body.social_instagram ?? null);
            if (body.social_facebook !== undefined)
                add('social_facebook', body.social_facebook ?? null);
            if (body.social_twitter !== undefined)
                add('social_twitter', body.social_twitter ?? null);
            if (body.social_tiktok !== undefined)
                add('social_tiktok', body.social_tiktok ?? null);
            if (body.website_url !== undefined)
                add('website_url', body.website_url ?? null);
            if (sets.length === 0)
                return { ok: true, vendor };
            sets.push(`updated_at = NOW()`);
            vals.push(vendor.id);
            const updated = await query(`UPDATE vendor_profiles SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING *`, vals);
            return { ok: true, vendor: updated[0] };
        }
        catch (err) {
            app.log.error(err, 'vendor.profile.patch.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // ── GET /vendor/dashboard/overview ──────────────────────────────────────
    app.get('/vendor/dashboard/overview', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
        if (!userId)
            return reply.code(401).send({ error: 'unauthorized' });
        try {
            const vendor = await getVendorForUser(userId);
            if (!vendor)
                return reply.code(404).send({ error: 'vendor_not_found' });
            const [stats, recentInquiries, recentNegotiations, topListings, boosts] = await Promise.all([
                // aggregated stats
                query(`
          SELECT
            COUNT(DISTINCT al.id) FILTER (WHERE al.status = 'ACTIVE')          AS active_listings,
            COUNT(DISTINCT al.id) FILTER (WHERE al.listing_kind = 'PRODUCT')   AS product_count,
            COUNT(DISTINCT al.id) FILTER (WHERE al.listing_kind = 'SERVICE')   AS service_count,
            COALESCE(SUM(al.views_total), 0)                                   AS total_views,
            COALESCE(SUM(al.qr_scan_count), 0)                                 AS total_qr_scans
          FROM advert_listings al
          WHERE al.vendor_id = $1`, [vendor.id]),
                // recent unread inquiries count
                query(`
          SELECT COUNT(*)::int AS unread_count
          FROM vendor_inquiries
          WHERE vendor_id = $1 AND status = 'NEW'`, [vendor.id]),
                // open negotiations count
                query(`
          SELECT COUNT(*)::int AS open_count
          FROM negotiation_threads
          WHERE vendor_id = $1 AND status = 'ACTIVE'`, [vendor.id]),
                // top 5 listings by views
                query(`
          SELECT id, slug, title, views_total, qr_scan_count, listing_kind, status,
            (SELECT url FROM advert_media am WHERE am.listing_id = al.id AND am.media_type = 'IMAGE'
             ORDER BY am.sort_order LIMIT 1) AS hero_url
          FROM advert_listings al
          WHERE vendor_id = $1
          ORDER BY views_total DESC
          LIMIT 5`, [vendor.id]),
                // active boosts
                query(`
          SELECT vb.id, vb.boost_type, vb.ends_at, vb.impressions, vb.clicks,
                 vbp.name AS plan_name, al.title AS listing_title
          FROM vendor_boosts vb
          LEFT JOIN vendor_boost_plans vbp ON vbp.id = vb.plan_id
          LEFT JOIN advert_listings al ON al.id = vb.listing_id
          WHERE vb.vendor_id = $1 AND vb.status = 'ACTIVE' AND vb.ends_at > NOW()
          ORDER BY vb.ends_at ASC
          LIMIT 5`, [vendor.id]),
            ]);
            // 7-day view trend
            const trend = await query(`
        SELECT
          DATE_TRUNC('day', created_at AT TIME ZONE 'UTC')::date AS day,
          COUNT(*) AS views
        FROM vendor_analytics_events
        WHERE vendor_id = $1
          AND event_type IN ('STOREFRONT_VIEW', 'LISTING_VIEW')
          AND created_at > NOW() - INTERVAL '7 days'
        GROUP BY 1
        ORDER BY 1 ASC`, [vendor.id]);
            return {
                vendor,
                stats: {
                    ...stats[0],
                    unread_inquiries: Number(recentInquiries[0]?.unread_count ?? 0),
                    open_negotiations: Number(recentNegotiations[0]?.open_count ?? 0),
                },
                top_listings: topListings,
                active_boosts: boosts,
                view_trend_7d: trend,
            };
        }
        catch (err) {
            app.log.error(err, 'vendor.dashboard.overview.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // ── GET /vendor/inquiries ────────────────────────────────────────────────
    app.get('/vendor/inquiries', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
        if (!userId)
            return reply.code(401).send({ error: 'unauthorized' });
        const q = request.query;
        const page = Math.max(1, parseInt(q.page ?? '1', 10));
        const limit = Math.min(50, parseInt(q.limit ?? '20', 10));
        const status = (q.status ?? '').trim() || null;
        const offset = (page - 1) * limit;
        try {
            const vendor = await getVendorForUser(userId);
            if (!vendor)
                return reply.code(404).send({ error: 'vendor_not_found' });
            const conditions = [`vi.vendor_id = $1`];
            const params = [vendor.id];
            if (status) {
                params.push(status);
                conditions.push(`vi.status = $${params.length}`);
            }
            const where = conditions.join(' AND ');
            const [rows, countRows] = await Promise.all([
                query(`
          SELECT vi.*, al.title AS listing_title, al.slug AS listing_slug
          FROM vendor_inquiries vi
          LEFT JOIN advert_listings al ON al.id = vi.listing_id
          WHERE ${where}
          ORDER BY vi.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]),
                query(`SELECT COUNT(*)::int AS total FROM vendor_inquiries vi WHERE ${where}`, params),
            ]);
            // Mark fetched inquiries as READ if they were NEW
            const newIds = rows.filter(r => r.status === 'NEW').map(r => r.id);
            if (newIds.length > 0) {
                await query(`UPDATE vendor_inquiries SET status = 'READ', updated_at = NOW()
           WHERE id = ANY($1::uuid[])`, [newIds]);
            }
            return {
                inquiries: rows,
                total: Number(countRows[0]?.total ?? 0),
                page,
                limit,
                total_pages: Math.ceil(Number(countRows[0]?.total ?? 0) / limit),
            };
        }
        catch (err) {
            app.log.error(err, 'vendor.inquiries.list.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // ── POST /vendor/inquiries/:id/reply ─────────────────────────────────────
    app.post('/vendor/inquiries/:id/reply', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
        if (!userId)
            return reply.code(401).send({ error: 'unauthorized' });
        const { id } = request.params;
        const parsed = replyInquirySchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'validation_error', issues: parsed.error.issues });
        }
        try {
            const vendor = await getVendorForUser(userId);
            if (!vendor)
                return reply.code(404).send({ error: 'vendor_not_found' });
            const inquiryRows = await query(`SELECT id, vendor_id FROM vendor_inquiries WHERE id = $1 LIMIT 1`, [id]);
            const inquiry = inquiryRows[0];
            if (!inquiry)
                return reply.code(404).send({ error: 'inquiry_not_found' });
            if (inquiry.vendor_id !== vendor.id)
                return reply.code(403).send({ error: 'forbidden' });
            await query(`UPDATE vendor_inquiries
         SET reply = $1, replied_at = NOW(), status = 'REPLIED', updated_at = NOW()
         WHERE id = $2`, [parsed.data.reply, id]);
            // bump counter
            await query(`UPDATE vendor_profiles SET total_inquiries = total_inquiries + 1, updated_at = NOW()
         WHERE id = $1`, [vendor.id]);
            return { ok: true };
        }
        catch (err) {
            app.log.error(err, 'vendor.inquiries.reply.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // ── GET /vendor/negotiations ─────────────────────────────────────────────
    app.get('/vendor/negotiations', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
        if (!userId)
            return reply.code(401).send({ error: 'unauthorized' });
        const q = request.query;
        const page = Math.max(1, parseInt(q.page ?? '1', 10));
        const limit = Math.min(50, parseInt(q.limit ?? '20', 10));
        const status = (q.status ?? '').trim() || null;
        const offset = (page - 1) * limit;
        try {
            const vendor = await getVendorForUser(userId);
            if (!vendor)
                return reply.code(404).send({ error: 'vendor_not_found' });
            const conditions = [`nt.vendor_id = $1`];
            const params = [vendor.id];
            if (status) {
                params.push(status);
                conditions.push(`nt.status = $${params.length}`);
            }
            const where = conditions.join(' AND ');
            const [rows, countRows] = await Promise.all([
                query(`
          SELECT nt.*, al.title AS listing_title, al.slug AS listing_slug,
            (SELECT url FROM advert_media am WHERE am.listing_id = nt.listing_id AND am.media_type = 'IMAGE'
             ORDER BY am.sort_order LIMIT 1) AS listing_hero_url,
            (SELECT COUNT(*)::int FROM negotiation_messages nm
             WHERE nm.thread_id = nt.id AND nm.is_read = FALSE AND nm.party = 'BUYER') AS unread_count
          FROM negotiation_threads nt
          JOIN advert_listings al ON al.id = nt.listing_id
          WHERE ${where}
          ORDER BY nt.last_message_at DESC NULLS LAST, nt.created_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]),
                query(`SELECT COUNT(*)::int AS total FROM negotiation_threads nt WHERE ${where}`, params),
            ]);
            return {
                threads: rows,
                total: Number(countRows[0]?.total ?? 0),
                page,
                limit,
                total_pages: Math.ceil(Number(countRows[0]?.total ?? 0) / limit),
            };
        }
        catch (err) {
            app.log.error(err, 'vendor.negotiations.list.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // ── GET /vendor/negotiations/:id ─────────────────────────────────────────
    app.get('/vendor/negotiations/:id', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
        if (!userId)
            return reply.code(401).send({ error: 'unauthorized' });
        const { id } = request.params;
        try {
            const vendor = await getVendorForUser(userId);
            if (!vendor)
                return reply.code(404).send({ error: 'vendor_not_found' });
            const threadRows = await query(`SELECT nt.*, al.title AS listing_title, al.slug AS listing_slug, al.price AS listing_price
         FROM negotiation_threads nt
         JOIN advert_listings al ON al.id = nt.listing_id
         WHERE nt.id = $1 AND nt.vendor_id = $2 LIMIT 1`, [id, vendor.id]);
            const thread = threadRows[0];
            if (!thread)
                return reply.code(404).send({ error: 'thread_not_found' });
            const messages = await query(`SELECT * FROM negotiation_messages WHERE thread_id = $1 ORDER BY created_at ASC`, [id]);
            // Mark buyer messages as read
            await query(`UPDATE negotiation_messages SET is_read = TRUE
         WHERE thread_id = $1 AND party = 'BUYER' AND is_read = FALSE`, [id]);
            return { thread, messages };
        }
        catch (err) {
            app.log.error(err, 'vendor.negotiations.detail.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // ── POST /vendor/negotiations/:id/respond ────────────────────────────────
    app.post('/vendor/negotiations/:id/respond', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
        if (!userId)
            return reply.code(401).send({ error: 'unauthorized' });
        const { id } = request.params;
        const parsed = negotiationResponseSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'validation_error', issues: parsed.error.issues });
        }
        const { action, offer_amount, message } = parsed.data;
        try {
            const vendor = await getVendorForUser(userId);
            if (!vendor)
                return reply.code(404).send({ error: 'vendor_not_found' });
            const threadRows = await query(`SELECT * FROM negotiation_threads WHERE id = $1 AND vendor_id = $2 LIMIT 1`, [id, vendor.id]);
            const thread = threadRows[0];
            if (!thread)
                return reply.code(404).send({ error: 'thread_not_found' });
            if (thread.status !== 'ACTIVE') {
                return reply.code(409).send({ error: 'negotiation_closed' });
            }
            await withTransaction(async (client) => {
                const messageType = action === 'COUNTER' ? 'COUNTER_OFFER'
                    : action === 'ACCEPT' ? 'ACCEPT' : 'REJECT';
                const content = message ?? (action === 'ACCEPT' ? 'I accept your offer.' :
                    action === 'REJECT' ? 'Sorry, I cannot proceed with this offer.' :
                        `Counter offer: ${thread.currency} ${offer_amount?.toLocaleString()}`);
                await client.query(`INSERT INTO negotiation_messages (id, thread_id, party, message_type, content, offer_amount, currency)
           VALUES ($1, $2, 'VENDOR', $3, $4, $5, $6)`, [uuid(), id, messageType, content, offer_amount ?? null, thread.currency]);
                const newStatus = action === 'ACCEPT' ? 'ACCEPTED'
                    : action === 'REJECT' ? 'REJECTED' : 'ACTIVE';
                await client.query(`UPDATE negotiation_threads
           SET status = $1, final_price = COALESCE($2, final_price),
               message_count = message_count + 1,
               last_message_at = NOW(), updated_at = NOW()
           WHERE id = $3`, [newStatus, offer_amount ?? null, id]);
                if (action === 'ACCEPT') {
                    await client.query(`UPDATE vendor_profiles SET total_negotiations = total_negotiations + 1, updated_at = NOW()
             WHERE id = $1`, [vendor.id]);
                }
            });
            return { ok: true };
        }
        catch (err) {
            app.log.error(err, 'vendor.negotiations.respond.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // ── GET /vendor/analytics ────────────────────────────────────────────────
    app.get('/vendor/analytics', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
        if (!userId)
            return reply.code(401).send({ error: 'unauthorized' });
        const q = request.query;
        const days = Math.min(90, Math.max(7, parseInt(q.days ?? '30', 10)));
        try {
            const vendor = await getVendorForUser(userId);
            if (!vendor)
                return reply.code(404).send({ error: 'vendor_not_found' });
            const [eventTrend, topEvents, topListings, inquiryTrend] = await Promise.all([
                query(`
          SELECT
            DATE_TRUNC('day', created_at AT TIME ZONE 'UTC')::date AS day,
            event_type,
            COUNT(*) AS count
          FROM vendor_analytics_events
          WHERE vendor_id = $1 AND created_at > NOW() - ($2 || ' days')::INTERVAL
          GROUP BY 1, 2 ORDER BY 1 ASC`, [vendor.id, days]),
                query(`
          SELECT event_type, COUNT(*) AS total
          FROM vendor_analytics_events
          WHERE vendor_id = $1 AND created_at > NOW() - ($2 || ' days')::INTERVAL
          GROUP BY event_type ORDER BY total DESC`, [vendor.id, days]),
                query(`
          SELECT al.id, al.slug, al.title, al.views_total, al.qr_scan_count,
            (SELECT url FROM advert_media am WHERE am.listing_id = al.id AND am.media_type = 'IMAGE'
             ORDER BY am.sort_order LIMIT 1) AS hero_url
          FROM advert_listings al
          WHERE al.vendor_id = $1 AND al.status = 'ACTIVE'
          ORDER BY al.views_total DESC LIMIT 10`, [vendor.id]),
                query(`
          SELECT
            DATE_TRUNC('day', created_at AT TIME ZONE 'UTC')::date AS day,
            COUNT(*) AS inquiries
          FROM vendor_inquiries
          WHERE vendor_id = $1 AND created_at > NOW() - ($2 || ' days')::INTERVAL
          GROUP BY 1 ORDER BY 1 ASC`, [vendor.id, days]),
            ]);
            return {
                period_days: days,
                event_trend: eventTrend,
                event_summary: topEvents,
                top_listings: topListings,
                inquiry_trend: inquiryTrend,
                vendor_stats: {
                    total_views: vendor.total_views,
                    total_inquiries: vendor.total_inquiries,
                    total_negotiations: vendor.total_negotiations,
                    qr_scan_count: vendor.qr_scan_count,
                },
            };
        }
        catch (err) {
            app.log.error(err, 'vendor.analytics.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // ── GET /vendor/boosts ───────────────────────────────────────────────────
    app.get('/vendor/boosts', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
        if (!userId)
            return reply.code(401).send({ error: 'unauthorized' });
        try {
            const vendor = await getVendorForUser(userId);
            if (!vendor)
                return reply.code(404).send({ error: 'vendor_not_found' });
            const [boosts, plans] = await Promise.all([
                query(`
          SELECT vb.*, vbp.name AS plan_name, al.title AS listing_title
          FROM vendor_boosts vb
          LEFT JOIN vendor_boost_plans vbp ON vbp.id = vb.plan_id
          LEFT JOIN advert_listings al ON al.id = vb.listing_id
          WHERE vb.vendor_id = $1
          ORDER BY vb.created_at DESC LIMIT 20`, [vendor.id]),
                query(`SELECT * FROM vendor_boost_plans WHERE is_active = TRUE ORDER BY sort_order ASC`),
            ]);
            return { boosts, plans };
        }
        catch (err) {
            app.log.error(err, 'vendor.boosts.list.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // ── POST /vendor/boosts ──────────────────────────────────────────────────
    app.post('/vendor/boosts', {
        preHandler: [app.authenticate],
    }, async (request, reply) => {
        const userId = String(request.user?.sub ?? '').trim();
        if (!userId)
            return reply.code(401).send({ error: 'unauthorized' });
        const parsed = createBoostSchema.safeParse(request.body);
        if (!parsed.success) {
            return reply.code(400).send({ error: 'validation_error', issues: parsed.error.issues });
        }
        const { plan_id, listing_id } = parsed.data;
        try {
            const vendor = await getVendorForUser(userId);
            if (!vendor)
                return reply.code(404).send({ error: 'vendor_not_found' });
            const planRows = await query(`SELECT * FROM vendor_boost_plans WHERE id = $1 AND is_active = TRUE LIMIT 1`, [plan_id]);
            const plan = planRows[0];
            if (!plan)
                return reply.code(404).send({ error: 'plan_not_found' });
            const boostId = uuid();
            const endsAt = new Date(Date.now() + plan.duration_hours * 3600000).toISOString();
            const rows = await query(`INSERT INTO vendor_boosts (id, vendor_id, listing_id, plan_id, boost_type, ends_at, cost_ugx)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`, [boostId, vendor.id, listing_id ?? null, plan_id, plan.boost_type, endsAt, plan.price_ugx]);
            return reply.code(201).send({ ok: true, boost: rows[0] });
        }
        catch (err) {
            app.log.error(err, 'vendor.boosts.create.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
    // ── POST /vendor/analytics/event ─────────────────────────────────────────
    // Internal event tracking endpoint (called by frontend)
    app.post('/vendor/analytics/event', async (request, reply) => {
        const body = request.body;
        const { vendor_id, listing_id, event_type, source, referrer } = body ?? {};
        if (!vendor_id || !event_type) {
            return reply.code(400).send({ error: 'missing_fields' });
        }
        const validTypes = [
            'STOREFRONT_VIEW', 'LISTING_VIEW', 'INQUIRY_SENT', 'NEGOTIATION_STARTED',
            'QR_SCAN', 'LINK_CLICK', 'WHATSAPP_CLICK', 'PHONE_CLICK',
            'BOOST_IMPRESSION', 'BOOST_CLICK', 'SHARE',
        ];
        if (!validTypes.includes(event_type)) {
            return reply.code(400).send({ error: 'invalid_event_type' });
        }
        try {
            await query(`INSERT INTO vendor_analytics_events
           (id, vendor_id, listing_id, event_type, source, ip_address, user_agent, referrer)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
                uuid(), vendor_id, listing_id ?? null, event_type, source ?? null,
                request.ip, request.headers['user-agent'] ?? null, referrer ?? null,
            ]);
            // Increment the appropriate counter on vendor_profiles / advert_listings
            if (event_type === 'STOREFRONT_VIEW') {
                await query(`UPDATE vendor_profiles SET total_views = total_views + 1 WHERE id = $1`, [vendor_id]);
            }
            else if (event_type === 'QR_SCAN') {
                await query(`UPDATE vendor_profiles SET qr_scan_count = qr_scan_count + 1 WHERE id = $1`, [vendor_id]);
                if (listing_id) {
                    await query(`UPDATE advert_listings SET qr_scan_count = qr_scan_count + 1 WHERE id = $1`, [listing_id]);
                }
            }
            else if (event_type === 'LISTING_VIEW' && listing_id) {
                await query(`UPDATE advert_listings SET views_total = COALESCE(views_total, 0) + 1 WHERE id = $1`, [listing_id]);
            }
            return { ok: true };
        }
        catch (err) {
            app.log.error(err, 'vendor.analytics.event.error');
            return reply.code(500).send({ error: 'internal_server_error' });
        }
    });
}
