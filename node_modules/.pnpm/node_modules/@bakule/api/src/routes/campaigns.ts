import { FastifyInstance } from 'fastify';
import { CreateCampaignSchema, FundCampaignSchema } from '@bakule/shared';
import { z } from 'zod';
import { withTransaction } from '../db.js';
import { CampaignRepo } from '../repositories/campaignRepo.js';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import { submitOrder } from '../services/pesapal.js';
import { v4 as uuid } from 'uuid';
import { config } from '../config.js';

export async function campaignRoutes(app: FastifyInstance) {
  const campaignRepo = new CampaignRepo();
  const paymentRepo = new PaymentRepo();
  const AcceptContractSchema = z.object({
    campaign_id: z.string().uuid(),
  });

  app.get('/campaigns', { preHandler: [app.authenticate] }, async (request) => {
    const authUser = (request.user as any)?.sub as string | undefined;
    const role = (request.user as any)?.role as string | undefined;
    const query = (request.query ?? {}) as {
      limit?: string | number;
      offset?: string | number;
      platform?: string;
      status?: string;
      available_only?: string;
    };
    const limitRaw = Number(query.limit ?? 50);
    const offsetRaw = Number(query.offset ?? 0);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
    const campaigns = await withTransaction(async (client) => {
      const conditions: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (query.platform) {
        conditions.push(`platform = $${idx}`);
        params.push(query.platform);
        idx++;
      }
      if (query.status) {
        conditions.push(`status = $${idx}`);
        params.push(query.status);
        idx++;
      }
      if (role !== 'ADMIN') {
        conditions.push(`(advertiser_id = $${idx} OR status = 'ACTIVE')`);
        params.push(authUser ?? '');
        idx++;
      }
      if (role === 'DISTRIBUTOR') {
        const availableOnly = (query.available_only ?? 'true').toString().toLowerCase();
        if (availableOnly !== 'false') {
          conditions.push(
            `NOT EXISTS (
               SELECT 1
               FROM contracts ctr
               WHERE ctr.campaign_id = campaigns.id
                 AND ctr.status = 'ACTIVE'
             )`
          );
        }
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const res = await client.query(
        `SELECT * FROM campaigns ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      );
      return res.rows;
    });
    return { campaigns };
  });

  app.get('/campaigns/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = request.params as { id: string };
    const authUser = (request.user as any)?.sub as string | undefined;
    const campaign = await withTransaction(async (client) => {
      const found = await campaignRepo.getCampaign(client, params.id);
      if (!found) return null;
      const activeContract = await client.query(
        `SELECT *
         FROM contracts
         WHERE campaign_id=$1
           AND status='ACTIVE'
         ORDER BY accepted_at DESC`,
        [params.id]
      );
      const activeContractRow = activeContract.rows[0] ?? null;
      return {
        ...found,
        active_contract: activeContractRow,
        my_active_contract:
          authUser
            ? activeContract.rows.find((row: any) => row.distributor_id === authUser) ?? null
            : null,
      };
    });
    if (!campaign) {
      reply.code(404);
      return { error: 'campaign_not_found' };
    }
    return { campaign };
  });

  app.get('/campaigns/:id/proofs', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = request.params as { id: string };
    const authUser = (request.user as any)?.sub as string | undefined;
    if (!authUser) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const proofs = await withTransaction(async (client) => {
      const campaign = await campaignRepo.getCampaign(client, params.id);
      if (!campaign) return { error: 'campaign_not_found' } as any;
      if (campaign.advertiser_id !== authUser) return { error: 'not_campaign_advertiser' } as any;

      const res = await client.query(
        `SELECT p.id,
                p.status,
                p.decision,
                p.observed_views,
                p.observed_post_hash,
                p.challenge_seen,
                p.confidence,
                p.created_at,
                u.id AS distributor_id,
                u.email AS distributor_email
         FROM proofs p
         JOIN verification_sessions s ON s.id = p.session_id
         JOIN users u ON u.id = p.user_id
         WHERE s.campaign_id=$1
         ORDER BY p.created_at DESC`,
        [params.id]
      );
      return { proofs: res.rows };
    });

    if ((proofs as any).error) {
      reply.code(403);
      return proofs;
    }

    return proofs;
  });

  app.get('/campaigns/:id/proofs/summary', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = request.params as { id: string };
    const authUser = (request.user as any)?.sub as string | undefined;
    if (!authUser) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const summary = await withTransaction(async (client) => {
      const campaign = await campaignRepo.getCampaign(client, params.id);
      if (!campaign) return { error: 'campaign_not_found' } as any;
      if (campaign.advertiser_id !== authUser) return { error: 'not_campaign_advertiser' } as any;

      const totalRes = await client.query(
        `SELECT COUNT(*)::int AS total FROM proofs p
         JOIN verification_sessions s ON s.id = p.session_id
         WHERE s.campaign_id=$1`,
        [params.id]
      );
      const latestRes = await client.query(
        `SELECT p.status, p.decision, p.created_at
         FROM proofs p
         JOIN verification_sessions s ON s.id = p.session_id
         WHERE s.campaign_id=$1
         ORDER BY p.created_at DESC
         LIMIT 1`,
        [params.id]
      );
      return {
        total: totalRes.rows[0]?.total ?? 0,
        latest: latestRes.rows[0] ?? null,
      };
    });

    if ((summary as any).error) {
      reply.code(403);
      return summary;
    }

    return summary;
  });

  app.post('/campaigns', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = CreateCampaignSchema.parse(request.body);
    const authUser = (request.user as any)?.sub as string | undefined;
    const role = (request.user as any)?.role as string | undefined;
    if (!authUser) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    if (role !== 'ADVERTISER' && role !== 'ADMIN') {
      reply.code(403);
      return { error: 'forbidden' };
    }
    const campaign = await withTransaction(async (client) => {
      const created = await campaignRepo.createCampaign(client, {
        ...body,
        advertiser_id: authUser
      });
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
      const role = (request.user as any)?.role as string | undefined;
      const userEmailRes = authUser
        ? await client.query('SELECT email, preferred_currency AS currency FROM users WHERE id=$1', [authUser])
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
      if (campaign.advertiser_id !== authUser && role !== 'ADMIN') {
        reply.code(403);
        return { error: 'not_campaign_advertiser' } as any;
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

  app.post('/campaigns/:id/accept', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = AcceptContractSchema.parse({ campaign_id: params.id });
    const authUser = (request.user as any)?.sub as string | undefined;
    const role = (request.user as any)?.role as string | undefined;
    if (!authUser) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    if (role !== 'DISTRIBUTOR' && role !== 'ADMIN') {
      reply.code(403);
      return { error: 'forbidden' };
    }

    const result = await withTransaction(async (client) => {
      const campaign = await campaignRepo.getCampaign(client, body.campaign_id);
      if (!campaign) return { error: 'campaign_not_found' } as any;
      if (campaign.status !== 'ACTIVE') return { error: 'campaign_not_active' } as any;

      const escrowRes = await client.query(
        'SELECT * FROM escrow_ledger WHERE campaign_id=$1 LIMIT 1',
        [body.campaign_id]
      );
      const escrow = escrowRes.rows[0];
      if (!escrow || (escrow.status !== 'FUNDED' && escrow.status !== 'PARTIALLY_DISBURSED')) {
        return { error: 'campaign_not_funded' } as any;
      }

      const userRes = await client.query(
        'SELECT can_multi_contract FROM users WHERE id=$1',
        [authUser]
      );
      const user = userRes.rows[0];
      if (!user) return { error: 'user_not_found' } as any;

      if (!user.can_multi_contract) {
        const activeCountRes = await client.query(
          `SELECT COUNT(*)::int AS count
           FROM contracts
           WHERE distributor_id=$1
             AND status='ACTIVE'`,
          [authUser]
        );
        const activeCount = activeCountRes.rows[0]?.count ?? 0;
        if (activeCount > 0) {
          return { error: 'distributor_active_contract_exists' } as any;
        }
      }

      const activeCampaignContractRes = await client.query(
        `SELECT id
         FROM contracts
         WHERE campaign_id=$1
           AND status='ACTIVE'
         LIMIT 1`,
        [body.campaign_id]
      );
      if (activeCampaignContractRes.rows[0]) {
        return { error: 'campaign_already_claimed' } as any;
      }

      const contractRes = await client.query(
        `INSERT INTO contracts (
          campaign_id,
          distributor_id,
          status,
          accepted_at,
          post_deadline_at,
          contract_deadline_at
        )
        SELECT
          $1,
          $2,
          'ACTIVE',
          now(),
          now() + interval '2 minutes',
          now() + (($3::int * 60 + 2)::text || ' minutes')::interval
        WHERE NOT EXISTS (
          SELECT 1 FROM contracts WHERE campaign_id=$1 AND status='ACTIVE'
        )
        RETURNING *`,
        [body.campaign_id, authUser, Number(campaign.terms_keep_hours ?? 12)]
      );
      if (!contractRes.rows[0]) {
        return { error: 'campaign_already_claimed' } as any;
      }
      return {
        contract: contractRes.rows[0],
        campaign,
      };
    });

    if ((result as any).error) {
      const error = (result as any).error as string;
      const code = error === 'campaign_not_found' ? 404 : error === 'forbidden' ? 403 : 409;
      reply.code(code);
      return { error };
    }
    return result;
  });

  app.post('/contracts/:id/cancel', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = request.params as { id: string };
    const authUser = (request.user as any)?.sub as string | undefined;
    if (!authUser) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    const result = await withTransaction(async (client) => {
      const contractRes = await client.query('SELECT * FROM contracts WHERE id=$1', [params.id]);
      const contract = contractRes.rows[0];
      if (!contract) return null;
      if (contract.distributor_id !== authUser) return { error: 'forbidden' } as any;
      if (contract.status !== 'ACTIVE') return { error: 'contract_not_active' } as any;
      const updated = await client.query(
        `UPDATE contracts
         SET status='CANCELLED', cancelled_at=now()
         WHERE id=$1
         RETURNING *`,
        [params.id]
      );
      return updated.rows[0];
    });
    if (!result) {
      reply.code(404);
      return { error: 'contract_not_found' };
    }
    if ((result as any).error) {
      reply.code((result as any).error === 'forbidden' ? 403 : 400);
      return result;
    }
    return { contract: result };
  });

  app.post('/contracts/:id/complete', { preHandler: [app.authenticate] }, async (request, reply) => {
    const params = request.params as { id: string };
    const authUser = (request.user as any)?.sub as string | undefined;
    if (!authUser) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    const result = await withTransaction(async (client) => {
      const contractRes = await client.query(
        `SELECT ctr.*, c.platform
         FROM contracts ctr
         JOIN campaigns c ON c.id = ctr.campaign_id
         WHERE ctr.id=$1`,
        [params.id]
      );
      const contract = contractRes.rows[0];
      if (!contract) return null;
      if (contract.distributor_id !== authUser) return { error: 'forbidden' } as any;
      if (contract.status !== 'ACTIVE') return { error: 'contract_not_active' } as any;
      const updated = await client.query(
        `UPDATE contracts
         SET status='COMPLETED', completed_at=now()
         WHERE id=$1
         RETURNING *`,
        [params.id]
      );
      return { contract: updated.rows[0], campaign_platform: contract.platform, campaign_id: contract.campaign_id };
    });
    if (!result) {
      reply.code(404);
      return { error: 'contract_not_found' };
    }
    if ((result as any).error) {
      reply.code((result as any).error === 'forbidden' ? 403 : 400);
      return result;
    }
    return result;
  });
}

