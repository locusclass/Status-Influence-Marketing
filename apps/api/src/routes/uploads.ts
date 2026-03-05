import { FastifyInstance } from 'fastify';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { signUpload, verifyUpload } from '../utils.js';

export async function uploadRoutes(app: FastifyInstance) {
  app.post('/uploads/sign', { preHandler: [app.authenticate] }, async (request, reply) => {
    const { file_name, mime_type } = request.body as { file_name: string; mime_type: string };
    if (
      !file_name ||
      !mime_type ||
      (!mime_type.startsWith('video/') && !mime_type.startsWith('image/'))
    ) {
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
    const id = (request.params as any).id as string;
    const expires = parseInt((request.query as any).expires, 10);
    const mime = String((request.query as any).mime ?? '');
    const token = String((request.query as any).token ?? '');

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

    const uploadDir = path.resolve(config.uploadDir);
    await fs.promises.mkdir(uploadDir, { recursive: true });
    const targetPath = path.join(uploadDir, `${id}-${data.filename}`);

    const sizeLimit = 200 * 1024 * 1024;
    let total = 0;
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createWriteStream(targetPath);
      data.file.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > sizeLimit) {
          data.file.destroy(new Error('file_too_large'));
        }
      });
      data.file.pipe(stream);
      data.file.on('end', () => resolve());
      data.file.on('error', (err: any) => reject(err));
    });

    return {
      file_url: `/uploads/files/${path.basename(targetPath)}?mime=${encodeURIComponent(
        data.mimetype ?? 'application/octet-stream'
      )}`
    };
  });

  app.get('/uploads/files/:file', async (request, reply) => {
    const file = (request.params as any).file as string;
    const uploadDir = path.resolve(config.uploadDir);
    if (!/^[a-zA-Z0-9._-]+$/.test(file)) {
      reply.code(400);
      return { error: 'invalid_file' };
    }
    const filePath = path.resolve(uploadDir, file);
    if (!filePath.startsWith(uploadDir + path.sep)) {
      reply.code(400);
      return { error: 'invalid_file' };
    }
    if (!fs.existsSync(filePath)) {
      reply.code(404);
      return { error: 'not_found' };
    }
    const mime = String((request.query as any).mime ?? '');
    const stat = await fs.promises.stat(filePath);
    const fileSize = stat.size;
    const range = request.headers.range;
    reply.header('Accept-Ranges', 'bytes');
    reply.type(mime || 'application/octet-stream');

    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      if (!match) {
        reply.code(416);
        return { error: 'invalid_range' };
      }
      const start = parseInt(match[1] ?? '0', 10);
      const end = match[2] ? parseInt(match[2], 10) : fileSize - 1;
      if (start >= fileSize || end >= fileSize) {
        reply.code(416);
        return { error: 'range_not_satisfiable' };
      }
      const chunkSize = end - start + 1;
      reply
        .code(206)
        .header('Content-Range', `bytes ${start}-${end}/${fileSize}`)
        .header('Content-Length', chunkSize);
      return fs.createReadStream(filePath, { start, end });
    }

    reply.header('Content-Length', fileSize);
    return fs.createReadStream(filePath);
  });
}
