import path from 'path';
import { PassThrough } from 'stream';
import { uploadToFirebaseStorage } from './firebaseStorage.js';

function sanitizeObjectNameSegment(value: string, fallback: string) {
  const sanitized = path
    .basename(value)
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .trim();
  return sanitized.length > 0 ? sanitized : fallback;
}

export function buildStoredUploadUrl(objectName: string, mimeType: string) {
  return `/uploads/files/${encodeURIComponent(objectName)}?mime=${encodeURIComponent(
    mimeType
  )}`;
}

export async function storeMultipartMediaFile(input: {
  part: any;
  prefix: string;
  kind: 'image' | 'video';
  maxBytes?: number;
}) {
  const part = input.part;
  if (!part?.file) {
    throw new Error('missing_file');
  }

  const mimeType = String(part.mimetype ?? '').trim().toLowerCase();
  if (!mimeType.startsWith(`${input.kind}/`)) {
    throw new Error(input.kind === 'image' ? 'invalid_image' : 'invalid_video');
  }

  const safeName = sanitizeObjectNameSegment(
    String(part.filename ?? input.prefix),
    input.prefix
  );
  const objectName = `${input.prefix}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 10)}-${safeName}`;
  const sizeLimit = input.maxBytes ?? 50 * 1024 * 1024;
  let totalBytes = 0;
  const passthrough = new PassThrough();
  const uploadStream = part.file as NodeJS.ReadableStream & {
    destroy(error?: Error): void;
  };

  uploadStream.on('data', (chunk: Buffer) => {
    totalBytes += chunk.length;
    if (totalBytes > sizeLimit) {
      uploadStream.destroy(new Error('file_too_large'));
    }
  });

  const uploadPromise = uploadToFirebaseStorage({
    objectName,
    mimeType,
    body: passthrough,
  });

  uploadStream.on('error', (error) => {
    passthrough.destroy(error);
  });
  uploadStream.pipe(passthrough);

  await uploadPromise;

  return {
    objectName,
    mimeType,
    sizeBytes: totalBytes,
    fileUrl: buildStoredUploadUrl(objectName, mimeType),
  };
}

export function resolveMediaUploadError(error: any) {
  const message = String(error?.message ?? '');
  if (message === 'missing_file') {
    return { statusCode: 400, payload: { error: 'missing_file' } };
  }
  if (message === 'invalid_image') {
    return { statusCode: 400, payload: { error: 'invalid_image' } };
  }
  if (message === 'invalid_video') {
    return { statusCode: 400, payload: { error: 'invalid_video' } };
  }
  if (message === 'file_too_large') {
    return { statusCode: 413, payload: { error: 'file_too_large' } };
  }
  if (message.includes('firebase_storage_not_configured')) {
    return {
      statusCode: 503,
      payload: { error: 'firebase_storage_not_configured' },
    };
  }
  if (message.includes('firebase_access_token_unavailable')) {
    return {
      statusCode: 503,
      payload: { error: 'firebase_access_token_unavailable' },
    };
  }
  if (message.includes('firebase_access_token_failed')) {
    return {
      statusCode: 503,
      payload: { error: 'firebase_access_token_failed', detail: message },
    };
  }
  if (message.includes('firebase_client_init_failed')) {
    return {
      statusCode: 503,
      payload: { error: 'firebase_client_init_failed', detail: message },
    };
  }
  if (message.includes('firebase_storage_upload_failed')) {
    return {
      statusCode: 502,
      payload: { error: 'firebase_storage_upload_failed', detail: message },
    };
  }
  return null;
}
