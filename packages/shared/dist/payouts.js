export const AMBASSADOR_PLATFORM_FEE_PERCENT = 15;
export function calculateAmbassadorPayoutBreakdown(grossAmount, feePercent = AMBASSADOR_PLATFORM_FEE_PERCENT) {
    const gross = Math.max(0, Math.round(Number(grossAmount) || 0));
    const normalizedPercent = Math.min(100, Math.max(0, Number.isFinite(Number(feePercent)) ? Number(feePercent) : 0));
    const platformFeeAmount = Math.round((gross * normalizedPercent) / 100);
    const netAmount = Math.max(0, gross - platformFeeAmount);
    return {
        gross_amount: gross,
        platform_fee_percent: normalizedPercent,
        platform_fee_amount: platformFeeAmount,
        net_amount: netAmount,
    };
}
