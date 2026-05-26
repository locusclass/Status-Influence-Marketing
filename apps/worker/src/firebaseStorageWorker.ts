// Thin Firebase Storage client for the worker process.
// Uses only Node built-ins (crypto, fetch) — no extra dependencies.

import { createSign } from 'crypto';

const STORAGE_SCOPE = 'https://www.googleapis.com/auth/devstorage.full_control';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';

function stripWrappingQuotes(value: string) {
  const t = value.trim();
  return (t.startsWith('"') && t.endsWith('"')) ||
         (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
}

function getFirebaseConfig() {
  return {
    clientEmail:   stripWrappingQuotes(process.env.FIREBASE_CLIENT_EMAIL ?? ''),
    privateKey:    stripWrappingQuotes(process.env.FIREBASE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
    storageBucket: stripWrappingQuotes(process.env.FIREBASE_STORAGE_BUCKET ?? ''),
    projectId:     stripWrappingQuotes(process.env.FIREBASE_PROJECT_ID ?? ''),
  };
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input) : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function getAccessToken(): Promise<string> {
  const { clientEmail, privateKey, storageBucket, projectId } = getFirebaseConfig();
  if (!clientEmail || !privateKey || !storageBucket || !projectId) {
    throw new Error('firebase_storage_not_configured');
  }

  const now = Math.floor(Date.now() / 1000);
  const header  = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    iss: clientEmail, sub: clientEmail, scope: STORAGE_SCOPE,
    aud: TOKEN_URL, iat: now, exp: now + 3600,
  }));

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  const sig = base64url(signer.sign(privateKey));
  const jwt = `${header}.${payload}.${sig}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  if (!res.ok) throw new Error(`firebase_access_token_failed:${res.status}`);
  const json = (await res.json()) as Record<string, any>;
  if (!json.access_token) throw new Error('firebase_access_token_unavailable');
  return json.access_token as string;
}

function getBuckets() {
  const { storageBucket, projectId } = getFirebaseConfig();
  const buckets = [storageBucket].filter(Boolean);
  if (storageBucket.endsWith('.firebasestorage.app') && projectId) {
    buckets.push(`${projectId}.appspot.com`);
  }
  return [...new Set(buckets)];
}

function metaUrl(bucket: string, obj: string) {
  return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(obj)}`;
}

function downloadUrl(bucket: string, obj: string) {
  return `${metaUrl(bucket, obj)}?alt=media`;
}

export async function getFirebaseObjectMetadata(
  objectName: string
): Promise<{ size: number | null; contentType: string | null } | null> {
  try {
    const token = await getAccessToken();
    for (const bucket of getBuckets()) {
      const res = await fetch(metaUrl(bucket, objectName), {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 404) continue;
      if (!res.ok) continue;
      const json = (await res.json()) as Record<string, any>;
      return { size: json.size != null ? Number(json.size) : null, contentType: json.contentType ?? null };
    }
    return null;
  } catch {
    return null;
  }
}

export async function deleteFromFirebaseStorage(objectName: string): Promise<boolean> {
  const token = await getAccessToken();
  for (const bucket of getBuckets()) {
    const res = await fetch(metaUrl(bucket, objectName), {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) continue;
    if (res.ok) return true;
  }
  return false;
}

export async function downloadFirebaseObject(
  objectName: string,
  maxBytes = 250 * 1024 * 1024
): Promise<Buffer> {
  const token = await getAccessToken();

  for (const bucket of getBuckets()) {
    const res = await fetch(downloadUrl(bucket, objectName), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) {
      continue;
    }
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `firebase_storage_download_failed:${res.status}:${bucket}:${detail}`
      );
    }

    const sizeHeader = Number(res.headers.get('content-length') ?? 0);
    if (Number.isFinite(sizeHeader) && sizeHeader > maxBytes) {
      throw new Error('download_too_large');
    }

    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(chunk);
      total += buf.length;
      if (total > maxBytes) {
        throw new Error('download_too_large');
      }
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  }

  throw new Error('firebase_storage_not_found');
}
