import { CreateVerificationSessionSchema, SubmitProofSchema } from '@bakule/shared';
import { withTransaction } from '../db.js';
import { VerificationRepo } from '../repositories/verificationRepo.js';
import { JobRepo } from '../repositories/jobRepo.js';
import { generateChallengeCode, generateChallengePhrase, hashFingerprint } from '../utils.js';
export async function verificationRoutes(app) {
    const verificationRepo = new VerificationRepo();
    const jobRepo = new JobRepo();
    app.post('/verification/sessions', { preHandler: [app.authenticate] }, async (request) => {
        const body = CreateVerificationSessionSchema.parse(request.body);
        const challenge_code = generateChallengeCode();
        const challenge_phrase = generateChallengePhrase();
        const expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString();
        const session = await withTransaction(async (client) => {
            return verificationRepo.createSession(client, {
                user_id: body.user_id,
                campaign_id: body.campaign_id,
                platform: body.platform,
                challenge_code,
                challenge_phrase,
                expires_at
            });
        });
        return { session };
    });
    app.post('/verification/proofs', { preHandler: [app.authenticate] }, async (request) => {
        const body = SubmitProofSchema.parse(request.body);
        const proof = await withTransaction(async (client) => {
            const session = await verificationRepo.getSession(client, body.session_id);
            if (!session)
                return { error: 'session_not_found' };
            if (new Date(session.expires_at).getTime() < Date.now())
                return { error: 'session_expired' };
            const created = await verificationRepo.createProof(client, {
                session_id: body.session_id,
                user_id: session.user_id,
                video_url: body.proof_video_url
            });
            const fingerprintHash = hashFingerprint(body.device_fingerprint);
            await verificationRepo.insertDeviceFingerprint(client, session.user_id, fingerprintHash);
            await jobRepo.enqueue(client, 'VERIFY_PROOF', { proof_id: created.id });
            return created;
        });
        if (proof.error)
            return proof;
        return { proof };
    });
}
