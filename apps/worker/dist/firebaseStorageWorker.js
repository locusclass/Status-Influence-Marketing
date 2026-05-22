// Thin Firebase Storage client for the worker process.
// Uses only Node built-ins (crypto, fetch) — no extra dependencies.
import { createSign } from 'crypto';
const STORAGE_SCOPE = 'https://www.googleapis.com/auth/devstorage.full_control';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
function stripWrappingQuotes(value) {
    const t = value.trim();
    return (t.startsWith('"') && t.endsWith('"')) ||
        (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
}
function getFirebaseConfig() {
    return {
        clientEmail: stripWrappingQuotes(process.env.FIREBASE_CLIENT_EMAIL ?? ''),
        privateKey: stripWrappingQuotes(process.env.FIREBASE_PRIVATE_KEY ?? '').replace(/\\n/g, '\n'),
        storageBucket: stripWrappingQuotes(process.env.FIREBASE_STORAGE_BUCKET ?? ''),
        projectId: stripWrappingQuotes(process.env.FIREBASE_PROJECT_ID ?? ''),
    };
}
function base64url(input) {
    const buf = typeof input === 'string' ? Buffer.from(input) : input;
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
async function getAccessToken() {
    const { clientEmail, privateKey, storageBucket, projectId } = getFirebaseConfig();
    if (!clientEmail || !privateKey || !storageBucket || !projectId) {
        throw new Error('firebase_storage_not_configured');
    }
    const now = Math.floor(Date.now() / 1000);
    const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
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
    if (!res.ok)
        throw new Error(`firebase_access_token_failed:${res.status}`);
    const json = (await res.json());
    if (!json.access_token)
        throw new Error('firebase_access_token_unavailable');
    return json.access_token;
}
function getBuckets() {
    const { storageBucket, projectId } = getFirebaseConfig();
    const buckets = [storageBucket].filter(Boolean);
    if (storageBucket.endsWith('.firebasestorage.app') && projectId) {
        buckets.push(`${projectId}.appspot.com`);
    }
    return [...new Set(buckets)];
}
function metaUrl(bucket, obj) {
    return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(obj)}`;
}
export async function getFirebaseObjectMetadata(objectName) {
    try {
        const token = await getAccessToken();
        for (const bucket of getBuckets()) {
            const res = await fetch(metaUrl(bucket, objectName), {
                headers: { Authorization: `Bearer ${token}` },
            });
            if (res.status === 404)
                continue;
            if (!res.ok)
                continue;
            const json = (await res.json());
            return { size: json.size != null ? Number(json.size) : null, contentType: json.contentType ?? null };
        }
        return null;
    }
    catch {
        return null;
    }
}
export async function deleteFromFirebaseStorage(objectName) {
    const token = await getAccessToken();
    for (const bucket of getBuckets()) {
        const res = await fetch(metaUrl(bucket, objectName), {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
        });
        if (res.status === 404)
            continue;
        if (res.ok)
            return true;
    }
    return false;
}
