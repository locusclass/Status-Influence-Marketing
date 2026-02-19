import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { signUpload, verifyUpload } from '../utils.js';
export async function uploadRoutes(app) {
    app.post('/uploads/sign', { preHandler: [app.authenticate] }, async (request) => {
        const { file_name, mime_type } = request.body;
        if (!file_name || !mime_type || !mime_type.startsWith('video/')) {
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
        if (!mime.startsWith('video/')) {
            reply.code(400);
            return { error: 'invalid_mime' };
        }
        const data = await request.file();
        if (!data) {
            reply.code(400);
            return { error: 'missing_file' };
        }
        if (!data.mimetype.startsWith('video/')) {
            reply.code(400);
            return { error: 'invalid_mime' };
        }
        const uploadDir = path.resolve(config.uploadDir);
        await fs.promises.mkdir(uploadDir, { recursive: true });
        const targetPath = path.join(uploadDir, `${id}-${data.filename}`);
        const sizeLimit = 200 * 1024 * 1024;
        let total = 0;
        await new Promise((resolve, reject) => {
            const stream = fs.createWriteStream(targetPath);
            data.file.on('data', (chunk) => {
                total += chunk.length;
                if (total > sizeLimit) {
                    data.file.destroy(new Error('file_too_large'));
                }
            });
            data.file.pipe(stream);
            data.file.on('end', () => resolve());
            data.file.on('error', (err) => reject(err));
        });
        return { file_url: `/uploads/files/${path.basename(targetPath)}` };
    });
    app.get('/uploads/files/:file', async (request, reply) => {
        const file = request.params.file;
        const uploadDir = path.resolve(config.uploadDir);
        const filePath = path.join(uploadDir, file);
        if (!fs.existsSync(filePath)) {
            reply.code(404);
            return { error: 'not_found' };
        }
        reply.type('video/mp4');
        return fs.createReadStream(filePath);
    });
}
