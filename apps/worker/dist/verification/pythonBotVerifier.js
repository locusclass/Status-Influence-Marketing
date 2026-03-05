import crypto from 'crypto';
import fs from 'fs';
import { spawn } from 'child_process';
import path from 'path';
function parseJsonFromStdout(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed)
        return { error: 'empty_stdout' };
    try {
        return JSON.parse(trimmed);
    }
    catch {
        const firstBrace = trimmed.indexOf('{');
        const lastBrace = trimmed.lastIndexOf('}');
        if (firstBrace >= 0 && lastBrace > firstBrace) {
            const candidate = trimmed.slice(firstBrace, lastBrace + 1);
            try {
                return JSON.parse(candidate);
            }
            catch {
                return { error: 'invalid_json' };
            }
        }
        return { error: 'invalid_json' };
    }
}
function runPythonBot(args) {
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
function mapVerdict(verdict) {
    if (verdict === 'VERIFIED')
        return 'VERIFIED';
    if (verdict === 'PROBABLE')
        return 'MANUAL_REVIEW';
    return 'REJECTED';
}
export class PythonBotVerifier {
    scriptPath;
    fps;
    maxSeconds;
    constructor() {
        const configured = process.env.PYTHON_VERIFIER_SCRIPT?.trim();
        this.scriptPath =
            configured && configured.length > 0
                ? configured
                : path.resolve(process.cwd(), 'scripts', 'wa_status_verifier.py');
        this.fps = Number(process.env.WA_VERIFIER_FPS ?? 2) || 2;
        this.maxSeconds = Number(process.env.WA_VERIFIER_MAX_SECONDS ?? 60) || 60;
    }
    async verify(videoPath, _campaignSpec, _challenge) {
        if (!fs.existsSync(this.scriptPath)) {
            throw new Error(`python_verifier_script_missing:${this.scriptPath}`);
        }
        const args = [
            this.scriptPath,
            '--video',
            videoPath,
            '--fps',
            String(this.fps),
            '--max-seconds',
            String(this.maxSeconds),
            '--quiet',
        ];
        const run = await runPythonBot(args);
        if (run.code !== 0) {
            throw new Error(`python_verifier_failed:${run.stderr || run.stdout || `exit_${run.code}`}`);
        }
        const report = parseJsonFromStdout(run.stdout);
        const verdict = mapVerdict(report.verdict);
        const confidence = Math.max(0, Math.min(1, Number(report.scores?.final ?? 0)));
        const observedViews = Math.max(0, Number(report.viewer_count ?? 0));
        const uiDetected = Boolean(report.ui_detected);
        const scrollDetected = Boolean(report.scroll_detected);
        const challengeSeen = uiDetected && scrollDetected;
        const hash = crypto.createHash('sha256').update(fs.readFileSync(videoPath)).digest('hex').slice(0, 12);
        return {
            observed_views: observedViews,
            observed_post_hash: hash,
            challenge_seen: challengeSeen,
            confidence,
            decision: verdict,
            verifier_report: report,
        };
    }
}
