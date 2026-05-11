import { PoolClient } from 'pg';
import { ensurePublicIdColumns } from '../services/publicId.js';

export class CampaignRepo {
  async createCampaign(
    client: PoolClient,
    input: {
      business_id: string;
      campaign_bundle_id?: string | null;
      bundle_root_campaign_id?: string | null;
      parent_campaign_id?: string | null;
      assigned_ambassador_id?: string | null;
      assigned_phone?: string | null;
      title: string;
      platform: string;
      delivery_model?: 'DETERMINISTIC' | 'PROBABILISTIC';
      execution_mode?: 'PRIVATE_CONTRACT' | 'OPEN_BUDGET';
      visibility?: 'PUBLIC' | 'PRIVATE';
      payout_amount: number;
      budget_total: number;
      impression_target?: number | null;
      platform_fee_percent?: number;
      business_wallet_mode?: 'CAMPAIGN_ONLY';
      last_allocated_at?: string | null;
      allocation_round?: number;
      media_type: string;
      media_text?: string;
      media_url?: string;
      execution_meta?: Record<string, unknown> | null;
      campaign_burst_mode?: boolean;
      terms_keep_hours?: number;
      terms_min_views?: number | null;
      terms_requirement?: 'DURATION' | 'VIEWS' | 'BOTH';
      start_date: string;
      end_date: string;
    }
  ) {
    await ensurePublicIdColumns(client);
    const executionMetaJson =
      input.execution_meta == null ? null : JSON.stringify(input.execution_meta);
    const res = await client.query(
      `INSERT INTO campaigns
      (business_id, campaign_bundle_id, bundle_root_campaign_id, parent_campaign_id, assigned_ambassador_id, assigned_phone, title, platform, delivery_model, execution_mode, visibility, payout_amount, budget_total, impression_target, platform_fee_percent, business_wallet_mode, last_allocated_at, allocation_round, media_type, media_text, media_url, execution_meta, campaign_burst_mode, terms_keep_hours, terms_min_views, terms_requirement, status, start_date, end_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb,$23,$24,$25,$26,$27,$28,$29)
      RETURNING *`,
      [
        input.business_id,
        input.campaign_bundle_id ?? null,
        input.bundle_root_campaign_id ?? null,
        input.parent_campaign_id ?? null,
        input.assigned_ambassador_id ?? null,
        input.assigned_phone ?? null,
        input.title,
        input.platform,
        input.delivery_model ?? 'DETERMINISTIC',
        input.execution_mode ?? 'PRIVATE_CONTRACT',
        input.visibility ?? 'PUBLIC',
        input.payout_amount,
        input.budget_total,
        input.impression_target ?? null,
        input.platform_fee_percent ?? 0,
        input.business_wallet_mode ?? 'CAMPAIGN_ONLY',
        input.last_allocated_at ?? null,
        input.allocation_round ?? 0,
        input.media_type,
        input.media_text ?? null,
        input.media_url ?? null,
        executionMetaJson,
        input.campaign_burst_mode ?? false,
        input.terms_keep_hours ?? 12,
        input.terms_min_views ?? null,
        input.terms_requirement ?? 'DURATION',
        'ACTIVE',
        input.start_date,
        input.end_date,
      ]
    );
    return res.rows[0];
  }

  async getCampaign(client: PoolClient, campaignId: string) {
    await ensurePublicIdColumns(client);
    const identifier = String(campaignId ?? '').trim();
    const res = await client.query(
      'SELECT * FROM campaigns WHERE id::text=$1 OR public_id=$1 LIMIT 1',
      [identifier]
    );
    return res.rows[0];
  }
}
