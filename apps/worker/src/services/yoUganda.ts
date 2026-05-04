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

async function postYoRequest(endpoint: string, fields: Record<string, string>) {
  const proxyMode = !isDirectYoTaskUrl(endpoint);

  const formBody = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    formBody.append(key, value);
  }

  const bodyKeys = Array.from(formBody.keys());
  const hasAuthorization = bodyKeys.includes('Authorization');

  console.info(
    `[YO] → POST ${endpoint} proxyMode=${proxyMode} bodyKeys=[${bodyKeys.join(',')}] hasAuthorization=${hasAuthorization}`
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/x-www-form-urlencoded, text/xml, */*',
    },
    body: formBody.toString(),
  });

  const text = await res.text();
  console.info(`[YO] ← status=${res.status} ok=${res.ok} snippet=${JSON.stringify(text.slice(0, 100))}`);

  if (!res.ok) {
    let detail = text.slice(0, 300);
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      detail = String(parsed.details ?? parsed.error ?? detail);
    } catch {
      // not JSON
    }
    throw new Error(`YO Uganda payout failed: ${detail}`.trim());
  }

  return text;
}

function isGatewayFailoverError(error: unknown, endpoint: string) {
  if (!endpoint || isDirectYoTaskUrl(endpoint)) {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    /YO proxy (request failed|error)/i.test(message) ||
    /timeout of \d+ms exceeded/i.test(message) ||
    /fetch failed/i.test(message) ||
    /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|UND_ERR_)\b/i.test(message)
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
  const fields: Record<string, string> = {};
  const raw: Record<string, string | number | null | undefined> = {
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
  };
  for (const [key, value] of Object.entries(raw)) {
    if (value != null && String(value).trim()) {
      fields[key] = String(value);
    }
  }

  try {
    return await postYoRequest(resolveYoBaseUrl(), fields);
  } catch (error) {
    if (!isGatewayFailoverError(error, resolveYoBaseUrl())) {
      throw error;
    }

    let lastError: unknown = error;
    for (const endpoint of failoverEndpoints()) {
      try {
        return await postYoRequest(endpoint, fields);
      } catch (failoverError) {
        lastError = failoverError;
      }
    }

    throw lastError;
  }
}
