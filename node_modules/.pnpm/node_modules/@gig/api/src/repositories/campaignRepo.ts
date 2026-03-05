import { PoolClient } from 'pg';

export class CampaignRepo {
  async createCampaign(client: PoolClient, input: {
    advertiser_id: string;
    title: string;
    platform: string;
    payout_amount: number;
    budget_total: number;
    media_type: string;
    media_text?: string;
    media_url?: string;
    terms_keep_hours?: number;
    terms_min_views?: number | null;
    terms_requirement?: 'DURATION' | 'VIEWS' | 'BOTH';
    start_date: string;
    end_date: string;
  }) {
    const res = await client.query(
      `INSERT INTO campaigns
      (advertiser_id, title, platform, payout_amount, budget_total, media_type, media_text, media_url, terms_keep_hours, terms_min_views, terms_requirement, status, start_date, end_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *`,
      [
        input.advertiser_id,
        input.title,
        input.platform,
        input.payout_amount,
        input.budget_total,
        input.media_type,
        input.media_text ?? null,
        input.media_url ?? null,
        input.terms_keep_hours ?? 12,
        input.terms_min_views ?? null,
        input.terms_requirement ?? 'DURATION',
        'ACTIVE',
        input.start_date,
        input.end_date
      ]
    );
    return res.rows[0];
  }

  async getCampaign(client: PoolClient, campaignId: string) {
    const res = await client.query('SELECT * FROM campaigns WHERE id=$1', [campaignId]);
    return res.rows[0];
  }
}
