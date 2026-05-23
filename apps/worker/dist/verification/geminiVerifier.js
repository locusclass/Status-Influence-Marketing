import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { GoogleGenerativeAI } from '@google/generative-ai';
function run(cmd, args) {
    return new Promise((resolve, reject) => {
        const p = spawn(cmd, args);
        let stderr = '';
        p.stderr.on('data', (d) => (stderr += d.toString()));
        p.on('error', reject);
        p.on('close', (code) => resolve({ code: code ?? -1, stderr }));
    });
}
async function extractFrameAt(videoPath, seconds, outPath) {
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
async function getVideoDuration(videoPath) {
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
function buildPrompt(campaignSpec, challenge) {
    return `You are verifying a WhatsApp Status advertising proof video for Prime Status. The ambassador is paid based on verified views.

Campaign: ${campaignSpec?.title ?? 'Unknown'}
Platform: ${campaignSpec?.platform ?? 'Unknown'}
Challenge code: ${challenge?.challenge_code ?? ''}
Challenge phrase: ${challenge?.challenge_phrase ?? ''}

Inspect the provided frames carefully. Determine:
1. Whether the recording shows the real WhatsApp status viewer count.
2. Whether the campaign media is visible and matches the expected content.
3. Whether the UI is genuine WhatsApp (not a mock/editor).
4. Whether there are signs of tampering.

Required evidence checklist:
- WhatsApp status viewer count screen visible
- Viewer count number clearly readable
- Campaign/ad content visible in the recording
- Challenge code "${challenge?.challenge_code ?? ''}" visible somewhere in the frames
- Challenge phrase "${challenge?.challenge_phrase ?? ''}" visible somewhere in the frames

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
function mapToDecision(r) {
    if (r.whatsapp_ui_detected &&
        r.campaign_visible &&
        r.campaign_match_confidence >= 0.80 &&
        r.viewer_count_detected != null &&
        r.viewer_count_confidence >= 0.80 &&
        !r.suspected_tampering &&
        r.fraud_risk_score <= 30) {
        return 'VERIFIED';
    }
    if (r.fraud_risk_score > 70 || !r.whatsapp_ui_detected || !r.campaign_visible) {
        return 'REJECTED';
    }
    return 'MANUAL_REVIEW';
}
export class GeminiVerifier {
    async verify(videoPath, campaignSpec, challenge) {
        const apiKey = process.env.GEMINI_API_KEY ?? '';
        if (!apiKey.trim()) {
            throw new Error('GEMINI_API_KEY not configured');
        }
        const modelName = process.env.GEMINI_VERIFICATION_MODEL ?? 'gemini-2.0-flash';
        const duration = await getVideoDuration(videoPath);
        const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gm-gemini-'));
        try {
            // Determine frame extraction seconds
            let frameTimes;
            if (duration > 0 && duration < 50) {
                const mid = Math.max(1, Math.round(duration / 2));
                const last = Math.max(1, Math.round(duration) - 1);
                frameTimes = [10, mid, last];
            }
            else {
                frameTimes = [10, 30, 50];
            }
            // Extract frames (skip a timestamp if video is too short for it)
            const frameDataParts = [];
            for (let i = 0; i < frameTimes.length; i++) {
                const t = frameTimes[i] ?? 0;
                if (duration > 0 && t >= duration)
                    continue;
                const outPath = path.join(tmpDir, `frame_${i}.jpg`);
                try {
                    await extractFrameAt(videoPath, t, outPath);
                    const data = await fs.promises.readFile(outPath);
                    frameDataParts.push({
                        inlineData: {
                            mimeType: 'image/jpeg',
                            data: data.toString('base64'),
                        },
                    });
                }
                catch {
                    // If a frame can't be extracted, skip it
                }
            }
            if (frameDataParts.length === 0) {
                throw new Error('no_frames_extracted');
            }
            const genAI = new GoogleGenerativeAI(apiKey);
            const model = genAI.getGenerativeModel({ model: modelName });
            const promptText = buildPrompt(campaignSpec, challenge);
            const attemptParse = async () => {
                const result = await model.generateContent([
                    promptText,
                    ...frameDataParts,
                ]);
                const text = result.response.text().trim();
                // Strip possible markdown fences
                const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
                return JSON.parse(cleaned);
            };
            let geminiResponse;
            try {
                geminiResponse = await attemptParse();
            }
            catch {
                // Retry once on parse failure
                geminiResponse = await attemptParse();
            }
            const challengeCode = String(challenge?.challenge_code ?? '').trim();
            const challengePhrase = String(challenge?.challenge_phrase ?? '').trim();
            const missingEvidence = Array.isArray(geminiResponse.missing_evidence)
                ? geminiResponse.missing_evidence
                : [];
            const challengeSeen = Boolean(challengeCode) &&
                Boolean(challengePhrase) &&
                !missingEvidence.some((m) => typeof m === 'string' &&
                    (m.toLowerCase().includes('challenge code') ||
                        m.toLowerCase().includes('challenge phrase')));
            const decision = mapToDecision(geminiResponse);
            return {
                observed_views: geminiResponse.viewer_count_detected ?? 0,
                observed_post_hash: null,
                challenge_seen: challengeSeen,
                confidence: geminiResponse.screen_recording_authenticity_score,
                decision,
                verifier_report: geminiResponse,
            };
        }
        finally {
            await fs.promises.rm(tmpDir, { recursive: true, force: true });
        }
    }
}
