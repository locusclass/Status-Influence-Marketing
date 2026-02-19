import fs from 'fs';
import os from 'os';
import path from 'path';
import { fetch } from 'undici';
export async function downloadToTemp(url) {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gm-video-'));
    const filePath = path.join(tmpDir, 'video.mp4');
    const res = await fetch(url);
    if (!res.ok)
        throw new Error(`Download failed: ${res.status}`);
    const buffer = Buffer.from(await res.arrayBuffer());
    await fs.promises.writeFile(filePath, buffer);
    return filePath;
}
export async function removeTemp(filePath) {
    const dir = path.dirname(filePath);
    await fs.promises.rm(dir, { recursive: true, force: true });
}
