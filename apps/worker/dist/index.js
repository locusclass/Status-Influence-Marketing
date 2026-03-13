import { pool, withTransaction } from './db.js';
import { platformAdapters } from './verification/adapters.js';
import { MockVerifier } from './verification/mockVerifier.js';
import { GeminiVerifier } from './verification/geminiVerifier.js';
import { DeterministicVerifier } from './verification/deterministicVerifier.js';
import { PythonBotVerifier } from './verification/pythonBotVerifier.js';
import { runTamperChecks } from './verification/tamper.js';
import { downloadToTemp, removeTemp } from './utils.js';
import { v4 as uuid } from 'uuid';
const verifierProvider = process.env.VERIFIER_PROVIDER ?? 'python_bot';
const verifier = verifierProvider === 'gemini'
    ? new GeminiVerifier()
    : verifierProvider === 'python_bot'
        ? new PythonBotVerifier()
        : verifierProvider === 'deterministic'
            ? new DeterministicVerifier()
            : new MockVerifier();
let lastContractExpirySweepAt = 0;
let lastOpenAllocatorSweepAt = 0;
if (process.env.NODE_ENV === 'production' && verifierProvider === 'mock') {
    throw new Error('VERIFIER_PROVIDER=mock is not allowed in production');
}
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
function shuffle(items) {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}
async function ensureCampaignAllocatorColumns(client) {
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS parent_campaign_id UUID REFERENCES campaigns(id)
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS assigned_distributor_id UUID REFERENCES users(id)
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS assigned_phone TEXT
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'PRIVATE_CONTRACT'
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'PUBLIC'
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS impression_target INTEGER
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS platform_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 0
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS advertiser_wallet_mode TEXT NOT NULL DEFAULT 'CAMPAIGN_ONLY'
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS last_allocated_at TIMESTAMPTZ
  `);
    await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS allocation_round INTEGER NOT NULL DEFAULT 0
  `);
}
async function getEligibleDistributors(client) {
    const res = await client.query(`
    SELECT
      u.id,
      u.phone,
      COALESCE(lp.observed_views, 0)::int AS latest_views
    FROM users u
    LEFT JOIN LATERAL (
      SELECT p.observed_views
      FROM proofs p
      WHERE p.user_id = u.id
        AND p.status = 'VERIFIED'
        AND p.observed_views IS NOT NULL
      ORDER BY p.created_at DESC
      LIMIT 1
    ) lp ON TRUE
    WHERE u.role IN ('DISTRIBUTOR', 'DUAL_USER')
      AND u.status = 'ACTIVE'
      AND COALESCE(lp.observed_views, 0) > 0
    ORDER BY lp.observed_views DESC, u.created_at ASC
    `);
    return res.rows.map((row) => ({
        id: row.id,
        phone: String(row.phone ?? ''),
        latest_views: Number(row.latest_views ?? 0),
    }));
}
async function getOpenRootCampaignsReadyForAllocation(client) {
    const res = await client.query(`
    SELECT c.*, e.amount_available, e.amount_total, e.status AS escrow_status
    FROM campaigns c
    JOIN escrow_ledger e ON e.campaign_id = c.id
    WHERE c.parent_campaign_id IS NULL
      AND c.execution_mode = 'OPEN_BUDGET'
      AND c.status = 'ACTIVE'
      AND e.status IN ('FUNDED', 'PARTIALLY_DISBURSED')
    ORDER BY c.created_at ASC
    `);
    return res.rows;
}
async function allocateOpenCampaignShares(client, rootCampaign) {
    const eligible = shuffle(await getEligibleDistributors(client));
    if (!eligible.length) {
        return 0;
    }
    const existingRes = await client.query(`
    SELECT COALESCE(SUM(impression_target), 0)::int AS allocated_views
    FROM campaigns
    WHERE parent_campaign_id=$1
      AND status IN ('ACTIVE', 'COMPLETED')
    `, [rootCampaign.id]);
    let remainingViews = Number(rootCampaign.impression_target ?? 0) -
        Number(existingRes.rows[0]?.allocated_views ?? 0);
    if (remainingViews <= 0) {
        return 0;
    }
    let created = 0;
    let round = Number(rootCampaign.allocation_round ?? 0) + 1;
    const recentlyAssigned = new Set();
    while (remainingViews > 0 && eligible.length > 0) {
        let allocatedThisPass = false;
        for (const distributor of eligible) {
            if (remainingViews <= 0)
                break;
            if (recentlyAssigned.has(distributor.id) && recentlyAssigned.size < eligible.length) {
                continue;
            }
            const activeRes = await client.query(`
        SELECT 1
        FROM campaigns
        WHERE parent_campaign_id=$1
          AND assigned_distributor_id=$2
          AND status='ACTIVE'
        LIMIT 1
        `, [rootCampaign.id, distributor.id]);
            if (activeRes.rows[0]) {
                continue;
            }
            const views = Math.max(1, Math.min(distributor.latest_views, remainingViews));
            const budgetTotal = views * Number(rootCampaign.payout_amount ?? 10);
            await client.query(`
        INSERT INTO campaigns (
          advertiser_id,
          parent_campaign_id,
          assigned_distributor_id,
          assigned_phone,
          title,
          platform,
          execution_mode,
          visibility,
          payout_amount,
          budget_total,
          impression_target,
          platform_fee_percent,
          advertiser_wallet_mode,
          last_allocated_at,
          allocation_round,
          media_type,
          media_text,
          media_url,
          terms_keep_hours,
          terms_min_views,
          terms_requirement,
          status,
          start_date,
          end_date
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,'OPEN_BUDGET','PRIVATE',$7,$8,$9,$10,$11,now(),$12,$13,$14,$15,$16,$17,$18,'ACTIVE',$19,$20
        )
        `, [
                rootCampaign.advertiser_id,
                rootCampaign.id,
                distributor.id,
                distributor.phone,
                `${rootCampaign.title} · Allocation ${uuid().slice(0, 8)}`,
                rootCampaign.platform,
                rootCampaign.payout_amount,
                budgetTotal,
                views,
                rootCampaign.platform_fee_percent ?? 25,
                rootCampaign.advertiser_wallet_mode ?? 'CAMPAIGN_ONLY',
                round,
                rootCampaign.media_type,
                rootCampaign.media_text,
                rootCampaign.media_url,
                rootCampaign.terms_keep_hours,
                rootCampaign.terms_min_views,
                rootCampaign.terms_requirement,
                rootCampaign.start_date,
                rootCampaign.end_date,
            ]);
            remainingViews -= views;
            created += 1;
            allocatedThisPass = true;
            recentlyAssigned.add(distributor.id);
        }
        if (!allocatedThisPass) {
            break;
        }
        if (recentlyAssigned.size >= eligible.length) {
            recentlyAssigned.clear();
            round += 1;
        }
    }
    if (created > 0) {
        await client.query(`
      UPDATE campaigns
      SET last_allocated_at = now(),
          allocation_round = $2
      WHERE id=$1
      `, [rootCampaign.id, round]);
    }
    return created;
}
async function reallocateExpiredOpenAllocations(client) {
    const res = await client.query(`
    SELECT c.*
    FROM campaigns c
    WHERE c.parent_campaign_id IS NOT NULL
      AND c.execution_mode='OPEN_BUDGET'
      AND c.status='ACTIVE'
      AND c.last_allocated_at IS NOT NULL
      AND c.last_allocated_at < now() - interval '1 hour'
      AND NOT EXISTS (
        SELECT 1 FROM contracts ctr
        WHERE ctr.campaign_id = c.id
          AND ctr.status IN ('ACTIVE', 'COMPLETED')
      )
    ORDER BY c.last_allocated_at ASC
    `);
    const eligible = shuffle(await getEligibleDistributors(client));
    for (const allocation of res.rows) {
        const unresolvedProofRes = await client.query(`
      SELECT 1
      FROM proofs p
      JOIN verification_sessions s ON s.id = p.session_id
      WHERE s.campaign_id=$1
        AND (
          p.status IN ('PENDING', 'MANUAL_REVIEW', 'VERIFIED')
          OR (p.status = 'REJECTED' AND COALESCE(p.decision, '') <> 'REJECTED')
        )
      LIMIT 1
      `, [allocation.id]);
        if (unresolvedProofRes.rows[0]) {
            continue;
        }
        const nextDistributor = eligible.find((row) => row.id !== allocation.assigned_distributor_id);
        if (!nextDistributor) {
            continue;
        }
        await client.query(`
      UPDATE campaigns
      SET assigned_distributor_id=$2,
          assigned_phone=$3,
          last_allocated_at=now(),
          allocation_round=allocation_round + 1
      WHERE id=$1
      `, [allocation.id, nextDistributor.id, nextDistributor.phone]);
    }
}
function evaluateClientTrace(script, clientMeta, tamperDuration) {
    const steps = Array.isArray(script) ? script : [];
    const requiredStepIds = steps.filter((s) => s?.required !== false).map((s) => String(s.id ?? ''));
    const uniqueRequired = new Set(requiredStepIds.filter(Boolean));
    const events = Array.isArray(clientMeta?.steps) ? clientMeta.steps : [];
    const completedIds = [];
    const completedAt = [];
    for (const event of events) {
        const id = String(event?.id ?? '').trim();
        if (!id)
            continue;
        completedIds.push(id);
        const ts = Date.parse(String(event?.completed_at ?? ''));
        if (!Number.isNaN(ts))
            completedAt.push(ts);
    }
    const startedAt = Date.parse(String(clientMeta?.recording_started_at ?? ''));
    const stoppedAt = Date.parse(String(clientMeta?.recording_stopped_at ?? ''));
    const declaredDuration = Number.isFinite(startedAt) && Number.isFinite(stoppedAt) && stoppedAt > startedAt
        ? Math.round((stoppedAt - startedAt) / 1000)
        : 0;
    const duration = tamperDuration > 0 ? Math.round(tamperDuration) : declaredDuration;
    let timelineOrderValid = true;
    for (let i = 1; i < completedAt.length; i += 1) {
        const current = completedAt[i] ?? 0;
        const previous = completedAt[i - 1] ?? 0;
        if (current < previous) {
            timelineOrderValid = false;
            break;
        }
    }
    const uniqueCompleted = new Set(completedIds);
    const requiredCompletedCount = [...uniqueRequired].filter((id) => uniqueCompleted.has(id)).length;
    const strictDuration = duration >= 58 && duration <= 75;
    const valid = uniqueRequired.size > 0 &&
        requiredCompletedCount >= uniqueRequired.size &&
        timelineOrderValid &&
        strictDuration;
    return {
        valid,
        required_steps: uniqueRequired.size,
        completed_steps: completedIds.length,
        unique_completed_steps: requiredCompletedCount,
        duration_seconds: duration,
        timeline_order_valid: timelineOrderValid,
    };
}
function buildReviewReasons(input) {
    const trace = evaluateClientTrace(input.script, input.clientMeta, Number(input.tamper?.details?.duration ?? 0));
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
    const botVerdict = String(input.result?.verifier_report?.verdict ?? '');
    if (botVerdict === 'REJECTED') {
        reasons.push({
            code: 'PYTHON_BOT_REJECTED',
            message: 'Python verification bot rejected the recording as non-authentic.',
        });
    }
    const botSignals = Array.isArray(input.result?.verifier_report?.tamper_signals)
        ? input.result.verifier_report.tamper_signals
        : [];
    if (botSignals.length > 0) {
        reasons.push({
            code: 'PYTHON_BOT_TAMPER_SIGNALS',
            message: `Python verification detected tamper signals: ${botSignals.join(', ')}`,
        });
    }
    const scrollDetected = Boolean(input.result?.verifier_report?.scroll_detected);
    if (!scrollDetected) {
        reasons.push({
            code: 'LIVENESS_SCROLL_MISSING',
            message: 'No reliable list scroll/liveness signal detected by the Python verifier.',
        });
    }
    if (trace.required_steps > 0 && trace.unique_completed_steps < trace.required_steps) {
        reasons.push({
            code: 'STEPS_INCOMPLETE',
            message: 'Required verification gestures were not completed.',
        });
    }
    if (!trace.timeline_order_valid) {
        reasons.push({
            code: 'STEP_TIMELINE_INVALID',
            message: 'Verification step timeline is inconsistent.',
        });
    }
    if (trace.duration_seconds < 58 || trace.duration_seconds > 75) {
        reasons.push({
            code: 'RECORDING_DURATION_INVALID',
            message: 'Recording duration is outside the required 60-second window.',
        });
    }
    return reasons;
}
async function preparePayoutRequest(client, proof, campaign) {
    const escrowCampaignId = campaign.parent_campaign_id ?? campaign.id;
    const contractRes = await client.query(`SELECT id
     FROM contracts
     WHERE campaign_id=$1
       AND distributor_id=$2
       AND status IN ('ACTIVE', 'COMPLETED')
     LIMIT 1`, [campaign.id, proof.user_id]);
    if (!contractRes.rows[0]) {
        throw new Error('active_contract_required');
    }
    const trustRow = await client.query('SELECT score FROM trust_scores WHERE user_id=$1', [proof.user_id]);
    const trustScore = trustRow.rows[0]?.score ?? 50;
    const escrowRes = await client.query('SELECT * FROM escrow_ledger WHERE campaign_id=$1', [escrowCampaignId]);
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
        return null;
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
    const userRes = await client.query('SELECT email, preferred_currency FROM users WHERE id=$1', [proof.user_id]);
    const user = userRes.rows[0];
    const walletRes = await client.query('SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE', [proof.user_id]);
    let wallet = walletRes.rows[0];
    if (!wallet) {
        const createdWallet = await client.query(`
      INSERT INTO wallets (user_id, currency, balance_available, balance_escrow, balance)
      VALUES ($1,$2,0,0,0)
      RETURNING *
      `, [
            proof.user_id,
            (user?.preferred_currency ?? 'UGX').toString().toUpperCase(),
        ]);
        wallet = createdWallet.rows[0];
    }
    await client.query(`
    UPDATE wallets
    SET balance_available = balance_available + $2,
        balance = balance + $2
    WHERE id=$1
    `, [wallet.id, campaign.payout_amount]);
    await client.query(`
    INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
    VALUES ($1,$2,'CREDIT',$3)
    `, [wallet.id, campaign.payout_amount, `PROOF_PAYOUT:${proof.id}`]);
    await client.query("UPDATE payout_requests SET status='PAID', pesapal_reference=$2 WHERE id=$1", [payoutRow.id, `WALLET_CREDIT:${proof.id}`]);
    return null;
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
        if (videoUrl.startsWith('/uploads/files/') || videoUrl.startsWith('/api/uploads/files/')) {
            const base = process.env.API_BASE_URL ?? 'http://localhost:3000';
            tempPath = await downloadToTemp(`${base}${videoUrl}`);
        }
        else if (videoUrl.startsWith('http')) {
            const parsed = new URL(videoUrl);
            if (!parsed.pathname.includes('/uploads/files/')) {
                throw new Error('disallowed_proof_video_url');
            }
            tempPath = await downloadToTemp(videoUrl);
        }
        else {
            throw new Error('invalid_proof_video_url');
        }
        if (!tempPath)
            throw new Error('temp_path_missing');
        const tamper = await runTamperChecks(tempPath, adapter?.roi);
        const result = await verifier.verify(tempPath, campaign, {
            challenge_code: session.challenge_code,
            challenge_phrase: session.challenge_phrase,
            expires_at: session.expires_at,
        });
        const trace = evaluateClientTrace(session.script, proof.meta, Number(tamper?.details?.duration ?? 0));
        const reasons = buildReviewReasons({ tamper, result, script: session.script, clientMeta: proof.meta });
        const finalDecision = 'MANUAL_REVIEW';
        const verificationReport = {
            generated_at: new Date().toISOString(),
            verifier_provider: verifierProvider,
            ai_decision: result.decision,
            ai_confidence: result.confidence,
            challenge_seen: Boolean(result.challenge_seen),
            observed_views: Number(result.observed_views ?? 0),
            tamper,
            python_bot: result.verifier_report ?? null,
            trace,
            strict_mode: true,
        };
        await withTransaction(async (client) => {
            await client.query(`UPDATE proofs
         SET decision=$2,
             observed_views=$3,
             observed_post_hash=$4,
             challenge_seen=$5,
             confidence=$6,
             review_reasons=$7::jsonb,
             meta = COALESCE(meta, '{}'::jsonb) || $8::jsonb,
             status=$2
         WHERE id=$1`, [
                proofId,
                finalDecision,
                result.observed_views,
                result.observed_post_hash,
                result.challenge_seen,
                result.confidence,
                JSON.stringify(reasons),
                JSON.stringify({ verification_report: verificationReport }),
            ]);
            const isAdvertiserProof = proof.user_id === campaign.advertiser_id;
            if (!isAdvertiserProof) {
                const delta = 0;
                await client.query('INSERT INTO trust_events (user_id, event_type, delta) VALUES ($1,$2,$3)', [proof.user_id, finalDecision, delta]);
                await client.query(`INSERT INTO trust_scores (user_id, score)
           VALUES ($1, 50)
           ON CONFLICT (user_id) DO NOTHING`, [proof.user_id]);
                await client.query(`UPDATE trust_scores
           SET score = LEAST(100, GREATEST(0, score + $2)),
               updated_at = now()
           WHERE user_id=$1`, [proof.user_id, delta]);
            }
            // Strict admin-gated verification mode:
            // payout jobs are only enqueued after explicit admin approval on /admin/proofs/:id.
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
            // Wallet crediting is completed inside the transaction.
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
async function expireOverdueContractsIfDue() {
    const now = Date.now();
    if (now - lastContractExpirySweepAt < 30_000)
        return;
    lastContractExpirySweepAt = now;
    await withTransaction(async (client) => {
        const expired = await client.query(`UPDATE contracts ctr
       SET status='CANCELLED',
           cancelled_at=COALESCE(cancelled_at, now())
       FROM campaigns c
       WHERE ctr.campaign_id = c.id
         AND ctr.status='ACTIVE'
         AND ctr.contract_deadline_at IS NOT NULL
         AND ctr.contract_deadline_at < now()
       RETURNING ctr.id, ctr.campaign_id, c.execution_mode`);
        const openCampaignIds = expired.rows
            .filter((row) => row.execution_mode === 'OPEN_BUDGET')
            .map((row) => row.campaign_id);
        if (openCampaignIds.length > 0) {
            await client.query(`
        UPDATE campaigns
        SET last_allocated_at = now() - interval '2 hours'
        WHERE id = ANY($1::uuid[])
        `, [openCampaignIds]);
        }
    });
}
async function runOpenContractAllocatorIfDue() {
    const now = Date.now();
    if (now - lastOpenAllocatorSweepAt < 30_000)
        return;
    lastOpenAllocatorSweepAt = now;
    await withTransaction(async (client) => {
        await ensureCampaignAllocatorColumns(client);
        await reallocateExpiredOpenAllocations(client);
        const roots = await getOpenRootCampaignsReadyForAllocation(client);
        for (const root of roots) {
            await allocateOpenCampaignShares(client, root);
        }
    });
}
async function loop() {
    while (true) {
        try {
            await expireOverdueContractsIfDue();
        }
        catch (err) {
            console.error('contract_expiry_sweep_failed', err);
        }
        try {
            await runOpenContractAllocatorIfDue();
        }
        catch (err) {
            console.error('open_contract_allocator_failed', err);
        }
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
