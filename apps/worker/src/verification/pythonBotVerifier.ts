import crypto from 'crypto';
import fs from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import { Verifier, WorkerVerificationResult } from './verifier.js';

type PythonBotReport = {
  ui_detected?: boolean;
  viewer_count?: number | null;
  viewer_count_confidence?: number;
  scroll_detected?: boolean;
  challenge_detected?: boolean;
  post_fingerprint?: string;
  tamper_signals?: string[];
  scores?: {
    ui_authenticity?: number;
    viewer_count?: number;
    liveness?: number;
    challenge?: number;
    tamper_risk?: number;
    final?: number;
  };
  verdict?: 'VERIFIED' | 'PROBABLE' | 'REJECTED' | string;
  metadata?: Record<string, unknown>;
  debug?: Record<string, unknown>;
  error?: string;
};

function parseJsonFromStdout(stdout: string): PythonBotReport {
  const trimmed = stdout.trim();
  if (!trimmed) return { error: 'empty_stdout' };
  try {
    return JSON.parse(trimmed) as PythonBotReport;
  } catch {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = trimmed.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(candidate) as PythonBotReport;
      } catch {
        return { error: 'invalid_json' };
      }
    }
    return { error: 'invalid_json' };
  }
}

function runPythonBot(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const preferredPython = process.env.PYTHON_EXECUTABLE?.trim();
  const command = preferredPython && preferredPython.length > 0 ? preferredPython : process.platform === 'win32' ? 'python' : 'python3';
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function mapVerdict(verdict?: string): WorkerVerificationResult['decision'] {
  if (verdict === 'VERIFIED') return 'VERIFIED';
  if (verdict === 'PROBABLE') return 'MANUAL_REVIEW';
  return 'REJECTED';
}

export class PythonBotVerifier implements Verifier {
  private scriptPath: string;
  private fps: number;
  private maxSeconds: number;
  private supportedPlatforms: Set<string>;

  constructor() {
    const configured = process.env.PYTHON_VERIFIER_SCRIPT?.trim();
    this.scriptPath =
      configured && configured.length > 0
        ? configured
        : path.resolve(process.cwd(), 'scripts', 'wa_status_verifier.py');
    this.fps = Number(process.env.WA_VERIFIER_FPS ?? 2) || 2;
    this.maxSeconds = Number(process.env.WA_VERIFIER_MAX_SECONDS ?? 60) || 60;
    this.supportedPlatforms = new Set(['WHATSAPP_STATUS']);
  }

  async verify(videoPath: string, campaignSpec: any, challenge: any): Promise<WorkerVerificationResult> {
    if (!fs.existsSync(this.scriptPath)) {
      throw new Error(`python_verifier_script_missing:${this.scriptPath}`);
    }
    const platform = String(campaignSpec?.platform ?? '').trim().toUpperCase();
    if (!this.supportedPlatforms.has(platform)) {
      throw new Error(`python_verifier_unsupported_platform:${platform || 'UNKNOWN'}`);
    }

    const args = [
      this.scriptPath,
      '--video',
      videoPath,
      '--platform',
      platform,
      '--fps',
      String(this.fps),
      '--max-seconds',
      String(this.maxSeconds),
      '--challenge-code',
      String(challenge?.challenge_code ?? ''),
      '--challenge-phrase',
      String(challenge?.challenge_phrase ?? ''),
      '--quiet',
    ];
    const run = await runPythonBot(args);
    if (run.code !== 0) {
      throw new Error(`python_verifier_failed:${run.stderr || run.stdout || `exit_${run.code}`}`);
    }

    const report = parseJsonFromStdout(run.stdout);
    if (report.error) {
      throw new Error(`python_verifier_report_error:${report.error}`);
    }
    const verdict = mapVerdict(report.verdict);
    const confidence = Math.max(0, Math.min(1, Number(report.scores?.final ?? 0)));
    const observedViews = Math.max(0, Number(report.viewer_count ?? 0));
    const uiDetected = Boolean(report.ui_detected);
    const scrollDetected = Boolean(report.scroll_detected);
    const challengeSeen = Boolean(report.challenge_detected);
    const hash =
      typeof report.post_fingerprint === 'string' && report.post_fingerprint.trim().length > 0
        ? report.post_fingerprint.trim().slice(0, 64)
        : crypto.createHash('sha256').update(fs.readFileSync(videoPath)).digest('hex').slice(0, 12);

    return {
      observed_views: observedViews,
      observed_post_hash: hash.slice(0, 12),
      challenge_seen: challengeSeen,
      confidence,
      decision: verdict,
      verifier_report: report as unknown as Record<string, unknown>,
    };
  }
}
