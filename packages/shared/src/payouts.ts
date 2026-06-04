// Platform fee is charged to the business on top of the promotion budget.
// Posters receive their full gross payout with no deduction.
export const AMBASSADOR_PLATFORM_FEE_PERCENT = 20;

export type AmbassadorPayoutBreakdown = {
  gross_amount: number;
  platform_fee_percent: number;
  platform_fee_amount: number;
  net_amount: number;
};

export function calculateAmbassadorPayoutBreakdown(
  grossAmount: number,
  feePercent = AMBASSADOR_PLATFORM_FEE_PERCENT
): AmbassadorPayoutBreakdown {
  const gross = Math.max(0, Math.round(Number(grossAmount) || 0));
  const normalizedPercent = Math.min(
    100,
    Math.max(0, Number.isFinite(Number(feePercent)) ? Number(feePercent) : 0)
  );
  // Fee is charged to the business; poster receives the full gross amount.
  const platformFeeAmount = Math.round((gross * normalizedPercent) / 100);
  const netAmount = gross;

  return {
    gross_amount: gross,
    platform_fee_percent: normalizedPercent,
    platform_fee_amount: platformFeeAmount,
    net_amount: netAmount,
  };
}
