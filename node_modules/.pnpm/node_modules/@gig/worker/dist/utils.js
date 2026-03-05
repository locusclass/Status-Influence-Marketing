import fs from 'fs';
import os from 'os';
import path from 'path';
import { fetch } from 'undici';
export async function downloadToTemp(url) {
    const maxBytes = 250 * 1024 * 1024;
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gm-video-'));
    const filePath = path.join(tmpDir, 'video.mp4');
    const timeoutSignal = AbortSignal.timeout(120_000);
    const res = await fetch(url, {
        signal: timeoutSignal,
    });
    if (!res.ok)
        throw new Error(`Download failed: ${res.status}`);
    const sizeHeader = Number(res.headers.get('content-length') ?? 0);
    if (Number.isFinite(sizeHeader) && sizeHeader > maxBytes) {
        throw new Error('download_too_large');
    }
    const chunks = [];
    let total = 0;
    for await (const chunk of res.body) {
        const buf = Buffer.from(chunk);
        total += buf.length;
        if (total > maxBytes) {
            throw new Error('download_too_large');
        }
        chunks.push(buf);
    }
    await fs.promises.writeFile(filePath, Buffer.concat(chunks));
    return filePath;
}
export async function removeTemp(filePath) {
    const dir = path.dirname(filePath);
    await fs.promises.rm(dir, { recursive: true, force: true });
}
