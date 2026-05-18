import { FastifyInstance } from 'fastify';
import path from 'path';
import { PassThrough } from 'stream';
import {
  uploadToFirebaseStorage,
  downloadFromFirebaseStorage,
  deleteFromFirebaseStorage,
  getFirebaseObjectMetadata,
} from '../services/firebaseStorage.js';
import { signUpload, verifyUpload } from '../utils.js';
import { pool } from '../db.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const VALID_PURPOSES = new Set([
  'campaign_banner',
  'campaign_gallery',
  'campaign_video',
  'landing_page_media',
  'ambassador_proof_screenshot',
  'ambassador_proof_screen_recording',
  'user_avatar',
  'business_logo',
  'admin_attachment',
]);

const PROOF_PURPOSES = new Set([
  'ambassador_proof_screenshot',
  'ambassador_proof_screen_recording',
]);

/** Bytes allowed per upload purpose. */
const SIZE_LIMITS: Record<string, number> = {
  campaign_banner:                   8  * 1024 * 1024,
  campaign_gallery:                  10 * 1024 * 1024,
  campaign_video:                    100 * 1024 * 1024,
  landing_page_media:                100 * 1024 * 1024,
  ambassador_proof_screenshot:       10 * 1024 * 1024,
  ambassador_proof_screen_recording: 250 * 1024 * 1024,
  user_avatar:                       5  * 1024 * 1024,
  business_logo:                     5  * 1024 * 1024,
  admin_attachment:                  50 * 1024 * 1024,
};

/** Allowed MIME type prefixes per purpose (prefix match). */
const ALLOWED_MIMES: Record<string, string[]> = {
  campaign_banner:                   ['image/'],
  campaign_gallery:                  ['image/'],
  campaign_video:                    ['video/'],
  landing_page_media:                ['image/', 'video/'],
  ambassador_proof_screenshot:       ['image/'],
  ambassador_proof_screen_recording: ['video/mp4'],
  user_avatar:                       ['image/'],
  business_logo:                     ['image/'],
  admin_attachment:                  ['image/', 'video/', 'application/pdf'],
};

const BLOCKED_MIMES = new Set([
  'application/x-msdownload',
  'application/x-executable',
  'application/x-sh',
  'text/x-shellscript',
  'application/x-bat',
]);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function sanitizeObjectNameSegment(value: string) {
  return path.basename(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}

function isMimeAllowed(mime: string, purpose: string): boolean {
  if (BLOCKED_MIMES.has(mime)) return false;
  const allowed = ALLOWED_MIMES[purpose] ?? ['image/', 'video/'];
  return allowed.some((prefix) => mime.startsWith(prefix));
}

function assetTypeFromMime(mime: string): string {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  return 'document';
}

function storagePath(purpose: string, userId: string, fileId: string, filename: string): string {
  const safe = sanitizeObjectNameSegment(filename || fileId);
  const name = `${fileId}-${safe}`;
  if (purpose.startsWith('ambassador_proof')) {
    return `proofs/${userId}/${name}`;
  }
  if (purpose === 'user_avatar' || purpose === 'business_logo') {
    return `users/${userId}/${purpose}/${name}`;
  }
  if (purpose === 'admin_attachment') {
    return `admin/${userId}/${name}`;
  }
  return `campaigns/media/${name}`;
}

// ─── Access control ───────────────────────────────────────────────────────────

type MediaAccess = 'allow' | 'deny';

async function checkReadAccess(
  requestUserId: string,
  requestUserRole: string,
  assetRow: Record<string, any>
): Promise<MediaAccess> {
  const purpose: string = assetRow.upload_purpose ?? '';
  const ownerUserId: string = String(assetRow.owner_user_id ?? '');
  const campaignId: string | null = assetRow.campaign_id ?? null;

  // Owner can always read their own media.
  if (ownerUserId === requestUserId) return 'allow';

  // Non-proof media is accessible to the campaign owner (business).
  if (!PROOF_PURPOSES.has(purpose) && campaignId) {
    const campaignRes = await pool.query(
      'SELECT business_id FROM campaigns WHERE id = $1 LIMIT 1',
      [campaignId]
    );
    const businessId = campaignRes.rows[0]?.business_id;
    if (businessId && String(businessId) === requestUserId) return 'allow';
  }

  // Admin / super admin can always read.
  if (['ADMIN', 'SUPER_ADMIN'].includes(requestUserRole.toUpperCase())) return 'allow';

  // Proof media: admins allowed (handled above). Deny everyone else.
  if (PROOF_PURPOSES.has(purpose)) return 'deny';

  // Non-proof non-campaign media: allow only the owner (already handled above).
  return 'deny';
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function uploadRoutes(app: FastifyInstance) {

  // POST /uploads/sign
  // Creates a media_assets record and returns a short-lived upload URL.
  app.post('/uploads/sign', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = String((request.user as any)?.sub ?? '').trim();
    const body = request.body as Record<string, any>;
    const { file_name, mime_type, upload_purpose, campaign_id } = body as {
      file_name?: string;
      mime_type?: string;
      upload_purpose?: string;
      campaign_id?: string;
    };

    if (!file_name || !mime_type) {
      return reply.code(400).send({ error: 'missing_fields', detail: 'file_name and mime_type are required' });
    }

    const purpose = (upload_purpose ?? 'campaign_gallery').trim();
    if (!VALID_PURPOSES.has(purpose)) {
      return reply.code(400).send({ error: 'invalid_purpose', detail: `upload_purpose must be one of: ${[...VALID_PURPOSES].join(', ')}` });
    }

    if (!isMimeAllowed(mime_type, purpose)) {
      return reply.code(400).send({ error: 'invalid_mime', detail: `${mime_type} is not allowed for ${purpose}` });
    }

    // If a campaign_id was provided, verify the user owns that campaign.
    if (campaign_id) {
      const campRes = await pool.query(
        'SELECT business_id, assigned_ambassador_id FROM campaigns WHERE id = $1 LIMIT 1',
        [campaign_id]
      );
      const camp = campRes.rows[0];
      if (!camp) {
        return reply.code(404).send({ error: 'campaign_not_found' });
      }
      const isOwner = String(camp.business_id ?? '') === userId;
      const isAmbassador = String(camp.assigned_ambassador_id ?? '') === userId;
      if (!isOwner && !isAmbassador) {
        return reply.code(403).send({ error: 'forbidden' });
      }
    }

    const fileId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const expires = Date.now() + 10 * 60 * 1000; // 10 minutes
    const payload = `${fileId}:${expires}:${mime_type}`;
    const token = signUpload(payload);

    const verificationStatus = PROOF_PURPOSES.has(purpose) ? 'pending' : 'not_required';

    // Create media_assets record in pending_upload state.
    await pool.query(
      `INSERT INTO media_assets
         (id, owner_user_id, campaign_id, asset_type, upload_purpose, mime_type,
          processing_status, moderation_status, verification_status)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending_upload', 'pending', $7)`,
      [
        fileId,
        userId,
        campaign_id ?? null,
        assetTypeFromMime(mime_type),
        purpose,
        mime_type,
        verificationStatus,
      ]
    );

    return {
      upload_url: `/uploads/${fileId}?expires=${expires}&mime=${encodeURIComponent(mime_type)}&token=${token}`,
      file_id: fileId,
      asset_id: fileId,
    };
  });

  // POST /uploads/:id
  // Proxies the file to Firebase Storage.  Updates media_assets and enqueues processing.
  app.post('/uploads/:id', async (request, reply) => {
    const fileId = (request.params as any).id as string;
    const expires = parseInt((request.query as any).expires, 10);
    const mime = String((request.query as any).mime ?? '');
    const token = String((request.query as any).token ?? '');

    if (!fileId || !expires || !mime || !token) {
      return reply.code(400).send({ error: 'missing_signature' });
    }
    if (Date.now() > expires) {
      return reply.code(400).send({ error: 'signature_expired' });
    }
    const payload = `${fileId}:${expires}:${mime}`;
    if (!verifyUpload(payload, token)) {
      return reply.code(401).send({ error: 'invalid_signature' });
    }

    // Look up the asset record to get purpose and limits.
    const assetRes = await pool.query(
      `SELECT id, owner_user_id, upload_purpose, processing_status
       FROM media_assets WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [fileId]
    );
    const assetRow = assetRes.rows[0];

    // Determine size limit (from DB purpose if available, else basic rule).
    const purpose: string = assetRow?.upload_purpose ?? (mime.startsWith('video/') ? 'campaign_video' : 'campaign_gallery');
    const sizeLimit = SIZE_LIMITS[purpose] ?? (mime.startsWith('video/') ? 250 * 1024 * 1024 : 10 * 1024 * 1024);

    if (!isMimeAllowed(mime, purpose)) {
      return reply.code(400).send({ error: 'invalid_mime' });
    }

    const contentType = String(request.headers['content-type'] ?? '');
    const isMultipart = contentType.toLowerCase().includes('multipart/form-data');

    let uploadStream: NodeJS.ReadableStream & { destroy(error?: Error): void };
    let uploadMime: string;
    let objectName: string;

    if (isMultipart) {
      const data = await request.file();
      if (!data) return reply.code(400).send({ error: 'missing_file' });
      if (!isMimeAllowed(data.mimetype, purpose)) return reply.code(400).send({ error: 'invalid_mime' });
      if (data.mimetype !== mime) return reply.code(400).send({ error: 'mime_mismatch' });
      uploadStream = data.file as typeof uploadStream;
      uploadMime = data.mimetype;
      objectName = storagePath(purpose, assetRow?.owner_user_id ?? 'unknown', fileId, data.filename || fileId);
    } else {
      const headerMime = contentType.split(';')[0]?.trim() ?? '';
      if (!headerMime || !isMimeAllowed(headerMime, purpose)) return reply.code(400).send({ error: 'invalid_mime' });
      if (headerMime !== mime) return reply.code(400).send({ error: 'mime_mismatch' });
      uploadStream = request.raw as typeof uploadStream;
      uploadMime = headerMime;
      objectName = storagePath(purpose, assetRow?.owner_user_id ?? 'unknown', fileId, fileId);
    }

    let total = 0;
    const passthrough = new PassThrough();

    uploadStream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > sizeLimit) {
        uploadStream.destroy(new Error('file_too_large'));
      }
    });

    const uploadPromise = uploadToFirebaseStorage({ objectName, mimeType: uploadMime, body: passthrough });

    uploadStream.on('error', (error) => { passthrough.destroy(error); });
    uploadStream.pipe(passthrough);

    try {
      await uploadPromise;
    } catch (error: any) {
      const message = String(error?.message ?? '');
      request.log.error({ fileId, objectName, mime, error: message }, `upload:firebase_failed`);

      if (error?.message === 'file_too_large') return reply.code(413).send({ error: 'file_too_large' });
      if (message.includes('firebase_storage_not_configured')) return reply.code(503).send({ error: 'firebase_storage_not_configured' });
      if (message.includes('firebase_access_token')) return reply.code(503).send({ error: 'firebase_access_token_failed' });
      if (message.includes('firebase_client_init_failed')) return reply.code(503).send({ error: 'firebase_client_init_failed' });
      if (message.includes('firebase_storage_upload_failed')) return reply.code(502).send({ error: 'firebase_storage_upload_failed', detail: message });
      throw error;
    }

    // Update asset record to uploaded state.
    if (assetRow) {
      await pool.query(
        `UPDATE media_assets
         SET processing_status = 'uploaded',
             original_storage_path = $2,
             file_size_bytes = $3,
             updated_at = now()
         WHERE id = $1`,
        [fileId, objectName, total || null]
      );
      // Enqueue async processing job.
      await pool.query(
        `INSERT INTO job_queue (id, job_type, payload, status, run_at)
         VALUES (gen_random_uuid(), 'PROCESS_MEDIA', $1, 'QUEUED', now())`,
        [JSON.stringify({ asset_id: fileId, object_name: objectName, mime_type: uploadMime, purpose })]
      );
    }

    const fileUrl = `/uploads/files/${encodeURIComponent(objectName)}?mime=${encodeURIComponent(uploadMime)}`;
    return { file_url: fileUrl, asset_id: fileId };
  });

  // GET /uploads/files/:file  (existing public proxy — retained for campaign/non-proof media)
  app.get('/uploads/files/:file', async (request, reply) => {
    const file = decodeURIComponent((request.params as any).file as string);
    if (!/^[a-zA-Z0-9/._-]+$/.test(file)) {
      return reply.code(400).send({ error: 'invalid_file' });
    }

    const downloaded = await downloadFromFirebaseStorage({ objectName: file, range: request.headers.range });
    if (!downloaded) return reply.code(404).send({ error: 'not_found' });

    const mime = String((request.query as any).mime ?? '');
    reply.header('Accept-Ranges', 'bytes');
    reply.type(mime || downloaded.contentType || 'application/octet-stream');
    if (downloaded.status === 206) reply.code(206);
    if (downloaded.contentLength) reply.header('Content-Length', downloaded.contentLength);
    if (downloaded.contentRange) reply.header('Content-Range', downloaded.contentRange);
    return downloaded.stream;
  });

  // GET /uploads/media/:id  — access-controlled signed proxy for a media asset.
  app.get('/uploads/media/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const assetId = (request.params as any).id as string;
    const userId = String((request.user as any)?.sub ?? '').trim();
    const userRole = String((request.user as any)?.role ?? '').trim();
    const variant = String((request.query as any).variant ?? 'original'); // original | optimized | thumbnail

    const assetRes = await pool.query(
      `SELECT * FROM media_assets WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [assetId]
    );
    const asset = assetRes.rows[0];
    if (!asset) return reply.code(404).send({ error: 'not_found' });

    const access = await checkReadAccess(userId, userRole, asset);
    if (access === 'deny') return reply.code(403).send({ error: 'forbidden' });

    const objectName = variant === 'thumbnail' && asset.thumbnail_storage_path
      ? asset.thumbnail_storage_path
      : variant === 'optimized' && asset.optimized_storage_path
        ? asset.optimized_storage_path
        : asset.original_storage_path;

    if (!objectName) return reply.code(404).send({ error: 'not_available' });

    const downloaded = await downloadFromFirebaseStorage({ objectName, range: request.headers.range });
    if (!downloaded) return reply.code(404).send({ error: 'not_found' });

    reply.header('Accept-Ranges', 'bytes');
    reply.type(asset.mime_type || downloaded.contentType || 'application/octet-stream');
    reply.header('Cache-Control', 'private, max-age=3600');
    if (downloaded.status === 206) reply.code(206);
    if (downloaded.contentLength) reply.header('Content-Length', downloaded.contentLength);
    if (downloaded.contentRange) reply.header('Content-Range', downloaded.contentRange);
    return downloaded.stream;
  });

  // DELETE /uploads/media/:id — soft-delete with role/ownership check.
  app.delete('/uploads/media/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const assetId = (request.params as any).id as string;
    const userId = String((request.user as any)?.sub ?? '').trim();
    const userRole = String((request.user as any)?.role ?? '').trim();
    const isObserver = (request.user as any)?.is_observer === true;

    if (isObserver) return reply.code(403).send({ error: 'observer_cannot_mutate' });

    const assetRes = await pool.query(
      `SELECT id, owner_user_id, original_storage_path, upload_purpose
       FROM media_assets WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [assetId]
    );
    const asset = assetRes.rows[0];
    if (!asset) return reply.code(404).send({ error: 'not_found' });

    const isOwner = String(asset.owner_user_id) === userId;
    const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(userRole.toUpperCase());
    if (!isOwner && !isAdmin) return reply.code(403).send({ error: 'forbidden' });

    await pool.query(
      `UPDATE media_assets
       SET processing_status = 'deleted', deleted_at = now(), updated_at = now()
       WHERE id = $1`,
      [assetId]
    );

    // Enqueue storage cleanup.
    if (asset.original_storage_path) {
      await pool.query(
        `INSERT INTO job_queue (id, job_type, payload, status, run_at)
         VALUES (gen_random_uuid(), 'CLEANUP_MEDIA', $1, 'QUEUED', now() + interval '5 minutes')`,
        [JSON.stringify({ asset_id: assetId, object_name: asset.original_storage_path })]
      );
    }

    return { deleted: true };
  });

  // GET /uploads/media/:id/status — returns processing state without serving the file.
  app.get('/uploads/media/:id/status', { preHandler: [app.authenticate] }, async (request, reply) => {
    const assetId = (request.params as any).id as string;
    const userId = String((request.user as any)?.sub ?? '').trim();

    const assetRes = await pool.query(
      `SELECT id, owner_user_id, processing_status, moderation_status, verification_status,
              asset_type, upload_purpose, mime_type, width, height, duration_seconds,
              file_size_bytes, created_at, updated_at
       FROM media_assets WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [assetId]
    );
    const asset = assetRes.rows[0];
    if (!asset) return reply.code(404).send({ error: 'not_found' });

    // Owner or admin can check status.
    const userRole = String((request.user as any)?.role ?? '');
    const isOwner = String(asset.owner_user_id) === userId;
    const isAdmin = ['ADMIN', 'SUPER_ADMIN'].includes(userRole.toUpperCase());
    if (!isOwner && !isAdmin) return reply.code(403).send({ error: 'forbidden' });

    return { asset };
  });
}
