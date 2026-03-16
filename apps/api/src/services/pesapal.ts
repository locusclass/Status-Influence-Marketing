import { fetch } from 'undici';
import crypto from 'crypto';
import { config } from '../config.js';

function getAuthHeaders() {
  return {
    Authorization: `Bearer ${config.flutterwave.secretKey}`,
    'Content-Type': 'application/json',
  };
}

export async function registerIpnUrl(): Promise<any> {
  return {
    ok: true,
    provider: 'FLUTTERWAVE',
    note: 'Flutterwave webhooks are configured from the dashboard.',
  };
}

export async function getIpnList(): Promise<any> {
  return {
    ok: true,
    provider: 'FLUTTERWAVE',
    note: 'Flutterwave webhook endpoints are managed from the dashboard.',
  };
}

export async function submitOrder(input: {
  amount: number;
  description: string;
  type: 'MERCHANT';
  reference: string;
  firstName: string;
  lastName: string;
  email: string;
  currency: string;
  callback_url: string;
  cancellation_url: string;
}) {
  const res = await fetch(`${config.flutterwave.baseUrl}/payments`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      tx_ref: input.reference,
      amount: input.amount,
      currency: input.currency,
      redirect_url: input.callback_url,
      customer: {
        email: input.email,
        name: `${input.firstName} ${input.lastName}`.trim(),
      },
      customizations: {
        title: 'Prime Checkout',
        description: input.description,
      },
      meta: {
        cancellation_url: input.cancellation_url,
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Flutterwave checkout failed: ${res.status} ${text}`);
  }

  return res.json();
}

export function buildInlinePayloadHash(input: {
  amount: number;
  currency: string;
  customerEmail: string;
  txRef: string;
}) {
  const hashedSecret = crypto
    .createHash('sha256')
    .update(config.flutterwave.secretKey)
    .digest('hex');
  return crypto
    .createHash('sha256')
    .update(
      `${input.amount}${input.currency}${input.customerEmail}${input.txRef}${hashedSecret}`
    )
    .digest('hex');
}

export async function getTransactionStatus(transactionId: string, _merchantReference?: string) {
  const res = await fetch(
    `${config.flutterwave.baseUrl}/transactions/${encodeURIComponent(transactionId)}/verify`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${config.flutterwave.secretKey}`,
      },
    }
  );

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Flutterwave verify failed: ${res.status} ${text}`);
  }

  return res.json();
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
  const res = await fetch(`${config.flutterwave.baseUrl}/transfers`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: JSON.stringify({
      account_bank: (input.receiverNetwork ?? 'MTN').trim().toUpperCase(),
      account_number: input.receiverPhone,
      amount: input.amount,
      narration: input.narration,
      currency: input.currency,
      reference: input.reference,
      debit_currency: input.currency,
      beneficiary_name: input.receiverName,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Flutterwave transfer failed: ${res.status} ${text}`);
  }

  return res.json();
}

export function verifyWebhookSignature(rawBody: string, signature: string, secret: string): boolean {
  if (!signature || !secret) {
    return false;
  }
  if (signature === secret) {
    return true;
  }

  const hmac = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  if (signature === hmac) {
    return true;
  }

  const hex = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return signature === hex;
}
