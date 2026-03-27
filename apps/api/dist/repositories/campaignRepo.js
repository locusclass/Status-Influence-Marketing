import { ensurePublicIdColumns } from '../services/publicId.js';
export class CampaignRepo {
    async createCampaign(client, input) {
        await ensurePublicIdColumns(client);
        const executionMetaJson = input.execution_meta == null ? null : JSON.stringify(input.execution_meta);
        const res = await client.query(`INSERT INTO campaigns
      (advertiser_id, parent_campaign_id, assigned_distributor_id, assigned_phone, title, platform, delivery_model, execution_mode, visibility, payout_amount, budget_total, impression_target, platform_fee_percent, advertiser_wallet_mode, last_allocated_at, allocation_round, media_type, media_text, media_url, execution_meta, campaign_burst_mode, terms_keep_hours, terms_min_views, terms_requirement, status, start_date, end_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::jsonb,$21,$22,$23,$24,$25,$26,$27)
      RETURNING *`, [
            input.advertiser_id,
            input.parent_campaign_id ?? null,
            input.assigned_distributor_id ?? null,
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
            input.advertiser_wallet_mode ?? 'CAMPAIGN_ONLY',
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
        ]);
        return res.rows[0];
    }
    async getCampaign(client, campaignId) {
        await ensurePublicIdColumns(client);
        const identifier = String(campaignId ?? '').trim();
        const res = await client.query('SELECT * FROM campaigns WHERE id::text=$1 OR public_id=$1 LIMIT 1', [identifier]);
        return res.rows[0];
    }
}
