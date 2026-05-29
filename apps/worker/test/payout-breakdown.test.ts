import { describe, expect, it } from 'vitest';
import {
  calculateAmbassadorPayoutBreakdown,
  AMBASSADOR_PLATFORM_FEE_PERCENT,
} from '@prime/shared';

describe('calculateAmbassadorPayoutBreakdown', () => {
  it('tracks the platform fee charged to the business; ambassador receives full gross', () => {
    expect(calculateAmbassadorPayoutBreakdown(10_000)).toEqual({
      gross_amount: 10_000,
      platform_fee_percent: AMBASSADOR_PLATFORM_FEE_PERCENT,
      platform_fee_amount: 2_000,
      net_amount: 10_000,
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
