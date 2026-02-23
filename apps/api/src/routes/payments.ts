import { FastifyInstance } from 'fastify';
import { withTransaction } from '../db.js';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import {
  getTransactionStatus,
  verifyWebhookSignature,
  submitOrder
} from '../services/pesapal.js';
import { config } from '../config.js';
import crypto from 'crypto';

export async function paymentRoutes(app: FastifyInstance) {
  const paymentRepo = new PaymentRepo();

  // ================================
  // CREATE ESCROW ORDER
  // ================================
  app.post(
    '/api/payments/create-escrow-order',
    { preHandler: app.authenticate },
    async (request: any, reply) => {
      try {
        const { amount, escrowId } = request.body;
        const user = request.user;

        if (!amount || amount <= 0) {
          return reply.code(400).send({ error: 'Invalid amount' });
        }

        const merchantReference = crypto.randomUUID();

        const order = (await submitOrder({
          amount,
          description: 'Escrow Contract Funding',
          type: 'MERCHANT',
          reference: merchantReference,
          firstName: user.firstName ?? 'User',
          lastName: user.lastName ?? 'Client',
          email: user.email,
          currency: user.currency ?? 'UGX',
          callback_url:
            'https://status-influence-marketing-production.up.railway.app/payment/success',
          cancellation_url:
            'https://status-influence-marketing-production.up.railway.app/payment/cancel',
        })) as any;

        await withTransaction(async (client) => {
          await paymentRepo.createPesaPalTransaction(
            client,
            escrowId,
            merchantReference,
            amount,
            order.order_tracking_id
          );
        });

        return reply.send({
          redirect_url: order.redirect_url,
          order_tracking_id: order.order_tracking_id,
          merchant_reference: merchantReference,
        });
      } catch (err) {
        app.log.error({ err }, 'create escrow order failed');
        return reply.code(500).send({ error: 'Payment creation failed' });
      }
    }
  );

  // ================================
  // IPN INFO
  // ================================
  const ipnInfo = async () => ({
    ok: true,
    method: 'POST',
    note: 'This endpoint expects a signed PesaPal IPN webhook.',
  });

  app.get('/payments/pesapal/ipn', ipnInfo);
  app.get('/api/payments/pesapal/ipn', ipnInfo);

  // ================================
  // HANDLE IPN
  // ================================
  app.post('/payments/pesapal/ipn', handleIpn);
  app.post('/api/payments/pesapal/ipn', handleIpn);

  async function handleIpn(request: any, reply: any) {
    const body = request.body as any;

    reply.code(200).send({ status: 'received' });

    const eventId =
      body?.OrderTrackingId ?? body?.orderTrackingId ?? body?.id;

    const merchantReference =
      body?.OrderMerchantReference ?? body?.merchantReference ?? body?.reference;

    if (!eventId || !merchantReference) return;

    setImmediate(async () => {
      try {
        const statusInfo = (await getTransactionStatus(
          String(eventId),
          String(merchantReference)
        )) as any;

        await withTransaction(async (client) => {
          const inserted = await paymentRepo.insertWebhookEvent(
            client,
            String(eventId),
            body
          );
          if (!inserted) return;

          const txnRows = await client.query(
            'SELECT * FROM pesapal_transactions WHERE merchant_reference=$1',
            [merchantReference]
          );
          const txn = txnRows.rows[0];
          if (!txn) return;

          const escrowRows = await client.query(
            'SELECT * FROM escrow_ledger WHERE id=$1',
            [txn.escrow_id]
          );
          const escrow = escrowRows.rows[0];
          if (!escrow) return;

          const amount = Number(statusInfo.amount ?? 0);
          if (amount !== escrow.amount_total) return;

          const status = String(
            statusInfo.payment_status_description ??
              statusInfo.status ??
              ''
          ).toUpperCase();

          if (status.includes('COMPLETED') || status.includes('SUCCESS')) {
            await paymentRepo.updatePesaPalTxnStatus(
              client,
              merchantReference,
              'COMPLETED',
              String(eventId)
            );
            await paymentRepo.markEscrowFunded(client, escrow.id, txn.id);
          } else if (status.includes('FAILED')) {
            await paymentRepo.updatePesaPalTxnStatus(
              client,
              merchantReference,
              'FAILED',
              String(eventId)
            );
          }
        });
      } catch (error) {
        app.log.error({ error }, 'pesapal ipn processing failed');
      }
    });
  }

  // ================================
  // PAYOUT WEBHOOK
  // ================================
  app.post('/payments/pesapal/payout-webhook', async (request, reply) => {
    return { status: 'accepted' };
  });
}
