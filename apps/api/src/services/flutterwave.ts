import { fetch } from 'undici';
import crypto from 'crypto';
import {
  config,
  hasFlutterwaveSecretKey,
  hasFlutterwaveClientCredentials,
  resolveFlutterwaveBaseUrl,
} from '../config.js';

let cachedAccessToken: { token: string; expiresAt: number } | null = null;

function randomId() {
  return crypto.randomUUID();
}

function normalizeNamePart(value: string | undefined, fallback: string) {
  const cleaned = (value ?? '')
    .replace(/[^A-Za-z ,.'-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length >= 2 && cleaned.length <= 50) {
    return cleaned;
  }

  return fallback;
}

function buildBaseUrl() {
  return resolveFlutterwaveBaseUrl();
}

function randomNonce(length = 12) {
  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(length);
  let nonce = '';
  for (let index = 0; index < length; index += 1) {
    nonce += alphabet[(bytes[index] ?? 0) % alphabet.length];
  }
  return nonce;
}

async function encryptFlutterwaveValue(value: string, nonce: string) {
  const encryptionKey = config.flutterwave.encryptionKey.trim();
  if (!encryptionKey) {
    throw new Error(
      'Flutterwave card payments require FLUTTERWAVE_ENCRYPTION_KEY.'
    );
  }
  if (nonce.length !== 12) {
    throw new Error('Flutterwave encryption nonce must be exactly 12 characters.');
  }

  const keyBytes = Buffer.from(encryptionKey, 'base64');
  if (keyBytes.length === 0) {
    throw new Error('FLUTTERWAVE_ENCRYPTION_KEY must be base64 encoded.');
  }

  const cryptoSubtle =
    globalThis.crypto?.subtle ?? crypto.webcrypto?.subtle;
  if (!cryptoSubtle) {
    throw new Error('Crypto API is not available in this environment.');
  }

  const key = await cryptoSubtle.importKey(
    'raw',
    keyBytes,
    { name: 'AES-GCM' },
    false,
    ['encrypt']
  );
  const encrypted = await cryptoSubtle.encrypt(
    {
      name: 'AES-GCM',
      iv: Buffer.from(nonce),
    },
    key,
    Buffer.from(value)
  );
  return Buffer.from(encrypted).toString('base64');
}

async function encryptFlutterwaveFields(
  fields: Record<string, string>,
  nonce = randomNonce()
) {
  const encryptedEntries = await Promise.all(
    Object.entries(fields).map(async ([key, value]) => {
      return [key, await encryptFlutterwaveValue(value, nonce)] as const;
    })
  );

  return {
    nonce,
    ...Object.fromEntries(encryptedEntries),
  };
}

function resolvePhonePayload(
  phoneNumber: string | undefined,
  phoneCountryCode: string | undefined
) {
  const normalizedPhone = (phoneNumber ?? '').replace(/[^\d]/g, '');
  const normalizedCountryCode = (phoneCountryCode ?? '').replace(/[^\d]/g, '');
  if (!normalizedPhone || !normalizedCountryCode) {
    return null;
  }

  return {
    country_code: normalizedCountryCode,
    number: normalizedPhone.startsWith(normalizedCountryCode)
      ? normalizedPhone.slice(normalizedCountryCode.length)
      : normalizedPhone.replace(/^0+/, ''),
  };
}

function readCheckoutUrl(payload: Record<string, any>) {
  const candidates = [
    payload?.data?.link,
    payload?.data?.checkout_url,
    payload?.data?.checkoutLink,
    payload?.link,
    payload?.checkout_url,
    payload?.checkoutLink,
  ];

  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim();
    if (value) {
      return value;
    }
  }

  return null;
}

export function isHostedCheckoutCompatibilityError(detail: string) {
  return detail.includes(
    'Flutterwave hosted checkout is using the v3 /payments API'
  );
}

async function getAccessToken() {
  if (!hasFlutterwaveClientCredentials()) {
    throw new Error('Flutterwave client credentials are not configured');
  }

  const now = Date.now();
  if (cachedAccessToken && cachedAccessToken.expiresAt > now + 30_000) {
    return cachedAccessToken.token;
  }

  const tokenEndpoint =
    'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';
  const tokenRequestBody = new URLSearchParams({
    client_id: config.flutterwave.clientId,
    client_secret: config.flutterwave.clientSecret,
    grant_type: 'client_credentials',
  });

  const res = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
      'X-Trace-Id': randomId(),
    },
    body: tokenRequestBody.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Flutterwave auth failed: ${res.status} ${text}`);
  }

  const body = (await res.json()) as Record<string, any>;
  const tokenPayload = (body.data ?? body) as Record<string, any>;
  const token = String(tokenPayload.access_token ?? tokenPayload.token ?? '').trim();
  if (!token) {
    throw new Error('Flutterwave auth did not return an access token');
  }

  const expiresIn = Number(tokenPayload.expires_in ?? 3600);
  cachedAccessToken = {
    token,
    expiresAt: now + Math.max(60, expiresIn) * 1000,
  };
  return token;
}

async function getRequestToken() {
  const secretKey = config.flutterwave.secretKey.trim();
  if (secretKey) {
    return secretKey;
  }

  if (hasFlutterwaveClientCredentials()) {
    return getAccessToken();
  }

  throw new Error('Flutterwave credentials are not configured');
}

async function flutterwaveRequest<T>(
  path: string,
  init: {
    method?: 'GET' | 'POST' | 'PUT';
    body?: Record<string, any>;
    idempotencyKey?: string;
  } = {}
) {
  const token = await getRequestToken();
  const res = await fetch(`${buildBaseUrl()}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Trace-Id': randomId(),
      ...(init.idempotencyKey ? { 'X-Idempotency-Key': init.idempotencyKey } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Flutterwave request failed: ${res.status} ${text}`);
  }

  return (await res.json()) as T;
}

export async function registerIpnUrl(): Promise<any> {
  return {
    ok: true,
    provider: 'FLUTTERWAVE_V4',
    note: 'Flutterwave webhooks are configured from the dashboard.',
  };
}

export async function getIpnList(): Promise<any> {
  return {
    ok: true,
    provider: 'FLUTTERWAVE_V4',
    note: 'Flutterwave webhook endpoints are managed from the dashboard.',
  };
}

export async function createHostedPayment(input: {
  txRef: string;
  amount: number;
  currency: string;
  redirectUrl: string;
  paymentOptions?: string;
  customer: {
    email: string;
    name: string;
    phoneNumber?: string;
  };
  customizations?: {
    title?: string;
    description?: string;
    logo?: string;
  };
  meta?: Record<string, any>;
}) {
  if (!hasFlutterwaveSecretKey() && hasFlutterwaveClientCredentials()) {
    throw new Error(
      'Flutterwave hosted checkout is using the v3 /payments API, but this server is configured for v4 client-credential flow. Switch to a v3 secret key for hosted checkout or replace this path with a true v4 payment-method/charge flow.'
    );
  }

  const response = await flutterwaveRequest<Record<string, any>>('/payments', {
    method: 'POST',
    body: {
      tx_ref: input.txRef,
      amount: input.amount,
      currency: input.currency,
      redirect_url: input.redirectUrl,
      payment_options: input.paymentOptions ?? 'card,mobilemoneyuganda',
      customer: {
        email: input.customer.email,
        name: input.customer.name,
        ...(input.customer.phoneNumber
          ? { phone_number: input.customer.phoneNumber }
          : {}),
      },
      ...(input.customizations ? { customizations: input.customizations } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
    },
    idempotencyKey: `hosted_payment:${input.txRef}`,
  });

  return {
    checkoutUrl: readCheckoutUrl(response),
    response,
  };
}

export async function createCustomer(input: {
  email: string;
  name: string;
  phoneNumber?: string;
  phoneCountryCode?: string;
  address?: {
    city?: string;
    country?: string;
    line1?: string;
    line2?: string;
    postalCode?: string;
    state?: string;
  };
}) {
  const parts = input.name.trim().split(/\s+/).filter(Boolean);
  const first = normalizeNamePart(parts[0], 'Customer');
  const last = normalizeNamePart(parts.slice(1).join(' '), 'User');
  const phone = resolvePhonePayload(input.phoneNumber, input.phoneCountryCode);
  const address = input.address
    ? {
        city: input.address.city?.trim() || undefined,
        country: input.address.country?.trim() || undefined,
        line1: input.address.line1?.trim() || undefined,
        line2: input.address.line2?.trim() || undefined,
        postal_code: input.address.postalCode?.trim() || undefined,
        state: input.address.state?.trim() || undefined,
      }
    : null;

  return flutterwaveRequest<Record<string, any>>('/customers', {
    method: 'POST',
    body: {
      email: input.email,
      name: {
        first,
        last,
      },
      ...(phone ? { phone } : {}),
      ...(address ? { address } : {}),
    },
    idempotencyKey: `customer:${input.email.toLowerCase()}`,
  });
}

export async function createMobileMoneyPaymentMethod(input: {
  phoneNumber: string;
  network: 'MTN' | 'AIRTEL' | 'M-PESA';
  countryCode: string;
}) {
  const normalizedPhone = input.phoneNumber.replace(/[^\d]/g, '');
  return flutterwaveRequest<Record<string, any>>('/payment-methods', {
    method: 'POST',
    body: {
      type: 'mobile_money',
      mobile_money: {
        phone_number: normalizedPhone.startsWith(input.countryCode)
          ? normalizedPhone.slice(input.countryCode.length)
          : normalizedPhone.replace(/^0+/, ''),
        network: input.network,
        country_code: input.countryCode,
      },
    },
    idempotencyKey: `pm:${normalizedPhone}:${input.network}:${input.countryCode}`,
  });
}

export async function createCharge(input: {
  amount: number;
  currency: string;
  customerId: string;
  paymentMethodId: string;
  txRef: string;
  redirectUrl?: string | null;
  meta?: Record<string, any>;
}) {
  return flutterwaveRequest<Record<string, any>>('/charges', {
    method: 'POST',
    body: {
      amount: input.amount,
      currency: input.currency,
      customer_id: input.customerId,
      payment_method_id: input.paymentMethodId,
      reference: input.txRef,
      ...(input.redirectUrl ? { redirect_url: input.redirectUrl } : {}),
      ...(input.meta ? { meta: input.meta } : {}),
    },
    idempotencyKey: `charge:${input.txRef}`,
  });
}

export async function createCardPaymentMethod(input: {
  cardNumber: string;
  expiryMonth: string;
  expiryYear: string;
  cvv: string;
}) {
  const encryptedCard = await encryptFlutterwaveFields({
    encrypted_card_number: input.cardNumber.replace(/\s+/g, ''),
    encrypted_expiry_month: input.expiryMonth.trim(),
    encrypted_expiry_year: input.expiryYear.trim(),
    encrypted_cvv: input.cvv.trim(),
  });

  return flutterwaveRequest<Record<string, any>>('/payment-methods', {
    method: 'POST',
    body: {
      type: 'card',
      card: encryptedCard,
    },
    idempotencyKey: `card_method:${encryptedCard.nonce}:${input.cardNumber.slice(-4)}`,
  });
}

export async function updateChargeAuthorization(input: {
  chargeId: string;
  authorization:
    | {
        type: 'pin';
        pin: string;
      }
    | {
        type: 'otp';
        otp: string;
      }
    | {
        type: 'avs';
        avs: {
          city: string;
          country: string;
          line1: string;
          line2?: string;
          postalCode: string;
          state: string;
        };
      };
}) {
  let authorization: Record<string, any>;

  if (input.authorization.type === 'pin') {
    authorization = {
      type: 'pin',
      pin: await encryptFlutterwaveFields({
        encrypted_pin: input.authorization.pin.trim(),
      }),
    };
  } else if (input.authorization.type === 'otp') {
    authorization = {
      type: 'otp',
      otp: {
        code: input.authorization.otp.trim(),
      },
    };
  } else {
    authorization = {
      type: 'avs',
      avs: {
        address: {
          city: input.authorization.avs.city.trim(),
          country: input.authorization.avs.country.trim().toUpperCase(),
          line1: input.authorization.avs.line1.trim(),
          ...(input.authorization.avs.line2?.trim()
            ? { line2: input.authorization.avs.line2.trim() }
            : {}),
          postal_code: input.authorization.avs.postalCode.trim(),
          state: input.authorization.avs.state.trim(),
        },
      },
    };
  }

  return flutterwaveRequest<Record<string, any>>(
    `/charges/${encodeURIComponent(input.chargeId)}`,
    {
      method: 'PUT',
      body: {
        authorization,
      },
      idempotencyKey: `charge_auth:${input.chargeId}:${input.authorization.type}`,
    }
  );
}

export async function getTransactionStatus(transactionId: string, _merchantReference?: string) {
  return flutterwaveRequest<Record<string, any>>(
    `/charges/${encodeURIComponent(transactionId)}`
  );
}

export async function verifyTransaction(transactionId: string | number) {
  return flutterwaveRequest<Record<string, any>>(
    `/transactions/${encodeURIComponent(String(transactionId))}/verify`
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
  const secretKey = config.flutterwave.secretKey.trim();
  if (!secretKey) {
    throw new Error('Flutterwave transfer secret key is not configured');
  }

  const normalizedPhone = input.receiverPhone.replace(/[^\d]/g, '');
  const normalizedNetwork = (input.receiverNetwork ?? 'MTN').trim().toUpperCase();
  const transferBaseUrl = buildBaseUrl().replace(/\/v\d+$/i, '');
  const res = await fetch(`${transferBaseUrl}/v3/transfers`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secretKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Trace-Id': randomId(),
    },
    body: JSON.stringify({
      account_bank: normalizedNetwork,
      account_number: normalizedPhone.startsWith('256')
        ? normalizedPhone
        : `256${normalizedPhone.replace(/^0+/, '')}`,
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

  return (await res.json()) as Record<string, any>;
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
