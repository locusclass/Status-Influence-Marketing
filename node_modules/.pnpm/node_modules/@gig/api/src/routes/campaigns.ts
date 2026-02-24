import { FastifyInstance } from 'fastify';
import { CreateCampaignSchema, FundCampaignSchema } from '@bakule/shared';
import { z } from 'zod';
import { withTransaction } from '../db.js';
import { CampaignRepo } from '../repositories/campaignRepo.js';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import { submitOrder } from '../services/pesapal.js';
import { v4 as uuid } from 'uuid';
import { config } from '../config.js';

const BillCampaignSchema = z.object({
  return_url: z.string().url(),
  cancel_url: z.string().url()
});

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
      if (!config.pesapal.ipnId) {
        reply.code(503);
        return { error: 'pesapal_ipn_not_configured' } as any;
      }

      const authUser = (request.user as any)?.sub as string | undefined;
      const userEmailRes = authUser
        ? await client.query('SELECT email, currency FROM users WHERE id=$1', [authUser])
        : null;
      const userEmail = userEmailRes?.rows?.[0]?.email as string | undefined;
      const rawCurrency = (userEmailRes?.rows?.[0]?.currency as string | undefined) ?? 'UGX';
      const userCurrency = rawCurrency.toUpperCase().length == 3 ? rawCurrency.toUpperCase() : 'UGX';
      if (!userEmail) {
        reply.code(400);
        return { error: 'user_email_missing' } as any;
      }
      if (!body.return_url || !body.cancel_url) {
        reply.code(400);
        return { error: 'payment_redirect_urls_missing' } as any;
      }
      const isValidUrl = (url: string) => /^https?:\/\//i.test(url);
      if (!isValidUrl(body.return_url) || !isValidUrl(body.cancel_url)) {
        reply.code(400);
        return { error: 'payment_redirect_urls_invalid' } as any;
      }
      const firstName = userEmail.split('@')[0] ?? 'User';
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
        currency: userCurrency,
        callback_url: body.return_url,
        cancellation_url: body.cancel_url
      });

      return { order, pesapalTxn };
    });

    const orderAny = order as any;
    const pesapalError = orderAny?.error ?? orderAny?.errro;
    const status = orderAny?.status;
    if (pesapalError || (status && status !== '200' && status !== 200)) {
      app.log.error({ order }, 'pesapal_submit_order_failed');
      reply.code(502);
      return { error: 'pesapal_submit_failed', pesapal_response: order };
    }
    const redirectUrl = orderAny?.redirect_url;
    if (!redirectUrl) {
      app.log.error({ order }, 'pesapal_submit_order_missing_redirect_url');
      reply.code(502);
      return { error: 'pesapal_missing_redirect_url', pesapal_response: order };
    }
    return { redirect_url: redirectUrl, pesapal_txn: pesapalTxn };
  });

  app.post('/campaigns/:id/bill', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = BillCampaignSchema.parse(request.body);

    const authUser = (request.user as any)?.sub as string | undefined;
    if (!authUser) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const { order, pesapalTxn } = await withTransaction(async (client) => {
      if (!config.pesapal.ipnId) {
        reply.code(503);
        return { error: 'pesapal_ipn_not_configured' } as any;
      }

      const userEmailRes = await client.query('SELECT email, currency FROM users WHERE id=$1', [authUser]);
      const userEmail = userEmailRes?.rows?.[0]?.email as string | undefined;
      const rawCurrency = (userEmailRes?.rows?.[0]?.currency as string | undefined) ?? 'UGX';
      const userCurrency = rawCurrency.toUpperCase().length == 3 ? rawCurrency.toUpperCase() : 'UGX';

      if (!userEmail) {
        reply.code(400);
        return { error: 'user_email_missing' } as any;
      }

      const isValidUrl = (url: string) => /^https?:\/\//i.test(url);
      if (!isValidUrl(body.return_url) || !isValidUrl(body.cancel_url)) {
        reply.code(400);
        return { error: 'payment_redirect_urls_invalid' } as any;
      }

      const campaign = await campaignRepo.getCampaign(client, params.id);
      if (!campaign) {
        reply.code(404);
        return { error: 'campaign_not_found' } as any;
      }

      if (campaign.advertiser_id !== authUser) {
        reply.code(403);
        return { error: 'not_campaign_advertiser' } as any;
      }

      const escrow = await paymentRepo.getEscrowByCampaign(client, params.id);
      if (!escrow) {
        reply.code(404);
        return { error: 'escrow_not_found' } as any;
      }
      if (escrow.status !== 'PENDING') {
        reply.code(409);
        return { error: 'escrow_already_funded' } as any;
      }

      const proofRes = await client.query(
        `SELECT p.*
         FROM proofs p
         JOIN verification_sessions s ON s.id = p.session_id
         WHERE s.campaign_id=$1 AND p.user_id=$2 AND p.status='VERIFIED'
         ORDER BY p.created_at DESC
         LIMIT 1`,
        [params.id, authUser]
      );
      const proof = proofRes.rows[0];
      if (!proof) {
        reply.code(400);
        return { error: 'verification_required' } as any;
      }

      const merchantReference = uuid();
      const pesapalTxn = await paymentRepo.createPesaPalTransaction(client, {
        escrow_id: escrow.id,
        type: 'FUNDING',
        amount: escrow.amount_total,
        merchant_reference: merchantReference
      });

      const firstName = userEmail.split('@')[0] ?? 'User';
      const order = await submitOrder({
        amount: escrow.amount_total,
        description: `Campaign billing: ${campaign.title}`,
        type: 'MERCHANT',
        reference: merchantReference,
        firstName,
        lastName: 'User',
        email: userEmail,
        currency: userCurrency,
        callback_url: body.return_url,
        cancellation_url: body.cancel_url
      });

      return { order, pesapalTxn };
    });

    const orderAny = order as any;
    const pesapalError = orderAny?.error ?? orderAny?.errro;
    const status = orderAny?.status;
    if (pesapalError || (status && status !== '200' && status !== 200)) {
      app.log.error({ order }, 'pesapal_submit_order_failed');
      reply.code(502);
      return { error: 'pesapal_submit_failed', pesapal_response: order };
    }
    const redirectUrl = orderAny?.redirect_url;
    if (!redirectUrl) {
      app.log.error({ order }, 'pesapal_submit_order_missing_redirect_url');
      reply.code(502);
      return { error: 'pesapal_missing_redirect_url', pesapal_response: order };
    }
    return { redirect_url: redirectUrl, pesapal_txn: pesapalTxn };
  });
}

