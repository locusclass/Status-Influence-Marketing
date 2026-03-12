import path from 'path';
import { PassThrough } from 'stream';
import { uploadToFirebaseStorage, downloadFromFirebaseStorage } from '../services/firebaseStorage.js';
import { signUpload, verifyUpload } from '../utils.js';
function sanitizeObjectNameSegment(value) {
    return path.basename(value).replace(/[^a-zA-Z0-9._-]/g, '_');
}
export async function uploadRoutes(app) {
    app.post('/uploads/sign', { preHandler: [app.authenticate] }, async (request, reply) => {
        const { file_name, mime_type } = request.body;
        if (!file_name ||
            !mime_type ||
            (!mime_type.startsWith('video/') && !mime_type.startsWith('image/'))) {
            reply.code(400);
            return { error: 'invalid_file' };
        }
        const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const expires = Date.now() + 10 * 60 * 1000;
        const payload = `${id}:${expires}:${mime_type}`;
        const token = signUpload(payload);
        return {
            upload_url: `/uploads/${id}?expires=${expires}&mime=${encodeURIComponent(mime_type)}&token=${token}`,
            file_id: id
        };
    });
    app.post('/uploads/:id', async (request, reply) => {
        const id = request.params.id;
        const expires = parseInt(request.query.expires, 10);
        const mime = String(request.query.mime ?? '');
        const token = String(request.query.token ?? '');
        if (!id || !expires || !mime || !token) {
            reply.code(400);
            return { error: 'missing_signature' };
        }
        if (Date.now() > expires) {
            reply.code(400);
            return { error: 'signature_expired' };
        }
        const payload = `${id}:${expires}:${mime}`;
        if (!verifyUpload(payload, token)) {
            reply.code(401);
            return { error: 'invalid_signature' };
        }
        if (!mime.startsWith('video/') && !mime.startsWith('image/')) {
            reply.code(400);
            return { error: 'invalid_mime' };
        }
        const contentType = String(request.headers['content-type'] ?? '');
        const isMultipart = contentType.toLowerCase().includes('multipart/form-data');
        let uploadStream;
        let uploadMime;
        let objectName;
        if (isMultipart) {
            const data = await request.file();
            if (!data) {
                reply.code(400);
                return { error: 'missing_file' };
            }
            if (!data.mimetype.startsWith('video/') && !data.mimetype.startsWith('image/')) {
                reply.code(400);
                return { error: 'invalid_mime' };
            }
            if (data.mimetype !== mime) {
                reply.code(400);
                return { error: 'mime_mismatch' };
            }
            uploadStream = data.file;
            uploadMime = data.mimetype ?? 'application/octet-stream';
            objectName = `${id}-${sanitizeObjectNameSegment(data.filename || id)}`;
        }
        else {
            const headerMime = contentType.split(';')[0]?.trim() ?? '';
            if (!headerMime) {
                reply.code(400);
                return { error: 'missing_file' };
            }
            if (!headerMime.startsWith('video/') && !headerMime.startsWith('image/')) {
                reply.code(400);
                return { error: 'invalid_mime' };
            }
            if (headerMime !== mime) {
                reply.code(400);
                return { error: 'mime_mismatch' };
            }
            uploadStream = request.raw;
            uploadMime = headerMime;
            objectName = sanitizeObjectNameSegment(id);
        }
        if (!uploadMime.startsWith('video/') && !uploadMime.startsWith('image/')) {
            reply.code(400);
            return { error: 'invalid_mime' };
        }
        const sizeLimit = 200 * 1024 * 1024;
        let total = 0;
        const passthrough = new PassThrough();
        uploadStream.on('data', (chunk) => {
            total += chunk.length;
            if (total > sizeLimit) {
                uploadStream.destroy(new Error('file_too_large'));
            }
        });
        const uploadPromise = uploadToFirebaseStorage({
            objectName,
            mimeType: uploadMime,
            body: passthrough,
        });
        uploadStream.on('error', (error) => {
            passthrough.destroy(error);
        });
        uploadStream.pipe(passthrough);
        try {
            await uploadPromise;
        }
        catch (error) {
            const message = String(error?.message ?? '');
            request.log.error({
                reqId: request.id,
                uploadId: id,
                objectName,
                mime,
                error: message,
            }, `upload:firebase_failed ${message || 'unknown'}`);
            if (error?.message === 'file_too_large') {
                reply.code(413);
                return { error: 'file_too_large' };
            }
            if (message.includes('firebase_storage_not_configured')) {
                reply.code(503);
                return { error: 'firebase_storage_not_configured' };
            }
            if (message.includes('firebase_access_token_unavailable')) {
                reply.code(503);
                return { error: 'firebase_access_token_unavailable' };
            }
            if (message.includes('firebase_access_token_failed')) {
                reply.code(503);
                return {
                    error: 'firebase_access_token_failed',
                    detail: message,
                };
            }
            if (message.includes('firebase_client_init_failed')) {
                reply.code(503);
                return {
                    error: 'firebase_client_init_failed',
                    detail: message,
                };
            }
            if (message.includes('firebase_storage_upload_failed')) {
                reply.code(502);
                return {
                    error: 'firebase_storage_upload_failed',
                    detail: message,
                };
            }
            throw error;
        }
        return {
            file_url: `/uploads/files/${encodeURIComponent(objectName)}?mime=${encodeURIComponent(uploadMime)}`
        };
    });
    app.get('/uploads/files/:file', async (request, reply) => {
        const file = decodeURIComponent(request.params.file);
        if (!/^[a-zA-Z0-9._-]+$/.test(file)) {
            reply.code(400);
            return { error: 'invalid_file' };
        }
        const downloaded = await downloadFromFirebaseStorage({
            objectName: file,
            range: request.headers.range,
        });
        if (!downloaded) {
            reply.code(404);
            return { error: 'not_found' };
        }
        const mime = String(request.query.mime ?? '');
        reply.header('Accept-Ranges', 'bytes');
        reply.type(mime || downloaded.contentType || 'application/octet-stream');
        if (downloaded.status === 206) {
            reply.code(206);
        }
        if (downloaded.contentLength) {
            reply.header('Content-Length', downloaded.contentLength);
        }
        if (downloaded.contentRange) {
            reply.header('Content-Range', downloaded.contentRange);
        }
        return downloaded.stream;
    });
}
