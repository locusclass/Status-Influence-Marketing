import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction } from '../db.js';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import {
  createCharge,
  createCustomer,
  createMobileMoneyPaymentMethod,
  getTransactionStatus,
  verifyTransaction,
  verifyWebhookSignature,
} from '../services/flutterwave.js';
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
      mobile_money_network TEXT,
      status payout_status NOT NULL DEFAULT 'PROCESSING',
      pesapal_reference TEXT UNIQUE,
      failure_reason TEXT,
      paid_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    ALTER TABLE wallet_withdrawals
      ADD COLUMN IF NOT EXISTS mobile_money_network TEXT
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

function readWebhookSignature(request: any) {
  const flutterwaveSignature = request.headers['flutterwave-signature'];
  if (typeof flutterwaveSignature === 'string' && flutterwaveSignature.trim()) {
    return flutterwaveSignature.trim();
  }
  const verifHash = request.headers['verif-hash'];
  if (typeof verifHash === 'string' && verifHash.trim()) {
    return verifHash.trim();
  }
  return undefined;
}

function normalizePaymentEvent(body: any) {
  const type = String(body?.event ?? body?.type ?? '').trim();
  const data = body?.data ?? {};
  const transactionId = data?.id ?? body?.id;
  const reference = data?.tx_ref ?? data?.txRef ?? data?.reference;
  const eventId = body?.id ?? `${type}:${transactionId ?? reference ?? 'unknown'}`;
  return { type, data, transactionId, reference, eventId };
}

function normalizeTransferEvent(body: any) {
  const type = String(body?.event ?? body?.type ?? '').trim();
  const data = body?.data ?? {};
  const reference = data?.reference ?? data?.tx_ref ?? data?.txRef ?? body?.reference;
  const status = String(data?.status ?? body?.status ?? '').trim().toUpperCase();
  const eventId = body?.id ?? `${type}:${data?.id ?? reference ?? 'unknown'}:${status}`;
  return { type, data, reference, status, eventId };
}

export async function paymentRoutes(app: FastifyInstance) {
  const paymentRepo = new PaymentRepo();
  const deepLinkReturn = 'bakule://payment/return';
  const deepLinkCancel = 'bakule://payment/cancel';

  const verifySchema = z.object({
    transaction_id: z.union([z.string().trim().min(1), z.number().int().positive()]),
    tx_ref: z.string().trim().min(1),
  });
  const initiateSchema = z.object({
    tx_ref: z.string().trim().min(1),
    network: z.enum(['MTN', 'AIRTEL']).default('MTN'),
  });

  const statusSuccess = new Set(['SUCCESSFUL', 'SUCCEEDED', 'COMPLETED']);
  const statusFailure = new Set(['FAILED', 'FAILURE', 'CANCELLED', 'CANCELED']);
  const statusPending = new Set([
    'CREATED',
    'PENDING',
    'PROCESSING',
    'INITIATED',
    'QUEUED',
    'REQUIRES_ACTION',
  ]);

  const readId = (payload: any) => {
    const candidates = [
      payload?.id,
      payload?.data?.id,
      payload?.charge_id,
      payload?.data?.charge_id,
    ];

    for (const candidate of candidates) {
      const value = String(candidate ?? '').trim();
      if (value) {
        return value;
      }
    }

    return '';
  };

  const readRedirectUrl = (payload: any) => {
    const candidates = [
      payload?.next_action?.redirect_url,
      payload?.data?.next_action?.redirect_url,
      payload?.redirect_url,
      payload?.data?.redirect_url,
      payload?.authorization_url,
      payload?.data?.authorization_url,
      payload?.payment_link,
      payload?.data?.payment_link,
      payload?.hosted_url,
      payload?.data?.hosted_url,
    ];

    for (const candidate of candidates) {
      const value = String(candidate ?? '').trim();
      if (value) {
        return value;
      }
    }

    return null;
  };

  const readProviderMessage = (payload: any) => {
    const candidates = [
      payload?.next_action?.message,
      payload?.data?.next_action?.message,
      payload?.processor_response,
      payload?.data?.processor_response,
      payload?.message,
      payload?.data?.message,
    ];

    for (const candidate of candidates) {
      const value = String(candidate ?? '').trim();
      if (value) {
        return value;
      }
    }

    return null;
  };

  const compactProviderSnapshot = (payload: any) => {
    const source = (payload?.data ?? payload) as Record<string, any> | undefined;
    if (!source || typeof source !== 'object') {
      return null;
    }

    return {
      id: source.id ?? null,
      status: source.status ?? source.payment_status ?? null,
      reference: source.reference ?? source.tx_ref ?? source.txRef ?? null,
      amount: source.amount ?? null,
      currency: source.currency ?? null,
      processor_response: source.processor_response ?? null,
      next_action_type: source.next_action?.type ?? null,
      next_action_message: source.next_action?.message ?? null,
      redirect_url: readRedirectUrl(source),
    };
  };

  const normalizeTransactionStatus = (payload: Record<string, any>) =>
    String(payload.status ?? payload.payment_status ?? '').trim().toUpperCase();

  const settleCharge = async (
    transactionId: string | number,
    reference: string,
    rawPayload?: any
  ) => {
    const verifiedResponse = (await verifyTransaction(
      String(transactionId)
    )) as Record<string, any>;
    const verified = (verifiedResponse.data ?? verifiedResponse) as Record<string, any>;
    const result = await withTransaction(async (client) =>
      applyVerifiedCharge(
        client,
        {
          transactionId,
          reference,
        },
        verified,
        rawPayload ?? verified.meta
      )
    );

    return { result, verified };
  };

  const applyVerifiedCharge = async (
    client: any,
    paymentEvent: { transactionId: string | number; reference: string },
    verified: Record<string, any>,
    rawPayload: any
  ) => {
    const txnRows = await client.query(
      'SELECT * FROM pesapal_transactions WHERE merchant_reference=$1 FOR UPDATE',
      [paymentEvent.reference]
    );
    const txn = txnRows.rows[0];
    if (!txn) {
      return { ok: false, error: 'txn_not_found' };
    }

    const txnPayload = (txn.raw_payload ?? rawPayload ?? {}) as Record<string, unknown>;
    const statusText = normalizeTransactionStatus(verified);
    const amount = Number(verified.amount ?? 0);
    const currency = String(verified.currency ?? '').trim().toUpperCase();
    const expectedCurrency = String(txnPayload.payment_currency ?? 'UGX')
      .trim()
      .toUpperCase();
    if (amount !== Number(txn.amount ?? 0) || currency !== expectedCurrency) {
      return { ok: false, error: 'amount_mismatch' };
    }

    if (txnPayload?.kind === 'WALLET_DEPOSIT') {
      if (txn.status === 'COMPLETED') {
        return { ok: true, duplicate: true, type: 'wallet_deposit' };
      }
      if (statusSuccess.has(statusText)) {
        const walletId = String(txnPayload.wallet_id ?? '');
        if (!walletId) {
          return { ok: false, error: 'wallet_not_found' };
        }
        await client.query('SELECT id FROM wallets WHERE id=$1 FOR UPDATE', [walletId]);
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
          ON CONFLICT DO NOTHING
          `,
          [walletId, amount, `WALLET_DEPOSIT:${paymentEvent.reference}`]
        );
        await paymentRepo.updatePesaPalTxnStatus(
          client,
          String(paymentEvent.reference),
          'COMPLETED',
          String(paymentEvent.transactionId)
        );
      } else if (statusFailure.has(statusText)) {
        await paymentRepo.updatePesaPalTxnStatus(
          client,
          String(paymentEvent.reference),
          'FAILED',
          String(paymentEvent.transactionId)
        );
      }
      return { ok: true, type: 'wallet_deposit' };
    }

    const escrowRows = await client.query('SELECT * FROM escrow_ledger WHERE id=$1', [txn.escrow_id]);
    const escrow = escrowRows.rows[0];
    if (!escrow || amount !== Number(escrow.amount_total ?? 0)) {
      return { ok: false, error: 'amount_mismatch' };
    }

    if (txn.status === 'COMPLETED') {
      return { ok: true, duplicate: true, type: 'campaign_funding', escrow_id: escrow.id };
    }

    if (statusSuccess.has(statusText)) {
      await paymentRepo.updatePesaPalTxnStatus(
        client,
        String(paymentEvent.reference),
        'COMPLETED',
        String(paymentEvent.transactionId)
      );
      await paymentRepo.markEscrowFunded(client, escrow.id, txn.id);
    } else if (statusFailure.has(statusText)) {
      await paymentRepo.updatePesaPalTxnStatus(
        client,
        String(paymentEvent.reference),
        'FAILED',
        String(paymentEvent.transactionId)
      );
    }
    return { ok: true, type: 'campaign_funding', escrow_id: escrow.id };
  };

  const resolveBrowserTarget = (request: any, fallbackPath: string) => {
    const query = (request.query as Record<string, unknown> | undefined) ?? {};
    const queryTarget = query.target;
    if (typeof queryTarget === 'string' && queryTarget.trim()) {
      try {
        const target = new URL(queryTarget.trim());
        for (const [key, value] of Object.entries(query)) {
          if (key === 'target' || value == null) continue;
          target.searchParams.set(key, String(value));
        }
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
        const target = new URL(fallbackPath, referer);
        for (const [key, value] of Object.entries(query)) {
          if (key === 'target' || value == null) continue;
          target.searchParams.set(key, String(value));
        }
        return target.toString();
      } catch {
        // Ignore invalid referers and use the deep link fallback.
      }
    }

    return null;
  };

  const webhookInfo = async () => ({
    ok: true,
    method: 'POST',
    note: 'This endpoint expects a signed Flutterwave webhook.',
  });

  const handleWebhook = async (request: any, reply: any) => {
    const body = request.body as any;
    const rawBody = (request as any).rawBody?.toString() ?? '';
    const signature = readWebhookSignature(request);

    app.log.info(
      { event: body?.event ?? body?.type, hasSignature: Boolean(signature), rawBodyLength: rawBody.length },
      'flutterwave_webhook_received'
    );

    if (config.flutterwave.webhookSecretHash) {
      if (
        !signature ||
        !verifyWebhookSignature(rawBody, signature, config.flutterwave.webhookSecretHash)
      ) {
        reply.code(401).send({ error: 'invalid_signature' });
        return;
      }
    } else {
      app.log.warn('FLUTTERWAVE_WEBHOOK_SECRET_HASH is not set; webhook verification is disabled');
    }

    reply.code(200).send({ status: 'received' });

    const paymentEvent = normalizePaymentEvent(body);
    const transferEvent = normalizeTransferEvent(body);
    const eventType = paymentEvent.type.toLowerCase();

    setImmediate(async () => {
      try {
        if (eventType.includes('charge')) {
          if (!paymentEvent.transactionId || !paymentEvent.reference) {
            app.log.warn(paymentEvent, 'flutterwave_charge_missing_identifiers');
            return;
          }

          const { result } = await settleCharge(
            paymentEvent.transactionId,
            String(paymentEvent.reference),
            body?.data?.meta
          );

          if (!result.ok) {
            app.log.warn({ result, paymentEvent }, 'flutterwave_charge_processing_issue');
          }
          return;
        }

        if (eventType.includes('transfer')) {
          if (!transferEvent.reference) {
            app.log.warn(transferEvent, 'flutterwave_transfer_missing_reference');
            return;
          }

          const result = await withTransaction(async (client) => {
            const inserted = await paymentRepo.insertWebhookEvent(
              client,
              String(transferEvent.eventId),
              body
            );
            if (!inserted) return { ok: true, duplicate: true };

            const payoutRows = await client.query(
              'SELECT * FROM payout_requests WHERE pesapal_reference=$1',
              [transferEvent.reference]
            );
            const payout = payoutRows.rows[0];
            if (payout) {
              if (transferEvent.status === 'SUCCESSFUL') {
                await paymentRepo.updatePayoutStatus(client, payout.id, 'PAID', transferEvent.reference);
              } else if (transferEvent.status === 'FAILED') {
                await paymentRepo.updatePayoutStatus(client, payout.id, 'FAILED', transferEvent.reference);
              }
              return { ok: true, type: 'proof_payout' };
            }

            await ensureWalletWithdrawalsTable(client);
            const withdrawalRows = await client.query(
              'SELECT * FROM wallet_withdrawals WHERE pesapal_reference=$1',
              [transferEvent.reference]
            );
            const withdrawal = withdrawalRows.rows[0];
            if (!withdrawal) return { ok: false, error: 'payout_not_found' };

            if (transferEvent.status === 'SUCCESSFUL') {
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
            } else if (transferEvent.status === 'FAILED') {
              await refundWalletWithdrawal(client, withdrawal, 'provider_failed');
            }
            return { ok: true, type: 'wallet_withdrawal' };
          });

          if (!result.ok) {
            app.log.warn({ result, transferEvent }, 'flutterwave_transfer_processing_issue');
          }
        }
      } catch (error) {
        app.log.error({ error, body }, 'flutterwave_webhook_processing_failed');
      }
    });
  };

  app.get('/payments/flutterwave/webhook', webhookInfo);
  app.post('/payments/flutterwave/webhook', handleWebhook);

  app.post('/payments/flutterwave/initiate', { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = initiateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    try {
      const authUser = (request.user as any)?.sub as string | undefined;
      if (!authUser) {
        reply.code(401);
        return { error: 'unauthorized' };
      }

      const result = await withTransaction(async (client) => {
        const txnRes = await client.query(
          'SELECT * FROM pesapal_transactions WHERE merchant_reference=$1 LIMIT 1',
          [parsed.data.tx_ref]
        );
        const txn = txnRes.rows[0];
        if (!txn) {
          return { error: 'txn_not_found' } as const;
        }

        const rawPayload = (txn.raw_payload ?? {}) as Record<string, any>;
        const metaNetwork = String(rawPayload.network ?? parsed.data.network).toUpperCase();
        const network = (metaNetwork === 'AIRTEL' ? 'AIRTEL' : 'MTN') as 'MTN' | 'AIRTEL';
        const txKind = String(rawPayload.kind ?? '').toUpperCase();

        let email = '';
        let phoneNumber = '';
        let customerName = '';

        if (txKind === 'WALLET_DEPOSIT') {
          if (String(rawPayload.user_id ?? '') !== authUser) {
            return { error: 'forbidden' } as const;
          }
          const userRes = await client.query(
            'SELECT email, phone, full_name FROM users WHERE id=$1 LIMIT 1',
            [authUser]
          );
          const user = userRes.rows[0];
          email = String(user?.email ?? '').trim();
          phoneNumber = String(user?.phone ?? '').trim();
          customerName = String(user?.full_name ?? '').trim() || email.split('@')[0] || 'User';
        } else {
          const escrowRes = await client.query(
            `SELECT e.id, c.id AS campaign_id, c.advertiser_id, c.title
             FROM escrow_ledger e
             JOIN campaigns c ON c.id = e.campaign_id
             WHERE e.id=$1
             LIMIT 1`,
            [txn.escrow_id]
          );
          const escrow = escrowRes.rows[0];
          if (!escrow || escrow.advertiser_id !== authUser) {
            return { error: 'forbidden' } as const;
          }
          const userRes = await client.query(
            'SELECT email, phone, full_name FROM users WHERE id=$1 LIMIT 1',
            [authUser]
          );
          const user = userRes.rows[0];
          email = String(user?.email ?? '').trim();
          phoneNumber = String(user?.phone ?? '').trim();
          customerName = String(user?.full_name ?? '').trim() || email.split('@')[0] || 'User';
        }

        if (!email) {
          return { error: 'user_email_missing' } as const;
        }
        if (!phoneNumber) {
          return { error: 'missing_payout_phone' } as const;
        }

        const callbackUrl =
          typeof rawPayload.return_url === 'string' && rawPayload.return_url.trim()
            ? rawPayload.return_url.trim()
            : null;

        const customerResponse = await createCustomer({
          email,
          name: customerName,
          phoneNumber,
        });
        const customerId = readId(customerResponse);
        if (!customerId) {
          throw new Error('Flutterwave customer creation did not return an id');
        }

        const methodResponse = await createMobileMoneyPaymentMethod({
          phoneNumber,
          network,
          countryCode: '256',
        });
        const paymentMethodId = readId(methodResponse);
        if (!paymentMethodId) {
          throw new Error('Flutterwave payment method creation did not return an id');
        }

        const chargeResponse = await createCharge({
          amount: Number(txn.amount ?? 0),
          currency: 'UGX',
          customerId,
          paymentMethodId,
          txRef: parsed.data.tx_ref,
          redirectUrl: callbackUrl,
        });
        const charge = (chargeResponse.data ?? chargeResponse) as Record<string, any>;
        const chargeId = readId(chargeResponse);
        if (!chargeId) {
          throw new Error('Flutterwave charge creation did not return an id');
        }

        await paymentRepo.updatePesaPalTxnStatus(
          client,
          parsed.data.tx_ref,
          'PENDING',
          chargeId || undefined
        );
        await client.query(
          `UPDATE pesapal_transactions
           SET raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb
           WHERE merchant_reference=$1`,
          [
            parsed.data.tx_ref,
            JSON.stringify({
              network,
              flutterwave_charge_id: chargeId,
              flutterwave_customer_id: customerId,
              flutterwave_payment_method_id: paymentMethodId,
            }),
          ]
        );

        return {
          ok: true,
          charge_id: chargeId,
          redirect_url: readRedirectUrl(charge),
          provider_status: normalizeTransactionStatus(charge),
          instruction: readProviderMessage(charge),
        };
      });

      if ('error' in result) {
        reply.code(result.error === 'forbidden' ? 403 : 400);
        app.log.warn(
          {
            tx_ref: parsed.data.tx_ref,
            network: parsed.data.network,
            outcome: result,
          },
          'flutterwave_initiate_rejected'
        );
        return result;
      }

      app.log.info(
        {
          tx_ref: parsed.data.tx_ref,
          network: parsed.data.network,
          charge_id: result.charge_id,
          redirect_url: result.redirect_url,
          provider_status: result.provider_status,
          instruction: result.instruction,
        },
        'flutterwave_initiate_result'
      );
      return result;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      app.log.error(
        {
          error,
          detail,
          body: request.body,
        },
        `flutterwave_initiate_failed: ${detail}`
      );
      reply.code(502);
      return { error: 'flutterwave_initiate_failed', detail };
    }
  });

  app.post('/payments/flutterwave/verify', { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = verifySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    try {
      const { result, verified } = await settleCharge(
        parsed.data.transaction_id,
        parsed.data.tx_ref
      );
      const verifiedStatus = normalizeTransactionStatus(verified);
      app.log.info(
        {
          tx_ref: parsed.data.tx_ref,
          transaction_id: parsed.data.transaction_id,
          verified_status: verifiedStatus,
          settlement_ok: result.ok,
          settlement_result: result,
          provider: compactProviderSnapshot(verified),
        },
        'flutterwave_verify_result'
      );
      if (!result.ok) {
        reply.code(400);
        return result;
      }
      return {
        ok: true,
        status: verifiedStatus,
        tx_ref: parsed.data.tx_ref,
        transaction_id: parsed.data.transaction_id,
        result,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      app.log.error(
        {
          error,
          detail,
          body: request.body,
        },
        `flutterwave_verify_failed: ${detail}`
      );
      reply.code(502);
      return { error: 'flutterwave_verify_failed', detail };
    }
  });

  app.get('/payments/return', async (request, reply) => {
    const query = request.query as Record<string, unknown> | undefined;
    const status = String(query?.status ?? '').toLowerCase();
    const cancelled = status === 'cancelled' || status === 'failed';
    const transactionId =
      typeof query?.transaction_id === 'string' && query.transaction_id.trim()
        ? query.transaction_id.trim()
        : typeof query?.transactionId === 'string' && query.transactionId.trim()
          ? query.transactionId.trim()
          : typeof query?.charge_id === 'string' && query.charge_id.trim()
            ? query.charge_id.trim()
          : undefined;
    const txRef =
      typeof query?.tx_ref === 'string' && query.tx_ref.trim()
        ? query.tx_ref.trim()
        : typeof query?.txRef === 'string' && query.txRef.trim()
          ? query.txRef.trim()
          : typeof query?.reference === 'string' && query.reference.trim()
            ? query.reference.trim()
          : undefined;

    if (transactionId && txRef) {
      try {
        const { result, verified } = await settleCharge(transactionId, txRef);
        const verifiedStatus = normalizeTransactionStatus(verified);
        app.log.info(
          {
            tx_ref: txRef,
            transaction_id: transactionId,
            query_status: status,
            verified_status: verifiedStatus,
            settlement_ok: result.ok,
            settlement_result: result,
            provider: compactProviderSnapshot(verified),
          },
          'flutterwave_return_result'
        );
        if (!result.ok) {
          app.log.warn(
            { result, transactionId, txRef, status },
            'flutterwave_return_processing_issue'
          );
        } else if (verifiedStatus !== 'SUCCESSFUL') {
          app.log.info(
            { transactionId, txRef, providerStatus: verifiedStatus },
            'flutterwave_return_not_successful'
          );
        }
      } catch (error) {
        app.log.error(
          { error, transactionId, txRef, status },
          'flutterwave_return_verification_failed'
        );
      }
    }

    reply.redirect(
      resolveBrowserTarget(
        request,
        cancelled ? '/payment/cancel' : '/payment/success'
      ) ?? (cancelled ? deepLinkCancel : deepLinkReturn)
    );
  });

  app.get('/payments/cancel', async (request, reply) => {
    reply.redirect(resolveBrowserTarget(request, '/payment/cancel') ?? deepLinkCancel);
  });
}
