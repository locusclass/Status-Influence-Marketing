import { FastifyInstance } from 'fastify';
import { withTransaction } from '../db.js';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import { getTransactionStatus, verifyWebhookSignature } from '../services/pesapal.js';
import { config } from '../config.js';

async function ensureWalletWithdrawalsTable(client: any) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS wallet_withdrawals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'UGX',
      receiver_phone TEXT NOT NULL,
      status payout_status NOT NULL DEFAULT 'PROCESSING',
      pesapal_reference TEXT UNIQUE,
      failure_reason TEXT,
      paid_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function refundWalletWithdrawal(client: any, withdrawal: any, reason: string) {
  if (!withdrawal || withdrawal.status === 'FAILED') {
    return;
  }
  await client.query(
    `
    UPDATE wallets
    SET balance_available = balance_available + $2,
        balance = balance + $2
    WHERE id=$1
    `,
    [withdrawal.wallet_id, withdrawal.amount]
  );
  await client.query(
    `
    INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
    VALUES ($1,$2,'CREDIT',$3)
    `,
    [
      withdrawal.wallet_id,
      withdrawal.amount,
      `${withdrawal.pesapal_reference ?? withdrawal.id}:REFUND`,
    ]
  );
  await client.query(
    `
    UPDATE wallet_withdrawals
    SET status='FAILED',
        failure_reason=$2,
        failed_at=NOW()
    WHERE id=$1
    `,
    [withdrawal.id, reason]
  );
}

export async function paymentRoutes(app: FastifyInstance) {
  const paymentRepo = new PaymentRepo();
  const deepLinkReturn = 'bakule://payment/return';
  const deepLinkCancel = 'bakule://payment/cancel';

  const resolveBrowserTarget = (request: any, fallbackPath: string) => {
    const queryTarget = (request.query as Record<string, unknown> | undefined)?.target;
    if (typeof queryTarget === 'string' && queryTarget.trim()) {
      try {
        const target = new URL(queryTarget.trim());
        if (
          target.protocol === 'http:' ||
          target.protocol === 'https:' ||
          target.protocol === 'bakule:'
        ) {
          return target.toString();
        }
      } catch {
        // Ignore invalid targets and fall back below.
      }
    }

    const referer = request.headers.referer ?? request.headers.referrer;
    if (typeof referer === 'string' && referer.trim()) {
      try {
        return new URL(fallbackPath, referer).toString();
      } catch {
        // Ignore invalid referers and use the deep link fallback.
      }
    }

    return null;
  };

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

    if (config.pesapal.ipnWebhookSecret) {
      if (!signature || !verifyWebhookSignature(rawBody, signature, config.pesapal.ipnWebhookSecret)) {
        reply.code(401).send({ error: 'invalid_signature' });
        return;
      }
    } else {
      app.log.warn('PESAPAL_IPN_WEBHOOK_SECRET is not set; IPN signature verification is disabled');
    }

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

          const rawPayload = txn.raw_payload as Record<string, unknown> | null;
          if (rawPayload?.kind === 'WALLET_DEPOSIT') {
            const statusRaw = statusInfo.payment_status_description ?? statusInfo.status;
            const status = typeof statusRaw === 'string' ? statusRaw.toUpperCase() : '';
            if (txn.status === 'COMPLETED') {
              return { ok: true, duplicate: true };
            }

            if (status.includes('COMPLETED') || status.includes('SUCCESS')) {
              const walletId = String(rawPayload.wallet_id ?? '');
              const amount = Number(txn.amount ?? 0);
              await client.query(
                `
                UPDATE wallets
                SET balance_available = balance_available + $2,
                    balance = balance + $2
                WHERE id=$1
                `,
                [walletId, amount]
              );
              await client.query(
                `
                INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
                VALUES ($1,$2,'CREDIT',$3)
                `,
                [walletId, amount, `WALLET_DEPOSIT:${merchantReference}`]
              );
              await paymentRepo.updatePesaPalTxnStatus(
                client,
                merchantReference,
                'COMPLETED',
                String(eventId)
              );
            } else if (status.includes('FAILED')) {
              await paymentRepo.updatePesaPalTxnStatus(
                client,
                merchantReference,
                'FAILED',
                String(eventId)
              );
            }
            return { ok: true, type: 'wallet_deposit' };
          }

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

  app.get('/payments/return', async (request, reply) => {
    reply.redirect(resolveBrowserTarget(request, '/payment/success') ?? deepLinkReturn);
  });

  app.get('/payments/cancel', async (request, reply) => {
    reply.redirect(resolveBrowserTarget(request, '/payment/cancel') ?? deepLinkCancel);
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
      if (payout) {
        if (status.includes('PAID') || status.includes('COMPLETED') || status.includes('SUCCESS')) {
          await paymentRepo.updatePayoutStatus(client, payout.id, 'PAID', reference);
        } else if (status.includes('FAILED')) {
          await paymentRepo.updatePayoutStatus(client, payout.id, 'FAILED', reference);
        }
        return { ok: true, type: 'proof_payout' };
      }

      await ensureWalletWithdrawalsTable(client);
      const withdrawalRows = await client.query(
        'SELECT * FROM wallet_withdrawals WHERE pesapal_reference=$1',
        [reference]
      );
      const withdrawal = withdrawalRows.rows[0];
      if (!withdrawal) return { ok: false, error: 'payout_not_found' };

      if (status.includes('PAID') || status.includes('COMPLETED') || status.includes('SUCCESS')) {
        await client.query(
          `
          UPDATE wallet_withdrawals
          SET status='PAID',
              paid_at=NOW(),
              failure_reason=NULL
          WHERE id=$1
          `,
          [withdrawal.id]
        );
      } else if (status.includes('FAILED')) {
        await refundWalletWithdrawal(client, withdrawal, 'provider_failed');
      }
      return { ok: true, type: 'wallet_withdrawal' };
    });

    if (!result.ok) {
      reply.code(400);
      return result;
    }
    return { status: 'accepted' };
  });
}
