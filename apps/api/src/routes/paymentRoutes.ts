import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import { withTransaction } from '../db.js';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import {
  submitOrder,
  getTransactionStatus,
} from '../services/pesapal.js';

type PesaPalOrderResponse = {
  order_tracking_id: string;
  redirect_url: string;
};

type PesaPalStatusResponse = {
  amount?: number | string;
  payment_status_description?: string;
  status?: string;
};

export async function paymentRoutes(app: FastifyInstance) {
  const paymentRepo = new PaymentRepo();

  // ============================================
  // CREATE ESCROW ORDER
  // ============================================
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
        })) as PesaPalOrderResponse;

        await withTransaction(async (client) => {
          await paymentRepo.createPesaPalTransaction(client, {
            escrow_id: escrowId,
            type: 'FUNDING',
            amount,
            merchant_reference: merchantReference,
            status: 'PENDING',
            transaction_reference: order.order_tracking_id,
          });
        });

        return reply.send({
          redirect_url: order.redirect_url,
          order_tracking_id: order.order_tracking_id,
          merchant_reference: merchantReference,
        });
      } catch (error) {
        app.log.error({ error }, 'create escrow order failed');
        return reply.code(500).send({ error: 'Payment creation failed' });
      }
    }
  );

  // ============================================
  // IPN ROUTES
  // ============================================
  app.get('/payments/pesapal/ipn', async () => ({
    ok: true,
    method: 'POST',
  }));

  app.post('/payments/pesapal/ipn', async (request: any, reply) => {
    const body = request.body;

    reply.code(200).send({ status: 'received' });

    const orderTrackingId =
      body?.OrderTrackingId ?? body?.orderTrackingId ?? body?.id;

    const merchantReference =
      body?.OrderMerchantReference ??
      body?.merchantReference ??
      body?.reference;

    if (!orderTrackingId || !merchantReference) return;

    setImmediate(async () => {
      try {
        const statusInfo = (await getTransactionStatus(
          String(orderTrackingId),
          String(merchantReference)
        )) as PesaPalStatusResponse;

        await withTransaction(async (client) => {
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

          const amountRaw = statusInfo.amount;
          const amount =
            typeof amountRaw === 'string'
              ? parseInt(amountRaw, 10)
              : Number(amountRaw ?? 0);

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
              String(orderTrackingId)
            );

            await paymentRepo.markEscrowFunded(
              client,
              escrow.id,
              txn.id
            );
          } else if (status.includes('FAILED')) {
            await paymentRepo.updatePesaPalTxnStatus(
              client,
              merchantReference,
              'FAILED',
              String(orderTrackingId)
            );
          }
        });
      } catch (error) {
        app.log.error({ error }, 'pesapal ipn processing failed');
      }
    });
  });
}
