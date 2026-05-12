import { z } from 'zod';
export const PlatformAdapterSchema = z.enum(['WHATSAPP_STATUS']);
export const MediaTypeSchema = z.enum(['IMAGE', 'VIDEO', 'TEXT']);
export const DeliveryModelSchema = z.enum(['DETERMINISTIC', 'PROBABILISTIC']);
export const PricePrivacyModeSchema = z.enum(['NEGOTIABLE', 'FIXED']);
const BeneficiaryPricingSchema = z.object({
    user_id: z.string().uuid().optional(),
    phone: z.string().trim().min(7).max(20).optional(),
    selected_rate_ugx: z.number().int().positive(),
    impression_target: z.number().int().min(1).optional(),
    pricing_reference_engagements_24h: z.number().int().min(1).optional(),
});
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
export const CampaignBundleItemSchema = z
    .object({
    title: z.string().min(3).max(120).optional(),
    platform: PlatformAdapterSchema,
    delivery_model: DeliveryModelSchema.optional(),
    payout_amount: z.number().int().positive(),
    budget_total: z.number().int().positive(),
    execution_mode: z.enum(['PRIVATE_CONTRACT']).optional(),
    visibility: z.enum(['PRIVATE']).optional(),
    counterparty_contact: z.string().trim().min(7).max(20).optional(),
    beneficiary_contacts: z.array(z.string().trim().min(7).max(20)).optional(),
    beneficiary_user_ids: z.array(z.string().uuid()).optional(),
    beneficiary_group_id: z.string().uuid().optional(),
    beneficiary_pricing: z.array(BeneficiaryPricingSchema).max(200).optional(),
    start_date: z.string(),
    end_date: z.string(),
    media_type: MediaTypeSchema,
    media_url: z.string().url().optional(),
    media_urls: z.array(z.string().url()).max(8).optional(),
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
    const hasMediaUrl = (typeof value.media_url === 'string' &&
        value.media_url.trim().length > 0) ||
        (Array.isArray(value.media_urls) &&
            value.media_urls.some((entry) => String(entry ?? '').trim().length > 0));
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
export const CreateCampaignSchema = z
    .object({
    title: z.string().min(3).max(120).optional(),
    platform: PlatformAdapterSchema.optional(),
    platforms: z.array(PlatformAdapterSchema).min(1).max(3).optional(),
    bundle_items: z.array(CampaignBundleItemSchema).min(1).max(3).optional(),
    delivery_model: DeliveryModelSchema.optional(),
    payout_amount: z.number().int().positive().optional(),
    budget_total: z.number().int().positive().optional(),
    execution_mode: z.enum(['PRIVATE_CONTRACT']).optional(),
    visibility: z.enum(['PRIVATE']).optional(),
    counterparty_contact: z.string().trim().min(7).max(20).optional(),
    beneficiary_contacts: z.array(z.string().trim().min(7).max(20)).optional(),
    beneficiary_user_ids: z.array(z.string().uuid()).optional(),
    beneficiary_group_id: z.string().uuid().optional(),
    beneficiary_pricing: z.array(BeneficiaryPricingSchema).max(200).optional(),
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    media_type: MediaTypeSchema.optional(),
    media_url: z.string().url().optional(),
    media_urls: z.array(z.string().url()).max(8).optional(),
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
    const hasBundleItems = Array.isArray(value.bundle_items) && value.bundle_items.length > 0;
    const hasSharedPlatforms = Array.isArray(value.platforms) && value.platforms.length > 0;
    const hasTitle = typeof value.title === 'string' && value.title.trim().length > 0;
    const hasMediaUrl = (typeof value.media_url === 'string' &&
        value.media_url.trim().length > 0) ||
        (Array.isArray(value.media_urls) &&
            value.media_urls.some((entry) => String(entry ?? '').trim().length > 0));
    const hasMediaText = typeof value.media_text === 'string' &&
        value.media_text.trim().length > 0;
    if (!hasBundleItems) {
        if (!hasTitle) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['title'],
                message: 'title is required.',
            });
        }
        if (!value.platform && !hasSharedPlatforms) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['platform'],
                message: 'Either platform or platforms is required.',
            });
        }
        if (typeof value.payout_amount !== 'number') {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['payout_amount'],
                message: 'payout_amount is required.',
            });
        }
        if (typeof value.budget_total !== 'number') {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['budget_total'],
                message: 'budget_total is required.',
            });
        }
        if (typeof value.start_date !== 'string' || value.start_date.trim().length === 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['start_date'],
                message: 'start_date is required.',
            });
        }
        if (typeof value.end_date !== 'string' || value.end_date.trim().length === 0) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['end_date'],
                message: 'end_date is required.',
            });
        }
        if (!value.media_type) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['media_type'],
                message: 'media_type is required.',
            });
        }
    }
    else if (!hasTitle) {
        value.bundle_items?.forEach((item, index) => {
            if (typeof item?.title === 'string' && item.title.trim().length > 0) {
                return;
            }
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['bundle_items', index, 'title'],
                message: 'title is required when the bundle has no shared title.',
            });
        });
    }
    if (!hasBundleItems && !hasMediaUrl && !hasMediaText) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['media_url'],
            message: 'Either media_url or media_text is required.',
        });
    }
    if (Array.isArray(value.platforms) &&
        value.platforms.length > 0 &&
        Array.isArray(value.bundle_items) &&
        value.bundle_items.length > 0) {
        const bundlePlatforms = new Set(value.bundle_items.map((item) => item.platform));
        const declaredPlatforms = new Set(value.platforms);
        if (bundlePlatforms.size !== declaredPlatforms.size ||
            [...bundlePlatforms].some((platform) => !declaredPlatforms.has(platform))) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['bundle_items'],
                message: 'bundle_items platforms must match platforms.',
            });
        }
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


