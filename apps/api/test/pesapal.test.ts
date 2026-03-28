import crypto from 'crypto';
import { describe, expect, it } from 'vitest';

import { verifyWebhookSignature } from '../src/services/flutterwave.js';
import { resolveFlutterwaveCheckoutProfile } from '../src/services/flutterwaveCheckoutProfile.js';

describe('Flutterwave payment configuration', () => {
  it('validates signature', () => {
    const body = JSON.stringify({ hello: 'world' });
    const secret = 'test-secret';
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyWebhookSignature(body, signature, secret)).toBe(true);
  });

  it('maps Uganda checkout to UGX with Airtel and MTN mobile money', () => {
    expect(resolveFlutterwaveCheckoutProfile('UG')).toEqual({
      country: 'UG',
      currency: 'UGX',
      phoneCountryCode: '256',
      paymentOptions: 'card,mobilemoneyuganda',
      paymentOptionsList: ['card', 'mobilemoneyuganda'],
      supportedPaymentMethods: ['CARD', 'MOBILE_MONEY'],
      mobileMoneyNetworks: ['MTN', 'AIRTEL'],
      availabilityNotes: [
        'Flutterwave v4 in Uganda supports cards and mobile money.',
      ],
    });
  });

  it('maps Kenya checkout to KES with M-Pesa mobile money', () => {
    expect(resolveFlutterwaveCheckoutProfile('KE')).toEqual({
      country: 'KE',
      currency: 'KES',
      phoneCountryCode: '254',
      paymentOptions: 'card,mpesa',
      paymentOptionsList: ['card', 'mpesa'],
      supportedPaymentMethods: ['CARD', 'MOBILE_MONEY'],
      mobileMoneyNetworks: ['M-PESA'],
      availabilityNotes: [
        'Flutterwave v4 in Kenya supports cards and M-Pesa.',
      ],
    });
  });

  it('maps every other country to USD card only', () => {
    expect(resolveFlutterwaveCheckoutProfile('NG')).toEqual({
      country: 'NG',
      currency: 'USD',
      phoneCountryCode: null,
      paymentOptions: 'card',
      paymentOptionsList: ['card'],
      supportedPaymentMethods: ['CARD'],
      mobileMoneyNetworks: [],
      availabilityNotes: [
        'Flutterwave v4 bank transfer is documented for NGN and GHS virtual accounts only, so USD checkout currently supports cards only.',
      ],
    });
  });
});
