import { fetch } from 'undici';
import crypto from 'crypto';
import { config, hasFlutterwaveClientCredentials, resolveFlutterwaveBaseUrl, } from '../config.js';
let cachedAccessToken = null;
function randomId() {
    return crypto.randomUUID();
}
function normalizeNamePart(value, fallback) {
    const cleaned = (value ?? '')
        .replace(/[^A-Za-z ,.'-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (cleaned.length >= 2 && cleaned.length <= 50) {
        return cleaned;
    }
    return fallback;
}
function buildBaseUrl() {
    return resolveFlutterwaveBaseUrl();
}
async function getAccessToken() {
    if (!hasFlutterwaveClientCredentials()) {
        throw new Error('Flutterwave client credentials are not configured');
    }
    const now = Date.now();
    if (cachedAccessToken && cachedAccessToken.expiresAt > now + 30_000) {
        return cachedAccessToken.token;
    }
    const tokenEndpoint = 'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';
    const tokenRequestBody = new URLSearchParams({
        client_id: config.flutterwave.clientId,
        client_secret: config.flutterwave.clientSecret,
        grant_type: 'client_credentials',
    });
    const res = await fetch(tokenEndpoint, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'X-Trace-Id': randomId(),
        },
        body: tokenRequestBody.toString(),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Flutterwave auth failed: ${res.status} ${text}`);
    }
    const body = (await res.json());
    const tokenPayload = (body.data ?? body);
    const token = String(tokenPayload.access_token ?? tokenPayload.token ?? '').trim();
    if (!token) {
        throw new Error('Flutterwave auth did not return an access token');
    }
    const expiresIn = Number(tokenPayload.expires_in ?? 3600);
    cachedAccessToken = {
        token,
        expiresAt: now + Math.max(60, expiresIn) * 1000,
    };
    return token;
}
async function getRequestToken() {
    if (hasFlutterwaveClientCredentials()) {
        return getAccessToken();
    }
    const secretKey = config.flutterwave.secretKey.trim();
    if (secretKey) {
        return secretKey;
    }
    throw new Error('Flutterwave credentials are not configured');
}
async function flutterwaveRequest(path, init = {}) {
    const token = await getRequestToken();
    const res = await fetch(`${buildBaseUrl()}${path}`, {
        method: init.method ?? 'GET',
        headers: {
            Authorization: `Bearer ${token}`,
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
    const parts = input.name.trim().split(/\s+/).filter(Boolean);
    const first = normalizeNamePart(parts[0], 'Customer');
    const last = normalizeNamePart(parts.slice(1).join(' '), 'User');
    const normalizedPhone = (input.phoneNumber ?? '').replace(/[^\d]/g, '');
    return flutterwaveRequest('/customers', {
        method: 'POST',
        body: {
            email: input.email,
            name: {
                first,
                last,
            },
            ...(normalizedPhone
                ? {
                    phone: {
                        country_code: '256',
                        number: normalizedPhone.startsWith('256')
                            ? normalizedPhone.slice(3)
                            : normalizedPhone.replace(/^0+/, ''),
                    },
                }
                : {}),
        },
        idempotencyKey: `customer:${input.email.toLowerCase()}`,
    });
}
export async function createMobileMoneyPaymentMethod(input) {
    const normalizedPhone = input.phoneNumber.replace(/[^\d]/g, '');
    return flutterwaveRequest('/payment-methods', {
        method: 'POST',
        body: {
            type: 'mobile_money',
            mobile_money: {
                phone_number: normalizedPhone.startsWith(input.countryCode)
                    ? normalizedPhone.slice(input.countryCode.length)
                    : normalizedPhone.replace(/^0+/, ''),
                network: input.network,
                country_code: input.countryCode,
            },
        },
        idempotencyKey: `pm:${normalizedPhone}:${input.network}:${input.countryCode}`,
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
export async function verifyTransaction(transactionId) {
    return getTransactionStatus(String(transactionId));
}
export async function requestPayout(input) {
    const secretKey = config.flutterwave.secretKey.trim();
    if (!secretKey) {
        throw new Error('Flutterwave transfer secret key is not configured');
    }
    const normalizedPhone = input.receiverPhone.replace(/[^\d]/g, '');
    const normalizedNetwork = (input.receiverNetwork ?? 'MTN').trim().toUpperCase();
    const transferBaseUrl = buildBaseUrl().replace(/\/v\d+$/i, '');
    const res = await fetch(`${transferBaseUrl}/v3/transfers`, {
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
