import { z } from 'zod';

export const PlatformAdapterSchema = z.enum(['WHATSAPP_STATUS', 'TIKTOK', 'INSTAGRAM', 'X']);
export const MediaTypeSchema = z.enum(['TEXT', 'IMAGE', 'VIDEO']);

export const CreateVerificationSessionSchema = z.object({
  user_id: z.string().uuid(),
  campaign_id: z.string().uuid(),
  platform: PlatformAdapterSchema
});

export const SubmitProofSchema = z.object({
  session_id: z.string().uuid(),
  proof_video_url: z.string().url(),
  device_fingerprint: z.string().min(16),
  client_meta: z.record(z.any()).optional()
});

export const CreateCampaignSchema = z
  .object({
    title: z.string().min(3).max(120),
    platform: PlatformAdapterSchema,
    payout_amount: z.number().int().positive(),
    budget_total: z.number().int().positive(),
    start_date: z.string(),
    end_date: z.string(),
    media_type: MediaTypeSchema,
    media_text: z.string().trim().max(2000).optional(),
    media_url: z.string().url().optional(),
    terms_keep_hours: z.number().int().min(1).max(168).optional(),
    terms_min_views: z.number().int().min(1).optional().nullable(),
    terms_requirement: z.enum(['DURATION', 'VIEWS', 'BOTH']).optional()
  })
  .superRefine((value, ctx) => {
    if (value.media_type === 'TEXT' && !value.media_text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'media_text is required for TEXT media.',
        path: ['media_text']
      });
    }
    if (value.media_type !== 'TEXT' && !value.media_url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'media_url is required for IMAGE or VIDEO media.',
        path: ['media_url']
      });
    }
  });

export const FundCampaignSchema = z.object({
  campaign_id: z.string().uuid(),
  amount: z.number().int().positive(),
  return_url: z.string().url(),
  cancel_url: z.string().url()
});

export const TrustScoreEventSchema = z.object({
  user_id: z.string().uuid(),
  event_type: z.enum(['VERIFIED', 'REJECTED', 'MANUAL_REVIEW']),
  delta: z.number().int()
});
