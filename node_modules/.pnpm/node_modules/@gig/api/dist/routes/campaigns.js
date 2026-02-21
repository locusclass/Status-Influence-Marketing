import { CreateCampaignSchema, FundCampaignSchema } from '@bakule/shared';
import { withTransaction } from '../db.js';
import { CampaignRepo } from '../repositories/campaignRepo.js';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import { submitOrder } from '../services/pesapal.js';
import { v4 as uuid } from 'uuid';
export async function campaignRoutes(app) {
    const campaignRepo = new CampaignRepo();
    const paymentRepo = new PaymentRepo();
    app.get('/campaigns', { preHandler: [app.authenticate] }, async () => {
        const campaigns = await withTransaction(async (client) => {
            const res = await client.query('SELECT * FROM campaigns ORDER BY created_at DESC');
            return res.rows;
        });
        return { campaigns };
    });
    app.get('/campaigns/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const campaign = await withTransaction(async (client) => campaignRepo.getCampaign(client, params.id));
        if (!campaign) {
            reply.code(404);
            return { error: 'campaign_not_found' };
        }
        return { campaign };
    });
    app.post('/campaigns', { preHandler: [app.authenticate] }, async (request) => {
        const body = CreateCampaignSchema.parse(request.body);
        const campaign = await withTransaction(async (client) => {
            const created = await campaignRepo.createCampaign(client, body);
            await paymentRepo.createEscrow(client, created.id, created.budget_total);
            return created;
        });
        return { campaign };
    });
    app.post('/campaigns/:id/fund', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const body = FundCampaignSchema.parse({ campaign_id: params.id, ...request.body });
        const { order, pesapalTxn } = await withTransaction(async (client) => {
            const authUser = request.user?.sub;
            const userEmailRes = authUser ? await client.query('SELECT email FROM users WHERE id=$1', [authUser]) : null;
            const userEmail = userEmailRes?.rows?.[0]?.email;
            if (!userEmail) {
                reply.code(400);
                return { error: 'user_email_missing' };
            }
            const firstName = userEmail.split('@')[0] ?? 'User';
            const campaign = await campaignRepo.getCampaign(client, params.id);
            if (!campaign) {
                reply.code(404);
                return { error: 'campaign_not_found' };
            }
            const escrow = await paymentRepo.getEscrowByCampaign(client, params.id);
            if (!escrow) {
                reply.code(404);
                return { error: 'escrow_not_found' };
            }
            if (body.amount !== escrow.amount_total) {
                reply.code(400);
                return { error: 'amount_mismatch' };
            }
            const merchantReference = uuid();
            const pesapalTxn = await paymentRepo.createPesaPalTransaction(client, {
                escrow_id: escrow.id,
                type: 'FUNDING',
                amount: body.amount,
                merchant_reference: merchantReference
            });
            const order = await submitOrder({
                amount: body.amount,
                description: `Campaign funding: ${campaign.title}`,
                type: 'MERCHANT',
                reference: merchantReference,
                firstName,
                lastName: 'User',
                email: userEmail,
                currency: 'KES',
                callback_url: body.return_url,
                cancellation_url: body.cancel_url
            });
            return { order, pesapalTxn };
        });
        if (order?.error)
            return order;
        return { redirect_url: order.redirect_url, pesapal_txn: pesapalTxn };
    });
}
