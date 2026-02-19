export class PaymentRepo {
    async createEscrow(client, campaignId, amountTotal) {
        const res = await client.query(`INSERT INTO escrow_ledger (campaign_id, amount_total, amount_available)
       VALUES ($1,$2,$2) RETURNING *`, [campaignId, amountTotal]);
        return res.rows[0];
    }
    async getEscrowByCampaign(client, campaignId) {
        const res = await client.query('SELECT * FROM escrow_ledger WHERE campaign_id=$1', [campaignId]);
        return res.rows[0];
    }
    async markEscrowFunded(client, escrowId, pesapalTxnId) {
        const res = await client.query('UPDATE escrow_ledger SET status=$2, pesapal_txn_id=$3 WHERE id=$1 RETURNING *', [escrowId, 'FUNDED', pesapalTxnId]);
        return res.rows[0];
    }
    async createPesaPalTransaction(client, input) {
        const res = await client.query(`INSERT INTO pesapal_transactions
      (escrow_id, type, amount, status, merchant_reference, raw_payload, transaction_reference)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [
            input.escrow_id ?? null,
            input.type,
            input.amount,
            input.status ?? 'PENDING',
            input.merchant_reference,
            input.raw_payload ?? null,
            input.transaction_reference ?? null
        ]);
        return res.rows[0];
    }
    async updatePesaPalTxnStatus(client, merchantReference, status, transactionReference) {
        const res = await client.query('UPDATE pesapal_transactions SET status=$2, transaction_reference=COALESCE($3, transaction_reference) WHERE merchant_reference=$1 RETURNING *', [merchantReference, status, transactionReference ?? null]);
        return res.rows[0];
    }
    async insertWebhookEvent(client, eventId, payload) {
        const res = await client.query('INSERT INTO pesapal_webhook_events (event_id, payload) VALUES ($1,$2) ON CONFLICT (event_id) DO NOTHING RETURNING *', [eventId, payload]);
        return res.rows[0];
    }
    async createPayoutRequest(client, input) {
        const res = await client.query(`INSERT INTO payout_requests (proof_id, user_id, amount, status, pesapal_reference)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (proof_id) DO NOTHING
       RETURNING *`, [input.proof_id, input.user_id, input.amount, input.status ?? 'REQUESTED', input.pesapal_reference ?? null]);
        return res.rows[0];
    }
    async updatePayoutStatus(client, payoutId, status, reference) {
        const res = await client.query('UPDATE payout_requests SET status=$2, pesapal_reference=COALESCE($3, pesapal_reference) WHERE id=$1 RETURNING *', [payoutId, status, reference ?? null]);
        return res.rows[0];
    }
    async debitEscrow(client, escrowId, amount) {
        const res = await client.query(`UPDATE escrow_ledger
       SET amount_available = amount_available - $2,
           status = CASE WHEN amount_available - $2 <= 0 THEN 'COMPLETED' ELSE 'PARTIALLY_DISBURSED' END
       WHERE id=$1 AND amount_available >= $2
       RETURNING *`, [escrowId, amount]);
        return res.rows[0];
    }
}
