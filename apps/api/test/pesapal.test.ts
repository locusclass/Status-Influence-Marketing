import crypto from 'crypto';
import { describe, expect, it } from 'vitest';

import { verifyWebhookSignature } from '../src/services/flutterwave.js';
import { resolveFlutterwaveCheckoutProfile } from '../src/services/flutterwaveCheckoutProfile.js';

describe('YO Uganda payment configuration', () => {
  it('validates signature', () => {
    const body = JSON.stringify({ hello: 'world' });
    const secret = 'test-secret';
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyWebhookSignature(body, signature, secret)).toBe(true);
  });

  it('maps Uganda checkout to UGX mobile money only', () => {
    expect(resolveFlutterwaveCheckoutProfile('UG')).toEqual({
      country: 'UG',
      currency: 'UGX',
      phoneCountryCode: '256',
      paymentOptions: 'mobilemoneyuganda',
      paymentOptionsList: ['mobilemoneyuganda'],
      supportedPaymentMethods: ['MOBILE_MONEY'],
      mobileMoneyNetworks: ['MTN', 'AIRTEL'],
      availabilityNotes: [
        'YO Uganda supports MTN and Airtel mobile money collections in UGX.',
      ],
    });
  });

  it('defaults every other country to the Uganda mobile money profile', () => {
    expect(resolveFlutterwaveCheckoutProfile('KE')).toEqual({
      country: 'UG',
      currency: 'UGX',
      phoneCountryCode: '256',
      paymentOptions: 'mobilemoneyuganda',
      paymentOptionsList: ['mobilemoneyuganda'],
      supportedPaymentMethods: ['MOBILE_MONEY'],
      mobileMoneyNetworks: ['MTN', 'AIRTEL'],
      availabilityNotes: [
        'YO Uganda currently routes collections through Uganda mobile money in UGX. Use an MTN or Airtel Uganda number to complete payment.',
      ],
    });
  });
});
