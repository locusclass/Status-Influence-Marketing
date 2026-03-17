import { fetch } from 'undici';
import crypto from 'crypto';
import { config } from '../config.js';
let cachedAccessToken = null;
function randomId() {
    return crypto.randomUUID();
}
function buildBaseUrl() {
    const configured = config.flutterwave.baseUrl.trim();
    if (configured) {
        return configured.replace(/\/+$/, '');
    }
    return 'https://developersandbox-api.flutterwave.com';
}
async function getAccessToken() {
    const now = Date.now();
    if (cachedAccessToken && cachedAccessToken.expiresAt > now + 30_000) {
        return cachedAccessToken.token;
    }
    const res = await fetch(`${buildBaseUrl()}/auth/token`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-Trace-Id': randomId(),
        },
        body: JSON.stringify({
            client_id: config.flutterwave.clientId,
            client_secret: config.flutterwave.clientSecret,
        }),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Flutterwave auth failed: ${res.status} ${text}`);
    }
    const body = (await res.json());
    const payload = (body.data ?? body);
    const token = String(payload.access_token ?? payload.token ?? '').trim();
    if (!token) {
        throw new Error('Flutterwave auth did not return an access token');
    }
    const expiresIn = Number(payload.expires_in ?? 3600);
    cachedAccessToken = {
        token,
        expiresAt: now + Math.max(60, expiresIn) * 1000,
    };
    return token;
}
async function flutterwaveRequest(path, init = {}) {
    const token = await getAccessToken();
    const res = await fetch(`${buildBaseUrl()}${path}`, {
        method: init.method ?? 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-Trace-Id': randomId(),
            ...(init.idempotencyKey
                ? { 'X-Idempotency-Key': init.idempotencyKey }
                : {}),
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
        provider: 'FLUTTERWAVE_V4',
        note: 'Flutterwave webhooks are configured from the dashboard.',
    };
}
export async function getIpnList() {
    return {
        ok: true,
        provider: 'FLUTTERWAVE_V4',
        note: 'Flutterwave webhook endpoints are managed from the dashboard.',
    };
}
export async function createCustomer(input) {
    return flutterwaveRequest('/customers', {
        method: 'POST',
        body: {
            name: input.name,
            email: input.email,
            phone_number: input.phoneNumber,
        },
        idempotencyKey: `customer:${input.email.toLowerCase()}`,
    });
}
export async function createMobileMoneyPaymentMethod(input) {
    return flutterwaveRequest('/payment-methods', {
        method: 'POST',
        body: {
            type: 'mobile_money',
            customer_id: input.customerId,
            mobile_money: {
                phone_number: input.phoneNumber,
                network: input.network,
                country: input.country,
            },
        },
        idempotencyKey: `pm:${input.customerId}:${input.phoneNumber}:${input.network}`,
    });
}
export async function createCharge(input) {
    return flutterwaveRequest('/charges', {
        method: 'POST',
        body: {
            amount: input.amount,
            currency: input.currency,
            customer_id: input.customerId,
            payment_method_id: input.paymentMethodId,
            reference: input.txRef,
            ...(input.redirectUrl ? { redirect_url: input.redirectUrl } : {}),
        },
        idempotencyKey: `charge:${input.txRef}`,
    });
}
export async function getTransactionStatus(transactionId, _merchantReference) {
    return flutterwaveRequest(`/charges/${encodeURIComponent(transactionId)}`);
}
export async function requestPayout(_input) {
    throw new Error('Flutterwave V4 payouts are not yet implemented in this build');
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
