import { CreateCampaignSchema, FundCampaignSchema } from '@bakule/shared';
import { withTransaction } from '../db.js';
import { CampaignRepo } from '../repositories/campaignRepo.js';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import { submitOrder } from '../services/pesapal.js';
import { v4 as uuid } from 'uuid';
import { config } from '../config.js';
export async function campaignRoutes(app) {
    const campaignRepo = new CampaignRepo();
    const paymentRepo = new PaymentRepo();
    app.get('/campaigns', { preHandler: [app.authenticate] }, async (request) => {
        const authUser = request.user?.sub;
        const role = request.user?.role;
        const query = (request.query ?? {});
        const limitRaw = Number(query.limit ?? 50);
        const offsetRaw = Number(query.offset ?? 0);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
        const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
        const campaigns = await withTransaction(async (client) => {
            const conditions = [];
            const params = [];
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
            const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
            const res = await client.query(`SELECT * FROM campaigns ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`, [...params, limit, offset]);
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
    app.get('/campaigns/:id/proofs', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const authUser = request.user?.sub;
        if (!authUser) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        const proofs = await withTransaction(async (client) => {
            const campaign = await campaignRepo.getCampaign(client, params.id);
            if (!campaign)
                return { error: 'campaign_not_found' };
            if (campaign.advertiser_id !== authUser)
                return { error: 'not_campaign_advertiser' };
            const res = await client.query(`SELECT p.id,
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
         ORDER BY p.created_at DESC`, [params.id]);
            return { proofs: res.rows };
        });
        if (proofs.error) {
            reply.code(403);
            return proofs;
        }
        return proofs;
    });
    app.get('/campaigns/:id/proofs/summary', { preHandler: [app.authenticate] }, async (request, reply) => {
        const params = request.params;
        const authUser = request.user?.sub;
        if (!authUser) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        const summary = await withTransaction(async (client) => {
            const campaign = await campaignRepo.getCampaign(client, params.id);
            if (!campaign)
                return { error: 'campaign_not_found' };
            if (campaign.advertiser_id !== authUser)
                return { error: 'not_campaign_advertiser' };
            const totalRes = await client.query(`SELECT COUNT(*)::int AS total FROM proofs p
         JOIN verification_sessions s ON s.id = p.session_id
         WHERE s.campaign_id=$1`, [params.id]);
            const latestRes = await client.query(`SELECT p.status, p.decision, p.created_at
         FROM proofs p
         JOIN verification_sessions s ON s.id = p.session_id
         WHERE s.campaign_id=$1
         ORDER BY p.created_at DESC
         LIMIT 1`, [params.id]);
            return {
                total: totalRes.rows[0]?.total ?? 0,
                latest: latestRes.rows[0] ?? null,
            };
        });
        if (summary.error) {
            reply.code(403);
            return summary;
        }
        return summary;
    });
    app.post('/campaigns', { preHandler: [app.authenticate] }, async (request, reply) => {
        const body = CreateCampaignSchema.parse(request.body);
        const authUser = request.user?.sub;
        const role = request.user?.role;
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
        const params = request.params;
        const body = FundCampaignSchema.parse({ campaign_id: params.id, ...request.body });
        const { order, pesapalTxn } = await withTransaction(async (client) => {
            if (!config.pesapal.ipnId) {
                reply.code(503);
                return { error: 'pesapal_ipn_not_configured' };
            }
            const authUser = request.user?.sub;
            const role = request.user?.role;
            const userEmailRes = authUser
                ? await client.query('SELECT email, preferred_currency AS currency FROM users WHERE id=$1', [authUser])
                : null;
            const userEmail = userEmailRes?.rows?.[0]?.email;
            const rawCurrency = userEmailRes?.rows?.[0]?.currency ?? 'UGX';
            const userCurrency = rawCurrency.toUpperCase().length == 3 ? rawCurrency.toUpperCase() : 'UGX';
            if (!userEmail) {
                reply.code(400);
                return { error: 'user_email_missing' };
            }
            if (!body.return_url || !body.cancel_url) {
                reply.code(400);
                return { error: 'payment_redirect_urls_missing' };
            }
            const isValidUrl = (url) => /^https?:\/\//i.test(url);
            if (!isValidUrl(body.return_url) || !isValidUrl(body.cancel_url)) {
                reply.code(400);
                return { error: 'payment_redirect_urls_invalid' };
            }
            const firstName = userEmail.split('@')[0] ?? 'User';
            const campaign = await campaignRepo.getCampaign(client, params.id);
            if (!campaign) {
                reply.code(404);
                return { error: 'campaign_not_found' };
            }
            if (campaign.advertiser_id !== authUser && role !== 'ADMIN') {
                reply.code(403);
                return { error: 'not_campaign_advertiser' };
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
                currency: userCurrency,
                callback_url: body.return_url,
                cancellation_url: body.cancel_url
            });
            return { order, pesapalTxn };
        });
        const orderAny = order;
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
