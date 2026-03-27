import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { withTransaction } from '../db.js';
import { canAccessAdvertiserFeatures } from '../services/roles.js';
const campaignDraftBodySchema = z.object({
    draft: z.record(z.string(), z.unknown()),
});
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
function normalizeDraftPayload(rawDraft, savedAt) {
    const selectedPlatforms = Array.isArray(rawDraft['selected_platforms'])
        ? Array.from(new Set(rawDraft['selected_platforms']
            .map((value) => String(value ?? '').trim().toUpperCase())
            .filter((value) => value.length > 0)))
        : [];
    const normalizedPlatformDrafts = rawDraft['platform_drafts'] &&
        typeof rawDraft['platform_drafts'] === 'object' &&
        !Array.isArray(rawDraft['platform_drafts'])
        ? Object.fromEntries(Object.entries(rawDraft['platform_drafts']).map(([key, value]) => [
            key.toString().trim().toUpperCase(),
            value,
        ]))
        : {};
    const activePlatform = String(rawDraft['active_platform'] ?? '')
        .trim()
        .toUpperCase();
    const normalizedStep = typeof rawDraft['step'] === 'number'
        ? Math.max(0, Math.trunc(rawDraft['step']))
        : Number.isFinite(Number(rawDraft['step']))
            ? Math.max(0, Math.trunc(Number(rawDraft['step'])))
            : 0;
    return {
        ...rawDraft,
        version: typeof rawDraft['version'] === 'number' && Number.isFinite(rawDraft['version'])
            ? Math.max(1, Math.trunc(rawDraft['version']))
            : 1,
        title: String(rawDraft['title'] ?? '').trim(),
        step: normalizedStep,
        active_platform: activePlatform || (selectedPlatforms.length > 0 ? selectedPlatforms[0] : 'WHATSAPP_STATUS'),
        selected_platforms: selectedPlatforms.length > 0 ? selectedPlatforms : ['WHATSAPP_STATUS'],
        platform_drafts: normalizedPlatformDrafts,
        saved_at: savedAt,
        server_updated_at: savedAt,
    };
}
function toDraftResponse(payload, updatedAt) {
    const savedAt = updatedAt instanceof Date
        ? updatedAt.toISOString()
        : new Date(updatedAt ? String(updatedAt) : Date.now()).toISOString();
    const rawPayload = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? payload
        : {};
    return normalizeDraftPayload(rawPayload, savedAt);
}
export async function campaignDraftRoutes(app) {
    await withTransaction(async (client) => {
        await ensureCampaignDraftsTable(client);
    });
    app.get('/campaign-drafts/active', { preHandler: [app.authenticate] }, async (request, reply) => {
        const advertiserId = request.user?.sub;
        const role = request.user?.role;
        if (!advertiserId) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        if (!canAccessAdvertiserFeatures(role)) {
            reply.code(403);
            return { error: 'forbidden' };
        }
        return withTransaction(async (client) => {
            await ensureCampaignDraftsTable(client);
            const draftRes = await client.query(`
        SELECT payload, updated_at
        FROM campaign_creation_drafts
        WHERE advertiser_id = $1
        LIMIT 1
        `, [advertiserId]);
            const row = draftRes.rows[0];
            return {
                draft: row ? toDraftResponse(row.payload, row.updated_at) : null,
            };
        });
    });
    app.put('/campaign-drafts/active', { preHandler: [app.authenticate] }, async (request, reply) => {
        const advertiserId = request.user?.sub;
        const role = request.user?.role;
        if (!advertiserId) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        if (!canAccessAdvertiserFeatures(role)) {
            reply.code(403);
            return { error: 'forbidden' };
        }
        const parsed = campaignDraftBodySchema.safeParse(request.body ?? {});
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        return withTransaction(async (client) => {
            await ensureCampaignDraftsTable(client);
            const savedAt = new Date().toISOString();
            const payload = normalizeDraftPayload(parsed.data.draft, savedAt);
            const result = await client.query(`
        INSERT INTO campaign_creation_drafts (
          id,
          advertiser_id,
          payload,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3::jsonb, NOW(), NOW())
        ON CONFLICT (advertiser_id)
        DO UPDATE SET
          payload = EXCLUDED.payload,
          updated_at = NOW()
        RETURNING payload, updated_at
        `, [uuid(), advertiserId, JSON.stringify(payload)]);
            const row = result.rows[0];
            return {
                draft: row ? toDraftResponse(row.payload, row.updated_at) : payload,
            };
        });
    });
    app.delete('/campaign-drafts/active', { preHandler: [app.authenticate] }, async (request, reply) => {
        const advertiserId = request.user?.sub;
        const role = request.user?.role;
        if (!advertiserId) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        if (!canAccessAdvertiserFeatures(role)) {
            reply.code(403);
            return { error: 'forbidden' };
        }
        return withTransaction(async (client) => {
            await ensureCampaignDraftsTable(client);
            await client.query(`
        DELETE FROM campaign_creation_drafts
        WHERE advertiser_id = $1
        `, [advertiserId]);
            return { deleted: true };
        });
    });
}
