import { FastifyInstance } from 'fastify';
import { CreateVerificationSessionSchema, SubmitProofSchema } from '@bakule/shared';
import { withTransaction } from '../db.js';
import { VerificationRepo } from '../repositories/verificationRepo.js';
import { JobRepo } from '../repositories/jobRepo.js';
import { generateChallengeCode, generateChallengePhrase, hashFingerprint } from '../utils.js';
import { config } from '../config.js';

const SESSION_DURATION_SECONDS = 60;
const SESSION_TTL_SECONDS = 10 * 60;

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
    'Open the posted advert video and keep it in frame.',
    'Open analytics/insights where views are visible.',
    'Scroll analytics panel down and back up once.',
    'Open comments then return to insights.',
    'Pause on engagement metrics for 3 seconds.',
    'Open share panel then close it.',
    'Replay the video briefly and return to analytics.',
  ],
  INSTAGRAM: [
    'Open the post and keep it in frame.',
    'Open post insights where views are visible.',
    'Scroll insights down and back up once.',
    'Open comments then return to insights.',
    'Open profile and return to the post.',
    'Switch to reels tab and return to the post.',
    'Hold on post metrics for 3 seconds.',
  ],
  X: [
    'Open the post and keep it in frame.',
    'Open analytics details where impressions are visible.',
    'Scroll analytics down and back up once.',
    'Open replies then return to analytics.',
    'Open profile card and close it.',
    'Refresh timeline then reopen analytics.',
    'Hold analytics screen for 3 seconds.',
  ],
};

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const temp = out[i];
    out[i] = out[j] as T;
    out[j] = temp as T;
  }
  return out;
}

function buildVerificationScript(platform: string) {
  const fallbackPool = platformInstructionPool.WHATSAPP_STATUS ?? [];
  const pool = platformInstructionPool[platform] ?? fallbackPool;
  const picks = shuffle(pool).slice(0, 4);
  const schedule = [5, 16, 28, 40];

  const scripted = picks.map((text, idx) => ({
    id: `step_${idx + 1}`,
    text,
    type: 'GESTURE',
    required: true,
    at_second: schedule[idx],
  }));

  scripted.push({
    id: 'show_code',
    text: 'Display the challenge code clearly and hold it for 3 seconds.',
    type: 'CHECKPOINT',
    required: true,
    at_second: 48,
  } as any);

  scripted.push({
    id: 'read_phrase',
    text: 'Read the challenge phrase clearly before recording ends.',
    type: 'CHECKPOINT',
    required: true,
    at_second: 55,
  } as any);

  return scripted;
}

function isAllowedProofVideoUrl(value: string): boolean {
  if (value.startsWith('/uploads/files/') || value.startsWith('/api/uploads/files/')) {
    return true;
  }
  try {
    const parsed = new URL(value);
    if (!parsed.pathname.includes('/uploads/files/')) return false;
    if (!config.apiBaseUrl) return true;
    const allowed = new URL(config.apiBaseUrl);
    return parsed.host === allowed.host;
  } catch {
    return false;
  }
}

export async function verificationRoutes(app: FastifyInstance) {
  const verificationRepo = new VerificationRepo();
  const jobRepo = new JobRepo();

  app.post('/verification/sessions', { preHandler: [app.authenticate] }, async (request, reply) => {
    const body = CreateVerificationSessionSchema.parse(request.body);
    const authUser = (request.user as any)?.sub as string | undefined;
    const role = (request.user as any)?.role as string | undefined;
    if (!authUser || authUser !== body.user_id) {
      reply.code(401);
      return { error: 'unauthorized' } as any;
    }
    if (role !== 'DISTRIBUTOR' && role !== 'ADMIN') {
      reply.code(403);
      return { error: 'forbidden' } as any;
    }

    const challenge_code = generateChallengeCode();
    const challenge_phrase = generateChallengePhrase();
    const script = buildVerificationScript(body.platform);
    const expires_at = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();

    const session = await withTransaction(async (client) => {
      const campaignRes = await client.query('SELECT id, status, platform FROM campaigns WHERE id=$1', [body.campaign_id]);
      const campaign = campaignRes.rows[0];
      if (!campaign) return { error: 'campaign_not_found' } as any;
      if (campaign.status !== 'ACTIVE') return { error: 'campaign_not_active' } as any;
      if (campaign.platform !== body.platform) return { error: 'platform_mismatch' } as any;

      const contractRes = await client.query(
        `SELECT id
         FROM contracts
         WHERE campaign_id=$1
           AND distributor_id=$2
           AND status='ACTIVE'
         LIMIT 1`,
        [body.campaign_id, authUser]
      );
      if (!contractRes.rows[0] && role !== 'ADMIN') return { error: 'contract_required' } as any;

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
        user_id: body.user_id,
        campaign_id: body.campaign_id,
        platform: body.platform,
        challenge_code,
        challenge_phrase,
        script,
        expires_at
      });
    });

    if ((session as any).error) {
      const codeMap: Record<string, number> = {
        campaign_not_found: 404,
        campaign_not_active: 409,
        platform_mismatch: 400,
        contract_required: 403,
        session_active_exists: 409,
      };
      reply.code(codeMap[(session as any).error] ?? 400);
      return session;
    }

    return {
      session,
      session_duration_seconds: SESSION_DURATION_SECONDS,
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

      const existingForSession = await client.query(
        'SELECT id FROM proofs WHERE session_id=$1 LIMIT 1',
        [body.session_id]
      );
      if (existingForSession.rows[0]) return { error: 'proof_already_submitted' } as any;

      const contractRes = await client.query(
        `SELECT id
         FROM contracts
         WHERE campaign_id=$1
           AND distributor_id=$2
           AND status='ACTIVE'
         LIMIT 1`,
        [session.campaign_id, authUser]
      );
      if (!contractRes.rows[0]) return { error: 'contract_not_active' } as any;

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

      const created = await verificationRepo.createProof(client, {
        session_id: body.session_id,
        user_id: authUser,
        video_url: body.proof_video_url,
        meta: body.client_meta ?? null
      });
      const fingerprintHash = hashFingerprint(body.device_fingerprint);
      await verificationRepo.insertDeviceFingerprint(client, authUser, fingerprintHash);

      await jobRepo.enqueue(client, 'VERIFY_PROOF', { proof_id: created.id });
      return created;
    });

    if ((proof as any).error) {
      const codeMap: Record<string, number> = {
        session_not_found: 404,
        session_user_mismatch: 403,
        session_expired: 409,
        proof_already_submitted: 409,
        contract_not_active: 403,
        duplicate_campaign_proof: 409,
      };
      reply.code(codeMap[(proof as any).error] ?? 400);
      return proof;
    }
    return { proof };
  });
}
