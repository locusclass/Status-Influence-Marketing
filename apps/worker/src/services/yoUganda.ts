import { fetch } from 'undici';
import { config, resolveYoBaseUrl } from '../config.js';

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

function buildRequestXml(request: Record<string, string | number | null | undefined>) {
  const body = Object.entries(request)
    .filter(([, value]) => value != null && String(value).trim().length > 0)
    .map(([key, value]) => `<${key}>${String(value)}</${key}>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><AutoCreate><Request>${body}</Request></AutoCreate>`;
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
  const res = await fetch(resolveYoBaseUrl(), {
    method: 'POST',
    headers: {
      Accept: 'application/xml, text/xml, */*',
      'Content-Type': 'text/xml',
      'Content-transfer-encoding': 'text',
    },
    body: buildRequestXml({
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
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`YO Uganda payout failed: ${res.status} ${text}`);
  }

  return res.text();
}
