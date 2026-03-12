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
  return new JWT({
    email: config.firebase.clientEmail,
    key: config.firebase.privateKey,
    scopes: [STORAGE_SCOPE],
  });
}

async function getAccessToken() {
  const client = createClient();
  const token = await client.getAccessToken();
  if (!token?.token) {
    throw new Error('firebase_access_token_unavailable');
  }
  return token.token;
}

function objectUploadUrl(objectName: string) {
  const bucket = encodeURIComponent(config.firebase.storageBucket);
  const name = encodeURIComponent(objectName);
  return `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${name}`;
}

function objectDownloadUrl(objectName: string) {
  const bucket = encodeURIComponent(config.firebase.storageBucket);
  const name = encodeURIComponent(objectName);
  return `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${name}?alt=media`;
}

export async function uploadToFirebaseStorage(input: {
  objectName: string;
  mimeType: string;
  body: Readable;
}) {
  const accessToken = await getAccessToken();
  const response = await fetch(objectUploadUrl(input.objectName), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': input.mimeType,
    },
    body: input.body as any,
    duplex: 'half',
  } as any);

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`firebase_storage_upload_failed:${response.status}:${detail}`);
  }
}

export async function downloadFromFirebaseStorage(input: {
  objectName: string;
  range?: string | undefined;
}) {
  const accessToken = await getAccessToken();
  const response = await fetch(objectDownloadUrl(input.objectName), {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(input.range ? { Range: input.range } : {}),
    },
  });

  if (response.status === 404) {
    return null;
  }
  if (!response.ok || !response.body) {
    const detail = await response.text();
    throw new Error(`firebase_storage_download_failed:${response.status}:${detail}`);
  }

  return {
    stream: Readable.fromWeb(response.body as any),
    status: response.status,
    contentLength: response.headers.get('content-length'),
    contentType: response.headers.get('content-type'),
    contentRange: response.headers.get('content-range'),
  };
}
