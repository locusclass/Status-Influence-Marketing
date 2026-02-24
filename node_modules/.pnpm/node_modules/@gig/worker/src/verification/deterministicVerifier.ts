import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { VerificationResult } from '@bakule/shared';
import { Verifier } from './verifier.js';
import { platformAdapters } from './adapters.js';

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d.toString()));
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => resolve({ stdout, stderr, code: code ?? -1 }));
  });
}

async function extractFrame(videoPath: string, outPath: string) {
  await run('ffmpeg', ['-y', '-i', videoPath, '-frames:v', '1', outPath]);
}

async function cropFrame(input: string, outPath: string, roi: { x: number; y: number; width: number; height: number }) {
  const crop = `crop=iw*${roi.width}:ih*${roi.height}:iw*${roi.x}:ih*${roi.y}`;
  await run('ffmpeg', ['-y', '-i', input, '-vf', crop, outPath]);
}

async function ocrImage(imagePath: string, whitelist?: string): Promise<string> {
  const args = [imagePath, 'stdout', '--psm', '6'];
  if (whitelist) {
    args.push('-c', `tessedit_char_whitelist=${whitelist}`);
  }
  const res = await run('tesseract', args);
  if (res.code !== 0) throw new Error('tesseract_failed');
  return res.stdout.trim();
}

function parseViews(text: string): number | null {
  const raw = text.replace(/[^\d]/g, '');
  if (!raw) return null;
  return parseInt(raw, 10);
}

export class DeterministicVerifier implements Verifier {
  async verify(videoPath: string, campaignSpec: any, challenge: any): Promise<VerificationResult> {
    const adapter = platformAdapters[campaignSpec?.platform ?? ''] ?? null;
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gm-det-'));
    const framePath = path.join(tmpDir, 'frame.png');
    const roiPath = path.join(tmpDir, 'roi.png');
    const fullTextPath = path.join(tmpDir, 'full.txt');

    try {
      await extractFrame(videoPath, framePath);

      let observedViews = 0;
      let challengeSeen = false;

      if (adapter?.roi) {
        await cropFrame(framePath, roiPath, adapter.roi);
        try {
          const roiText = await ocrImage(roiPath, '0123456789');
          const views = parseViews(roiText);
          if (views != null) observedViews = views;
        } catch {
          observedViews = 0;
        }
      }

      try {
        const fullText = await ocrImage(framePath);
        await fs.promises.writeFile(fullTextPath, fullText);
        const code = String(challenge?.challenge_code ?? '').trim();
        const phrase = String(challenge?.challenge_phrase ?? '').trim();
        const codeFound = code && fullText.includes(code);
        const phraseFound = phrase && fullText.toLowerCase().includes(phrase.toLowerCase());
        challengeSeen = Boolean(codeFound && phraseFound);
      } catch {
        challengeSeen = false;
      }

      const hash = crypto.createHash('sha256').update(fs.readFileSync(framePath)).digest('hex');
      const decision = challengeSeen && observedViews > 0 ? 'VERIFIED' : 'MANUAL_REVIEW';
      const confidence = challengeSeen && observedViews > 0 ? 0.85 : 0.55;

      return {
        observed_views: observedViews,
        observed_post_hash: hash.slice(0, 12),
        challenge_seen: challengeSeen,
        confidence,
        decision
      };
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  }
}
