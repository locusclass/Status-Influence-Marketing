import { fetch } from 'undici';
import { config, hasAfricaTalkingCredentials } from '../config.js';
export const AFRICAS_TALKING_SMS_PROVIDER = 'AFRICAS_TALKING';
function safeParseJson(value) {
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
}
function readRecipient(payload) {
    const recipients = payload?.SMSMessageData;
    if (!recipients || typeof recipients !== 'object') {
        return null;
    }
    const list = Array.isArray(recipients.Recipients)
        ? recipients.Recipients
        : [];
    const first = list[0];
    return first && typeof first === 'object'
        ? first
        : null;
}
function isRecipientSuccess(recipient) {
    const status = String(recipient?.status ?? '').trim().toLowerCase();
    const statusCode = Number(recipient?.statusCode ?? Number.NaN);
    return (status === 'success' ||
        status === 'sent' ||
        (Number.isFinite(statusCode) && statusCode >= 100 && statusCode < 200));
}
export function isAfricaTalkingSandbox() {
    return config.africaTalking.environment === 'sandbox';
}
export function normalizeUgandaPhoneNumber(phone) {
    const trimmed = String(phone ?? '').trim();
    if (!trimmed) {
        return null;
    }
    const cleaned = trimmed.replace(/[^\d+]/g, '');
    if (/^\+2567\d{8}$/.test(cleaned)) {
        return cleaned;
    }
    const digits = cleaned.replace(/\D/g, '');
    if (/^07\d{8}$/.test(digits)) {
        return `+256${digits.slice(1)}`;
    }
    if (/^2567\d{8}$/.test(digits)) {
        return `+${digits}`;
    }
    if (/^7\d{8}$/.test(digits)) {
        return `+256${digits}`;
    }
    return null;
}
export async function sendAfricaTalkingSms(input) {
    const normalizedPhone = normalizeUgandaPhoneNumber(input.phone);
    if (!normalizedPhone) {
        return {
            ok: false,
            provider: AFRICAS_TALKING_SMS_PROVIDER,
            providerStatus: 'FAILED',
            normalizedPhone: null,
            response: null,
            error: 'invalid_uganda_phone_number',
        };
    }
    if (!hasAfricaTalkingCredentials()) {
        return {
            ok: false,
            provider: AFRICAS_TALKING_SMS_PROVIDER,
            providerStatus: 'SKIPPED',
            normalizedPhone,
            response: null,
            error: 'africas_talking_not_configured',
        };
    }
    const form = new URLSearchParams();
    form.set('username', config.africaTalking.username);
    form.set('to', normalizedPhone);
    form.set('message', String(input.message ?? '').trim());
    if (input.enqueue === true) {
        form.set('enqueue', '1');
    }
    const senderId = String(input.senderId ?? config.africaTalking.senderId ?? '').trim();
    if (senderId && !isAfricaTalkingSandbox()) {
        form.set('from', senderId);
    }
    try {
        const response = await fetch(config.africaTalking.baseUrl, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/x-www-form-urlencoded',
                apiKey: config.africaTalking.apiKey,
            },
            body: form.toString(),
            signal: AbortSignal.timeout(10_000),
        });
        const rawText = await response.text();
        const payload = safeParseJson(rawText);
        const recipient = readRecipient(payload);
        const ok = response.ok && isRecipientSuccess(recipient);
        return {
            ok,
            provider: AFRICAS_TALKING_SMS_PROVIDER,
            providerStatus: ok ? 'SENT' : 'FAILED',
            normalizedPhone,
            response: {
                httpStatus: response.status,
                body: payload ?? { raw: rawText },
                rawText,
                recipient,
            },
            error: ok
                ? null
                : String(recipient?.status ??
                    payload?.error ??
                    `africas_talking_http_${response.status}`),
        };
    }
    catch (error) {
        return {
            ok: false,
            provider: AFRICAS_TALKING_SMS_PROVIDER,
            providerStatus: 'FAILED',
            normalizedPhone,
            response: null,
            error: error instanceof Error ? error.message : 'africas_talking_request_failed',
        };
    }
}
