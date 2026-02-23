import { FastifyInstance } from 'fastify';
import { withTransaction } from '../db.js';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import { getTransactionStatus, verifyWebhookSignature } from '../services/pesapal.js';
import { config } from '../config.js';

export async function paymentRoutes(app: FastifyInstance) {
  const paymentRepo = new PaymentRepo();
  const deepLinkReturn = 'bakule://payment/return';
  const deepLinkCancel = 'bakule://payment/cancel';

  const ipnInfo = async () => {
    return {
      ok: true,
      method: 'POST',
      note: 'This endpoint expects a signed PesaPal IPN webhook.',
    };
  };

  const handleIpn = async (request: any, reply: any) => {
    const body = request.body as any;
    const rawBody = (request as any).rawBody?.toString() ?? '';
    const signature = request.headers['x-pesapal-signature'] as string | undefined;

    app.log.info({ body, hasSignature: Boolean(signature), rawBodyLength: rawBody.length }, 'pesapal ipn received');

    // Respond immediately as required by PesaPal.
    reply.code(200).send({ status: 'received' });

    const eventId = body?.OrderTrackingId ?? body?.orderTrackingId ?? body?.id ?? body?.event_id;
    const merchantReference = body?.OrderMerchantReference ?? body?.merchantReference ?? body?.reference;
    if (!eventId || !merchantReference) {
      app.log.warn({ eventId, merchantReference }, 'pesapal ipn missing identifiers');
      return;
    }

    // Process asynchronously to avoid delaying the IPN response.
    setImmediate(async () => {
      try {
        const statusInfo = (await getTransactionStatus(String(eventId), String(merchantReference))) as Record<string, unknown>;

        const result = await withTransaction(async (client) => {
          const inserted = await paymentRepo.insertWebhookEvent(client, String(eventId), body);
          if (!inserted) {
            return { ok: true, duplicate: true };
          }

          const txnRows = await client.query('SELECT * FROM pesapal_transactions WHERE merchant_reference=$1', [merchantReference]);
          const txn = txnRows.rows[0];
          if (!txn) return { ok: false, error: 'txn_not_found' };

          const amountRaw = statusInfo.amount ?? statusInfo.Amount;
          const amount = typeof amountRaw === 'string' ? parseInt(amountRaw, 10) : Number(amountRaw ?? 0);
          const escrowRows = await client.query('SELECT * FROM escrow_ledger WHERE id=$1', [txn.escrow_id]);
          const escrow = escrowRows.rows[0];
          if (!escrow || amount !== escrow.amount_total) {
            return { ok: false, error: 'amount_mismatch' };
          }

          const statusRaw = statusInfo.payment_status_description ?? statusInfo.status;
          const status = typeof statusRaw === 'string' ? statusRaw.toUpperCase() : '';
          if (status.includes('COMPLETED') || status.includes('SUCCESS')) {
            await paymentRepo.updatePesaPalTxnStatus(client, merchantReference, 'COMPLETED', String(eventId));
            await paymentRepo.markEscrowFunded(client, escrow.id, txn.id);
          } else if (status.includes('FAILED')) {
            await paymentRepo.updatePesaPalTxnStatus(client, merchantReference, 'FAILED', String(eventId));
          }
          return { ok: true };
        });

        if (!result.ok) {
          app.log.warn({ result, eventId, merchantReference }, 'pesapal ipn processing issue');
        }
      } catch (error) {
        app.log.error({ error, eventId, merchantReference }, 'pesapal ipn processing failed');
      }
    });
  };

  app.get('/payments/pesapal/ipn', ipnInfo);
  app.post('/payments/pesapal/ipn', handleIpn);

  app.get('/payments/return', async (_request, reply) => {
    reply.redirect(deepLinkReturn);
  });

  app.get('/payments/cancel', async (_request, reply) => {
    reply.redirect(deepLinkCancel);
  });

  app.post('/payments/pesapal/payout-webhook', async (request, reply) => {
    const signature = request.headers['x-pesapal-signature'] as string | undefined;
    const rawBody = (request as any).rawBody?.toString() ?? '';
    if (!signature || !verifyWebhookSignature(rawBody, signature, config.pesapal.payoutWebhookSecret)) {
      reply.code(401);
      return { error: 'invalid_signature' };
    }

    const body = request.body as any;
    const eventId = body.id ?? body.event_id ?? body.tracking_id;
    const reference = body.reference ?? body.merchant_reference;
    const status = (body.status ?? '').toUpperCase();

    if (!eventId || !reference) {
      reply.code(400);
      return { error: 'missing_fields' };
    }

    const result = await withTransaction(async (client) => {
      const inserted = await paymentRepo.insertWebhookEvent(client, String(eventId), body);
      if (!inserted) return { ok: true, duplicate: true };

      const payoutRows = await client.query('SELECT * FROM payout_requests WHERE pesapal_reference=$1', [reference]);
      const payout = payoutRows.rows[0];
      if (!payout) return { ok: false, error: 'payout_not_found' };

      if (status.includes('PAID') || status.includes('COMPLETED') || status.includes('SUCCESS')) {
        await paymentRepo.updatePayoutStatus(client, payout.id, 'PAID', reference);
      } else if (status.includes('FAILED')) {
        await paymentRepo.updatePayoutStatus(client, payout.id, 'FAILED', reference);
      }
      return { ok: true };
    });

    if (!result.ok) {
      reply.code(400);
      return result;
    }
    return { status: 'accepted' };
  });
}
