export declare const PROMOTER_PLATFORM_FEE_PERCENT = 15;
export type PromoterPayoutBreakdown = {
    gross_amount: number;
    platform_fee_percent: number;
    platform_fee_amount: number;
    net_amount: number;
};
export declare function calculatePromoterPayoutBreakdown(grossAmount: number, feePercent?: number): PromoterPayoutBreakdown;
