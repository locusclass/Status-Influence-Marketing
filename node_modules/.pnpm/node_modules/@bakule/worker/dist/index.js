import { pool, withTransaction } from './db.js';
import { platformAdapters } from './verification/adapters.js';
import { MockVerifier } from './verification/mockVerifier.js';
import { GeminiVerifier } from './verification/geminiVerifier.js';
import { DeterministicVerifier } from './verification/deterministicVerifier.js';
import { runTamperChecks } from './verification/tamper.js';
import { requestPayout } from './services/pesapal.js';
import { downloadToTemp, removeTemp } from './utils.js';
import { v4 as uuid } from 'uuid';
const verifierProvider = process.env.VERIFIER_PROVIDER ?? 'mock';
const verifier = verifierProvider === 'gemini'
    ? new GeminiVerifier()
    : verifierProvider === 'deterministic'
        ? new DeterministicVerifier()
        : new MockVerifier();
async function fetchNextJob() {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const res = await client.query(`SELECT *
       FROM job_queue
       WHERE status IN ('QUEUED', 'RETRY')
         AND run_at <= now()
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`);
        const job = res.rows[0];
        if (!job) {
            await client.query('COMMIT');
            return null;
        }
        await client.query("UPDATE job_queue SET status='PROCESSING', updated_at=now() WHERE id=$1", [job.id]);
        await client.query('COMMIT');
        return job;
    }
    catch (err) {
        await client.query('ROLLBACK');
        throw err;
    }
    finally {
        client.release();
    }
}
function buildReviewReasons(input) {
    const reasons = [];
    if (input.tamper.cut_spike) {
        reasons.push({ code: 'TAMPER_CUT_SPIKE', message: 'Abrupt scene changes detected.' });
    }
    if (input.tamper.frozen_frames) {
        reasons.push({ code: 'TAMPER_FROZEN_FRAMES', message: 'Frozen frames detected in the recording.' });
    }
    if (input.tamper.timestamp_inconsistent) {
        reasons.push({ code: 'TAMPER_TIMESTAMP', message: 'Recording timestamp metadata inconsistent.' });
    }
    if (input.tamper.overlay_suspected) {
        reasons.push({ code: 'TAMPER_OVERLAY', message: 'Overlay anomalies detected near target UI.' });
    }
    if (input.result.challenge_seen === false) {
        reasons.push({ code: 'CHALLENGE_NOT_SEEN', message: 'Challenge code/phrase not visible or not detected.' });
    }
    if (typeof input.result.confidence === 'number' && input.result.confidence < 0.7) {
        reasons.push({ code: 'LOW_CONFIDENCE', message: 'Verification confidence is below threshold.' });
    }
    if (!input.result.observed_views || input.result.observed_views <= 0) {
        reasons.push({ code: 'VIEWS_MISSING', message: 'View count could not be verified.' });
    }
    if (input.script && Array.isArray(input.script)) {
        const requiredSteps = input.script.filter((s) => s?.required !== false).length;
        const completedSteps = input.clientMeta?.steps?.length ?? 0;
        if (completedSteps < requiredSteps) {
            reasons.push({
                code: 'STEPS_INCOMPLETE',
                message: 'Required verification gestures were not completed.',
            });
        }
    }
    return reasons;
}
async function preparePayoutRequest(client, proof, campaign) {
    const trustRow = await client.query('SELECT score FROM trust_scores WHERE user_id=$1', [proof.user_id]);
    const trustScore = trustRow.rows[0]?.score ?? 50;
    const escrowRes = await client.query('SELECT * FROM escrow_ledger WHERE campaign_id=$1', [campaign.id]);
    const escrow = escrowRes.rows[0];
    if (!escrow || escrow.status === 'PENDING') {
        throw new Error('escrow_not_funded');
    }
    const existingPayoutRes = await client.query('SELECT * FROM payout_requests WHERE proof_id=$1', [proof.id]);
    let payoutRow = existingPayoutRes.rows[0];
    if (!payoutRow) {
        const payoutInsert = await client.query(`INSERT INTO payout_requests (proof_id, user_id, amount, status)
       VALUES ($1,$2,$3,'REQUESTED')
       RETURNING *`, [proof.id, proof.user_id, campaign.payout_amount]);
        payoutRow = payoutInsert.rows[0];
    }
    if (!payoutRow)
        return null;
    if (payoutRow.status === 'PAID')
        return null;
    if (trustScore < 60) {
        await client.query("UPDATE payout_requests SET status='REQUESTED' WHERE id=$1", [payoutRow.id]);
        return null;
    }
    if (payoutRow.status === 'PROCESSING' && payoutRow.pesapal_reference) {
        const userRes = await client.query('SELECT email, phone, preferred_currency FROM users WHERE id=$1', [proof.user_id]);
        const user = userRes.rows[0];
        if (!user?.phone) {
            throw new Error('missing_payout_phone');
        }
        return {
            payoutId: payoutRow.id,
            escrowId: escrow.id,
            amount: campaign.payout_amount,
            reference: payoutRow.pesapal_reference,
            receiverName: user.email?.split('@')[0] ?? 'Distributor',
            receiverPhone: user.phone,
            currency: (user.preferred_currency ?? 'UGX').toString().toUpperCase(),
            narration: `Payout for proof ${proof.id}`,
        };
    }
    if (payoutRow.status === 'FAILED') {
        const resetRes = await client.query("UPDATE payout_requests SET status='REQUESTED' WHERE id=$1 RETURNING *", [payoutRow.id]);
        payoutRow = resetRes.rows[0] ?? payoutRow;
    }
    const updatedEscrow = await client.query(`UPDATE escrow_ledger
     SET amount_available = amount_available - $2,
         status = CASE
           WHEN amount_available - $2 <= 0
           THEN 'COMPLETED'
           ELSE 'PARTIALLY_DISBURSED'
         END
     WHERE id=$1 AND amount_available >= $2
     RETURNING *`, [escrow.id, campaign.payout_amount]);
    if (!updatedEscrow.rows[0]) {
        throw new Error('insufficient_escrow');
    }
    const userRes = await client.query('SELECT email, phone, preferred_currency FROM users WHERE id=$1', [proof.user_id]);
    const user = userRes.rows[0];
    if (!user?.phone) {
        throw new Error('missing_payout_phone');
    }
    const payoutReference = uuid();
    await client.query("UPDATE payout_requests SET status='PROCESSING', pesapal_reference=$2 WHERE id=$1", [payoutRow.id, payoutReference]);
    return {
        payoutId: payoutRow.id,
        escrowId: escrow.id,
        amount: campaign.payout_amount,
        reference: payoutReference,
        receiverName: user.email?.split('@')[0] ?? 'Distributor',
        receiverPhone: user.phone,
        currency: (user.preferred_currency ?? 'UGX').toString().toUpperCase(),
        narration: `Payout for proof ${proof.id}`,
    };
}
async function compensatePayoutFailure(proofId, campaignId) {
    await withTransaction(async (client) => {
        const payoutRes = await client.query('SELECT * FROM payout_requests WHERE proof_id=$1', [proofId]);
        const payout = payoutRes.rows[0];
        if (!payout || payout.status !== 'PROCESSING') {
            return;
        }
        await client.query("UPDATE payout_requests SET status='FAILED' WHERE id=$1", [payout.id]);
        await client.query(`UPDATE escrow_ledger
       SET amount_available = amount_available + $2,
           status = CASE
             WHEN amount_available + $2 >= amount_total THEN 'FUNDED'
             ELSE 'PARTIALLY_DISBURSED'
           END
       WHERE campaign_id=$1`, [campaignId, payout.amount]);
    });
}
async function submitPayout(input) {
    await requestPayout({
        amount: input.amount,
        currency: input.currency,
        narration: input.narration,
        reference: input.reference,
        receiverName: input.receiverName,
        receiverPhone: input.receiverPhone,
    });
}
async function processVerificationJob(job) {
    const proofId = job.payload.proof_id;
    let tempPath = null;
    try {
        const proofRes = await pool.query('SELECT * FROM proofs WHERE id=$1', [proofId]);
        const proof = proofRes.rows[0];
        if (!proof)
            throw new Error('proof_not_found');
        const sessionRes = await pool.query('SELECT * FROM verification_sessions WHERE id=$1', [proof.session_id]);
        const session = sessionRes.rows[0];
        if (!session)
            throw new Error('session_not_found');
        const campaignRes = await pool.query('SELECT * FROM campaigns WHERE id=$1', [session.campaign_id]);
        const campaign = campaignRes.rows[0];
        if (!campaign)
            throw new Error('campaign_not_found');
        const adapter = platformAdapters[campaign.platform];
        const videoUrl = proof.video_url;
        if (videoUrl.startsWith('http')) {
            tempPath = await downloadToTemp(videoUrl);
        }
        else if (videoUrl.startsWith('/uploads/files/')) {
            const base = process.env.API_BASE_URL ?? 'http://localhost:3000';
            tempPath = await downloadToTemp(`${base}${videoUrl}`);
        }
        else {
            tempPath = videoUrl;
        }
        if (!tempPath)
            throw new Error('temp_path_missing');
        const tamper = await runTamperChecks(tempPath, adapter?.roi);
        const result = await verifier.verify(tempPath, campaign, {
            challenge_code: session.challenge_code,
            challenge_phrase: session.challenge_phrase,
            expires_at: session.expires_at,
        });
        const reasons = buildReviewReasons({ tamper, result, script: session.script, clientMeta: proof.meta });
        const finalDecision = result.decision === 'VERIFIED' && reasons.length === 0
            ? 'VERIFIED'
            : 'MANUAL_REVIEW';
        await withTransaction(async (client) => {
            await client.query(`UPDATE proofs
         SET decision=$2,
             observed_views=$3,
             observed_post_hash=$4,
             challenge_seen=$5,
             confidence=$6,
             review_reasons=$7::jsonb,
             status=$2
         WHERE id=$1`, [
                proofId,
                finalDecision,
                result.observed_views,
                result.observed_post_hash,
                result.challenge_seen,
                result.confidence,
                JSON.stringify(reasons),
            ]);
            const isAdvertiserProof = proof.user_id === campaign.advertiser_id;
            if (!isAdvertiserProof) {
                const delta = finalDecision === 'VERIFIED' ? 2 : -1;
                await client.query('INSERT INTO trust_events (user_id, event_type, delta) VALUES ($1,$2,$3)', [proof.user_id, finalDecision, delta]);
                await client.query(`INSERT INTO trust_scores (user_id, score)
           VALUES ($1, 50)
           ON CONFLICT (user_id) DO NOTHING`, [proof.user_id]);
                await client.query(`UPDATE trust_scores
           SET score = LEAST(100, GREATEST(0, score + $2)),
               updated_at = now()
           WHERE user_id=$1`, [proof.user_id, delta]);
            }
            if (finalDecision === 'VERIFIED' && !isAdvertiserProof) {
                const existingPayoutJob = await client.query(`SELECT id
           FROM job_queue
           WHERE job_type='PAYOUT_PROOF'
             AND payload->>'proof_id'=$1
             AND status IN ('QUEUED','PROCESSING','RETRY')
           LIMIT 1`, [proof.id]);
                if (!existingPayoutJob.rows[0]) {
                    await client.query('INSERT INTO job_queue (job_type, payload) VALUES ($1,$2)', ['PAYOUT_PROOF', { proof_id: proof.id }]);
                }
            }
        });
        await pool.query("UPDATE job_queue SET status='DONE', updated_at=now() WHERE id=$1", [job.id]);
    }
    catch (err) {
        const attempts = job.attempts + 1;
        const nextStatus = attempts >= job.max_attempts ? 'FAILED' : 'RETRY';
        const delay = Math.min(60 * attempts, 300);
        await pool.query(`UPDATE job_queue
       SET status=$2,
           attempts=$3,
           last_error=$4,
           run_at=now() + ($5 || ' seconds')::interval,
           updated_at=now()
       WHERE id=$1`, [job.id, nextStatus, attempts, err?.message ?? 'error', delay]);
    }
    finally {
        if (tempPath && tempPath.includes('gm-video-')) {
            await removeTemp(tempPath);
        }
    }
}
async function processPayoutJob(job) {
    const proofId = job.payload.proof_id;
    try {
        const proofRes = await pool.query('SELECT * FROM proofs WHERE id=$1', [proofId]);
        const proof = proofRes.rows[0];
        if (!proof)
            throw new Error('proof_not_found');
        if (proof.status !== 'VERIFIED')
            throw new Error('proof_not_verified');
        const sessionRes = await pool.query('SELECT * FROM verification_sessions WHERE id=$1', [proof.session_id]);
        const session = sessionRes.rows[0];
        if (!session)
            throw new Error('session_not_found');
        const campaignRes = await pool.query('SELECT * FROM campaigns WHERE id=$1', [session.campaign_id]);
        const campaign = campaignRes.rows[0];
        if (!campaign)
            throw new Error('campaign_not_found');
        const payoutRequest = await withTransaction(async (client) => {
            const isAdvertiserProof = proof.user_id === campaign.advertiser_id;
            if (!isAdvertiserProof) {
                return preparePayoutRequest(client, proof, campaign);
            }
            return null;
        });
        if (payoutRequest) {
            await submitPayout({
                amount: payoutRequest.amount,
                currency: payoutRequest.currency,
                narration: payoutRequest.narration,
                reference: payoutRequest.reference,
                receiverName: payoutRequest.receiverName,
                receiverPhone: payoutRequest.receiverPhone,
            });
        }
        await pool.query("UPDATE job_queue SET status='DONE', updated_at=now() WHERE id=$1", [job.id]);
    }
    catch (err) {
        try {
            const proofRes = await pool.query('SELECT * FROM proofs WHERE id=$1', [proofId]);
            const proof = proofRes.rows[0];
            if (proof) {
                const sessionRes = await pool.query('SELECT * FROM verification_sessions WHERE id=$1', [proof.session_id]);
                const session = sessionRes.rows[0];
                if (session) {
                    await compensatePayoutFailure(proofId, session.campaign_id);
                }
            }
        }
        catch {
            // best-effort compensation only
        }
        const attempts = job.attempts + 1;
        const nextStatus = attempts >= job.max_attempts ? 'FAILED' : 'RETRY';
        const delay = Math.min(60 * attempts, 300);
        await pool.query(`UPDATE job_queue
       SET status=$2,
           attempts=$3,
           last_error=$4,
           run_at=now() + ($5 || ' seconds')::interval,
           updated_at=now()
       WHERE id=$1`, [job.id, nextStatus, attempts, err?.message ?? 'error', delay]);
    }
}
async function loop() {
    while (true) {
        const job = await fetchNextJob();
        if (!job) {
            await new Promise((r) => setTimeout(r, 2000));
            continue;
        }
        if (job.job_type === 'VERIFY_PROOF') {
            await processVerificationJob(job);
        }
        else if (job.job_type === 'PAYOUT_PROOF') {
            await processPayoutJob(job);
        }
        else {
            await pool.query("UPDATE job_queue SET status='FAILED', last_error='unknown_job_type' WHERE id=$1", [job.id]);
        }
    }
}
loop().catch((err) => {
    console.error(err);
    process.exit(1);
});
