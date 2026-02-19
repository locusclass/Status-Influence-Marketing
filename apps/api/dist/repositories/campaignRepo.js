export class CampaignRepo {
    async createCampaign(client, input) {
        const res = await client.query(`INSERT INTO campaigns
      (advertiser_id, title, platform, payout_amount, budget_total, start_date, end_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING *`, [
            input.advertiser_id,
            input.title,
            input.platform,
            input.payout_amount,
            input.budget_total,
            input.start_date,
            input.end_date
        ]);
        return res.rows[0];
    }
    async getCampaign(client, campaignId) {
        const res = await client.query('SELECT * FROM campaigns WHERE id=$1', [campaignId]);
        return res.rows[0];
    }
}
