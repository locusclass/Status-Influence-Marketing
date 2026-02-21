import { fetch } from 'undici';
import { config } from '../config.js';
let cachedToken = null;
async function getToken() {
    if (cachedToken && Date.now() < cachedToken.expiresAt - 30_000) {
        return cachedToken.token;
    }
    const res = await fetch(`${config.pesapal.baseUrl}/api/Auth/RequestToken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            consumer_key: config.pesapal.consumerKey,
            consumer_secret: config.pesapal.consumerSecret
        })
    });
    if (!res.ok)
        throw new Error(`PesaPal token error: ${res.status}`);
    const data = (await res.json());
    cachedToken = { token: data.token, expiresAt: Date.now() + data.expires_in * 1000 };
    return data.token;
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
