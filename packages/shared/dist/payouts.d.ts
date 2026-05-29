export declare const AMBASSADOR_PLATFORM_FEE_PERCENT = 20;
export type AmbassadorPayoutBreakdown = {
    gross_amount: number;
    platform_fee_percent: number;
    platform_fee_amount: number;
    net_amount: number;
};
export declare function calculateAmbassadorPayoutBreakdown(grossAmount: number, feePercent?: number): AmbassadorPayoutBreakdown;
