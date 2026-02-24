import { FastifyInstance } from 'fastify';
import { CreateVerificationSessionSchema, SubmitProofSchema } from '@bakule/shared';
import { withTransaction } from '../db.js';
import { VerificationRepo } from '../repositories/verificationRepo.js';
import { JobRepo } from '../repositories/jobRepo.js';
import { generateChallengeCode, generateChallengePhrase, hashFingerprint } from '../utils.js';

const gesturePool = [
  'Tap the viewer count three times.',
  'Scroll the viewer list from top to bottom, then bottom to top.',
  'Long-press the media preview for 2 seconds.',
  'Open the profile card, then close it.',
];

function pickGestures(count: number) {
  const shuffled = [...gesturePool].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, Math.max(1, count));
}

function buildVerificationScript(platform: string) {
  const gestures = pickGestures(2);
  if (platform === 'WHATSAPP_STATUS') {
    return [
      {
        id: 'open_status',
        text: 'Navigate to WhatsApp Status and open the advert status.',
        type: 'INSTRUCTION',
        required: true
      },
      {
        id: 'open_viewers',
        text: 'Tap the viewer count to open the viewer list.',
        type: 'INSTRUCTION',
        required: true
      },
      {
        id: 'gesture_1',
        text: gestures[0],
        type: 'GESTURE',
        required: true
      },
      {
        id: 'scroll_viewers',
        text: 'Scroll the viewer list from top to bottom, then bottom to top.',
        type: 'GESTURE',
        required: true
      },
      {
        id: 'show_code',
        text: 'Display the challenge code clearly in the recording.',
        type: 'CHECKPOINT',
        required: true
      },
      {
        id: 'read_phrase',
        text: 'Read the challenge phrase clearly.',
        type: 'CHECKPOINT',
        required: true
      },
      {
        id: 'gesture_2',
        text: gestures[1],
        type: 'GESTURE',
        required: true
      }
    ];
  }

  if (platform === 'TIKTOK') {
    return [
      {
        id: 'open_tiktok',
        text: 'Open TikTok and navigate to the published advert.',
        type: 'INSTRUCTION',
        required: true
      },
      {
        id: 'open_insights',
        text: 'Open the video insights / analytics view where views are visible.',
        type: 'INSTRUCTION',
        required: true
      },
      {
        id: 'gesture_1',
        text: gestures[0],
        type: 'GESTURE',
        required: true
      },
      {
        id: 'scroll_metrics',
        text: 'Scroll the insights panel down and back up to confirm live UI.',
        type: 'GESTURE',
        required: true
      },
      {
        id: 'show_code',
        text: 'Display the challenge code clearly in the recording.',
        type: 'CHECKPOINT',
        required: true
      },
      {
        id: 'read_phrase',
        text: 'Read the challenge phrase clearly.',
        type: 'CHECKPOINT',
        required: true
      },
      {
        id: 'gesture_2',
        text: gestures[1],
        type: 'GESTURE',
        required: true
      }
    ];
  }

  return [
    {
      id: 'open_platform',
      text: 'Open the target platform and show the advert.',
      type: 'INSTRUCTION',
      required: true
    },
    {
      id: 'show_views',
      text: 'Show the view count clearly.',
      type: 'CHECKPOINT',
      required: true
    },
    {
      id: 'show_code',
      text: 'Display the challenge code clearly in the recording.',
      type: 'CHECKPOINT',
      required: true
    },
    {
      id: 'read_phrase',
      text: 'Read the challenge phrase clearly.',
      type: 'CHECKPOINT',
      required: true
    }
  ];
}

export async function verificationRoutes(app: FastifyInstance) {
  const verificationRepo = new VerificationRepo();
  const jobRepo = new JobRepo();

  app.post('/verification/sessions', { preHandler: [app.authenticate] }, async (request) => {
    const body = CreateVerificationSessionSchema.parse(request.body);
    const authUser = (request.user as any)?.sub as string | undefined;
    if (!authUser || authUser !== body.user_id) {
      return { error: 'unauthorized' } as any;
    }
    const challenge_code = generateChallengeCode();
    const challenge_phrase = generateChallengePhrase();
    const script = buildVerificationScript(body.platform);
    const expires_at = new Date(Date.now() + 15 * 60 * 1000).toISOString();

    const session = await withTransaction(async (client) => {
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

    return { session };
  });

  app.post('/verification/proofs', { preHandler: [app.authenticate] }, async (request) => {
    const body = SubmitProofSchema.parse(request.body);
    const proof = await withTransaction(async (client) => {
      const session = await verificationRepo.getSession(client, body.session_id);
      if (!session) return { error: 'session_not_found' } as any;
      if (new Date(session.expires_at).getTime() < Date.now()) return { error: 'session_expired' } as any;

      const created = await verificationRepo.createProof(client, {
        session_id: body.session_id,
        user_id: session.user_id,
        video_url: body.proof_video_url,
        meta: body.client_meta ?? null
      });
      const fingerprintHash = hashFingerprint(body.device_fingerprint);
      await verificationRepo.insertDeviceFingerprint(client, session.user_id, fingerprintHash);

      await jobRepo.enqueue(client, 'VERIFY_PROOF', { proof_id: created.id });
      return created;
    });
    if ((proof as any).error) return proof;
    return { proof };
  });
}

