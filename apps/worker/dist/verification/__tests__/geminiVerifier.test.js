import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GeminiVerifier } from '../geminiVerifier.js';
// Mock @google/generative-ai
vi.mock('@google/generative-ai', () => {
    return {
        GoogleGenerativeAI: vi.fn().mockImplementation(() => ({
            getGenerativeModel: vi.fn().mockReturnValue({
                generateContent: vi.fn(),
            }),
        })),
    };
});
// Mock child_process spawn used by ffmpeg/ffprobe helpers
vi.mock('child_process', () => {
    const EventEmitter = require('events');
    function makeFakeSpawn(stdoutData, exitCode) {
        return () => {
            const proc = new EventEmitter();
            proc.stdout = new EventEmitter();
            proc.stderr = new EventEmitter();
            proc.stdin = { write: vi.fn(), end: vi.fn() };
            setImmediate(() => {
                proc.stdout.emit('data', stdoutData);
                proc.emit('close', exitCode);
            });
            return proc;
        };
    }
    return { spawn: makeFakeSpawn('60', 0) };
});
// Mock fs operations so we don't need a real video file
vi.mock('fs', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        promises: {
            ...actual.promises,
            mkdtemp: vi.fn().mockResolvedValue('/tmp/fake-gemini-dir'),
            readFile: vi.fn().mockResolvedValue(Buffer.from('fake-image-data')),
            rm: vi.fn().mockResolvedValue(undefined),
        },
    };
});
describe('GeminiVerifier', () => {
    const originalEnv = process.env;
    beforeEach(() => {
        process.env = { ...originalEnv };
    });
    afterEach(() => {
        process.env = originalEnv;
        vi.restoreAllMocks();
    });
    it('throws when GEMINI_API_KEY is not set', async () => {
        delete process.env.GEMINI_API_KEY;
        const verifier = new GeminiVerifier();
        await expect(verifier.verify('/tmp/fake-video.mp4', { platform: 'WHATSAPP_STATUS', title: 'Test' }, {
            challenge_code: 'ABC123',
            challenge_phrase: 'blue mango',
        })).rejects.toThrow('GEMINI_API_KEY not configured');
    });
    it('maps a valid Gemini response to WorkerVerificationResult correctly', async () => {
        process.env.GEMINI_API_KEY = 'test-api-key';
        const mockGeminiResponse = {
            viewer_count_detected: 142,
            viewer_count_confidence: 0.93,
            campaign_visible: true,
            campaign_match_confidence: 0.88,
            whatsapp_ui_detected: true,
            screen_recording_authenticity_score: 0.91,
            suspected_tampering: false,
            fraud_risk_score: 12,
            fraud_signals: [],
            missing_evidence: [],
            recommendation: 'approve',
            reasoning_summary: 'All evidence present, genuine WhatsApp UI detected.',
        };
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const mockGenerateContent = vi.fn().mockResolvedValue({
            response: { text: () => JSON.stringify(mockGeminiResponse) },
        });
        GoogleGenerativeAI.mockImplementation(() => ({
            getGenerativeModel: vi.fn().mockReturnValue({ generateContent: mockGenerateContent }),
        }));
        const verifier = new GeminiVerifier();
        const result = await verifier.verify('/tmp/fake-video.mp4', { platform: 'WHATSAPP_STATUS', title: 'Test Campaign' }, { challenge_code: 'ABC123', challenge_phrase: 'blue mango' });
        expect(result.observed_views).toBe(142);
        expect(result.decision).toBe('VERIFIED');
        expect(result.confidence).toBeCloseTo(0.91);
        expect(result.challenge_seen).toBe(true);
        expect(result.verifier_report).toMatchObject({
            viewer_count_detected: 142,
            whatsapp_ui_detected: true,
            fraud_risk_score: 12,
        });
    });
    it('returns REJECTED when fraud_risk_score > 70', async () => {
        process.env.GEMINI_API_KEY = 'test-api-key';
        const mockGeminiResponse = {
            viewer_count_detected: 10,
            viewer_count_confidence: 0.5,
            campaign_visible: true,
            campaign_match_confidence: 0.6,
            whatsapp_ui_detected: true,
            screen_recording_authenticity_score: 0.3,
            suspected_tampering: true,
            fraud_risk_score: 85,
            fraud_signals: ['screen_overlay_detected'],
            missing_evidence: [],
            recommendation: 'reject',
            reasoning_summary: 'High fraud risk detected.',
        };
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const mockGenerateContent = vi.fn().mockResolvedValue({
            response: { text: () => JSON.stringify(mockGeminiResponse) },
        });
        GoogleGenerativeAI.mockImplementation(() => ({
            getGenerativeModel: vi.fn().mockReturnValue({ generateContent: mockGenerateContent }),
        }));
        const verifier = new GeminiVerifier();
        const result = await verifier.verify('/tmp/fake-video.mp4', { platform: 'WHATSAPP_STATUS', title: 'Test Campaign' }, { challenge_code: 'XYZ789', challenge_phrase: 'red apple' });
        expect(result.decision).toBe('REJECTED');
    });
    it('returns MANUAL_REVIEW for borderline result', async () => {
        process.env.GEMINI_API_KEY = 'test-api-key';
        const mockGeminiResponse = {
            viewer_count_detected: 50,
            viewer_count_confidence: 0.65,
            campaign_visible: true,
            campaign_match_confidence: 0.75,
            whatsapp_ui_detected: true,
            screen_recording_authenticity_score: 0.6,
            suspected_tampering: false,
            fraud_risk_score: 40,
            fraud_signals: [],
            missing_evidence: [],
            recommendation: 'manual_review',
            reasoning_summary: 'Viewer count confidence below threshold.',
        };
        const { GoogleGenerativeAI } = await import('@google/generative-ai');
        const mockGenerateContent = vi.fn().mockResolvedValue({
            response: { text: () => JSON.stringify(mockGeminiResponse) },
        });
        GoogleGenerativeAI.mockImplementation(() => ({
            getGenerativeModel: vi.fn().mockReturnValue({ generateContent: mockGenerateContent }),
        }));
        const verifier = new GeminiVerifier();
        const result = await verifier.verify('/tmp/fake-video.mp4', { platform: 'WHATSAPP_STATUS', title: 'Test Campaign' }, { challenge_code: 'DEF456', challenge_phrase: 'green leaf' });
        expect(result.decision).toBe('MANUAL_REVIEW');
    });
});
