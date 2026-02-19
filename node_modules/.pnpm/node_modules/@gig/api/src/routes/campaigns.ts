import { FastifyInstance } from 'fastify';
import { CreateCampaignSchema, FundCampaignSchema } from '@gig/shared';
import { withTransaction } from '../db.js';
import { CampaignRepo } from '../repositories/campaignRepo.js';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import { submitOrder } from '../services/pesapal.js';
import { v4 as uuid } from 'uuid';

export async function campaignRoutes(app: FastifyInstance) {
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
    const params = request.params as { id: string };
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
    const params = request.params as { id: string };
    const body = FundCampaignSchema.parse({ campaign_id: params.id, ...(request.body as any) });

    const { order, pesapalTxn } = await withTransaction(async (client) => {
      const authUser = (request.user as any)?.sub as string | undefined;
      const userEmailRes = authUser ? await client.query('SELECT email FROM users WHERE id=$1', [authUser]) : null;
      const userEmail = userEmailRes?.rows?.[0]?.email as string | undefined;
      if (!userEmail) {
        reply.code(400);
        return { error: 'user_email_missing' } as any;
      }
      const firstName = userEmail.split('@')[0];
      const campaign = await campaignRepo.getCampaign(client, params.id);
      if (!campaign) {
        reply.code(404);
        return { error: 'campaign_not_found' } as any;
      }
      const escrow = await paymentRepo.getEscrowByCampaign(client, params.id);
      if (!escrow) {
        reply.code(404);
        return { error: 'escrow_not_found' } as any;
      }
      if (body.amount !== escrow.amount_total) {
        reply.code(400);
        return { error: 'amount_mismatch' } as any;
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

    if ((order as any)?.error) return order;
    return { redirect_url: order.redirect_url, pesapal_txn: pesapalTxn };
  });
}
