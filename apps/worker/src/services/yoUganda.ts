import { fetch } from 'undici';
import { isDirectYoTaskUrl } from '@prime/shared';
import {
  config,
  resolveYoBaseUrl,
  resolveYoDirectFailoverBaseUrls,
} from '../config.js';

function normalizePhoneNumber(phoneNumber: string) {
  const digits = phoneNumber.replace(/[^\d]/g, '');
  if (!digits) {
    return '';
  }
  if (digits.startsWith('256')) {
    return digits;
  }
  if (digits.startsWith('0')) {
    return `256${digits.slice(1)}`;
  }
  return digits;
}

function resolveAccountProviderCode(network?: string) {
  const normalized = String(network ?? '').trim().toUpperCase();
  if (normalized === 'MTN') {
    return 'MTN_UGANDA';
  }
  if (normalized === 'AIRTEL') {
    return 'AIRTEL_UGANDA';
  }
  return undefined;
}

function failoverEndpoints() {
  return Array.from(
    new Set(
      resolveYoDirectFailoverBaseUrls().filter(
        (endpoint) => endpoint && endpoint !== resolveYoBaseUrl()
      )
    )
  );
}

function buildRequestXml(request: Record<string, string | number | null | undefined>) {
  const body = Object.entries(request)
    .filter(([, value]) => value != null && String(value).trim().length > 0)
    .map(([key, value]) => `<${key}>${String(value)}</${key}>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><AutoCreate><Request>${body}</Request></AutoCreate>`;
}

async function postXml(endpoint: string, body: string) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Accept: 'application/xml, text/xml, */*',
      'Content-Type': 'text/xml',
      'Content-transfer-encoding': 'text',
    },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`YO Uganda payout failed: ${res.status} ${text}`.trim());
  }

  return text;
}

function isGatewayFailoverError(error: unknown, endpoint: string) {
  if (!endpoint || isDirectYoTaskUrl(endpoint)) {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    /YO proxy request failed/i.test(message) ||
    /timeout of \d+ms exceeded/i.test(message) ||
    /fetch failed/i.test(message) ||
    /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|UND_ERR_)\b/i.test(
      message
    )
  );
}

export async function requestPayout(input: {
  amount: number;
  currency: string;
  narration: string;
  reference: string;
  receiverName: string;
  receiverPhone: string;
  receiverNetwork?: string;
}) {
  const body = buildRequestXml({
    Authorization: config.yo.authorizationCode,
    APIUsername: config.yo.apiUsername,
    APIPassword: config.yo.apiPassword,
    Method: 'acwithdrawfunds',
    NonBlocking: 'FALSE',
    Amount: input.amount,
    Account: normalizePhoneNumber(input.receiverPhone),
    AccountProviderCode: resolveAccountProviderCode(input.receiverNetwork),
    Narrative: input.narration,
    ExternalReference: input.reference,
    ProviderReferenceText: input.reference,
  });

  try {
    return await postXml(resolveYoBaseUrl(), body);
  } catch (error) {
    if (!isGatewayFailoverError(error, resolveYoBaseUrl())) {
      throw error;
    }

    let lastError: unknown = error;
    for (const endpoint of failoverEndpoints()) {
      try {
        return await postXml(endpoint, body);
      } catch (failoverError) {
        lastError = failoverError;
      }
    }

    throw lastError;
  }
}
