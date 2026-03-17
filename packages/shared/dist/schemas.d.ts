import { z } from 'zod';
export declare const PlatformAdapterSchema: z.ZodLiteral<"WHATSAPP_STATUS">;
export declare const MediaTypeSchema: z.ZodEnum<["IMAGE", "VIDEO"]>;
export declare const CreateVerificationSessionSchema: z.ZodObject<{
    user_id: z.ZodString;
    campaign_id: z.ZodString;
    platform: z.ZodLiteral<"WHATSAPP_STATUS">;
}, "strip", z.ZodTypeAny, {
    user_id: string;
    campaign_id: string;
    platform: "WHATSAPP_STATUS";
}, {
    user_id: string;
    campaign_id: string;
    platform: "WHATSAPP_STATUS";
}>;
export declare const SubmitProofSchema: z.ZodObject<{
    session_id: z.ZodString;
    proof_video_url: z.ZodString;
    device_fingerprint: z.ZodString;
    client_meta: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodAny>>;
}, "strip", z.ZodTypeAny, {
    session_id: string;
    proof_video_url: string;
    device_fingerprint: string;
    client_meta?: Record<string, any> | undefined;
}, {
    session_id: string;
    proof_video_url: string;
    device_fingerprint: string;
    client_meta?: Record<string, any> | undefined;
}>;
export declare const CreateCampaignSchema: z.ZodObject<{
    title: z.ZodString;
    platform: z.ZodLiteral<"WHATSAPP_STATUS">;
    payout_amount: z.ZodNumber;
    budget_total: z.ZodNumber;
    execution_mode: z.ZodOptional<z.ZodEnum<["PRIVATE_CONTRACT", "OPEN_BUDGET"]>>;
    visibility: z.ZodOptional<z.ZodEnum<["PUBLIC", "PRIVATE"]>>;
    counterparty_contact: z.ZodOptional<z.ZodString>;
    beneficiary_contacts: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    start_date: z.ZodString;
    end_date: z.ZodString;
    media_type: z.ZodEnum<["IMAGE", "VIDEO"]>;
    media_url: z.ZodString;
    impression_target: z.ZodOptional<z.ZodNumber>;
    platform_fee_percent: z.ZodOptional<z.ZodNumber>;
    advertiser_wallet_mode: z.ZodOptional<z.ZodEnum<["CAMPAIGN_ONLY"]>>;
    terms_keep_hours: z.ZodOptional<z.ZodNumber>;
    terms_min_views: z.ZodNullable<z.ZodOptional<z.ZodNumber>>;
    terms_requirement: z.ZodOptional<z.ZodEnum<["DURATION", "VIEWS", "BOTH"]>>;
}, "strip", z.ZodTypeAny, {
    platform: "WHATSAPP_STATUS";
    title: string;
    payout_amount: number;
    budget_total: number;
    start_date: string;
    end_date: string;
    media_type: "IMAGE" | "VIDEO";
    media_url: string;
    execution_mode?: "PRIVATE_CONTRACT" | "OPEN_BUDGET" | undefined;
    visibility?: "PUBLIC" | "PRIVATE" | undefined;
    counterparty_contact?: string | undefined;
    beneficiary_contacts?: string[] | undefined;
    impression_target?: number | undefined;
    platform_fee_percent?: number | undefined;
    advertiser_wallet_mode?: "CAMPAIGN_ONLY" | undefined;
    terms_keep_hours?: number | undefined;
    terms_min_views?: number | null | undefined;
    terms_requirement?: "DURATION" | "VIEWS" | "BOTH" | undefined;
}, {
    platform: "WHATSAPP_STATUS";
    title: string;
    payout_amount: number;
    budget_total: number;
    start_date: string;
    end_date: string;
    media_type: "IMAGE" | "VIDEO";
    media_url: string;
    execution_mode?: "PRIVATE_CONTRACT" | "OPEN_BUDGET" | undefined;
    visibility?: "PUBLIC" | "PRIVATE" | undefined;
    counterparty_contact?: string | undefined;
    beneficiary_contacts?: string[] | undefined;
    impression_target?: number | undefined;
    platform_fee_percent?: number | undefined;
    advertiser_wallet_mode?: "CAMPAIGN_ONLY" | undefined;
    terms_keep_hours?: number | undefined;
    terms_min_views?: number | null | undefined;
    terms_requirement?: "DURATION" | "VIEWS" | "BOTH" | undefined;
}>;
export declare const FundCampaignSchema: z.ZodObject<{
    campaign_id: z.ZodString;
    amount: z.ZodNumber;
    fund_source: z.ZodOptional<z.ZodEnum<["FLUTTERWAVE", "WALLET", "PESAPAL"]>>;
    return_url: z.ZodOptional<z.ZodString>;
    cancel_url: z.ZodOptional<z.ZodString>;
    network: z.ZodOptional<z.ZodEnum<["MTN", "AIRTEL"]>>;
}, "strip", z.ZodTypeAny, {
    campaign_id: string;
    amount: number;
    fund_source?: "FLUTTERWAVE" | "WALLET" | "PESAPAL" | undefined;
    return_url?: string | undefined;
    cancel_url?: string | undefined;
    network?: "MTN" | "AIRTEL" | undefined;
}, {
    campaign_id: string;
    amount: number;
    fund_source?: "FLUTTERWAVE" | "WALLET" | "PESAPAL" | undefined;
    return_url?: string | undefined;
    cancel_url?: string | undefined;
    network?: "MTN" | "AIRTEL" | undefined;
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
