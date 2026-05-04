import { z } from 'zod';
import { withTransaction } from '../db.js';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import { getTransactionStatus, initiateMobileMoneyCollection, } from '../services/yoUganda.js';
import { config, hasYoClientCredentials, YO_AUTHORIZATION_MISSING_MESSAGE, } from '../config.js';
import { isDirectYoTaskUrl } from '@prime/shared';
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
];
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
];
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
];
function readTextValue(value) {
    const text = String(value ?? '').trim();
    return text.length > 0 ? text : null;
}
function asRecord(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value;
    }
    return {};
}
function readInputField(input, keys, nestedKeys = ['reference_data', 'provider', 'meta']) {
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
function readTransactionReference(payload) {
    const source = payload;
    return (readTextValue(source.transactionReference) ??
        readTextValue(source.TransactionReference));
}
function normalizeTransactionStatus(payload) {
    const source = payload;
    const transactionStatus = readTextValue(source.transactionStatus) ??
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
function buildProviderMessage(payload) {
    const source = payload;
    return (readTextValue(source.errorMessage) ??
        readTextValue(source.ErrorMessage) ??
        readTextValue(source.statusMessage) ??
        readTextValue(source.StatusMessage));
}
function compactProviderSnapshot(payload) {
    const source = payload;
    const statusCodeRaw = source.statusCode ?? source.StatusCode;
    const parsedStatusCode = Number.parseInt(String(statusCodeRaw ?? ''), 10);
    return {
        status: readTextValue(source.status) ?? readTextValue(source.Status),
        status_code: Number.isFinite(parsedStatusCode) ? parsedStatusCode : null,
        status_message: readTextValue(source.statusMessage) ?? readTextValue(source.StatusMessage),
        error_message: readTextValue(source.errorMessage) ?? readTextValue(source.ErrorMessage),
        transaction_status: readTextValue(source.transactionStatus) ??
            readTextValue(source.TransactionStatus),
        transaction_reference: readTextValue(source.transactionReference) ??
            readTextValue(source.TransactionReference),
    };
}
function readNumericField(payload, keys) {
    const source = payload;
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
function readStringField(payload, keys) {
    const source = payload;
    for (const key of keys) {
        const value = readTextValue(source[key]);
        if (value) {
            return value;
        }
    }
    return null;
}
function readProviderMerchantReference(payload) {
    return readStringField(payload, [
        'InternalReference',
        'internalReference',
        'ExternalReference',
        'externalReference',
        'MerchantReference',
        'merchantReference',
    ]);
}
export function readYoProviderTransactionReference(input) {
    return readInputField(input, yoProviderReferenceInputKeys);
}
export function readYoMerchantReference(input) {
    return readInputField(input, yoMerchantReferenceInputKeys, ['reference_data', 'meta']);
}
export function resolveStoredYoTransactionReference(txn) {
    if (!txn)
        return null;
    const rawPayload = asRecord(txn.raw_payload);
    return (readTextValue(txn.transaction_reference) ??
        readInputField(rawPayload, yoStoredProviderReferenceKeys, ['reference_data']) ??
        readInputField(txn, yoStoredProviderReferenceKeys, []));
}
export async function paymentRoutes(app) {
    const paymentRepo = new PaymentRepo();
    const deepLinkReturn = 'bakule://payment/return';
    const deepLinkCancel = 'bakule://payment/cancel';
    const yoRouteBase = '/payments/yo-uganda';
    const legacyFlutterwaveRouteBase = '/payments/flutterwave';
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
    const applyVerifiedCharge = async (client, paymentEvent, verified) => {
        const txnRows = await client.query('SELECT * FROM pesapal_transactions WHERE merchant_reference=$1 FOR UPDATE', [paymentEvent.reference]);
        const txn = txnRows.rows[0];
        if (!txn) {
            return { ok: false, error: 'txn_not_found' };
        }
        const txnPayload = (txn.raw_payload ?? {});
        const statusText = normalizeTransactionStatus(verified);
        const actualProviderReference = readTransactionReference(verified);
        const expectedProviderReference = paymentEvent.expectedProviderReference ??
            resolveStoredYoTransactionReference(txn) ??
            null;
        const merchantReferenceFromProvider = readProviderMerchantReference(verified);
        const verifiedAmount = readNumericField(verified, ['Amount', 'amount']);
        const verifiedCurrency = readStringField(verified, ['CurrencyCode', 'Currency', 'currency']);
        const expectedCurrency = String(txnPayload.payment_currency ?? 'UGX')
            .trim()
            .toUpperCase();
        if (expectedProviderReference &&
            actualProviderReference &&
            expectedProviderReference !== actualProviderReference) {
            return { ok: false, error: 'reference_mismatch' };
        }
        if (actualProviderReference &&
            readTextValue(paymentEvent.transactionId) &&
            actualProviderReference !== readTextValue(paymentEvent.transactionId)) {
            return { ok: false, error: 'reference_mismatch' };
        }
        if (merchantReferenceFromProvider &&
            merchantReferenceFromProvider !== paymentEvent.reference) {
            return { ok: false, error: 'reference_mismatch' };
        }
        if (verifiedAmount != null &&
            Math.round(verifiedAmount) !== Math.round(Number(txn.amount ?? 0))) {
            return { ok: false, error: 'amount_mismatch' };
        }
        if (verifiedCurrency != null &&
            verifiedCurrency.trim().toUpperCase() !== expectedCurrency) {
            return { ok: false, error: 'amount_mismatch' };
        }
        if (txnPayload.kind === 'WALLET_DEPOSIT') {
            if (txn.status === 'COMPLETED') {
                return { ok: true, duplicate: true, type: 'wallet_deposit' };
            }
            if (statusSuccess.has(statusText)) {
                const walletId = String(txnPayload.wallet_id ?? '');
                if (!walletId) {
                    return { ok: false, error: 'wallet_not_found' };
                }
                await client.query('SELECT id FROM wallets WHERE id=$1 FOR UPDATE', [walletId]);
                await client.query(`
          UPDATE wallets
          SET balance_available = balance_available + $2,
              balance = balance + $2
          WHERE id=$1
          `, [walletId, Number(txn.amount ?? 0)]);
                await client.query(`
          INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
          VALUES ($1,$2,'CREDIT',$3)
          ON CONFLICT DO NOTHING
          `, [walletId, Number(txn.amount ?? 0), `WALLET_DEPOSIT:${paymentEvent.reference}`]);
                await paymentRepo.updatePesaPalTxnStatus(client, String(paymentEvent.reference), 'COMPLETED', String(paymentEvent.transactionId));
                return { ok: true, type: 'wallet_deposit' };
            }
            if (statusFailure.has(statusText)) {
                await paymentRepo.updatePesaPalTxnStatus(client, String(paymentEvent.reference), 'FAILED', String(paymentEvent.transactionId));
                return { ok: true, type: 'wallet_deposit' };
            }
            await paymentRepo.updatePesaPalTxnStatus(client, String(paymentEvent.reference), 'PENDING', String(paymentEvent.transactionId));
            return { ok: true, pending: true, type: 'wallet_deposit' };
        }
        const escrowRows = await client.query('SELECT * FROM escrow_ledger WHERE id=$1', [txn.escrow_id]);
        const escrow = escrowRows.rows[0];
        if (!escrow || Number(txn.amount ?? 0) !== Number(escrow.amount_total ?? 0)) {
            return { ok: false, error: 'amount_mismatch' };
        }
        if (txn.status === 'COMPLETED') {
            return { ok: true, duplicate: true, type: 'campaign_funding', escrow_id: escrow.id };
        }
        if (statusSuccess.has(statusText)) {
            await paymentRepo.updatePesaPalTxnStatus(client, String(paymentEvent.reference), 'COMPLETED', String(paymentEvent.transactionId));
            await paymentRepo.markEscrowFunded(client, escrow.id, txn.id);
            return { ok: true, type: 'campaign_funding', escrow_id: escrow.id };
        }
        if (statusFailure.has(statusText)) {
            await paymentRepo.updatePesaPalTxnStatus(client, String(paymentEvent.reference), 'FAILED', String(paymentEvent.transactionId));
            return { ok: true, type: 'campaign_funding', escrow_id: escrow.id };
        }
        await paymentRepo.updatePesaPalTxnStatus(client, String(paymentEvent.reference), 'PENDING', String(paymentEvent.transactionId));
        return { ok: true, pending: true, type: 'campaign_funding', escrow_id: escrow.id };
    };
    const settleCharge = async (paymentEvent) => {
        const verified = await getTransactionStatus(String(paymentEvent.transactionId), paymentEvent.reference);
        const result = await withTransaction(async (client) => applyVerifiedCharge(client, paymentEvent, verified));
        return { result, verified };
    };
    const resolveBrowserTarget = (request, fallbackPath) => {
        const query = request.query ?? {};
        const queryTarget = query.target;
        if (typeof queryTarget === 'string' && queryTarget.trim()) {
            try {
                const target = new URL(queryTarget.trim());
                for (const [key, value] of Object.entries(query)) {
                    if (key === 'target' || value == null)
                        continue;
                    target.searchParams.set(key, String(value));
                }
                if (target.protocol === 'http:' ||
                    target.protocol === 'https:' ||
                    target.protocol === 'bakule:') {
                    return target.toString();
                }
            }
            catch {
                // Ignore invalid targets and fall back below.
            }
        }
        const referer = request.headers.referer ?? request.headers.referrer;
        if (typeof referer === 'string' && referer.trim()) {
            try {
                const target = new URL(fallbackPath, referer);
                for (const [key, value] of Object.entries(query)) {
                    if (key === 'target' || value == null)
                        continue;
                    target.searchParams.set(key, String(value));
                }
                return target.toString();
            }
            catch {
                // Ignore invalid referers and use the deep link fallback.
            }
        }
        return null;
    };
    const yoHealthCheck = async (_request, reply) => {
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
                detail: YO_AUTHORIZATION_MISSING_MESSAGE,
            };
        }
        return {
            ok: true,
            endpoint,
            proxy_mode: proxyMode,
            allow_direct_bypass: allowDirectBypass,
            credentials_configured: true,
            authorization_configured: Boolean(config.yo.authorizationCode),
        };
    };
    const webhookInfo = async () => ({
        ok: true,
        method: 'POST',
        note: 'YO Uganda payment collection uses client-side status polling. Webhook ingestion is not active on this endpoint.',
    });
    const handleWebhook = async (_request, reply) => {
        reply.code(410).send({
            error: 'webhook_not_supported',
            detail: 'YO Uganda payment collection uses transaction polling instead of this webhook endpoint.',
        });
    };
    for (const routeBase of [yoRouteBase, legacyFlutterwaveRouteBase]) {
        app.get(`${routeBase}/health`, yoHealthCheck);
        app.get(`${routeBase}/webhook`, webhookInfo);
        app.post(`${routeBase}/webhook`, handleWebhook);
    }
    const loadTransactionByReference = async (client, txRef) => {
        const txnRes = await client.query('SELECT * FROM pesapal_transactions WHERE merchant_reference=$1 LIMIT 1', [txRef]);
        return txnRes.rows[0];
    };
    const loadChargeContext = async (client, txRef, authUser) => {
        const txn = await loadTransactionByReference(client, txRef);
        if (!txn) {
            return { error: 'txn_not_found' };
        }
        const rawPayload = (txn.raw_payload ?? {});
        const txKind = String(rawPayload.kind ?? '').toUpperCase();
        if (txKind === 'WALLET_DEPOSIT') {
            if (String(rawPayload.user_id ?? '') !== authUser) {
                return { error: 'forbidden' };
            }
        }
        else {
            const escrowRes = await client.query(`SELECT e.id, c.id AS campaign_id, c.advertiser_id
         FROM escrow_ledger e
         JOIN campaigns c ON c.id = e.campaign_id
         WHERE e.id=$1
         LIMIT 1`, [txn.escrow_id]);
            const escrow = escrowRes.rows[0];
            if (!escrow || escrow.advertiser_id !== authUser) {
                return { error: 'forbidden' };
            }
        }
        const userRes = await client.query('SELECT phone FROM users WHERE id=$1 LIMIT 1', [authUser]);
        const user = userRes.rows[0];
        const supportedPaymentMethods = Array.isArray(rawPayload.supported_payment_methods)
            ? rawPayload.supported_payment_methods
                .map((entry) => String(entry ?? '').trim().toUpperCase())
                .filter(Boolean)
            : [];
        const mobileMoneyNetworks = Array.isArray(rawPayload.mobile_money_networks)
            ? rawPayload.mobile_money_networks
                .map((entry) => String(entry ?? '').trim().toUpperCase())
                .filter(Boolean)
            : [];
        return {
            txn,
            rawPayload,
            phoneNumber: String(rawPayload.customer?.phone_number ?? rawPayload.customer?.phone ?? user?.phone ?? '').trim(),
            supportedPaymentMethods,
            mobileMoneyNetworks,
        };
    };
    const buildChargeResponse = (txRef, paymentMethod, chargePayload) => {
        const chargeId = readTransactionReference(chargePayload);
        const providerStatus = normalizeTransactionStatus(chargePayload);
        const instruction = buildProviderMessage(chargePayload) ??
            (statusPending.has(providerStatus)
                ? 'Approve the payment prompt on the mobile money phone to continue.'
                : null);
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
            next_action: statusPending.has(providerStatus)
                ? {
                    type: 'payment_instruction',
                    note: instruction,
                }
                : null,
            provider: compactProviderSnapshot(chargePayload),
        };
    };
    const resolveSettlementReference = (txn, rawInput) => {
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
    const initiatePayment = async (request, reply) => {
        const parsed = initiateSchema.safeParse(request.body);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        try {
            const authUser = request.user?.sub;
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
                    };
                }
                const phoneNumber = parsed.data.phone_number?.trim() || context.phoneNumber;
                if (!phoneNumber) {
                    return { error: 'missing_payout_phone' };
                }
                const preferredNetwork = String(parsed.data.network ?? '')
                    .trim()
                    .toUpperCase();
                const network = preferredNetwork || context.mobileMoneyNetworks[0] || '';
                if (!network) {
                    return { error: 'missing_mobile_money_network' };
                }
                if (context.mobileMoneyNetworks.length > 0 &&
                    !context.mobileMoneyNetworks.includes(network)) {
                    return { error: 'unsupported_payment_method' };
                }
                const chargeResponse = await initiateMobileMoneyCollection({
                    amount: Number(context.txn.amount ?? 0),
                    phoneNumber,
                    network: network,
                    narrative: String(context.rawPayload.kind ?? '').toUpperCase() === 'WALLET_DEPOSIT'
                        ? `Wallet deposit ${parsed.data.tx_ref}`
                        : `Campaign funding ${parsed.data.tx_ref}`,
                    reference: parsed.data.tx_ref,
                    providerReferenceText: `Prime ${parsed.data.tx_ref}`,
                    nonBlocking: true,
                });
                const chargeId = readTransactionReference(chargeResponse);
                const providerStatus = normalizeTransactionStatus(chargeResponse);
                if (!chargeId && !statusFailure.has(providerStatus)) {
                    throw new Error('YO Uganda did not return a transaction reference');
                }
                await client.query(`UPDATE pesapal_transactions
           SET raw_payload = COALESCE(raw_payload, '{}'::jsonb) || $2::jsonb
           WHERE merchant_reference=$1`, [
                    parsed.data.tx_ref,
                    JSON.stringify({
                        payment_method: parsed.data.payment_method,
                        network,
                        yo_transaction_reference: chargeId,
                        yo_last_provider_status: providerStatus,
                        yo_next_action: statusPending.has(providerStatus)
                            ? {
                                type: 'payment_instruction',
                                note: buildProviderMessage(chargeResponse) ??
                                    'Approve the payment prompt on the mobile money phone to continue.',
                            }
                            : null,
                    }),
                ]);
                if (statusSuccess.has(providerStatus)) {
                    await applyVerifiedCharge(client, {
                        transactionId: chargeId ?? parsed.data.tx_ref,
                        reference: parsed.data.tx_ref,
                        expectedProviderReference: chargeId,
                    }, chargeResponse);
                }
                else if (statusFailure.has(providerStatus)) {
                    await paymentRepo.updatePesaPalTxnStatus(client, parsed.data.tx_ref, 'FAILED', chargeId ?? undefined);
                }
                else {
                    await paymentRepo.updatePesaPalTxnStatus(client, parsed.data.tx_ref, 'PENDING', chargeId ?? undefined);
                }
                return buildChargeResponse(parsed.data.tx_ref, parsed.data.payment_method, chargeResponse);
            });
            const outcome = result;
            if (outcome?.error) {
                reply.code(outcome.error === 'forbidden'
                    ? 403
                    : outcome.error === 'txn_not_found'
                        ? 404
                        : 400);
                app.log.warn({
                    tx_ref: parsed.data.tx_ref,
                    payment_method: parsed.data.payment_method,
                    outcome,
                }, 'yo_initiate_rejected');
                return outcome;
            }
            app.log.info({
                tx_ref: parsed.data.tx_ref,
                payment_method: parsed.data.payment_method,
                charge_id: outcome.charge_id,
                provider_status: outcome.provider_status,
                instruction: outcome.instruction,
            }, 'yo_initiate_result');
            return outcome;
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            app.log.error({
                error,
                detail,
                body: request.body,
            }, `yo_initiate_failed: ${detail}`);
            reply.code(502);
            return { error: 'yo_uganda_initiate_failed', detail };
        }
    };
    const authorizePayment = async (request, reply) => {
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
    const verifyPayment = async (request, reply) => {
        const parsed = verifySchema.safeParse(request.body);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        try {
            const authUser = request.user?.sub;
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
                    return { error: 'missing_transaction_reference' };
                }
                return settlementReference;
            });
            if (!('transactionId' in verificationContext)) {
                reply.code(verificationContext.error === 'forbidden'
                    ? 403
                    : verificationContext.error === 'txn_not_found'
                        ? 404
                        : 400);
                return verificationContext;
            }
            const { result, verified } = await settleCharge({
                transactionId: verificationContext.transactionId,
                reference: txRef,
                expectedProviderReference: verificationContext.expectedProviderReference,
            });
            const verifiedStatus = normalizeTransactionStatus(verified);
            app.log.info({
                tx_ref: txRef,
                transaction_id: verificationContext.transactionId,
                verified_status: verifiedStatus,
                settlement_ok: result.ok,
                settlement_result: result,
                provider: compactProviderSnapshot(verified),
            }, 'yo_verify_result');
            if (!result.ok) {
                reply.code(result.error === 'txn_not_found' ? 404 : 400);
                return result;
            }
            return {
                ok: true,
                status: verifiedStatus,
                tx_ref: txRef,
                transaction_id: verificationContext.transactionId,
                result,
            };
        }
        catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            app.log.error({
                error,
                detail,
                body: request.body,
            }, `yo_verify_failed: ${detail}`);
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
        const query = request.query;
        const status = String(query?.status ?? '').toLowerCase();
        const paymentState = String(query?.payment ?? '').toLowerCase();
        const cancelled = status === 'cancelled' ||
            status === 'failed' ||
            status === 'error' ||
            paymentState === 'cancel';
        const txRef = readYoMerchantReference(query);
        if (txRef) {
            try {
                const settlementReference = await withTransaction(async (client) => {
                    const txn = await loadTransactionByReference(client, txRef);
                    if (!txn) {
                        return { error: 'txn_not_found' };
                    }
                    return resolveSettlementReference(txn, query) ?? {
                        error: 'missing_transaction_reference',
                    };
                });
                if ('error' in settlementReference) {
                    app.log.warn({ settlementReference, txRef, query }, 'yo_return_verification_skipped');
                }
                else {
                    await settleCharge({
                        transactionId: settlementReference.transactionId,
                        reference: txRef,
                        expectedProviderReference: settlementReference.expectedProviderReference,
                    });
                }
            }
            catch (error) {
                app.log.error({
                    error,
                    transaction_id: readYoProviderTransactionReference(query),
                    txRef,
                    status,
                    payment: paymentState,
                }, 'yo_return_verification_failed');
            }
        }
        reply.redirect(resolveBrowserTarget(request, cancelled ? '/payment/cancel' : '/payment/success') ?? (cancelled ? deepLinkCancel : deepLinkReturn));
    });
    app.get('/payments/cancel', async (request, reply) => {
        reply.redirect(resolveBrowserTarget(request, '/payment/cancel') ?? deepLinkCancel);
    });
}
