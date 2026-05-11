import crypto from 'crypto';
import { config } from './config.js';

const WORDS = [
  'silver','forest','anchor','pixel','yellow','marble','swift','linen','copper','river',
  'crystal','meadow','orbit','valley','breeze','magnet','ember','harbor','violet','sable'
];

export function generateChallengeCode(): string {
  const bytes = crypto.randomBytes(4);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let out = '';
  for (let i = 0; i < 6; i += 1) {
    const byte = bytes[i % bytes.length] ?? 0;
    out += alphabet[byte % alphabet.length] ?? 'A';
  }
  return out;
}

export function generateChallengePhrase(): string {
  const pick = () => WORDS[Math.floor(Math.random() * WORDS.length)];
  return [pick(), pick(), pick()].join(' ');
}

export function hashFingerprint(raw: string): string {
  return crypto.createHmac('sha256', config.fingerprintPepper).update(raw).digest('hex');
}

export function signUpload(payload: string): string {
  return crypto.createHmac('sha256', config.uploadSigningSecret).update(payload).digest('hex');
}

export function verifyUpload(payload: string, signature: string): boolean {
  const sig = signUpload(payload);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function nowIso(): string {
  return new Date().toISOString();
}

function getForwardedHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0]?.trim() || undefined;
  return value?.split(',')[0]?.trim() || undefined;
}

/**
 * Converts a relative upload path (e.g. "/uploads/files/xxx?mime=...") to an absolute URL.
 * Uses API_BASE_URL env var first, then falls back to the incoming request's forwarded headers.
 * If no base can be determined the relative path is returned unchanged.
 */
export function resolveUploadedFileUrl(relativeUrl: string, request: any): string {
  const explicit = config.apiBaseUrl.trim();
  let origin: string | null = null;
  if (explicit) {
    try {
      origin = new URL(explicit).origin;
    } catch {
      // fall through to request headers
    }
  }
  if (!origin) {
    const proto = getForwardedHeader(request.headers['x-forwarded-proto']) || request.protocol || 'https';
    const host = getForwardedHeader(request.headers['x-forwarded-host']) || getForwardedHeader(request.headers.host);
    if (host) origin = `${proto}://${host}`;
  }
  return origin ? `${origin}${relativeUrl}` : relativeUrl;
}
