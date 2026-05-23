import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { fetch } from 'undici';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { Verifier, WorkerVerificationResult } from './verifier.js';

function run(cmd: string, args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let stderr = '';
    p.stderr.on('data', (d) => (stderr += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

async function extractFrameAt(videoPath: string, seconds: number, outPath: string): Promise<void> {
  const result = await run('ffmpeg', [
    '-y',
    '-ss', String(seconds),
    '-i', videoPath,
    '-frames:v', '1',
    '-q:v', '2',
    outPath,
  ]);
  if (result.code !== 0) {
    throw new Error(`ffmpeg frame extract failed at ${seconds}s: ${result.stderr}`);
  }
}

async function getVideoDuration(videoPath: string): Promise<number> {
  return new Promise((resolve) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      videoPath,
    ]);
    let out = '';
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('error', () => resolve(0));
    p.on('close', () => resolve(parseFloat(out.trim()) || 0));
  });
}

/** Download a URL and return raw bytes, capped at 20 MB. */
async function fetchBytes(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(chunk);
      total += buf.length;
      if (total > 20 * 1024 * 1024) return null; // too large
      chunks.push(buf);
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

/**
 * Download the campaign creative and return an inline Gemini image part.
 * For IMAGE media: download directly.
 * For VIDEO media: extract the first frame via ffmpeg.
 * Returns null if the media cannot be fetched or processed.
 */
async function buildCampaignMediaPart(
  mediaType: string | null,
  mediaUrl: string | null,
  tmpDir: string
): Promise<{ inlineData: { mimeType: string; data: string } } | null> {
  if (!mediaUrl) return null;

  if (mediaType === 'IMAGE') {
    const bytes = await fetchBytes(mediaUrl);
    if (!bytes) return null;
    // Detect JPEG vs PNG by magic bytes
    const mimeType = bytes[0] === 0xff && bytes[1] === 0xd8 ? 'image/jpeg' : 'image/png';
    return { inlineData: { mimeType, data: bytes.toString('base64') } };
  }

  if (mediaType === 'VIDEO') {
    // Download video to temp, extract first frame
    const bytes = await fetchBytes(mediaUrl);
    if (!bytes) return null;
    const videoTmp = path.join(tmpDir, 'campaign_video.mp4');
    const frameTmp = path.join(tmpDir, 'campaign_frame.jpg');
    await fs.promises.writeFile(videoTmp, bytes);
    try {
      await extractFrameAt(videoTmp, 0, frameTmp);
      const frameData = await fs.promises.readFile(frameTmp);
      return { inlineData: { mimeType: 'image/jpeg', data: frameData.toString('base64') } };
    } catch {
      return null;
    }
  }

  return null;
}

function buildPrompt(campaignSpec: any, challenge: any, hasCampaignMedia: boolean): string {
  const mediaType: string = campaignSpec?.media_type ?? 'UNKNOWN';
  const mediaText: string | null = campaignSpec?.media_text ?? null;

  const mediaDescription =
    mediaType === 'TEXT' && mediaText
      ? `Campaign ad content (TEXT): "${mediaText}"`
      : hasCampaignMedia
      ? `The first image provided is the CAMPAIGN REFERENCE IMAGE — this is the actual ad creative the ambassador was supposed to post as their WhatsApp Status.`
      : `No campaign media reference is available. Assess based on campaign title only.`;

  const proofFrameNote = hasCampaignMedia
    ? `The remaining images are PROOF FRAMES extracted from the ambassador's screen recording.`
    : `The images are PROOF FRAMES extracted from the ambassador's screen recording.`;

  return `You are verifying a WhatsApp Status advertising proof video for Prime Status. The ambassador is paid based on verified views.

CAMPAIGN DETAILS
Title: ${campaignSpec?.title ?? 'Unknown'}
Platform: ${campaignSpec?.platform ?? 'Unknown'}
Media type: ${mediaType}
${mediaDescription}

PROOF RECORDING
${proofFrameNote}

Challenge code the ambassador must display: "${challenge?.challenge_code ?? ''}"
Challenge phrase the ambassador must speak/show: "${challenge?.challenge_phrase ?? ''}"

YOUR TASK
Carefully examine all provided images and determine:
1. Does the proof recording show the real WhatsApp Status viewer count screen?
2. Is the campaign ad creative (the content the ambassador posted) visible in the recording${hasCampaignMedia || mediaText ? ' and does it match the reference provided above' : ''}?
3. Is the UI genuinely WhatsApp (not a mock, editor, or photo of a screen)?
4. Are the challenge code and phrase visible in the recording?
5. Are there any signs of tampering, editing, frozen frames, overlays, or AI-generated content?

REQUIRED EVIDENCE CHECKLIST
- WhatsApp Status viewer count screen clearly visible
- Viewer count number legible
- Campaign ad content visible in the recording${hasCampaignMedia || mediaText ? ' and matching the reference creative' : ''}
- Challenge code "${challenge?.challenge_code ?? ''}" present in the frames
- Challenge phrase "${challenge?.challenge_phrase ?? ''}" present in the frames

Return ONLY valid JSON with no markdown, matching exactly this schema:
{
  "viewer_count_detected": <number or null>,
  "viewer_count_confidence": <0.0-1.0>,
  "campaign_visible": <boolean>,
  "campaign_match_confidence": <0.0-1.0>,
  "whatsapp_ui_detected": <boolean>,
  "screen_recording_authenticity_score": <0.0-1.0>,
  "suspected_tampering": <boolean>,
  "fraud_risk_score": <0-100>,
  "fraud_signals": [<string>],
  "missing_evidence": [<string>],
  "recommendation": <"approve"|"manual_review"|"reject">,
  "reasoning_summary": <string>
}`;
}

interface GeminiVerificationResponse {
  viewer_count_detected: number | null;
  viewer_count_confidence: number;
  campaign_visible: boolean;
  campaign_match_confidence: number;
  whatsapp_ui_detected: boolean;
  screen_recording_authenticity_score: number;
  suspected_tampering: boolean;
  fraud_risk_score: number;
  fraud_signals: string[];
  missing_evidence: string[];
  recommendation: 'approve' | 'manual_review' | 'reject';
  reasoning_summary: string;
}

function mapToDecision(r: GeminiVerificationResponse): 'VERIFIED' | 'REJECTED' | 'MANUAL_REVIEW' {
  if (
    r.whatsapp_ui_detected &&
    r.campaign_visible &&
    r.campaign_match_confidence >= 0.80 &&
    r.viewer_count_detected != null &&
    r.viewer_count_confidence >= 0.80 &&
    !r.suspected_tampering &&
    r.fraud_risk_score <= 30
  ) {
    return 'VERIFIED';
  }
  if (r.fraud_risk_score > 70 || !r.whatsapp_ui_detected || !r.campaign_visible) {
    return 'REJECTED';
  }
  return 'MANUAL_REVIEW';
}

export class GeminiVerifier implements Verifier {
  async verify(videoPath: string, campaignSpec: any, challenge: any): Promise<WorkerVerificationResult> {
    const apiKey = process.env.GEMINI_API_KEY ?? '';
    if (!apiKey.trim()) {
      throw new Error('GEMINI_API_KEY not configured');
    }
    const modelName = process.env.GEMINI_VERIFICATION_MODEL ?? 'gemini-2.0-flash';

    const duration = await getVideoDuration(videoPath);
    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gm-gemini-'));

    try {
      // ── Campaign media reference ──────────────────────────────────────────
      const campaignMediaPart = await buildCampaignMediaPart(
        campaignSpec?.media_type ?? null,
        campaignSpec?.media_url ?? null,
        tmpDir
      );

      // ── Proof frames ──────────────────────────────────────────────────────
      let frameTimes: number[];
      if (duration > 0 && duration < 50) {
        const mid = Math.max(1, Math.round(duration / 2));
        const last = Math.max(1, Math.round(duration) - 1);
        frameTimes = [10, mid, last];
      } else {
        frameTimes = [10, 30, 50];
      }

      const proofFrameParts: Array<{ inlineData: { mimeType: string; data: string } }> = [];
      for (let i = 0; i < frameTimes.length; i++) {
        const t = frameTimes[i] ?? 0;
        if (duration > 0 && t >= duration) continue;
        const outPath = path.join(tmpDir, `frame_${i}.jpg`);
        try {
          await extractFrameAt(videoPath, t, outPath);
          const data = await fs.promises.readFile(outPath);
          proofFrameParts.push({ inlineData: { mimeType: 'image/jpeg', data: data.toString('base64') } });
        } catch {
          // skip unextractable frame
        }
      }

      if (proofFrameParts.length === 0) {
        throw new Error('no_frames_extracted');
      }

      // ── Build content parts: [prompt, campaign ref (if any), proof frames] ─
      const hasCampaignMedia = campaignMediaPart !== null;
      const promptText = buildPrompt(campaignSpec, challenge, hasCampaignMedia);

      const contentParts: Array<string | { inlineData: { mimeType: string; data: string } }> = [
        promptText,
        ...(hasCampaignMedia ? [campaignMediaPart!] : []),
        ...proofFrameParts,
      ];

      // ── Call Gemini ───────────────────────────────────────────────────────
      const genAI = new GoogleGenerativeAI(apiKey);
      const model = genAI.getGenerativeModel({ model: modelName });

      const attemptParse = async (): Promise<GeminiVerificationResponse> => {
        const result = await model.generateContent(contentParts);
        const text = result.response.text().trim();
        const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
        return JSON.parse(cleaned) as GeminiVerificationResponse;
      };

      let geminiResponse: GeminiVerificationResponse;
      try {
        geminiResponse = await attemptParse();
      } catch {
        geminiResponse = await attemptParse();
      }

      // ── Map response to WorkerVerificationResult ──────────────────────────
      const challengeCode = String(challenge?.challenge_code ?? '').trim();
      const challengePhrase = String(challenge?.challenge_phrase ?? '').trim();
      const missingEvidence = Array.isArray(geminiResponse.missing_evidence)
        ? geminiResponse.missing_evidence
        : [];
      const challengeSeen =
        Boolean(challengeCode) &&
        Boolean(challengePhrase) &&
        !missingEvidence.some(
          (m) =>
            typeof m === 'string' &&
            (m.toLowerCase().includes('challenge code') ||
              m.toLowerCase().includes('challenge phrase'))
        );

      return {
        observed_views: geminiResponse.viewer_count_detected ?? 0,
        observed_post_hash: null as any,
        challenge_seen: challengeSeen,
        confidence: geminiResponse.screen_recording_authenticity_score,
        decision: mapToDecision(geminiResponse),
        verifier_report: geminiResponse as unknown as Record<string, unknown>,
      };
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
  }
}
