import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { PNG } from 'pngjs';
function run(cmd, args) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args, { stdio: 'ignore' });
        p.on('error', reject);
        p.on('close', (code) => {
            if (code === 0)
                resolve();
            else
                reject(new Error(`${cmd} exited ${code}`));
        });
    });
}
async function ffprobeDuration(videoPath) {
    return new Promise((resolve, reject) => {
        const args = ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath];
        const p = spawn('ffprobe', args);
        let out = '';
        p.stdout.on('data', (d) => (out += d.toString()));
        p.on('error', reject);
        p.on('close', (code) => {
            if (code !== 0)
                return reject(new Error('ffprobe failed'));
            resolve(parseFloat(out.trim()) || 0);
        });
    });
}
function loadPng(file) {
    return new Promise((resolve, reject) => {
        fs.createReadStream(file)
            .pipe(new PNG())
            .on('parsed', function () {
            resolve(this);
        })
            .on('error', reject);
    });
}
function grayscaleHistogram(png) {
    const bins = new Array(16).fill(0);
    for (let i = 0; i < png.data.length; i += 4) {
        const r = png.data[i] ?? 0;
        const g = png.data[i + 1] ?? 0;
        const b = png.data[i + 2] ?? 0;
        const gray = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
        const idx = Math.min(15, Math.floor(gray / 16));
        bins[idx] = (bins[idx] ?? 0) + 1;
    }
    const total = png.width * png.height;
    return bins.map((v) => v / total);
}
function histDelta(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i += 1) {
        const av = a[i] ?? 0;
        const bv = b[i] ?? 0;
        sum += Math.abs(av - bv);
    }
    return sum;
}
function meanAbsDiff(a, b) {
    let sum = 0;
    const len = Math.min(a.data.length, b.data.length);
    for (let i = 0; i < len; i += 4) {
        const da = Math.abs((a.data[i] ?? 0) - (b.data[i] ?? 0)) +
            Math.abs((a.data[i + 1] ?? 0) - (b.data[i + 1] ?? 0)) +
            Math.abs((a.data[i + 2] ?? 0) - (b.data[i + 2] ?? 0));
        sum += da / 3;
    }
    return sum / (len / 4) / 255;
}
function edgeDensity(png, roi) {
    const w = png.width;
    const h = png.height;
    const startX = roi ? Math.floor(roi.x * w) : 0;
    const startY = roi ? Math.floor(roi.y * h) : 0;
    const endX = roi ? Math.floor((roi.x + roi.width) * w) : w - 1;
    const endY = roi ? Math.floor((roi.y + roi.height) * h) : h - 1;
    let edges = 0;
    let total = 0;
    for (let y = startY + 1; y < endY - 1; y += 1) {
        for (let x = startX + 1; x < endX - 1; x += 1) {
            const idx = (y * w + x) * 4;
            const gray = ((png.data[idx] ?? 0) + (png.data[idx + 1] ?? 0) + (png.data[idx + 2] ?? 0)) / 3;
            const right = ((png.data[idx + 4] ?? 0) + (png.data[idx + 5] ?? 0) + (png.data[idx + 6] ?? 0)) / 3;
            const down = ((png.data[idx + w * 4] ?? 0) + (png.data[idx + w * 4 + 1] ?? 0) + (png.data[idx + w * 4 + 2] ?? 0)) / 3;
            const gx = Math.abs(gray - right);
            const gy = Math.abs(gray - down);
            const mag = gx + gy;
            if (mag > 30)
                edges += 1;
            total += 1;
        }
    }
    return total > 0 ? edges / total : 0;
}
export async function runTamperChecks(videoPath, roi) {
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gm-frames-'));
    const framePattern = path.join(tmpDir, 'frame-%03d.png');
    let duration = 0;
    try {
        duration = await ffprobeDuration(videoPath);
    }
    catch {
        duration = 0;
    }
    try {
        await run('ffmpeg', ['-i', videoPath, '-vf', 'fps=1', '-frames:v', '20', framePattern]);
    }
    catch {
        return {
            cut_spike: false,
            frozen_frames: false,
            timestamp_inconsistent: duration <= 0,
            overlay_suspected: false,
            details: { max_hist_delta: 0, frozen_run: 0, roi_edge_ratio: 0, duration }
        };
    }
    const frames = (await fs.promises.readdir(tmpDir)).filter((f) => f.endsWith('.png')).sort();
    let prevHist = null;
    let maxDelta = 0;
    let frozenRun = 0;
    let maxFrozenRun = 0;
    let roiEdgeRatio = 0;
    let prevPng = null;
    for (const frame of frames) {
        const png = await loadPng(path.join(tmpDir, frame));
        const hist = grayscaleHistogram(png);
        if (prevHist) {
            const delta = histDelta(prevHist, hist);
            if (delta > maxDelta)
                maxDelta = delta;
        }
        if (prevPng) {
            const diff = meanAbsDiff(prevPng, png);
            if (diff < 0.01) {
                frozenRun += 1;
                if (frozenRun > maxFrozenRun)
                    maxFrozenRun = frozenRun;
            }
            else {
                frozenRun = 0;
            }
        }
        const overallEdge = edgeDensity(png);
        const roiEdge = roi ? edgeDensity(png, roi) : overallEdge;
        const ratio = overallEdge > 0 ? roiEdge / overallEdge : 0;
        if (ratio > roiEdgeRatio)
            roiEdgeRatio = ratio;
        prevHist = hist;
        prevPng = png;
    }
    await fs.promises.rm(tmpDir, { recursive: true, force: true });
    return {
        cut_spike: maxDelta > 0.4,
        frozen_frames: maxFrozenRun >= 3,
        timestamp_inconsistent: duration <= 0,
        overlay_suspected: roiEdgeRatio > 1.8,
        details: { max_hist_delta: maxDelta, frozen_run: maxFrozenRun, roi_edge_ratio: roiEdgeRatio, duration }
    };
}
