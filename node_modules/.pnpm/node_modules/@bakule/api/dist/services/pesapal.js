import { fetch } from 'undici';
import crypto from 'crypto';
import { config } from '../config.js';
let cachedToken = null;
async function getToken() {
    if (cachedToken && Date.now() < cachedToken.expiresAt - 30_000) {
        return cachedToken.token;
    }
    const res = await fetch(`${config.pesapal.baseUrl}/api/Auth/RequestToken`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            consumer_key: config.pesapal.consumerKey,
            consumer_secret: config.pesapal.consumerSecret
        })
    });
    if (!res.ok) {
        throw new Error(`PesaPal token error: ${res.status}`);
    }
    const data = (await res.json());
    cachedToken = { token: data.token, expiresAt: Date.now() + data.expires_in * 1000 };
    return data.token;
}
export async function registerIpnUrl() {
    const token = await getToken();
    const res = await fetch(`${config.pesapal.baseUrl}/api/URLSetup/RegisterIPN`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            url: config.pesapal.callbackUrl,
            ipn_notification_type: 'POST'
        })
    });
    if (!res.ok)
        throw new Error(`PesaPal IPN register failed: ${res.status}`);
    return res.json();
}
export async function submitOrder(input) {
    const token = await getToken();
    const res = await fetch(`${config.pesapal.baseUrl}/api/Transactions/SubmitOrderRequest`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            id: input.reference,
            currency: input.currency,
            amount: input.amount,
            description: input.description,
            callback_url: input.callback_url,
            cancellation_url: input.cancellation_url,
            notification_id: config.pesapal.ipnId,
            billing_address: {
                email_address: input.email,
                first_name: input.firstName,
                last_name: input.lastName
            }
        })
    });
    if (!res.ok)
        throw new Error(`PesaPal submit order failed: ${res.status}`);
    return res.json();
}
export async function getTransactionStatus(orderTrackingId, merchantReference) {
    const token = await getToken();
    const url = `${config.pesapal.baseUrl}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(orderTrackingId)}&merchantReference=${encodeURIComponent(merchantReference)}`;
    const res = await fetch(url, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`
        }
    });
    if (!res.ok)
        throw new Error(`PesaPal status failed: ${res.status}`);
    return res.json();
}
export async function requestPayout(input) {
    const token = await getToken();
    const res = await fetch(`${config.pesapal.baseUrl}/api/Transactions/SubmitB2C`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            amount: input.amount,
            currency: input.currency,
            narration: input.narration,
            source: 'MERCHANT',
            reference: input.reference,
            callback_url: config.pesapal.payoutCallbackUrl,
            receiver: {
                name: input.receiverName,
                phone_number: input.receiverPhone
            }
        })
    });
    if (!res.ok)
        throw new Error(`PesaPal payout failed: ${res.status}`);
    return res.json();
}
export function verifyWebhookSignature(rawBody, signature, secret) {
    const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}
