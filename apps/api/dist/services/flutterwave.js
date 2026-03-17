import { fetch } from 'undici';
import crypto from 'crypto';
import { config } from '../config.js';
function randomId() {
    return crypto.randomUUID();
}
function buildBaseUrl() {
    const configured = config.flutterwave.baseUrl.trim();
    if (configured) {
        return configured.replace(/\/+$/, '');
    }
    return 'https://api.flutterwave.com/v3';
}
function readCheckoutUrl(payload) {
    const candidates = [
        payload?.data?.link,
        payload?.data?.checkout_url,
        payload?.data?.checkoutLink,
        payload?.link,
        payload?.checkout_url,
        payload?.checkoutLink,
    ];
    for (const candidate of candidates) {
        const value = String(candidate ?? '').trim();
        if (value) {
            return value;
        }
    }
    return null;
}
async function flutterwaveRequest(path, init = {}) {
    const secretKey = config.flutterwave.secretKey.trim();
    if (!secretKey) {
        throw new Error('Flutterwave secret key is not configured');
    }
    const res = await fetch(`${buildBaseUrl()}${path}`, {
        method: init.method ?? 'GET',
        headers: {
            Authorization: `Bearer ${secretKey}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Trace-Id': randomId(),
            ...(init.idempotencyKey ? { 'X-Idempotency-Key': init.idempotencyKey } : {}),
        },
        ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Flutterwave request failed: ${res.status} ${text}`);
    }
    return (await res.json());
}
export async function registerIpnUrl() {
    return {
        ok: true,
        provider: 'FLUTTERWAVE_V3',
        note: 'Flutterwave webhooks are configured from the dashboard.',
    };
}
export async function getIpnList() {
    return {
        ok: true,
        provider: 'FLUTTERWAVE_V3',
        note: 'Flutterwave webhook endpoints are managed from the dashboard.',
    };
}
export async function createHostedPayment(input) {
    const response = await flutterwaveRequest('/payments', {
        method: 'POST',
        body: {
            tx_ref: input.txRef,
            amount: input.amount,
            currency: input.currency,
            redirect_url: input.redirectUrl,
            payment_options: input.paymentOptions ?? 'card,mobilemoneyuganda',
            customer: {
                email: input.customer.email,
                name: input.customer.name,
                ...(input.customer.phoneNumber
                    ? { phone_number: input.customer.phoneNumber }
                    : {}),
            },
            ...(input.customizations ? { customizations: input.customizations } : {}),
            ...(input.meta ? { meta: input.meta } : {}),
        },
        idempotencyKey: `hosted_payment:${input.txRef}`,
    });
    return {
        checkoutUrl: readCheckoutUrl(response),
        response,
    };
}
export async function verifyTransaction(transactionId) {
    return flutterwaveRequest(`/transactions/${encodeURIComponent(String(transactionId))}/verify`);
}
export async function requestPayout(input) {
    const secretKey = config.flutterwave.secretKey.trim();
    if (!secretKey) {
        throw new Error('Flutterwave transfer secret key is not configured');
    }
    const normalizedPhone = input.receiverPhone.replace(/[^\d]/g, '');
    const normalizedNetwork = (input.receiverNetwork ?? 'MTN').trim().toUpperCase();
    const res = await fetch(`${buildBaseUrl()}/transfers`, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${secretKey}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Trace-Id': randomId(),
        },
        body: JSON.stringify({
            account_bank: normalizedNetwork,
            account_number: normalizedPhone.startsWith('256')
                ? normalizedPhone
                : `256${normalizedPhone.replace(/^0+/, '')}`,
            amount: input.amount,
            narration: input.narration,
            currency: input.currency,
            reference: input.reference,
            debit_currency: input.currency,
            beneficiary_name: input.receiverName,
        }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Flutterwave transfer failed: ${res.status} ${text}`);
    }
    return (await res.json());
}
export function verifyWebhookSignature(rawBody, signature, secret) {
    if (!signature || !secret) {
        return false;
    }
    if (signature === secret) {
        return true;
    }
    const hmac = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
    if (signature === hmac) {
        return true;
    }
    const hex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return signature === hex;
}
