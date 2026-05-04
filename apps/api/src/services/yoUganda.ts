import { fetch } from 'undici';
import crypto from 'crypto';
import { isDirectYoTaskUrl } from '@prime/shared';
import {
  config,
  hasYoCredentials,
  resolveYoBaseUrl,
  resolveYoDirectFailoverBaseUrls,
  resolveYoFallbackBaseUrl,
} from '../config.js';

export type YoPaymentResponse = {
  status: string;
  statusCode: number | null;
  statusMessage: string | null;
  errorMessage: string | null;
  transactionStatus: string | null;
  transactionReference: string | null;
  raw: Record<string, string>;
};

function xmlEscape(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlUnescape(value: string) {
  return value
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function uniqueEndpoints() {
  return Array.from(
    new Set([resolveYoBaseUrl(), resolveYoFallbackBaseUrl()].filter(Boolean))
  );
}

function directFailoverEndpoints() {
  return Array.from(
    new Set(
      resolveYoDirectFailoverBaseUrls().filter(
        (endpoint) => endpoint && !uniqueEndpoints().includes(endpoint)
      )
    )
  );
}

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

function buildTraceId() {
  return crypto.randomUUID();
}

export function buildYoRequestXml(
  request: Record<string, string | number | boolean | null | undefined>
) {
  const body = Object.entries(request)
    .filter(([, value]) => {
      if (value == null) {
        return false;
      }
      const text = String(value).trim();
      return text.length > 0;
    })
    .map(([key, value]) => {
      return `<${key}>${xmlEscape(String(value))}</${key}>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8"?><AutoCreate><Request>${body}</Request></AutoCreate>`;
}

export function parseYoResponseXml(xml: string): YoPaymentResponse {
  const responseMatch =
    xml.match(/<Response>([\s\S]*?)<\/Response>/i) ??
    xml.match(/<AutoCreate>([\s\S]*?)<\/AutoCreate>/i);
  const source = responseMatch?.[1] ?? xml;
  const raw: Record<string, string> = {};
  const pattern = /<([A-Za-z0-9_]+)>([\s\S]*?)<\/\1>/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source))) {
    const key = match[1];
    const rawValue = match[2];
    if (!key || rawValue == null) {
      continue;
    }
    const value = rawValue.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
    if (/<[A-Za-z]/.test(value)) {
      continue;
    }
    raw[key] = xmlUnescape(value);
  }

  const parseStatusCode = (value: string | undefined) => {
    if (!value) {
      return null;
    }
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  };

  return {
    status: raw.Status ?? '',
    statusCode: parseStatusCode(raw.StatusCode),
    statusMessage: raw.StatusMessage ?? null,
    errorMessage: raw.ErrorMessage ?? null,
    transactionStatus: raw.TransactionStatus ?? null,
    transactionReference: raw.TransactionReference ?? null,
    raw,
  };
}

function parseYoFormResponse(text: string): YoPaymentResponse {
  const params = new URLSearchParams(text);
  const raw: Record<string, string> = {};
  for (const [key, value] of params.entries()) {
    raw[key] = value;
  }
  const status = params.get('ybs_autocreate_status') ?? '';
  const returnCode = params.get('ybs_autocreate_returncode');
  const message = params.get('ybs_autocreate_message') ?? null;
  const txRef = params.get('ybs_autocreate_transactionreference') ?? null;
  const txStatus = params.get('ybs_autocreate_transactionstatus') ?? null;
  const parsedCode = returnCode != null ? Number.parseInt(returnCode, 10) : null;

  return {
    status,
    statusCode: parsedCode != null && Number.isFinite(parsedCode) ? parsedCode : null,
    statusMessage: status === 'ERROR' ? null : message,
    errorMessage: status === 'ERROR' ? message : null,
    transactionStatus: txStatus,
    transactionReference: txRef,
    raw,
  };
}

export function parseYoResponse(text: string): YoPaymentResponse {
  if (/ybs_autocreate_status/i.test(text)) {
    return parseYoFormResponse(text);
  }
  return parseYoResponseXml(text);
}

export function buildYoReferenceFields(input: {
  reference?: string;
  providerReferenceText?: string;
  linkedTransactionReference?: string;
}) {
  return {
    // YO only accepts InternalReference when linking to an existing YO transaction.
    InternalReference: input.linkedTransactionReference,
    ExternalReference: input.reference,
    ProviderReferenceText: input.providerReferenceText,
  };
}

function sanitizeResponseSnippet(text: string) {
  return text
    .slice(0, 300)
    .replace(/<(APIUsername|APIPassword|Authorization)>[\s\S]*?<\/\1>/gi, '<$1>[REDACTED]</$1>')
    .replace(/(APIUsername|APIPassword|Authorization)=[^&\s]*/gi, '$1=[REDACTED]');
}

function classifyYoNetworkError(message: string): string {
  if (/ECONNREFUSED/i.test(message)) {
    return 'YO payment proxy refused the connection — check proxy is running on port 3000.';
  }
  if (/EHOSTUNREACH/i.test(message)) {
    return 'YO payment proxy host is unreachable — check proxy IP and firewall rules.';
  }
  if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(message)) {
    return 'YO payment proxy connection timed out — proxy may be down or overloaded.';
  }
  if (/fetch failed|UND_ERR_/i.test(message)) {
    return 'YO payment proxy connection failed — verify proxy is reachable from Railway.';
  }
  return message;
}

async function postYoRequest(
  endpoint: string,
  fields: Record<string, string>
) {
  const proxyMode = !isDirectYoTaskUrl(endpoint);

  // Map PascalCase fields to lowercase fields expected by YO/proxy in form-encoded mode
  const formBody = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    let mappedKey = key.toLowerCase();
    if (key === 'APIUsername') mappedKey = 'username';
    if (key === 'APIPassword') mappedKey = 'password';
    if (key === 'ExternalReference') mappedKey = 'external_reference';
    if (key === 'InternalReference') mappedKey = 'internal_reference';
    if (key === 'ProviderReferenceText') mappedKey = 'provider_reference_text';
    if (key === 'AccountProviderCode') mappedKey = 'account_provider_code';
    if (key === 'NonBlocking') mappedKey = 'non_blocking';

    // Map Authorization to lowercase 'authorization'
    if (key === 'Authorization') mappedKey = 'authorization';

    formBody.append(mappedKey, value);
  }

  const bodyKeys = Array.from(formBody.keys());
  console.info(
    `[YO] → POST ${endpoint} proxyMode=${proxyMode} bodyKeys=[${bodyKeys.join(',')}]`
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let res: any;
  let text: string;

  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/x-www-form-urlencoded, text/xml, */*',
        'X-Trace-Id': buildTraceId(),
      },
      body: formBody,
    });
    text = await res.text();
  } catch (fetchError) {
    const msg = fetchError instanceof Error ? fetchError.message : String(fetchError ?? '');
    console.error(`[YO] ✗ fetch error endpoint=${endpoint} error=${msg}`);
    throw new Error(classifyYoNetworkError(msg));
  }

  const snippet = sanitizeResponseSnippet(text);
  console.info(`[YO] ← status=${res.status} ok=${res.ok} snippet=${JSON.stringify(snippet)}`);

  if (!res.ok) {
    // For 5xx proxy errors extract the details field for failover classification.
    // For other errors keep the full status+body so callers see the real cause.
    if (res.status >= 500) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        const detail = String(parsed.details ?? parsed.error ?? '');
        if (detail) throw new Error(classifyYoNetworkError(detail));
      } catch (inner) {
        if (inner instanceof Error && !/JSON|SyntaxError/i.test(inner.message)) throw inner;
      }
    }
    throw new Error(`YO Uganda request failed: ${res.status} ${text.slice(0, 200)}`.trim());
  }

  if (!text.trim()) {
    throw new Error(`YO Uganda request failed: ${res.status} empty response`);
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
    /YO payment proxy/i.test(message) ||
    /timeout of \d+ms exceeded/i.test(message) ||
    /fetch failed/i.test(message) ||
    /\b(?:ETIMEDOUT|ECONNRESET|ECONNREFUSED|EHOSTUNREACH|UND_ERR_)\b/i.test(message)
  );
}

async function yoRequest(
  request: Record<string, string | number | boolean | null | undefined>
) {
  if (!hasYoCredentials()) {
    throw new Error('YO Uganda API credentials are not configured');
  }

  const fields: Record<string, string> = {};
  const combined: Record<string, string | number | boolean | null | undefined> = {
    Authorization: config.yo.authorizationCode,
    APIUsername: config.yo.apiUsername,
    APIPassword: config.yo.apiPassword,
    ...request,
  };
  for (const [key, value] of Object.entries(combined)) {
    if (value != null && String(value).trim()) {
      fields[key] = String(value);
    }
  }

  const endpoints = uniqueEndpoints();
  const failoverEndpoints = directFailoverEndpoints();
  let lastError: unknown = null;
  let shouldTryDirectFailover = false;

  for (const endpoint of endpoints) {
    try {
      const responseText = await postYoRequest(endpoint, fields);
      return parseYoResponse(responseText);
    } catch (error) {
      if (isGatewayFailoverError(error, endpoint)) {
        shouldTryDirectFailover = true;
      }
      lastError = error;
    }
  }

  if (shouldTryDirectFailover) {
    for (const endpoint of failoverEndpoints) {
      try {
        const responseText = await postYoRequest(endpoint, fields);
        return parseYoResponse(responseText);
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('YO Uganda request failed');
}

export async function initiateMobileMoneyCollection(input: {
  amount: number;
  phoneNumber: string;
  narrative: string;
  reference?: string;
  providerReferenceText?: string;
  linkedTransactionReference?: string;
  network?: 'MTN' | 'AIRTEL' | 'M-PESA';
  nonBlocking?: boolean;
}) {
  return yoRequest({
    Method: 'acdepositfunds',
    NonBlocking: input.nonBlocking === false ? 'FALSE' : 'TRUE',
    Amount: input.amount,
    Account: normalizePhoneNumber(input.phoneNumber),
    AccountProviderCode: resolveAccountProviderCode(input.network),
    Narrative: input.narrative,
    ...buildYoReferenceFields({
      reference: input.reference,
      providerReferenceText: input.providerReferenceText,
      linkedTransactionReference: input.linkedTransactionReference,
    }),
  });
}

export async function getTransactionStatus(
  transactionId: string,
  _merchantReference?: string
) {
  return yoRequest({
    Method: 'actransactioncheckstatus',
    TransactionReference: transactionId,
  });
}

export async function verifyTransaction(transactionId: string | number) {
  return getTransactionStatus(String(transactionId));
}

export async function requestPayout(input: {
  amount: number;
  currency: string;
  narration: string;
  reference: string;
  linkedTransactionReference?: string;
  providerReferenceText?: string;
  receiverName: string;
  receiverPhone: string;
  receiverNetwork?: string;
  nonBlocking?: boolean;
}) {
  return yoRequest({
    Method: 'acwithdrawfunds',
    NonBlocking: input.nonBlocking === true ? 'TRUE' : 'FALSE',
    Amount: input.amount,
    Account: normalizePhoneNumber(input.receiverPhone),
    AccountProviderCode: resolveAccountProviderCode(input.receiverNetwork),
    Narrative: input.narration,
    ...buildYoReferenceFields({
      reference: input.reference,
      providerReferenceText: input.providerReferenceText ?? input.reference,
      linkedTransactionReference: input.linkedTransactionReference,
    }),
  });
}

export function verifyWebhookSignature(
  rawBody: string,
  signature: string,
  secret: string
): boolean {
  if (!signature || !secret) {
    return false;
  }
  if (signature === secret) {
    return true;
  }

  const hmac = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('base64');
  if (signature === hmac) {
    return true;
  }

  const hex = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return signature === hex;
}
