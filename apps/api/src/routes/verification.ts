import { FastifyInstance } from 'fastify';
import {
  CreateVerificationSessionSchema,
  PlatformAdapterSchema,
  SubmitProofSchema,
} from '@prime/shared';
import { withTransaction } from '../db.js';
import { VerificationRepo } from '../repositories/verificationRepo.js';
import { JobRepo } from '../repositories/jobRepo.js';
import { generateChallengeCode, generateChallengePhrase, hashFingerprint } from '../utils.js';
import { randomInt } from 'crypto';
import { config } from '../config.js';
import { ensurePublicIdColumns, resolveUserId } from '../services/publicId.js';
import { canAccessDistributorFeatures } from '../services/roles.js';

const SESSION_DURATION_SECONDS = 60;
const SESSION_TTL_SECONDS = 10 * 60;
const MIN_RECORDING_SECONDS = 58;
const MAX_RECORDING_SECONDS = 75;
const STEP_TIMING_LEEWAY_SECONDS = 12;
const SUPPORTED_PLATFORM_CHECK_SQL = `CHECK (platform IN (${PlatformAdapterSchema.options
  .map((platform) => `'${platform}'`)
  .join(', ')}))`;

const platformInstructionPool: Record<string, string[]> = {
  WHATSAPP_STATUS: [
    'Open the status post and keep it centered in frame.',
    'Open viewer insights and hold steady for 3 seconds.',
    'Scroll the viewer list down and back up once.',
    'Tap viewer count three times with pauses.',
    'Open profile card then close it.',
    'Switch to another status briefly and return.',
    'Long-press the media preview for 2 seconds.',
  ],
  TIKTOK: [
    'Open the public video post and keep the creator profile visible.',
    'Open the metrics area and hold steady for 3 seconds.',
    'Refresh the page once, then return to the metrics view.',
    'Open the comments sheet briefly, then close it.',
    'Show the share sheet for 2 seconds and dismiss it.',
    'Scroll the caption area down and back up once.',
    'Keep the post URL and post ID visible before returning to the video.',
  ],
  X: [
    'Open the live post and keep the full tweet in frame.',
    'Open the analytics or metrics row and hold steady for 3 seconds.',
    'Refresh the post once, then return to the metrics view.',
    'Open the repost or quote detail briefly, then close it.',
    'Scroll through the thread or replies down and back up once.',
    'Hold the timestamp and account handle visible for 2 seconds.',
    'Return to the main post and keep impressions visible before the next step.',
  ],
};

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    const temp = out[i];
    out[i] = out[j] as T;
    out[j] = temp as T;
  }
  return out;
}

function buildVerificationScript(platform: string) {
  const pool = platformInstructionPool[platform];
  if (!pool || pool.length < 4) {
    throw new Error(`unsupported_platform:${platform}`);
  }
  const picks = shuffle(pool).slice(0, 4);
  const schedule = [
    randomInt(4, 9),
    randomInt(14, 20),
    randomInt(25, 32),
    randomInt(36, 44),
  ];

  const scripted = picks.map((text, idx) => ({
    id: `step_${idx + 1}_${randomInt(100000, 999999)}`,
    text,
    type: 'GESTURE',
    required: true,
    at_second: schedule[idx],
  }));

  scripted.push({
    id: `show_code_${randomInt(100000, 999999)}`,
    text: 'Display the challenge code clearly and hold it for 3 seconds.',
    type: 'CHECKPOINT',
    required: true,
    at_second: randomInt(46, 52),
  } as any);

  scripted.push({
    id: `read_phrase_${randomInt(100000, 999999)}`,
    text: 'Read the challenge phrase clearly before recording ends.',
    type: 'CHECKPOINT',
    required: true,
    at_second: randomInt(53, 58),
  } as any);

  return scripted;
}

function extractRequiredStepIds(script: any): string[] {
  const steps = Array.isArray(script) ? script : [];
  return steps.filter((step) => step?.required !== false).map((step) => String(step?.id ?? '')).filter(Boolean);
}

function validateStrictClientMeta(clientMeta: any, script: any): string | null {
  if (!clientMeta || typeof clientMeta !== 'object') return 'client_meta_required';
  const startedAt = Date.parse(String(clientMeta?.recording_started_at ?? ''));
  const stoppedAt = Date.parse(String(clientMeta?.recording_stopped_at ?? ''));
  if (!Number.isFinite(startedAt) || !Number.isFinite(stoppedAt) || stoppedAt <= startedAt) {
    return 'client_meta_recording_window_invalid';
  }
  const duration = Math.round((stoppedAt - startedAt) / 1000);
  if (duration < MIN_RECORDING_SECONDS || duration > MAX_RECORDING_SECONDS) {
    return 'client_meta_recording_duration_invalid';
  }
  const events = Array.isArray(clientMeta?.steps) ? clientMeta.steps : [];
  if (!events.length) return 'client_meta_steps_missing';
  const eventIds = events
    .map((event: any) => String(event?.id ?? '').trim())
    .filter(Boolean);
  const completed = new Set(eventIds);
  const steps = Array.isArray(script) ? script.filter((step) => step?.required !== false) : [];
  const requiredIds = extractRequiredStepIds(script);
  const missing = requiredIds.filter((id) => !completed.has(id));
  if (missing.length > 0) return 'client_meta_required_steps_missing';
  if (eventIds.join('|') !== requiredIds.join('|')) {
    return 'client_meta_step_sequence_invalid';
  }

  for (const step of steps) {
    const stepId = String(step?.id ?? '').trim();
    if (!stepId) continue;
    const matchingEvent = events.find((event: any) => String(event?.id ?? '').trim() === stepId);
    if (!matchingEvent) return 'client_meta_required_steps_missing';
    const scheduledSecond = Number(step?.at_second ?? 0);
    const completedSecondRaw =
      Number.isFinite(Number(matchingEvent?.completed_second))
        ? Number(matchingEvent.completed_second)
        : Math.round(
            (Date.parse(String(matchingEvent?.completed_at ?? '')) - startedAt) / 1000
          );
    if (!Number.isFinite(completedSecondRaw)) {
      return 'client_meta_step_timing_invalid';
    }
    if (
      completedSecondRaw < Math.max(0, scheduledSecond - STEP_TIMING_LEEWAY_SECONDS) ||
      completedSecondRaw > scheduledSecond + STEP_TIMING_LEEWAY_SECONDS
    ) {
      return 'client_meta_step_timing_invalid';
    }
  }
  return null;
}

async function getActiveDistributorContract(
  client: any,
  campaignId: string,
  userId: string
) {
  const contractRes = await client.query(
    `SELECT id, post_deadline_at, contract_deadline_at
     FROM contracts
     WHERE campaign_id=$1
       AND distributor_id=$2
       AND status='ACTIVE'
     LIMIT 1`,
    [campaignId, userId]
  );
  return contractRes.rows[0] ?? null;
}

function hasDeadlinePassed(raw: unknown) {
  if (!raw) return false;
  const deadline = Date.parse(String(raw));
  return Number.isFinite(deadline) && deadline < Date.now();
}

function isAllowedProofVideoUrl(value: string): boolean {
  if (value.startsWith('/uploads/files/') || value.startsWith('/api/uploads/files/')) {
    const parsed = new URL(value, 'http://local.test');
    const mime = String(parsed.searchParams.get('mime') ?? '');
    return mime.startsWith('video/');
  }
  try {
    const parsed = new URL(value);
    if (!parsed.pathname.includes('/uploads/files/')) return false;
    const mime = String(parsed.searchParams.get('mime') ?? '');
    if (!mime.startsWith('video/')) return false;
    if (!config.apiBaseUrl) return true;
    const allowed = new URL(config.apiBaseUrl);
    return parsed.host === allowed.host;
  } catch {
    return false;
  }
}

async function ensureVerificationSessionColumns(client: any) {
  await ensurePublicIdColumns(client);
  await client.query(`
    DO $$ BEGIN
      IF to_regclass('public.verification_sessions') IS NOT NULL THEN
        ALTER TABLE verification_sessions DROP CONSTRAINT IF EXISTS verification_sessions_platform_check;
        ALTER TABLE verification_sessions
          ADD CONSTRAINT verification_sessions_platform_check ${SUPPORTED_PLATFORM_CHECK_SQL};
      END IF;
    END $$;
  `);
}

export async function verificationRoutes(app: FastifyInstance) {
  await withTransaction(async (client) => {
    await ensureVerificationSessionColumns(client);
  });

  const verificationRepo = new VerificationRepo();
  const jobRepo = new JobRepo();

  app.post('/verification/sessions', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = CreateVerificationSessionSchema.parse(request.body);
    const authUser = (request.user as any)?.sub as string | undefined;
    const role = (request.user as any)?.role as string | undefined;
    if (!authUser) {
      reply.code(401);
      return { error: 'unauthorized' } as any;
    }
    if (!canAccessDistributorFeatures(role)) {
      reply.code(403);
      return { error: 'forbidden' } as any;
    }

    const challenge_code = generateChallengeCode();
    const challenge_phrase = generateChallengePhrase();
    const expires_at = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

    const session = await withTransaction(async (client) => {
      await ensureVerificationSessionColumns(client);
      const resolvedUserId = await resolveUserId(client, body.user_id);
      if (!resolvedUserId || authUser !== resolvedUserId) {
        return { error: 'unauthorized' } as any;
      }
      const campaignRes = await client.query(
        'SELECT id, public_id, status, platform FROM campaigns WHERE id::text=$1 OR public_id=$1 LIMIT 1',
        [body.campaign_id]
      );
      const campaign = campaignRes.rows[0];
      if (!campaign) return { error: 'campaign_not_found' } as any;
      if (campaign.status !== 'ACTIVE') return { error: 'campaign_not_active' } as any;
      if (campaign.platform !== body.platform) return { error: 'platform_mismatch' } as any;
      const script = (() => {
        try {
          return buildVerificationScript(body.platform);
        } catch {
          return { error: 'unsupported_platform' } as any;
        }
      })();
      if ((script as any).error) {
        return script;
      }

      const contract = await getActiveDistributorContract(
        client,
        body.campaign_id,
        authUser
      );
      if (!contract && role !== 'ADMIN') return { error: 'contract_required' } as any;
      if (contract && hasDeadlinePassed(contract.contract_deadline_at)) {
        return { error: 'contract_not_active' } as any;
      }
      if (contract && hasDeadlinePassed(contract.post_deadline_at)) {
        return { error: 'post_deadline_passed' } as any;
      }

      const activeSessionRes = await client.query(
        `SELECT id
         FROM verification_sessions
         WHERE campaign_id=$1
           AND user_id=$2
           AND expires_at > now()
         ORDER BY created_at DESC
         LIMIT 1`,
        [body.campaign_id, authUser]
      );
      if (activeSessionRes.rows[0]) {
        return { error: 'session_active_exists' } as any;
      }

      return verificationRepo.createSession(client, {
        user_id: resolvedUserId,
        campaign_id: campaign.id,
        platform: body.platform,
        challenge_code,
        challenge_phrase,
        script,
        expires_at
      });
    });

    if ((session as any).error) {
      const codeMap: Record<string, number> = {
        unauthorized: 401,
        campaign_not_found: 404,
        campaign_not_active: 409,
        platform_mismatch: 400,
        unsupported_platform: 400,
        contract_required: 403,
        post_deadline_passed: 409,
        session_active_exists: 409,
      };
      reply.code(codeMap[(session as any).error] ?? 400);
      return session;
    }

    return {
      session,
      session_duration_seconds: SESSION_DURATION_SECONDS,
      recording_policy: {
        mode: 'SCREEN_RECORDING',
        duration_seconds: SESSION_DURATION_SECONDS,
        min_duration_seconds: MIN_RECORDING_SECONDS,
        max_duration_seconds: MAX_RECORDING_SECONDS,
        strict_trace_required: true,
      },
    };
  });

  app.post('/verification/proofs', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = SubmitProofSchema.parse(request.body);
    const authUser = (request.user as any)?.sub as string | undefined;
    if (!authUser) {
      reply.code(401);
      return { error: 'unauthorized' } as any;
    }
    if (!isAllowedProofVideoUrl(body.proof_video_url)) {
      reply.code(400);
      return { error: 'invalid_proof_video_url' } as any;
    }

    const proof = await withTransaction(async (client) => {
      const session = await verificationRepo.getSession(client, body.session_id);
      if (!session) return { error: 'session_not_found' } as any;
      if (session.user_id !== authUser) return { error: 'session_user_mismatch' } as any;
      if (new Date(session.expires_at).getTime() < Date.now()) return { error: 'session_expired' } as any;
      const strictMetaError = validateStrictClientMeta(body.client_meta, session.script);
      if (strictMetaError) return { error: strictMetaError } as any;

      const existingForSession = await client.query(
        'SELECT id FROM proofs WHERE session_id=$1 LIMIT 1',
        [body.session_id]
      );
      if (existingForSession.rows[0]) return { error: 'proof_already_submitted' } as any;

      const contract = await getActiveDistributorContract(
        client,
        session.campaign_id,
        authUser
      );
      if (!contract) return { error: 'contract_not_active' } as any;
      if (hasDeadlinePassed(contract.contract_deadline_at)) {
        return { error: 'contract_not_active' } as any;
      }
      if (hasDeadlinePassed(contract.post_deadline_at)) {
        return { error: 'post_deadline_passed' } as any;
      }

      const priorProof = await client.query(
        `SELECT p.id
         FROM proofs p
         JOIN verification_sessions s ON s.id = p.session_id
         WHERE s.campaign_id=$1
           AND p.user_id=$2
           AND p.status IN ('PENDING','MANUAL_REVIEW','VERIFIED')
         LIMIT 1`,
        [session.campaign_id, authUser]
      );
      if (priorProof.rows[0]) return { error: 'duplicate_campaign_proof' } as any;

      const fingerprintHash = hashFingerprint(body.device_fingerprint);
      const fingerprintConflict = await client.query(
        `SELECT 1
         FROM device_fingerprints
         WHERE fingerprint_hash=$1
           AND user_id <> $2
         LIMIT 1`,
        [fingerprintHash, authUser]
      );
      if (fingerprintConflict.rows[0]) {
        return { error: 'device_fingerprint_conflict' } as any;
      }

      const created = await verificationRepo.createProof(client, {
        session_id: body.session_id,
        user_id: authUser,
        video_url: body.proof_video_url,
        meta: body.client_meta ?? null
      });
      await verificationRepo.insertDeviceFingerprint(client, authUser, fingerprintHash);

      await jobRepo.enqueue(client, 'VERIFY_PROOF', { proof_id: created.id });
      return created;
    });

    if ((proof as any).error) {
      const codeMap: Record<string, number> = {
        session_not_found: 404,
        session_user_mismatch: 403,
        session_expired: 409,
        client_meta_required: 400,
        client_meta_recording_window_invalid: 400,
        client_meta_recording_duration_invalid: 400,
        client_meta_steps_missing: 400,
        client_meta_required_steps_missing: 400,
        client_meta_step_sequence_invalid: 400,
        client_meta_step_timing_invalid: 400,
        proof_already_submitted: 409,
        contract_not_active: 403,
        post_deadline_passed: 409,
        duplicate_campaign_proof: 409,
        device_fingerprint_conflict: 409,
      };
      reply.code(codeMap[(proof as any).error] ?? 400);
      return proof;
    }
    return { proof };
  });
}
