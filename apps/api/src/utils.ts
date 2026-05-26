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

/**
 * Converts a relative upload path (e.g. "/uploads/files/xxx?mime=...") to an absolute URL.
 * Only uses the configured API_BASE_URL. If it is not configured, the relative path is returned.
 */
export function resolveUploadedFileUrl(relativeUrl: string, _request: any): string {
  const explicit = config.apiBaseUrl.trim();
  if (explicit) {
    try {
      return `${new URL(explicit).origin}${relativeUrl}`;
    } catch {
      return relativeUrl;
    }
  }
  return relativeUrl;
}
