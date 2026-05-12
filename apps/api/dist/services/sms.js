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
function readProviderMessage(payload) {
    const data = payload?.SMSMessageData;
    if (!data || typeof data !== 'object') {
        return null;
    }
    const message = String(data.Message ?? '').trim();
    return message.length > 0 ? message : null;
}
function isInvalidSenderIdMessage(message) {
    return String(message ?? '').trim().toLowerCase() === 'invalidsenderid';
}
async function performAfricaTalkingRequest(form, normalizedPhone) {
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
    const providerMessage = readProviderMessage(payload);
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
                providerMessage ??
                payload?.error ??
                `africas_talking_http_${response.status}`),
    };
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
    if (/^\+256[37]\d{8}$/.test(cleaned)) {
        return cleaned;
    }
    const digits = cleaned.replace(/\D/g, '');
    if (/^0[37]\d{8}$/.test(digits)) {
        return `+256${digits.slice(1)}`;
    }
    if (/^256[37]\d{8}$/.test(digits)) {
        return `+${digits}`;
    }
    if (/^00256[37]\d{8}$/.test(digits)) {
        return `+${digits.slice(2)}`;
    }
    if (/^[37]\d{8}$/.test(digits)) {
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
    const canUseSenderId = senderId && !isAfricaTalkingSandbox();
    if (canUseSenderId)
        form.set('from', senderId);
    try {
        const firstAttempt = await performAfricaTalkingRequest(form, normalizedPhone);
        if (!firstAttempt.ok &&
            canUseSenderId &&
            isInvalidSenderIdMessage(firstAttempt.error)) {
            form.delete('from');
            return performAfricaTalkingRequest(form, normalizedPhone);
        }
        return firstAttempt;
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
