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

export function isAfricaTalkingSandbox() {
  return config.africaTalking.environment === 'sandbox';
}

export function normalizeUgandaPhoneNumber(phone: string) {
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
      error:
        ok
          ? null
          : String(
              recipient?.status ??
                (payload?.error as string | undefined) ??
                `africas_talking_http_${response.status}`
            ),
    };
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
