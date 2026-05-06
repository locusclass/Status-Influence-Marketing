import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { withTransaction } from '../db.js';
import { canAccessBusinessFeatures } from '../services/roles.js';

const campaignDraftBodySchema = z.object({
  draft: z.record(z.string(), z.unknown()),
});

async function ensureCampaignDraftsTable(client: any) {
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

function normalizeDraftPayload(rawDraft: Record<string, unknown>, savedAt: string) {
  const selectedPlatforms = Array.isArray(rawDraft['selected_platforms'])
    ? Array.from(
        new Set(
          (rawDraft['selected_platforms'] as unknown[])
            .map((value) => String(value ?? '').trim().toUpperCase())
            .filter((value) => value === 'WHATSAPP_STATUS')
            .filter((value) => value.length > 0)
        )
      )
    : [];

  const normalizedPlatformDrafts =
    rawDraft['platform_drafts'] &&
    typeof rawDraft['platform_drafts'] === 'object' &&
    !Array.isArray(rawDraft['platform_drafts'])
      ? Object.fromEntries(
          Object.entries(rawDraft['platform_drafts'] as Record<string, unknown>)
            .filter(([key]) => key.toString().trim().toUpperCase() === 'WHATSAPP_STATUS')
            .map(([key, value]) => [key.toString().trim().toUpperCase(), value])
        )
      : {};

  const activePlatform = String(rawDraft['active_platform'] ?? '')
    .trim()
    .toUpperCase();
  const normalizedStep =
    typeof rawDraft['step'] === 'number'
      ? Math.max(0, Math.trunc(rawDraft['step']))
      : Number.isFinite(Number(rawDraft['step']))
          ? Math.max(0, Math.trunc(Number(rawDraft['step'])))
          : 0;

  return {
    ...rawDraft,
    version:
      typeof rawDraft['version'] === 'number' && Number.isFinite(rawDraft['version'])
        ? Math.max(1, Math.trunc(rawDraft['version']))
        : 1,
    title: String(rawDraft['title'] ?? '').trim(),
    step: normalizedStep,
    active_platform:
      activePlatform || (selectedPlatforms.length > 0 ? selectedPlatforms[0] : 'WHATSAPP_STATUS'),
    selected_platforms:
      selectedPlatforms.length > 0 ? selectedPlatforms : ['WHATSAPP_STATUS'],
    platform_drafts: normalizedPlatformDrafts,
    saved_at: savedAt,
    server_updated_at: savedAt,
  };
}

function toDraftResponse(payload: unknown, updatedAt: unknown) {
  const savedAt =
    updatedAt instanceof Date
      ? updatedAt.toISOString()
      : new Date(updatedAt ? String(updatedAt) : Date.now()).toISOString();
  const rawPayload =
    payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  return normalizeDraftPayload(rawPayload, savedAt);
}

export async function campaignDraftRoutes(app: FastifyInstance) {
  app.addHook('onListen', async () => {
    if (process.env.SKIP_OPTIONAL_STARTUP_WARMUPS === '1') {
      return;
    }
    try {
      await withTransaction(async (client) => {
        await ensureCampaignDraftsTable(client);
      });
    } catch (error) {
      app.log.error({ err: error }, 'startup warmup failed for campaign draft schema');
    }
  });

  app.get('/campaign-drafts/active', { preHandler: [app.authenticate] }, async (request, reply) => {
    const businessId = (request.user as any)?.sub as string | undefined;
    const role = (request.user as any)?.role;
    if (!businessId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    if (!canAccessBusinessFeatures(role)) {
      reply.code(403);
      return { error: 'forbidden' };
    }

    return withTransaction(async (client) => {
      await ensureCampaignDraftsTable(client);
      const draftRes = await client.query(
        `
        SELECT payload, updated_at
        FROM campaign_creation_drafts
        WHERE business_id = $1
        LIMIT 1
        `,
        [businessId]
      );

      const row = draftRes.rows[0];
      return {
        draft: row ? toDraftResponse(row.payload, row.updated_at) : null,
      };
    });
  });

  app.put('/campaign-drafts/active', { preHandler: [app.authenticate] }, async (request, reply) => {
    const businessId = (request.user as any)?.sub as string | undefined;
    const role = (request.user as any)?.role;
    if (!businessId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    if (!canAccessBusinessFeatures(role)) {
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
      const result = await client.query(
        `
        INSERT INTO campaign_creation_drafts (
          id,
          business_id,
          payload,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3::jsonb, NOW(), NOW())
        ON CONFLICT (business_id)
        DO UPDATE SET
          payload = EXCLUDED.payload,
          updated_at = NOW()
        RETURNING payload, updated_at
        `,
        [uuid(), businessId, JSON.stringify(payload)]
      );

      const row = result.rows[0];
      return {
        draft: row ? toDraftResponse(row.payload, row.updated_at) : payload,
      };
    });
  });

  app.delete('/campaign-drafts/active', { preHandler: [app.authenticate] }, async (request, reply) => {
    const businessId = (request.user as any)?.sub as string | undefined;
    const role = (request.user as any)?.role;
    if (!businessId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    if (!canAccessBusinessFeatures(role)) {
      reply.code(403);
      return { error: 'forbidden' };
    }

    return withTransaction(async (client) => {
      await ensureCampaignDraftsTable(client);
      await client.query(
        `
        DELETE FROM campaign_creation_drafts
        WHERE business_id = $1
        `,
        [businessId]
      );
      return { deleted: true };
    });
  });
}
