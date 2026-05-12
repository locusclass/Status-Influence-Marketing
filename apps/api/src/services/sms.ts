import { fetch } from 'undici';
import { config, hasAfricaTalkingCredentials } from '../config.js';

export const AFRICAS_TALKING_SMS_PROVIDER = 'AFRICAS_TALKING' as const;

export type SmsProviderStatus = 'SENT' | 'FAILED' | 'SKIPPED';

export type AfricaTalkingHttpResponse = {
  httpStatus: number;
  body: unknown;
  rawText: string;
  recipient: Record<string, unknown> | null;
};

export type AfricaTalkingSmsResult = {
  ok: boolean;
  provider: typeof AFRICAS_TALKING_SMS_PROVIDER;
  providerStatus: SmsProviderStatus;
  normalizedPhone: string | null;
  response: AfricaTalkingHttpResponse | null;
  error: string | null;
};

type AfricaTalkingSmsRequest = {
  phone: string;
  message: string;
  senderId?: string | null;
  enqueue?: boolean;
};

function safeParseJson(value: string) {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readRecipient(
  payload: Record<string, unknown> | null
): Record<string, unknown> | null {
  const recipients = payload?.SMSMessageData;
  if (!recipients || typeof recipients !== 'object') {
    return null;
  }
  const list = Array.isArray((recipients as Record<string, unknown>).Recipients)
    ? ((recipients as Record<string, unknown>).Recipients as Array<unknown>)
    : [];
  const first = list[0];
  return first && typeof first === 'object'
    ? (first as Record<string, unknown>)
    : null;
}

function isRecipientSuccess(recipient: Record<string, unknown> | null) {
  const status = String(recipient?.status ?? '').trim().toLowerCase();
  const statusCode = Number(recipient?.statusCode ?? Number.NaN);
  return (
    status === 'success' ||
    status === 'sent' ||
    (Number.isFinite(statusCode) && statusCode >= 100 && statusCode < 200)
  );
}

function readProviderMessage(payload: Record<string, unknown> | null) {
  const data = payload?.SMSMessageData;
  if (!data || typeof data !== 'object') {
    return null;
  }
  const message = String((data as Record<string, unknown>).Message ?? '').trim();
  return message.length > 0 ? message : null;
}

function isInvalidSenderIdMessage(message: string | null) {
  return String(message ?? '').trim().toLowerCase() === 'invalidsenderid';
}

async function performAfricaTalkingRequest(
  form: URLSearchParams,
  normalizedPhone: string
) {
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
    providerStatus: ok ? ('SENT' as const) : ('FAILED' as const),
    normalizedPhone,
    response: {
      httpStatus: response.status,
      body: payload ?? { raw: rawText },
      rawText,
      recipient,
    },
    error:
      ok
        ? null
        : String(
            recipient?.status ??
              providerMessage ??
              (payload?.error as string | undefined) ??
              `africas_talking_http_${response.status}`
          ),
  };
}

export function isAfricaTalkingSandbox() {
  return config.africaTalking.environment === 'sandbox';
}

export function normalizeUgandaPhoneNumber(phone: string) {
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

export async function sendAfricaTalkingSms(
  input: AfricaTalkingSmsRequest
): Promise<AfricaTalkingSmsResult> {
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

  const senderId = String(
    input.senderId ?? config.africaTalking.senderId ?? ''
  ).trim();
  const canUseSenderId = senderId && !isAfricaTalkingSandbox();
  if (canUseSenderId) form.set('from', senderId);

  try {
    const firstAttempt = await performAfricaTalkingRequest(form, normalizedPhone);
    if (
      !firstAttempt.ok &&
      canUseSenderId &&
      isInvalidSenderIdMessage(firstAttempt.error)
    ) {
      form.delete('from');
      return performAfricaTalkingRequest(form, normalizedPhone);
    }
    return firstAttempt;
  } catch (error) {
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
