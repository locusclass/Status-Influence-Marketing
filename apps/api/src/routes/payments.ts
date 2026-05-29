import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction } from '../db.js';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import {
  getTransactionStatus,
  initiateMobileMoneyCollection,
  type YoPaymentResponse,
} from '../services/yoUganda.js';
import {
  config,
  hasYoClientCredentials,
  YO_API_PASSWORD_MISSING_MESSAGE,
  YO_API_USERNAME_MISSING_MESSAGE,
} from '../config.js';
import { isDirectYoTaskUrl } from '@prime/shared';
import { createUserNotificationsWithSmsPlan } from '../services/notificationDelivery.js';
import { queueSmsDispatch } from '../services/smsDispatch.js';
import { activateListingBoost } from '../services/listingBoosts.js';
import {
  insertPrimeRequestAccessPass,
  insertPrimeRequestUnlock,
  normalizePrimeRequestPassType,
} from '../services/primeRequests.js';

const yoProviderReferenceInputKeys = [
  'transaction_id',
  'transactionId',
  'charge_id',
  'chargeId',
  'provider_reference',
  'providerReference',
  'provider_transaction_reference',
  'providerTransactionReference',
  'provider_transaction_id',
  'providerTransactionId',
  'yo_reference',
  'yoReference',
  'yo_transaction_reference',
  'yoTransactionReference',
  'transaction_reference',
  'transactionReference',
  'TransactionReference',
] as const;

const yoMerchantReferenceInputKeys = [
  'tx_ref',
  'txRef',
  'reference',
  'merchant_reference',
  'merchantReference',
  'internal_reference',
  'internalReference',
  'internal_transaction_reference',
  'internalTransactionReference',
  'external_reference',
  'externalReference',
] as const;

const yoStoredProviderReferenceKeys = [
  'transaction_reference',
  'transactionReference',
  'yo_transaction_reference',
  'yoTransactionReference',
  'yo_reference',
  'yoReference',
  'provider_transaction_reference',
  'providerTransactionReference',
  'provider_transaction_id',
  'providerTransactionId',
  'provider_reference',
  'providerReference',
  'charge_id',
  'chargeId',
  'transaction_id',
  'transactionId',
] as const;

function readTextValue(value: unknown) {
  const text = String(value ?? '').trim();
  return text.length > 0 ? text : null;
}

function asRecord(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {} as Record<string, unknown>;
}

function readInputField(
  input: unknown,
  keys: readonly string[],
  nestedKeys: readonly string[] = ['reference_data', 'provider', 'meta']
) {
  const source = asRecord(input);
  const sources = [source];
  for (const nestedKey of nestedKeys) {
    const nestedSource = asRecord(source[nestedKey]);
    if (Object.keys(nestedSource).length > 0) {
      sources.push(nestedSource);
    }
  }
  for (const candidateSource of sources) {
    for (const key of keys) {
      const value = readTextValue(candidateSource[key]);
      if (value) {
        return value;
      }
    }
  }
  return null;
}

function readTransactionReference(payload: YoPaymentResponse | Record<string, unknown>) {
  const source = payload as Record<string, unknown>;
  return (
    readTextValue(source.transactionReference) ??
    readTextValue(source.TransactionReference)
  );
}

function normalizeTransactionStatus(payload: YoPaymentResponse | Record<string, unknown>) {
  const source = payload as Record<string, unknown>;
  const transactionStatus =
    readTextValue(source.transactionStatus) ??
    readTextValue(source.TransactionStatus);
  if (transactionStatus) {
    return transactionStatus.toUpperCase();
  }

  const topLevelStatus = readTextValue(source.status) ?? readTextValue(source.Status);
  if (!topLevelStatus) {
    return '';
  }

  const normalized = topLevelStatus.toUpperCase();
  if (normalized === 'OK') {
    return 'SUCCEEDED';
  }
  if (normalized === 'ERROR') {
    return 'FAILED';
  }
  return normalized;
}

function buildProviderMessage(payload: YoPaymentResponse | Record<string, unknown>) {
  const source = payload as Record<string, unknown>;
  return (
    readTextValue(source.errorMessage) ??
    readTextValue(source.ErrorMessage) ??
    readTextValue(source.statusMessage) ??
    readTextValue(source.StatusMessage)
  );
}

function compactProviderSnapshot(payload: YoPaymentResponse | Record<string, unknown>) {
  const source = payload as Record<string, unknown>;
  const statusCodeRaw = source.statusCode ?? source.StatusCode;
  const parsedStatusCode = Number.parseInt(String(statusCodeRaw ?? ''), 10);

  return {
    status: readTextValue(source.status) ?? readTextValue(source.Status),
    status_code: Number.isFinite(parsedStatusCode) ? parsedStatusCode : null,
    status_message:
      readTextValue(source.statusMessage) ?? readTextValue(source.StatusMessage),
    error_message:
      readTextValue(source.errorMessage) ?? readTextValue(source.ErrorMessage),
    transaction_status:
      readTextValue(source.transactionStatus) ??
      readTextValue(source.TransactionStatus),
    transaction_reference:
      readTextValue(source.transactionReference) ??
      readTextValue(source.TransactionReference),
  };
}

function readNumericField(payload: YoPaymentResponse | Record<string, unknown>, keys: string[]) {
  const source = payload as Record<string, unknown>;
  for (const key of keys) {
    const raw = source[key];
    if (raw == null || raw === '') {
      continue;
    }
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function readStringField(payload: YoPaymentResponse | Record<string, unknown>, keys: string[]) {
  const source = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = readTextValue(source[key]);
    if (value) {
      return value;
    }
  }
  return null;
}

function readProviderMerchantReference(payload: YoPaymentResponse | Record<string, unknown>) {
  return readStringField(payload, [
    'InternalReference',
    'internalReference',
    'ExternalReference',
    'externalReference',
    'MerchantReference',
    'merchantReference',
  ]);
}

export function readYoProviderTransactionReference(input: unknown) {
  return readInputField(input, yoProviderReferenceInputKeys);
}

export function readYoMerchantReference(input: unknown) {
  return readInputField(input, yoMerchantReferenceInputKeys, ['reference_data', 'meta']);
}

export function resolveStoredYoTransactionReference(
  txn: Record<string, unknown> | null | undefined
) {
  if (!txn) return null;
  const rawPayload = asRecord(txn.raw_payload);
  return (
    readTextValue(txn.transaction_reference) ??
    readInputField(rawPayload, yoStoredProviderReferenceKeys, ['reference_data']) ??
    readInputField(txn, yoStoredProviderReferenceKeys, [])
  );
}

export async function paymentRoutes(app: FastifyInstance) {
  const paymentRepo = new PaymentRepo();
  const deepLinkReturn = 'bakule://payment/return';
  const deepLinkCancel = 'bakule://payment/cancel';
  const yoRouteBase = '/payments/yo-uganda';
  const legacyFlutterwaveRouteBase = '/payments/flutterwave';
  const yoRecommendedPollIntervalMs = 10_000;
  const yoVerifyPendingCacheWindowMs = yoRecommendedPollIntervalMs;
  const publicAppOrigin = (() => {
    try {
      return new URL(config.publicAppBaseUrl).origin;
    } catch {
      return null;
    }
  })();

  const verifySchema = z
    .object({
      transaction_id: z
        .union([z.string().trim().min(1), z.number().int().positive()])
        .optional(),
      charge_id: z.string().trim().min(1).optional(),
      provider_reference: z.string().trim().min(1).optional(),
      provider_transaction_reference: z.string().trim().min(1).optional(),
      provider_transaction_id: z.string().trim().min(1).optional(),
      yo_reference: z.string().trim().min(1).optional(),
      yo_transaction_reference: z.string().trim().min(1).optional(),
      transaction_reference: z.string().trim().min(1).optional(),
      tx_ref: z.string().trim().min(1).optional(),
      reference: z.string().trim().min(1).optional(),
      merchant_reference: z.string().trim().min(1).optional(),
      internal_transaction_reference: z.string().trim().min(1).optional(),
      reference_data: z.record(z.string()).optional(),
    })
    .superRefine((value, ctx) => {
      if (!readYoMerchantReference(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['tx_ref'],
          message: 'Transaction reference is required.',
        });
      }
    });
  const initiateSchema = z.object({
    tx_ref: z.string().trim().min(1),
    payment_method: z.enum(['MOBILE_MONEY', 'CARD', 'BANK_TRANSFER']),
    network: z.enum(['MTN', 'AIRTEL', 'M-PESA']).optional(),
    phone_number: z.string().trim().min(7).max(20).optional(),
    card: z.record(z.any()).optional(),
  });
  const authorizeSchema = z.object({
    tx_ref: z.string().trim().min(1),
    charge_id: z.string().trim().min(1).optional(),
    authorization_type: z.string().trim().min(1).optional(),
  });

  const statusSuccess = new Set(['SUCCESSFUL', 'SUCCEEDED', 'COMPLETED']);
  const statusFailure = new Set([
    'FAILED',
    'FAILURE',
    'CANCELLED',
    'CANCELED',
    'ERROR',
  ]);
  const statusPending = new Set([
    'CREATED',
    'PENDING',
    'PROCESSING',
    'INITIATED',
    'QUEUED',
    'REQUIRES_ACTION',
    'INDETERMINATE',
  ]);

  const formatUgandaMoney = (value: number) =>
    `UGX ${Math.trunc(Math.max(0, Number(value ?? 0))).toLocaleString('en-US')}`;

  const planPaymentOutcomeNotification = async (
    client: any,
    input: {
      userId: string;
      txRef: string;
      kind: string;
      status: 'COMPLETED' | 'FAILED';
      amount: number;
      campaignId?: string | null;
      campaignTitle?: string | null;
    }
  ) => {
    const userId = String(input.userId ?? '').trim();
    if (!userId) {
      return [];
    }

    const isSuccess = input.status === 'COMPLETED';
    const isWalletDeposit = input.kind === 'WALLET_DEPOSIT';
    const amountText = formatUgandaMoney(input.amount);
    const title = isWalletDeposit
      ? isSuccess
        ? 'Wallet deposit received'
        : 'Wallet deposit failed'
      : isSuccess
        ? 'Campaign payment successful'
        : 'Campaign payment failed';
    const body = isWalletDeposit
      ? isSuccess
        ? `Your wallet deposit of ${amountText} was successful and is now available in your Prime Status wallet.`
        : `Your wallet deposit of ${amountText} was not completed. You can try again from the app.`
      : isSuccess
        ? `Your payment of ${amountText} for "${input.campaignTitle ?? 'your campaign'}" was successful. Funding is now confirmed.`
        : `Your payment of ${amountText} for "${input.campaignTitle ?? 'your campaign'}" was not completed. The campaign is still awaiting funding.`;

    const plan = await createUserNotificationsWithSmsPlan(
      client,
      [userId],
      {
        category: isSuccess ? 'PAYMENT_SUCCESS' : 'PAYMENT_FAILURE',
        title,
        body,
        targetType: 'PAYMENT',
        targetId: input.txRef,
        meta: {
          payment_kind: input.kind,
          payment_status: input.status,
          amount: Math.trunc(Number(input.amount ?? 0)),
          campaign_id: input.campaignId ?? null,
          tx_ref: input.txRef,
        },
      },
      {
        sms: {
          enabled: true,
          message: body,
        },
      }
    );

    return plan.smsJobs;
  };

  const buildPendingNextAction = (
    payload: YoPaymentResponse | Record<string, unknown>,
    nextCheckInMs = yoRecommendedPollIntervalMs
  ) => {
    const providerStatus = normalizeTransactionStatus(payload);
    if (!statusPending.has(providerStatus)) {
      return null;
    }
    return {
      type: 'payment_instruction',
      note:
        buildProviderMessage(payload) ??
        'Approve the payment prompt on the mobile money phone to continue.',
      next_check_in_ms: nextCheckInMs,
    };
  };

  const parseRecentPendingVerificationCache = (input: {
    txRef: string;
    transactionId: string;
    rawPayload: Record<string, unknown>;
  }) => {
    const providerStatus = readTextValue(input.rawPayload.yo_last_provider_status)?.toUpperCase();
    if (!providerStatus || !statusPending.has(providerStatus)) {
      return null;
    }

    const checkedAt = readTextValue(input.rawPayload.yo_last_status_check_at);
    const checkedAtMs = checkedAt ? Date.parse(checkedAt) : Number.NaN;
    if (!Number.isFinite(checkedAtMs)) {
      return null;
    }

    const ageMs = Date.now() - checkedAtMs;
    if (ageMs < 0 || ageMs >= yoVerifyPendingCacheWindowMs) {
      return null;
    }

    const nextCheckInMs = yoVerifyPendingCacheWindowMs - ageMs;
    const storedNextAction = asRecord(input.rawPayload.yo_next_action);

    return {
      ok: true,
      cached: true,
      status: providerStatus,
      tx_ref: input.txRef,
      transaction_id: input.transactionId,
      next_action: {
        type: readTextValue(storedNextAction.type) ?? 'payment_instruction',
        note:
          readTextValue(storedNextAction.note) ??
          'Approve the payment prompt on the mobile money phone to continue.',
        next_check_in_ms: nextCheckInMs,
      },
      recommended_poll_interval_ms: yoRecommendedPollIntervalMs,
      provider: asRecord(input.rawPayload.yo_last_provider_snapshot),
      result: {
        ok: true,
        pending: true,
        cached: true,
        next_check_in_ms: nextCheckInMs,
      },
    };
  };

  const applyVerifiedCharge = async (
    client: any,
    paymentEvent: {
      transactionId: string | number;
      reference: string;
      expectedProviderReference?: string | null;
    },
    verified: YoPaymentResponse
  ) => {
    const txnRows = await client.query(
      'SELECT * FROM pesapal_transactions WHERE merchant_reference=$1 FOR UPDATE',
      [paymentEvent.reference]
    );
    const txn = txnRows.rows[0];
    if (!txn) {
      return { ok: false, error: 'txn_not_found' };
    }

    const txnPayload = (txn.raw_payload ?? {}) as Record<string, unknown>;
    const txKind = String(txnPayload.kind ?? 'CAMPAIGN_FUNDING')
      .trim()
      .toUpperCase();
    const statusText = normalizeTransactionStatus(verified);
    const actualProviderReference = readTransactionReference(verified);
    const expectedProviderReference =
      paymentEvent.expectedProviderReference ??
      resolveStoredYoTransactionReference(txn) ??
      null;
    const merchantReferenceFromProvider = readProviderMerchantReference(verified);
    const verifiedAmount = readNumericField(verified, ['Amount', 'amount']);
    const verifiedCurrency = readStringField(verified, ['CurrencyCode', 'Currency', 'currency']);
    const expectedCurrency = String(txnPayload.payment_currency ?? 'UGX')
      .trim()
      .toUpperCase();

    if (
      expectedProviderReference &&
      actualProviderReference &&
      expectedProviderReference !== actualProviderReference
    ) {
      return { ok: false, error: 'reference_mismatch' };
    }
    if (
      actualProviderReference &&
      readTextValue(paymentEvent.transactionId) &&
      actualProviderReference !== readTextValue(paymentEvent.transactionId)
    ) {
      return { ok: false, error: 'reference_mismatch' };
    }
    if (
      merchantReferenceFromProvider &&
      merchantReferenceFromProvider !== paymentEvent.reference
    ) {
      return { ok: false, error: 'reference_mismatch' };
    }

    if (
      verifiedAmount != null &&
      Math.round(verifiedAmount) !== Math.round(Number(txn.amount ?? 0))
    ) {
      return { ok: false, error: 'amount_mismatch' };
    }
    if (
      verifiedCurrency != null &&
      verifiedCurrency.trim().toUpperCase() !== expectedCurrency
    ) {
      return { ok: false, error: 'amount_mismatch' };
    }

    if (txKind === 'WALLET_DEPOSIT') {
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
          [walletId, Number(txn.amount ?? 0)]
        );
        await client.query(
          `
          INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
          VALUES ($1,$2,'CREDIT',$3)
          ON CONFLICT DO NOTHING
          `,
          [walletId, Number(txn.amount ?? 0), `WALLET_DEPOSIT:${paymentEvent.reference}`]
        );
        await paymentRepo.updatePesaPalTxnStatus(
          client,
          String(paymentEvent.reference),
          'COMPLETED',
          String(paymentEvent.transactionId)
        );
        return {
          ok: true,
          type: 'wallet_deposit',
          smsJobs: await planPaymentOutcomeNotification(client, {
            userId: String(txnPayload.user_id ?? ''),
            txRef: String(paymentEvent.reference),
            kind: txKind,
            status: 'COMPLETED',
            amount: Number(txn.amount ?? 0),
          }),
        };
      }

      if (statusFailure.has(statusText)) {
        await paymentRepo.updatePesaPalTxnStatus(
          client,
          String(paymentEvent.reference),
          'FAILED',
          String(paymentEvent.transactionId)
        );
        return {
          ok: true,
          type: 'wallet_deposit',
          smsJobs:
            txn.status === 'FAILED'
              ? []
              : await planPaymentOutcomeNotification(client, {
                  userId: String(txnPayload.user_id ?? ''),
                  txRef: String(paymentEvent.reference),
                  kind: txKind,
                  status: 'FAILED',
                  amount: Number(txn.amount ?? 0),
                }),
        };
      }

      await paymentRepo.updatePesaPalTxnStatus(
        client,
        String(paymentEvent.reference),
        'PENDING',
        String(paymentEvent.transactionId)
      );
      return { ok: true, pending: true, type: 'wallet_deposit' };
    }

    if (txKind === 'AMBASSADOR_SUBSCRIPTION') {
      if (txn.status === 'COMPLETED') {
        return { ok: true, duplicate: true, type: 'ambassador_subscription' };
      }

      if (statusSuccess.has(statusText)) {
        await paymentRepo.updatePesaPalTxnStatus(
          client,
          String(paymentEvent.reference),
          'COMPLETED',
          String(paymentEvent.transactionId)
        );
        // Mark the ambassador subscription as paid
        const userId = String(txnPayload.user_id ?? '');
        if (userId) {
          await client.query(
            `UPDATE ambassador_subscriptions
             SET paid_at = now()
             WHERE ambassador_id = $1 AND payment_reference = $2 AND paid_at IS NULL`,
            [userId, String(paymentEvent.reference)]
          );
        }
        return { ok: true, type: 'ambassador_subscription', smsJobs: [] };
      }

      if (statusFailure.has(statusText)) {
        await paymentRepo.updatePesaPalTxnStatus(
          client,
          String(paymentEvent.reference),
          'FAILED',
          String(paymentEvent.transactionId)
        );
        return { ok: true, type: 'ambassador_subscription', smsJobs: [] };
      }

      await paymentRepo.updatePesaPalTxnStatus(
        client,
        String(paymentEvent.reference),
        'PENDING',
        String(paymentEvent.transactionId)
      );
      return { ok: true, pending: true, type: 'ambassador_subscription' };
    }

    if (txKind === 'LISTING_BOOST') {
      if (txn.status === 'COMPLETED') {
        return { ok: true, duplicate: true, type: 'listing_boost' };
      }

      if (statusSuccess.has(statusText)) {
        await paymentRepo.updatePesaPalTxnStatus(
          client,
          String(paymentEvent.reference),
          'COMPLETED',
          String(paymentEvent.transactionId)
        );
        const listingId = String(txnPayload.listing_id ?? '');
        const businessId = String(txnPayload.user_id ?? '');
        const planCode = String(txnPayload.plan_code ?? '');
        const amountUgx = Number(txnPayload.amount ?? 0);
        if (listingId && businessId && planCode) {
          try {
            await activateListingBoost(client, {
              listingId,
              businessId,
              paymentReference: String(paymentEvent.reference),
              planCode,
              amountUgx,
            });
          } catch (e) {
            // Log but don't block — listing may have expired; boost record is still recorded
          }
        }
        return { ok: true, type: 'listing_boost', smsJobs: [] };
      }

      if (statusFailure.has(statusText)) {
        await paymentRepo.updatePesaPalTxnStatus(
          client,
          String(paymentEvent.reference),
          'FAILED',
          String(paymentEvent.transactionId)
        );
        return { ok: true, type: 'listing_boost', smsJobs: [] };
      }

      await paymentRepo.updatePesaPalTxnStatus(
        client,
        String(paymentEvent.reference),
        'PENDING',
        String(paymentEvent.transactionId)
      );
      return { ok: true, pending: true, type: 'listing_boost' };
    }

    if (txKind === 'MARKETPLACE_LISTING_SUBSCRIPTION') {
      if (txn.status === 'COMPLETED') {
        return { ok: true, duplicate: true, type: 'marketplace_listing_subscription' };
      }

      if (statusSuccess.has(statusText)) {
        await paymentRepo.updatePesaPalTxnStatus(
          client,
          String(paymentEvent.reference),
          'COMPLETED',
          String(paymentEvent.transactionId)
        );
        const businessId = String(txnPayload.user_id ?? '');
        const planCode = String(txnPayload.plan_code ?? '');
        const amount = Number(txnPayload.amount ?? 0);
        if (businessId && planCode && amount > 0) {
          const validUntil = new Date();
          validUntil.setDate(validUntil.getDate() + 30);
          await client.query(
            `INSERT INTO business_listing_subscriptions
               (business_id, plan_code, amount, currency, paid_at, valid_until, payment_reference)
             VALUES ($1, $2, $3, 'UGX', now(), $4, $5)
             ON CONFLICT DO NOTHING`,
            [businessId, planCode, amount, validUntil.toISOString(), String(paymentEvent.reference)]
          );
        }
        return { ok: true, type: 'marketplace_listing_subscription', smsJobs: [] };
      }

      if (statusFailure.has(statusText)) {
        await paymentRepo.updatePesaPalTxnStatus(
          client,
          String(paymentEvent.reference),
          'FAILED',
          String(paymentEvent.transactionId)
        );
        return { ok: true, type: 'marketplace_listing_subscription', smsJobs: [] };
      }

      await paymentRepo.updatePesaPalTxnStatus(
        client,
        String(paymentEvent.reference),
        'PENDING',
        String(paymentEvent.transactionId)
      );
      return { ok: true, pending: true, type: 'marketplace_listing_subscription' };
    }

    if (txKind === 'PRIME_REQUEST_UNLOCK') {
      if (txn.status === 'COMPLETED') {
        return { ok: true, duplicate: true, type: 'prime_request_unlock' };
      }

      if (statusSuccess.has(statusText)) {
        await paymentRepo.updatePesaPalTxnStatus(
          client,
          String(paymentEvent.reference),
          'COMPLETED',
          String(paymentEvent.transactionId)
        );
        const userId = String(txnPayload.user_id ?? '');
        const requestId = String(txnPayload.request_id ?? '');
        const amount = Number(txnPayload.amount ?? txn.amount ?? 0);
        if (userId && requestId && amount > 0) {
          await insertPrimeRequestUnlock(client, {
            requestId,
            userId,
            amountPaid: amount,
            paymentReference: String(paymentEvent.reference),
          });
        }
        return { ok: true, type: 'prime_request_unlock', smsJobs: [] };
      }

      if (statusFailure.has(statusText)) {
        await paymentRepo.updatePesaPalTxnStatus(
          client,
          String(paymentEvent.reference),
          'FAILED',
          String(paymentEvent.transactionId)
        );
        return { ok: true, type: 'prime_request_unlock', smsJobs: [] };
      }

      await paymentRepo.updatePesaPalTxnStatus(
        client,
        String(paymentEvent.reference),
        'PENDING',
        String(paymentEvent.transactionId)
      );
      return { ok: true, pending: true, type: 'prime_request_unlock' };
    }

    if (txKind === 'PRIME_REQUEST_ACCESS_PASS') {
      if (txn.status === 'COMPLETED') {
        return { ok: true, duplicate: true, type: 'prime_request_access_pass' };
      }

      if (statusSuccess.has(statusText)) {
        await paymentRepo.updatePesaPalTxnStatus(
          client,
          String(paymentEvent.reference),
          'COMPLETED',
          String(paymentEvent.transactionId)
        );
        const userId = String(txnPayload.user_id ?? '');
        const passType = normalizePrimeRequestPassType(txnPayload.pass_type);
        const amount = Number(txnPayload.amount ?? txn.amount ?? 0);
        if (userId && passType && amount > 0) {
          await insertPrimeRequestAccessPass(client, {
            userId,
            passType,
            amountPaid: amount,
            paymentReference: String(paymentEvent.reference),
          });
        }
        return { ok: true, type: 'prime_request_access_pass', smsJobs: [] };
      }

      if (statusFailure.has(statusText)) {
        await paymentRepo.updatePesaPalTxnStatus(
          client,
          String(paymentEvent.reference),
          'FAILED',
          String(paymentEvent.transactionId)
        );
        return { ok: true, type: 'prime_request_access_pass', smsJobs: [] };
      }

      await paymentRepo.updatePesaPalTxnStatus(
        client,
        String(paymentEvent.reference),
        'PENDING',
        String(paymentEvent.transactionId)
      );
      return { ok: true, pending: true, type: 'prime_request_access_pass' };
    }

    const escrowRows = await client.query('SELECT * FROM escrow_ledger WHERE id=$1', [txn.escrow_id]);
    const escrow = escrowRows.rows[0];
    if (!escrow || Number(txn.amount ?? 0) !== Number(escrow.amount_total ?? 0)) {
      return { ok: false, error: 'amount_mismatch' };
    }
    const campaignOwnerRes = await client.query(
      `
      SELECT id, business_id, title
      FROM campaigns
      WHERE id = $1
      LIMIT 1
      `,
      [escrow.campaign_id]
    );
    const campaignOwner = campaignOwnerRes.rows[0] ?? null;

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
      // Activate the campaign(s) so they appear in ambassador opportunities
      await client.query(
        `UPDATE campaigns
         SET status = 'ACTIVE', updated_at = now()
         WHERE (
           id = $1
           OR parent_campaign_id = $1
           OR bundle_root_campaign_id = $1
         )
         AND status NOT IN ('ACTIVE', 'COMPLETED', 'CANCELLED')`,
        [escrow.campaign_id]
      );
      // Activate any DRAFT listing linked to the funded campaign(s)
      await client.query(
        `
        UPDATE advert_listings al
        SET status = 'ACTIVE',
            campaign_start_at = COALESCE(c.start_date, now()),
            campaign_end_at = COALESCE(c.end_date, COALESCE(c.start_date, now()) + COALESCE(c.terms_keep_hours, 12) * INTERVAL '1 hour'),
            expires_at = COALESCE(c.end_date, COALESCE(c.start_date, now()) + COALESCE(c.terms_keep_hours, 12) * INTERVAL '1 hour'),
            updated_at = now()
        FROM campaigns c
        WHERE al.campaign_id = c.id
          AND al.status = 'DRAFT'
          AND (c.id = $1 OR c.parent_campaign_id = $1 OR c.bundle_root_campaign_id = $1)
        `,
        [escrow.campaign_id]
      );
      // Notify assigned ambassadors now that escrow is funded
      // Include root campaign itself AND any child/bundle campaigns
      const assignedRows = await client.query(
        `SELECT c.assigned_ambassador_id, c.title
         FROM campaigns c
         WHERE (
           c.id = $1
           OR c.parent_campaign_id = $1
           OR c.bundle_root_campaign_id = $1
         )
           AND c.assigned_ambassador_id IS NOT NULL
           AND c.status != 'CANCELLED'`,
        [escrow.campaign_id]
      );
      const assignmentSmsJobs: any[] = [];
      if (assignedRows.rows.length > 0) {
        const notices = new Map<string, string[]>();
        for (const row of assignedRows.rows) {
          const id = String(row.assigned_ambassador_id);
          const title = String(row.title ?? '');
          if (!notices.has(id)) notices.set(id, []);
          notices.get(id)!.push(title);
        }
        for (const [userId, titles] of notices.entries()) {
          const subject = titles.length === 1 ? `"${titles[0]}"` : `${titles.length} campaigns`;
          const msgBody = `You have been assigned to ${subject} on Prime Status. Open the app to review and accept the contract.`;
          const plan = await createUserNotificationsWithSmsPlan(client, [userId], {
            category: 'CAMPAIGN_ASSIGNMENT',
            title: 'New campaign assignment',
            body: msgBody,
            targetType: 'campaign',
            targetId: escrow.campaign_id,
            meta: { assigned_campaign_titles: titles },
          }, { sms: { enabled: true, message: msgBody } });
          assignmentSmsJobs.push(...plan.smsJobs);
        }
      }
      return {
        ok: true,
        type: 'campaign_funding',
        escrow_id: escrow.id,
        smsJobs: [
          ...assignmentSmsJobs,
          ...await planPaymentOutcomeNotification(client, {
          userId: String(campaignOwner?.business_id ?? ''),
          txRef: String(paymentEvent.reference),
          kind: txKind,
          status: 'COMPLETED',
          amount: Number(txn.amount ?? 0),
          campaignId: campaignOwner?.id ? String(campaignOwner.id) : null,
          campaignTitle:
            campaignOwner?.title == null ? null : String(campaignOwner.title),
        }),
        ],
      };
    }

    if (statusFailure.has(statusText)) {
      await paymentRepo.updatePesaPalTxnStatus(
        client,
        String(paymentEvent.reference),
        'FAILED',
        String(paymentEvent.transactionId)
      );
      return {
        ok: true,
        type: 'campaign_funding',
        escrow_id: escrow.id,
        smsJobs:
          txn.status === 'FAILED'
            ? []
            : await planPaymentOutcomeNotification(client, {
                userId: String(campaignOwner?.business_id ?? ''),
                txRef: String(paymentEvent.reference),
                kind: txKind,
                status: 'FAILED',
                amount: Number(txn.amount ?? 0),
                campaignId: campaignOwner?.id ? String(campaignOwner.id) : null,
                campaignTitle:
                  campaignOwner?.title == null ? null : String(campaignOwner.title),
              }),
      };
    }

    await paymentRepo.updatePesaPalTxnStatus(
      client,
      String(paymentEvent.reference),
      'PENDING',
      String(paymentEvent.transactionId)
    );
    return { ok: true, pending: true, type: 'campaign_funding', escrow_id: escrow.id };
  };

  const settleCharge = async (
    paymentEvent: {
      transactionId: string | number;
      reference: string;
      expectedProviderReference?: string | null;
    }
  ) => {
    const verified = await getTransactionStatus(
      String(paymentEvent.transactionId),
      paymentEvent.reference
    );
    const verifiedStatus = normalizeTransactionStatus(verified);
    const verifiedSnapshot = compactProviderSnapshot(verified);
    const nextAction = buildPendingNextAction(verified);
    const result = await withTransaction(async (client) => {
      await client.query(
        `UPDATE pesapal_transactions
         SET raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb
         WHERE merchant_reference=$1`,
        [
          paymentEvent.reference,
          JSON.stringify({
            yo_last_provider_status: verifiedStatus,
            yo_last_status_check_at: new Date().toISOString(),
            yo_last_provider_snapshot: verifiedSnapshot,
            yo_next_action: nextAction,
          }),
        ]
      );

      return applyVerifiedCharge(client, paymentEvent, verified);
    });

    return { result, verified };
  };

  const resolveBrowserTarget = (request: any, fallbackPath: string) => {
    const query = (request.query as Record<string, unknown> | undefined) ?? {};
    const isAllowedBrowserUrl = (target: URL) =>
      (target.protocol === 'http:' || target.protocol === 'https:') &&
      publicAppOrigin != null &&
      target.origin === publicAppOrigin;
    const queryTarget = query.target;
    if (typeof queryTarget === 'string' && queryTarget.trim()) {
      try {
        const target = new URL(queryTarget.trim());
        for (const [key, value] of Object.entries(query)) {
          if (key === 'target' || value == null) continue;
          target.searchParams.set(key, String(value));
        }
        if (isAllowedBrowserUrl(target)) {
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
        if (isAllowedBrowserUrl(target)) {
          return target.toString();
        }
      } catch {
        // Ignore invalid referers and use the deep link fallback.
      }
    }

    return null;
  };

  const yoHealthCheck = async (_request: any, reply: any) => {
    const credentialsConfigured = hasYoClientCredentials();
    const endpoint = config.yo.baseUrl;
    const proxyMode = !isDirectYoTaskUrl(endpoint);
    const allowDirectBypass = config.yo.allowDirectApiBypass;

    if (!credentialsConfigured) {
      reply.code(503);
      return {
        ok: false,
        error: 'yo_uganda_not_configured',
        endpoint,
        proxy_mode: proxyMode,
        allow_direct_bypass: allowDirectBypass,
        credentials_configured: false,
        detail: `${YO_API_USERNAME_MISSING_MESSAGE} and/or ${YO_API_PASSWORD_MISSING_MESSAGE}`,
      };
    }

    return {
      ok: true,
      endpoint,
      proxy_mode: proxyMode,
      allow_direct_bypass: allowDirectBypass,
      credentials_configured: true,
      api_username_configured: Boolean(config.yo.apiUsername),
      api_password_configured: Boolean(config.yo.apiPassword),
      authorization_configured: Boolean(config.yo.authorizationCode),
    };
  };

  const webhookInfo = async () => ({
    ok: true,
    method: 'POST',
    note: 'YO Uganda payment collection uses client-side status polling. Webhook ingestion is not active on this endpoint.',
  });

  const handleWebhook = async (_request: any, reply: any) => {
    reply.code(410).send({
      error: 'webhook_not_supported',
      detail:
        'YO Uganda payment collection uses transaction polling instead of this webhook endpoint.',
    });
  };

  for (const routeBase of [yoRouteBase, legacyFlutterwaveRouteBase]) {
    app.get(`${routeBase}/health`, yoHealthCheck);
    app.get(`${routeBase}/webhook`, webhookInfo);
    app.post(`${routeBase}/webhook`, handleWebhook);
  }

  const loadTransactionByReference = async (client: any, txRef: string) => {
    const txnRes = await client.query(
      'SELECT * FROM pesapal_transactions WHERE merchant_reference=$1 LIMIT 1',
      [txRef]
    );
    return txnRes.rows[0];
  };

  const loadChargeContext = async (client: any, txRef: string, authUser: string) => {
    const txn = await loadTransactionByReference(client, txRef);
    if (!txn) {
      return { error: 'txn_not_found' } as const;
    }

    const rawPayload = (txn.raw_payload ?? {}) as Record<string, any>;
    const txKind = String(rawPayload.kind ?? '').toUpperCase();

    if (txKind === 'WALLET_DEPOSIT' || txKind === 'AMBASSADOR_SUBSCRIPTION'
        || txKind === 'LISTING_BOOST' || txKind === 'MARKETPLACE_LISTING_SUBSCRIPTION'
        || txKind === 'PRIME_REQUEST_UNLOCK' || txKind === 'PRIME_REQUEST_ACCESS_PASS') {
      if (String(rawPayload.user_id ?? '') !== authUser) {
        return { error: 'forbidden' } as const;
      }
    } else {
      const escrowRes = await client.query(
        `SELECT e.id, c.id AS campaign_id, c.business_id
         FROM escrow_ledger e
         JOIN campaigns c ON c.id = e.campaign_id
         WHERE e.id=$1
         LIMIT 1`,
        [txn.escrow_id]
      );
      const escrow = escrowRes.rows[0];
      if (!escrow || escrow.business_id !== authUser) {
        return { error: 'forbidden' } as const;
      }
    }

    const userRes = await client.query(
      'SELECT phone FROM users WHERE id=$1 LIMIT 1',
      [authUser]
    );
    const user = userRes.rows[0];
    const supportedPaymentMethods = Array.isArray(rawPayload.supported_payment_methods)
      ? rawPayload.supported_payment_methods
          .map((entry: unknown) => String(entry ?? '').trim().toUpperCase())
          .filter(Boolean)
      : [];
    const mobileMoneyNetworks = Array.isArray(rawPayload.mobile_money_networks)
      ? rawPayload.mobile_money_networks
          .map((entry: unknown) => String(entry ?? '').trim().toUpperCase())
          .filter(Boolean)
      : [];

    return {
      txn,
      rawPayload,
      phoneNumber: String(
        rawPayload.customer?.phone_number ?? rawPayload.customer?.phone ?? user?.phone ?? ''
      ).trim(),
      supportedPaymentMethods,
      mobileMoneyNetworks,
    };
  };

  const buildChargeResponse = (
    txRef: string,
    paymentMethod: 'MOBILE_MONEY' | 'CARD' | 'BANK_TRANSFER',
    chargePayload: YoPaymentResponse
  ) => {
    const chargeId = readTransactionReference(chargePayload);
    const providerStatus = normalizeTransactionStatus(chargePayload);
    const pendingNextAction = buildPendingNextAction(chargePayload);
    const instruction = pendingNextAction?.note ?? buildProviderMessage(chargePayload) ?? null;

    return {
      ok: true,
      tx_ref: txRef,
      payment_method: paymentMethod,
      charge_id: chargeId,
      transaction_id: chargeId,
      provider_reference: chargeId,
      provider_transaction_reference: chargeId,
      yo_transaction_reference: chargeId,
      provider_status: providerStatus,
      redirect_url: null,
      instruction,
      next_action: pendingNextAction,
      recommended_poll_interval_ms: pendingNextAction ? yoRecommendedPollIntervalMs : null,
      provider: compactProviderSnapshot(chargePayload),
    };
  };

  const resolveSettlementReference = (
    txn: Record<string, unknown> | null | undefined,
    rawInput: unknown
  ) => {
    const storedProviderReference = resolveStoredYoTransactionReference(txn);
    const requestedProviderReference = readYoProviderTransactionReference(rawInput);
    const transactionId = storedProviderReference ?? requestedProviderReference;
    if (!transactionId) {
      return null;
    }
    return {
      transactionId,
      expectedProviderReference: storedProviderReference ?? transactionId,
    };
  };

  const initiatePayment = async (request: any, reply: any) => {
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
      if (!hasYoClientCredentials()) {
        reply.code(503);
        return { error: 'yo_uganda_not_configured' };
      }

      const result = await withTransaction(async (client) => {
        const context = await loadChargeContext(client, parsed.data.tx_ref, authUser);
        if ('error' in context) {
          return context;
        }

        if (parsed.data.payment_method !== 'MOBILE_MONEY') {
          return {
            error: 'unsupported_payment_method',
            detail: 'YO Uganda currently supports mobile money collections only.',
          } as const;
        }

        const phoneNumber = parsed.data.phone_number?.trim() || context.phoneNumber;
        if (!phoneNumber) {
          return { error: 'missing_payout_phone' } as const;
        }

        const preferredNetwork = String(parsed.data.network ?? '')
          .trim()
          .toUpperCase();
        const network = preferredNetwork || context.mobileMoneyNetworks[0] || '';
        if (!network) {
          return { error: 'missing_mobile_money_network' } as const;
        }
        if (
          context.mobileMoneyNetworks.length > 0 &&
          !context.mobileMoneyNetworks.includes(network)
        ) {
          return { error: 'unsupported_payment_method' } as const;
        }

        const chargeResponse = await initiateMobileMoneyCollection({
          amount: Number(context.txn.amount ?? 0),
          phoneNumber,
          network: network as 'MTN' | 'AIRTEL' | 'M-PESA',
          narrative: (() => {
            const k = String(context.rawPayload.kind ?? '').toUpperCase();
            if (k === 'WALLET_DEPOSIT') return `Wallet deposit ${parsed.data.tx_ref}`;
            if (k === 'AMBASSADOR_SUBSCRIPTION') return `Ambassador subscription ${parsed.data.tx_ref}`;
            if (k === 'LISTING_BOOST') return `Listing boost ${parsed.data.tx_ref}`;
            if (k === 'PRIME_REQUEST_UNLOCK') return `Prime Request unlock ${parsed.data.tx_ref}`;
            if (k === 'PRIME_REQUEST_ACCESS_PASS') return `Prime Requests access pass ${parsed.data.tx_ref}`;
            return `Campaign funding ${parsed.data.tx_ref}`;
          })(),
          reference: parsed.data.tx_ref,
          providerReferenceText: `Prime ${parsed.data.tx_ref}`,
          nonBlocking: true,
        });

        const chargeId = readTransactionReference(chargeResponse);
        const providerStatus = normalizeTransactionStatus(chargeResponse);
        if (!chargeId && !statusFailure.has(providerStatus)) {
          throw new Error('YO Uganda did not return a transaction reference');
        }

        await client.query(
          `UPDATE pesapal_transactions
           SET raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb
           WHERE merchant_reference=$1`,
          [
            parsed.data.tx_ref,
            JSON.stringify({
              payment_method: parsed.data.payment_method,
              network,
              yo_transaction_reference: chargeId,
              yo_last_provider_status: providerStatus,
              yo_last_status_check_at: new Date().toISOString(),
              yo_last_provider_snapshot: compactProviderSnapshot(chargeResponse),
              yo_next_action: buildPendingNextAction(chargeResponse),
            }),
          ]
        );

        let smsJobs: any[] = [];
        if (statusSuccess.has(providerStatus)) {
          const settlement = await applyVerifiedCharge(
            client,
            {
              transactionId: chargeId ?? parsed.data.tx_ref,
              reference: parsed.data.tx_ref,
              expectedProviderReference: chargeId,
            },
            chargeResponse
          );
          smsJobs = settlement?.smsJobs ?? [];
        } else if (statusFailure.has(providerStatus)) {
          await paymentRepo.updatePesaPalTxnStatus(
            client,
            parsed.data.tx_ref,
            'FAILED',
            chargeId ?? undefined
          );
          const failedKind = String(context.rawPayload.kind ?? '').toUpperCase();
          if (failedKind === 'WALLET_DEPOSIT' || failedKind === 'AMBASSADOR_SUBSCRIPTION' || failedKind === 'LISTING_BOOST' || failedKind === 'PRIME_REQUEST_UNLOCK' || failedKind === 'PRIME_REQUEST_ACCESS_PASS') {
            smsJobs = await planPaymentOutcomeNotification(client, {
              userId: authUser,
              txRef: parsed.data.tx_ref,
              kind: failedKind,
              status: 'FAILED',
              amount: Number(context.txn.amount ?? 0),
            });
          } else {
            const campaignRes = await client.query(
              `
              SELECT c.id, c.business_id, c.title
              FROM escrow_ledger e
              JOIN campaigns c ON c.id = e.campaign_id
              WHERE e.id = $1
              LIMIT 1
              `,
              [context.txn.escrow_id]
            );
            const campaign = campaignRes.rows[0] ?? null;
            smsJobs = await planPaymentOutcomeNotification(client, {
              userId: String(campaign?.business_id ?? authUser),
              txRef: parsed.data.tx_ref,
              kind: failedKind || 'CAMPAIGN_FUNDING',
              status: 'FAILED',
              amount: Number(context.txn.amount ?? 0),
              campaignId: campaign?.id ? String(campaign.id) : null,
              campaignTitle:
                campaign?.title == null ? null : String(campaign.title),
            });
          }
        } else {
          await paymentRepo.updatePesaPalTxnStatus(
            client,
            parsed.data.tx_ref,
            'PENDING',
            chargeId ?? undefined
          );
        }

        return {
          response: buildChargeResponse(
            parsed.data.tx_ref,
            parsed.data.payment_method,
            chargeResponse
          ),
          smsJobs,
        };
      });

      const outcome: any = result;
      if (outcome?.error) {
        reply.code(
          outcome.error === 'forbidden'
            ? 403
            : outcome.error === 'txn_not_found'
              ? 404
              : 400
        );
        app.log.warn(
          {
            tx_ref: parsed.data.tx_ref,
            payment_method: parsed.data.payment_method,
            outcome,
          },
          'yo_initiate_rejected'
        );
        return outcome;
      }
      queueSmsDispatch(outcome.smsJobs ?? [], app.log, 'payments:initiate');

      app.log.info(
        {
          tx_ref: parsed.data.tx_ref,
          payment_method: parsed.data.payment_method,
          charge_id: outcome.response?.charge_id,
          provider_status: outcome.response?.provider_status,
          instruction: outcome.response?.instruction,
        },
        'yo_initiate_result'
      );
      return outcome.response;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      app.log.error(
        {
          error,
          detail,
          body: request.body,
        },
        `yo_initiate_failed: ${detail}`
      );
      reply.code(502);
      return { error: 'yo_uganda_initiate_failed', detail };
    }
  };

  const authorizePayment = async (request: any, reply: any) => {
    const parsed = authorizeSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    reply.code(400);
    return {
      error: 'authorization_not_supported',
      detail: 'YO Uganda mobile money collections do not require an extra authorization call in this checkout flow.',
    };
  };

  const verifyPayment = async (request: any, reply: any) => {
    const parsed = verifySchema.safeParse(request.body);
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

      const txRef = readYoMerchantReference(request.body) ?? readYoMerchantReference(parsed.data);
      if (!txRef) {
        reply.code(400);
        return { error: 'validation_failed', issues: [{ path: ['tx_ref'] }] };
      }

      const verificationContext = await withTransaction(async (client) => {
        const context = await loadChargeContext(client, txRef, authUser);
        if ('error' in context) {
          return context;
        }
        const settlementReference = resolveSettlementReference(context.txn, request.body);
        if (!settlementReference) {
          return { error: 'missing_transaction_reference' } as const;
        }
        return {
          ...settlementReference,
          txn: context.txn,
          rawPayload: context.rawPayload,
        };
      });

      if (!('transactionId' in verificationContext)) {
        reply.code(
          verificationContext.error === 'forbidden'
            ? 403
            : verificationContext.error === 'txn_not_found'
              ? 404
              : 400
        );
        return verificationContext;
      }

      const cachedPendingResult = parseRecentPendingVerificationCache({
        txRef,
        transactionId: verificationContext.transactionId,
        rawPayload: verificationContext.rawPayload,
      });
      if (cachedPendingResult) {
        app.log.info(
          {
            tx_ref: txRef,
            transaction_id: verificationContext.transactionId,
            cached: true,
            next_check_in_ms: cachedPendingResult.result.next_check_in_ms,
          },
          'yo_verify_result_cached'
        );
        return cachedPendingResult;
      }

      const { result, verified } = await settleCharge({
        transactionId: verificationContext.transactionId,
        reference: txRef,
        expectedProviderReference: verificationContext.expectedProviderReference,
      });
      const verifiedStatus = normalizeTransactionStatus(verified);
      app.log.info(
        {
          tx_ref: txRef,
          transaction_id: verificationContext.transactionId,
          verified_status: verifiedStatus,
          settlement_ok: result.ok,
          settlement_result: result,
          provider: compactProviderSnapshot(verified),
        },
        'yo_verify_result'
      );
      if (!result.ok) {
        reply.code(result.error === 'txn_not_found' ? 404 : 400);
        return result;
      }
      queueSmsDispatch((result as any).smsJobs ?? [], app.log, 'payments:verify');
      return {
        ok: true,
        status: verifiedStatus,
        tx_ref: txRef,
        transaction_id: verificationContext.transactionId,
        next_action: buildPendingNextAction(verified),
        recommended_poll_interval_ms: statusPending.has(verifiedStatus)
          ? yoRecommendedPollIntervalMs
          : null,
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
        `yo_verify_failed: ${detail}`
      );
      reply.code(502);
      return { error: 'yo_uganda_verify_failed', detail };
    }
  };

  for (const routeBase of [yoRouteBase, legacyFlutterwaveRouteBase]) {
    app.post(`${routeBase}/initiate`, { preHandler: [app.authenticate] }, initiatePayment);
    app.post(`${routeBase}/authorize`, { preHandler: [app.authenticate] }, authorizePayment);
    app.post(`${routeBase}/verify`, { preHandler: [app.authenticate] }, verifyPayment);
  }

  app.get('/payments/return', async (request, reply) => {
    const query = request.query as Record<string, unknown> | undefined;
    const status = String(query?.status ?? '').toLowerCase();
    const paymentState = String(query?.payment ?? '').toLowerCase();
    const cancelled =
      status === 'cancelled' ||
      status === 'failed' ||
      status === 'error' ||
      paymentState === 'cancel';
    const txRef = readYoMerchantReference(query);

    if (txRef) {
      try {
        const settlementReference = await withTransaction(async (client) => {
          const txn = await loadTransactionByReference(client, txRef);
          if (!txn) {
            return { error: 'txn_not_found' } as const;
          }
          return resolveSettlementReference(txn, query) ?? {
            error: 'missing_transaction_reference',
          };
        });

        if ('error' in settlementReference) {
          app.log.warn(
            { settlementReference, txRef, query },
            'yo_return_verification_skipped'
          );
        } else {
          await settleCharge({
            transactionId: settlementReference.transactionId,
            reference: txRef,
            expectedProviderReference: settlementReference.expectedProviderReference,
          });
        }
      } catch (error) {
        app.log.error(
          {
            error,
            transaction_id: readYoProviderTransactionReference(query),
            txRef,
            status,
            payment: paymentState,
          },
          'yo_return_verification_failed'
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
