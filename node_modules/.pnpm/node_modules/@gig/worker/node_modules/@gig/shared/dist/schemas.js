import { z } from 'zod';
export const PlatformAdapterSchema = z.enum(['WHATSAPP_STATUS', 'TIKTOK', 'INSTAGRAM', 'X']);
export const CreateVerificationSessionSchema = z.object({
    user_id: z.string().uuid(),
    campaign_id: z.string().uuid(),
    platform: PlatformAdapterSchema
});
export const SubmitProofSchema = z.object({
    session_id: z.string().uuid(),
    proof_video_url: z.string().url(),
    device_fingerprint: z.string().min(16)
});
export const CreateCampaignSchema = z.object({
    advertiser_id: z.string().uuid(),
    title: z.string().min(3).max(120),
    platform: PlatformAdapterSchema,
    payout_amount: z.number().int().positive(),
    budget_total: z.number().int().positive(),
    start_date: z.string(),
    end_date: z.string()
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
