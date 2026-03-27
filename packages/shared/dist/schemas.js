import { z } from 'zod';
export const PlatformAdapterSchema = z.enum(['WHATSAPP_STATUS', 'TIKTOK', 'X']);
export const MediaTypeSchema = z.enum(['IMAGE', 'VIDEO', 'TEXT']);
export const DeliveryModelSchema = z.enum(['DETERMINISTIC', 'PROBABILISTIC']);
export const CreateVerificationSessionSchema = z.object({
    user_id: z.string().trim().min(3),
    campaign_id: z.string().trim().min(3),
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
    delivery_model: DeliveryModelSchema.optional(),
    payout_amount: z.number().int().positive(),
    budget_total: z.number().int().positive(),
    execution_mode: z.enum(['PRIVATE_CONTRACT', 'OPEN_BUDGET']).optional(),
    visibility: z.enum(['PUBLIC', 'PRIVATE']).optional(),
    counterparty_contact: z.string().trim().min(7).max(20).optional(),
    beneficiary_contacts: z.array(z.string().trim().min(7).max(20)).optional(),
    start_date: z.string(),
    end_date: z.string(),
    media_type: MediaTypeSchema,
    media_url: z.string().url().optional(),
    media_text: z.string().trim().min(3).max(4000).optional(),
    execution_meta: z.record(z.any()).optional(),
    impression_target: z.number().int().min(1).optional(),
    platform_fee_percent: z.number().min(0).max(100).optional(),
    advertiser_wallet_mode: z.enum(['CAMPAIGN_ONLY']).optional(),
    terms_keep_hours: z.number().int().min(1).max(168).optional(),
    terms_min_views: z.number().int().min(1).optional().nullable(),
    terms_requirement: z.enum(['DURATION', 'VIEWS', 'BOTH']).optional()
})
    .superRefine((value, ctx) => {
    const hasMediaUrl = typeof value.media_url === 'string' && value.media_url.trim().length > 0;
    const hasMediaText = typeof value.media_text === 'string' &&
        value.media_text.trim().length > 0;
    if (!hasMediaUrl && !hasMediaText) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['media_url'],
            message: 'Either media_url or media_text is required.',
        });
    }
});
export const FundCampaignSchema = z.object({
    campaign_id: z.string().trim().min(3),
    amount: z.number().int().positive(),
    fund_source: z.enum(['FLUTTERWAVE', 'WALLET', 'PESAPAL']).optional(),
    return_url: z.string().trim().min(1).optional(),
    cancel_url: z.string().trim().min(1).optional(),
    network: z.enum(['MTN', 'AIRTEL']).optional()
});
export const TrustScoreEventSchema = z.object({
    user_id: z.string().trim().min(3),
    event_type: z.enum(['VERIFIED', 'REJECTED', 'MANUAL_REVIEW']),
    delta: z.number().int()
});
