import { JWT } from 'google-auth-library';
import { Readable } from 'stream';
import { config } from '../config.js';

const STORAGE_SCOPE = 'https://www.googleapis.com/auth/devstorage.full_control';

function ensureFirebaseStorageConfigured() {
  if (
    !config.firebase.projectId ||
    !config.firebase.clientEmail ||
    !config.firebase.privateKey ||
    !config.firebase.storageBucket
  ) {
    throw new Error('firebase_storage_not_configured');
  }
}

function createClient() {
  ensureFirebaseStorageConfigured();
  try {
    return new JWT({
      email: config.firebase.clientEmail,
      key: config.firebase.privateKey,
      scopes: [STORAGE_SCOPE],
    });
  } catch (error: any) {
    throw new Error(
      `firebase_client_init_failed:${String(error?.message ?? 'unknown')}`
    );
  }
}

async function getAccessToken() {
  try {
    const client = createClient();
    const token = await client.getAccessToken();
    if (!token?.token) {
      throw new Error('firebase_access_token_unavailable');
    }
    return token.token;
  } catch (error: any) {
    const message = String(error?.message ?? '');
    if (
      message.includes('firebase_storage_not_configured') ||
      message.includes('firebase_access_token_unavailable')
    ) {
      throw error;
    }
    throw new Error(`firebase_access_token_failed:${message || 'unknown'}`);
  }
}

function getBucketCandidates() {
  const configured = config.firebase.storageBucket.trim();
  const candidates = [configured].filter(Boolean);

  if (
    configured.endsWith('.firebasestorage.app') &&
    config.firebase.projectId.trim()
  ) {
    candidates.push(`${config.firebase.projectId.trim()}.appspot.com`);
  }

  return candidates.filter(
    (bucket, index, list) => list.indexOf(bucket) === index
  );
}

function objectUploadUrl(bucketName: string, objectName: string) {
  const bucket = encodeURIComponent(bucketName);
  const name = encodeURIComponent(objectName);
  return `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${name}`;
}

function objectDownloadUrl(bucketName: string, objectName: string) {
  const bucket = encodeURIComponent(bucketName);
  const name = encodeURIComponent(objectName);
  return `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${name}?alt=media`;
}

function objectMetadataUrl(bucketName: string, objectName: string) {
  const bucket = encodeURIComponent(bucketName);
  const name = encodeURIComponent(objectName);
  return `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${name}`;
}

function isMissingBucket(status: number, detail: string) {
  return status === 404 && /not found/i.test(detail);
}

export async function uploadToFirebaseStorage(input: {
  objectName: string;
  mimeType: string;
  body: Readable;
}) {
  try {
    const accessToken = await getAccessToken();
    const buckets = getBucketCandidates();
    let lastError = '';

    for (const bucketName of buckets) {
      const response = await fetch(objectUploadUrl(bucketName, input.objectName), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': input.mimeType,
        },
        body: input.body as any,
        duplex: 'half',
      } as any);

      if (response.ok) {
        return;
      }

      const detail = await response.text();
      lastError = `firebase_storage_upload_failed:${response.status}:${bucketName}:${detail}`;
      if (!isMissingBucket(response.status, detail)) {
        break;
      }
    }

    throw new Error(lastError || 'firebase_storage_upload_failed:unknown');
  } catch (error: any) {
    const message = String(error?.message ?? '');
    if (
      message.includes('firebase_storage_not_configured') ||
      message.includes('firebase_access_token_') ||
      message.includes('firebase_client_init_failed') ||
      message.includes('firebase_storage_upload_failed')
    ) {
      throw error;
    }
    throw new Error(`firebase_storage_upload_failed:runtime:${message || 'unknown'}`);
  }
}

export async function downloadFromFirebaseStorage(input: {
  objectName: string;
  range?: string | undefined;
}) {
  const accessToken = await getAccessToken();
  const buckets = getBucketCandidates();
  let lastError = '';

  for (const bucketName of buckets) {
    const response = await fetch(objectDownloadUrl(bucketName, input.objectName), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(input.range ? { Range: input.range } : {}),
      },
    });

    if (response.status === 404) {
      continue;
    }
    if (!response.ok || !response.body) {
      const detail = await response.text();
      lastError = `firebase_storage_download_failed:${response.status}:${bucketName}:${detail}`;
      if (!isMissingBucket(response.status, detail)) {
        break;
      }
      continue;
    }

    return {
      stream: Readable.fromWeb(response.body as any),
      status: response.status,
      contentLength: response.headers.get('content-length'),
      contentType: response.headers.get('content-type'),
      contentRange: response.headers.get('content-range'),
    };
  }

  if (lastError) {
    throw new Error(lastError);
  }
  return null;
}

export function extractFirebaseObjectNameFromUrl(rawUrl: string) {
  const value = rawUrl.trim();
  if (!value) {
    return null;
  }

  const isValidObjectName = (objectName: string) =>
    /^[a-zA-Z0-9/._-]+$/.test(objectName);

  try {
    const parsed = new URL(value);
    const marker = '/uploads/files/';
    const markerIndex = parsed.pathname.indexOf(marker);
    if (markerIndex >= 0) {
      const encodedObjectName = parsed.pathname.slice(markerIndex + marker.length);
      const objectName = decodeURIComponent(encodedObjectName);
      return isValidObjectName(objectName) ? objectName : null;
    }
    return null;
  } catch {
    const marker = '/uploads/files/';
    const markerIndex = value.indexOf(marker);
    if (markerIndex < 0) {
      return null;
    }
    const [rawObjectName = ''] = value
      .slice(markerIndex + marker.length)
      .split('?');
    const encodedObjectName = rawObjectName.trim();
    if (!encodedObjectName) {
      return null;
    }
    const objectName = decodeURIComponent(encodedObjectName);
    return isValidObjectName(objectName) ? objectName : null;
  }
}

export async function getFirebaseObjectMetadata(objectName: string): Promise<{
  size: number | null;
  contentType: string | null;
} | null> {
  try {
    const accessToken = await getAccessToken();
    const buckets = getBucketCandidates();

    for (const bucketName of buckets) {
      const response = await fetch(objectMetadataUrl(bucketName, objectName), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (response.status === 404) continue;
      if (!response.ok) continue;
      const json = (await response.json()) as Record<string, any>;
      return {
        size: json.size != null ? Number(json.size) : null,
        contentType: json.contentType ?? null,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function deleteFromFirebaseStorage(objectName: string) {
  const accessToken = await getAccessToken();
  const buckets = getBucketCandidates();
  let lastError = '';

  for (const bucketName of buckets) {
    const response = await fetch(objectMetadataUrl(bucketName, objectName), {
      method: 'DELETE',
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (response.status === 404) {
      continue;
    }
    if (!response.ok) {
      const detail = await response.text();
      lastError = `firebase_storage_delete_failed:${response.status}:${bucketName}:${detail}`;
      if (!isMissingBucket(response.status, detail)) {
        break;
      }
      continue;
    }

    return true;
  }

  if (lastError) {
    throw new Error(lastError);
  }
  return false;
}
