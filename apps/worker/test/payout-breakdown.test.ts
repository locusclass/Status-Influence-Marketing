import { describe, expect, it } from 'vitest';
import {
  calculateAmbassadorPayoutBreakdown,
  Ambassador_PLATFORM_FEE_PERCENT,
} from '@prime/shared';

describe('calculateAmbassadorPayoutBreakdown', () => {
  it('credits the gross amount and derives the platform fee from Ambassador earnings', () => {
    expect(calculateAmbassadorPayoutBreakdown(10_000)).toEqual({
      gross_amount: 10_000,
      platform_fee_percent: Ambassador_PLATFORM_FEE_PERCENT,
      platform_fee_amount: 1_500,
      net_amount: 8_500,
    });
  });

  it('clamps invalid inputs safely', () => {
    expect(calculateAmbassadorPayoutBreakdown(-500, 250)).toEqual({
      gross_amount: 0,
      platform_fee_percent: 100,
      platform_fee_amount: 0,
      net_amount: 0,
    });
  });
});
