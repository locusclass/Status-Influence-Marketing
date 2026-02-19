import { pool, withTransaction } from './db.js';
import { platformAdapters } from './verification/adapters.js';
import { MockVerifier } from './verification/mockVerifier.js';
import { GeminiVerifier } from './verification/geminiVerifier.js';
import { runTamperChecks } from './verification/tamper.js';
import { requestPayout } from './services/pesapal.js';
import { downloadToTemp, removeTemp } from './utils.js';
import { v4 as uuid } from 'uuid';

const verifierProvider = process.env.VERIFIER_PROVIDER ?? 'mock';
const verifier = verifierProvider === 'gemini' ? new GeminiVerifier() : new MockVerifier();

async function fetchNextJob() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await client.query(
      `SELECT * FROM job_queue
       WHERE status IN ('QUEUED','RETRY') AND run_at <= now()
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    );
    const job = res.rows[0];
    if (!job) {
      await client.query('COMMIT');
      return null;
    }
    await client.query('UPDATE job_queue SET status=\'PROCESSING\', updated_at=now() WHERE id=$1', [job.id]);
    await client.query('COMMIT');
    return job;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function processVerificationJob(job: any) {
  const proofId = job.payload.proof_id;
  let tempPath: string | null = null;

  try {
    const proofRes = await pool.query('SELECT * FROM proofs WHERE id=$1', [proofId]);
    const proof = proofRes.rows[0];
    if (!proof) throw new Error('proof_not_found');

    const sessionRes = await pool.query('SELECT * FROM verification_sessions WHERE id=$1', [proof.session_id]);
    const session = sessionRes.rows[0];
    if (!session) throw new Error('session_not_found');

    const campaignRes = await pool.query('SELECT * FROM campaigns WHERE id=$1', [session.campaign_id]);
    const campaign = campaignRes.rows[0];

    const adapter = platformAdapters[campaign.platform];
    const videoUrl = proof.video_url;

    if (videoUrl.startsWith('http')) {
      tempPath = await downloadToTemp(videoUrl);
    } else if (videoUrl.startsWith('/uploads/files/')) {
      const base = process.env.API_BASE_URL ?? 'http://localhost:3000';
      tempPath = await downloadToTemp(`${base}${videoUrl}`);
    } else {
      tempPath = videoUrl;
    }

    const tamper = await runTamperChecks(tempPath, adapter?.roi);

    const result = await verifier.verify(tempPath, campaign, {
      challenge_code: session.challenge_code,
      challenge_phrase: session.challenge_phrase,
      expires_at: session.expires_at
    });

    let finalDecision = result.decision;
    const tamperFlags = [tamper.cut_spike, tamper.frozen_frames, tamper.timestamp_inconsistent, tamper.overlay_suspected].filter(Boolean).length;
    if (tamperFlags >= 2) finalDecision = 'REJECTED';
    else if (tamperFlags === 1 && finalDecision === 'VERIFIED') finalDecision = 'MANUAL_REVIEW';

    await withTransaction(async (client) => {
      await client.query(
        `UPDATE proofs
         SET decision=$2, observed_views=$3, observed_post_hash=$4, challenge_seen=$5, confidence=$6, status=$2
         WHERE id=$1`,
        [proofId, finalDecision, result.observed_views, result.observed_post_hash, result.challenge_seen, result.confidence]
      );

      const delta = finalDecision === 'VERIFIED' ? 2 : finalDecision === 'REJECTED' ? -5 : -1;
      await client.query('INSERT INTO trust_events (user_id, event_type, delta) VALUES ($1,$2,$3)', [proof.user_id, finalDecision, delta]);
      await client.query(
        `INSERT INTO trust_scores (user_id, score)
         VALUES ($1, 50)
         ON CONFLICT (user_id) DO NOTHING`,
        [proof.user_id]
      );
      await client.query(
        `UPDATE trust_scores
         SET score=LEAST(100, GREATEST(0, score + $2)), updated_at=now()
         WHERE user_id=$1`,
        [proof.user_id, delta]
      );

      if (finalDecision === 'VERIFIED') {
        const trustRow = await client.query('SELECT score FROM trust_scores WHERE user_id=$1', [proof.user_id]);
        const trustScore = trustRow.rows[0]?.score ?? 50;
        const escrowRes = await client.query('SELECT * FROM escrow_ledger WHERE campaign_id=$1', [campaign.id]);
        const escrow = escrowRes.rows[0];
        if (!escrow || escrow.status === 'PENDING') throw new Error('escrow_not_funded');

        const payout = await client.query(
          `INSERT INTO payout_requests (proof_id, user_id, amount, status)
           VALUES ($1,$2,$3,'REQUESTED')
           ON CONFLICT (proof_id) DO NOTHING
           RETURNING *`,
          [proof.id, proof.user_id, campaign.payout_amount]
        );
        const payoutRow = payout.rows[0];
        if (payoutRow) {
          if (trustScore < 60) {
            await client.query('UPDATE payout_requests SET status=\\'REQUESTED\\' WHERE id=$1', [payoutRow.id]);
            return;
          }
          const updatedEscrow = await client.query(
            `UPDATE escrow_ledger
             SET amount_available = amount_available - $2,
                 status = CASE WHEN amount_available - $2 <= 0 THEN 'COMPLETED' ELSE 'PARTIALLY_DISBURSED' END
             WHERE id=$1 AND amount_available >= $2
             RETURNING *`,
            [escrow.id, campaign.payout_amount]
          );
          if (!updatedEscrow.rows[0]) throw new Error('insufficient_escrow');

          const userRes = await client.query('SELECT email, phone FROM users WHERE id=$1', [proof.user_id]);
          const user = userRes.rows[0];
          if (!user?.phone) throw new Error('missing_payout_phone');
          const payoutReference = uuid();
          await client.query('UPDATE payout_requests SET status=\'PROCESSING\', pesapal_reference=$2 WHERE id=$1', [payoutRow.id, payoutReference]);

          await requestPayout({
            amount: campaign.payout_amount,
            currency: 'KES',
            narration: `Payout for proof ${proof.id}`,
            reference: payoutReference,
            receiverName: user.email?.split('@')[0] ?? 'Distributor',
            receiverPhone: user.phone
          });
        }
      }
    });

    await pool.query('UPDATE job_queue SET status=\'DONE\', updated_at=now() WHERE id=$1', [job.id]);
  } catch (err: any) {
    const attempts = job.attempts + 1;
    const nextStatus = attempts >= job.max_attempts ? 'FAILED' : 'RETRY';
    const delay = Math.min(60 * attempts, 300);
    await pool.query(
      `UPDATE job_queue
       SET status=$2, attempts=$3, last_error=$4, run_at=now() + ($5 || ' seconds')::interval, updated_at=now()
       WHERE id=$1`,
      [job.id, nextStatus, attempts, err.message ?? 'error', delay]
    );
  } finally {
    if (tempPath && tempPath.includes('gm-video-')) await removeTemp(tempPath);
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
    } else {
      await pool.query('UPDATE job_queue SET status=\'FAILED\', last_error=\'unknown_job_type\' WHERE id=$1', [job.id]);
    }
  }
}

loop().catch((err) => {
  console.error(err);
  process.exit(1);
});
