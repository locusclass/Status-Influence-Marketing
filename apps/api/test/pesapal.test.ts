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
      paymentOptions: 'card,banktransfer,mobilemoneyuganda',
      paymentOptionsList: ['card', 'banktransfer', 'mobilemoneyuganda'],
      supportedPaymentMethods: ['CARD', 'BANK_TRANSFER', 'MOBILE_MONEY'],
      mobileMoneyNetworks: ['MTN', 'AIRTEL'],
    });
  });

  it('maps Kenya checkout to KES with M-Pesa mobile money', () => {
    expect(resolveFlutterwaveCheckoutProfile('KE')).toEqual({
      country: 'KE',
      currency: 'KES',
      paymentOptions: 'card,banktransfer,mpesa',
      paymentOptionsList: ['card', 'banktransfer', 'mpesa'],
      supportedPaymentMethods: ['CARD', 'BANK_TRANSFER', 'MOBILE_MONEY'],
      mobileMoneyNetworks: ['M-PESA'],
    });
  });

  it('maps every other country to USD card and bank transfer only', () => {
    expect(resolveFlutterwaveCheckoutProfile('NG')).toEqual({
      country: 'NG',
      currency: 'USD',
      paymentOptions: 'card,banktransfer',
      paymentOptionsList: ['card', 'banktransfer'],
      supportedPaymentMethods: ['CARD', 'BANK_TRANSFER'],
      mobileMoneyNetworks: [],
    });
  });
});
