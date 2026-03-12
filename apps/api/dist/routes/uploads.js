import path from 'path';
import { PassThrough } from 'stream';
import { uploadToFirebaseStorage, downloadFromFirebaseStorage } from '../services/firebaseStorage.js';
import { signUpload, verifyUpload } from '../utils.js';
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
        const safeName = path.basename(data.filename).replace(/[^a-zA-Z0-9._-]/g, '_');
        const objectName = `${id}-${safeName}`;
        const sizeLimit = 200 * 1024 * 1024;
        let total = 0;
        const passthrough = new PassThrough();
        data.file.on('data', (chunk) => {
            total += chunk.length;
            if (total > sizeLimit) {
                data.file.destroy(new Error('file_too_large'));
            }
        });
        const uploadPromise = uploadToFirebaseStorage({
            objectName,
            mimeType: data.mimetype ?? 'application/octet-stream',
            body: passthrough,
        });
        data.file.on('error', (error) => {
            passthrough.destroy(error);
        });
        data.file.pipe(passthrough);
        try {
            await uploadPromise;
        }
        catch (error) {
            if (error?.message === 'file_too_large') {
                reply.code(413);
                return { error: 'file_too_large' };
            }
            if (String(error?.message ?? '').includes('firebase_storage_not_configured')) {
                reply.code(503);
                return { error: 'firebase_storage_not_configured' };
            }
            throw error;
        }
        return {
            file_url: `/uploads/files/${encodeURIComponent(objectName)}?mime=${encodeURIComponent(data.mimetype ?? 'application/octet-stream')}`
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
