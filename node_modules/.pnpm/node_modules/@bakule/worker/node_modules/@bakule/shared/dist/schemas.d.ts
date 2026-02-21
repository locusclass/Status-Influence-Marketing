import { z } from 'zod';
export declare const PlatformAdapterSchema: z.ZodEnum<["WHATSAPP_STATUS", "TIKTOK", "INSTAGRAM", "X"]>;
export declare const CreateVerificationSessionSchema: z.ZodObject<{
    user_id: z.ZodString;
    campaign_id: z.ZodString;
    platform: z.ZodEnum<["WHATSAPP_STATUS", "TIKTOK", "INSTAGRAM", "X"]>;
}, "strip", z.ZodTypeAny, {
    user_id: string;
    campaign_id: string;
    platform: "WHATSAPP_STATUS" | "TIKTOK" | "INSTAGRAM" | "X";
}, {
    user_id: string;
    campaign_id: string;
    platform: "WHATSAPP_STATUS" | "TIKTOK" | "INSTAGRAM" | "X";
}>;
export declare const SubmitProofSchema: z.ZodObject<{
    session_id: z.ZodString;
    proof_video_url: z.ZodString;
    device_fingerprint: z.ZodString;
}, "strip", z.ZodTypeAny, {
    session_id: string;
    proof_video_url: string;
    device_fingerprint: string;
}, {
    session_id: string;
    proof_video_url: string;
    device_fingerprint: string;
}>;
export declare const CreateCampaignSchema: z.ZodObject<{
    advertiser_id: z.ZodString;
    title: z.ZodString;
    platform: z.ZodEnum<["WHATSAPP_STATUS", "TIKTOK", "INSTAGRAM", "X"]>;
    payout_amount: z.ZodNumber;
    budget_total: z.ZodNumber;
    start_date: z.ZodString;
    end_date: z.ZodString;
}, "strip", z.ZodTypeAny, {
    platform: "WHATSAPP_STATUS" | "TIKTOK" | "INSTAGRAM" | "X";
    advertiser_id: string;
    title: string;
    payout_amount: number;
    budget_total: number;
    start_date: string;
    end_date: string;
}, {
    platform: "WHATSAPP_STATUS" | "TIKTOK" | "INSTAGRAM" | "X";
    advertiser_id: string;
    title: string;
    payout_amount: number;
    budget_total: number;
    start_date: string;
    end_date: string;
}>;
export declare const FundCampaignSchema: z.ZodObject<{
    campaign_id: z.ZodString;
    amount: z.ZodNumber;
    return_url: z.ZodString;
    cancel_url: z.ZodString;
}, "strip", z.ZodTypeAny, {
    campaign_id: string;
    amount: number;
    return_url: string;
    cancel_url: string;
}, {
    campaign_id: string;
    amount: number;
    return_url: string;
    cancel_url: string;
}>;
export declare const TrustScoreEventSchema: z.ZodObject<{
    user_id: z.ZodString;
    event_type: z.ZodEnum<["VERIFIED", "REJECTED", "MANUAL_REVIEW"]>;
    delta: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    user_id: string;
    event_type: "VERIFIED" | "REJECTED" | "MANUAL_REVIEW";
    delta: number;
}, {
    user_id: string;
    event_type: "VERIFIED" | "REJECTED" | "MANUAL_REVIEW";
    delta: number;
}>;
