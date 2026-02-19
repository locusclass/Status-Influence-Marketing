import crypto from 'crypto';
export class MockVerifier {
    async verify(videoPath, _campaignSpec, _challenge) {
        const hash = crypto.createHash('sha256').update(videoPath).digest('hex');
        const score = parseInt(hash.slice(0, 2), 16);
        const decision = score > 180 ? 'VERIFIED' : score > 80 ? 'MANUAL_REVIEW' : 'REJECTED';
        return {
            observed_views: 100 + (score % 50),
            observed_post_hash: hash.slice(0, 12),
            challenge_seen: score > 40,
            confidence: Math.min(0.99, Math.max(0.4, score / 255)),
            decision
        };
    }
}
