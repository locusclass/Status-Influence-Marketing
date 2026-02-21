import { describe, it, expect } from 'vitest';
import { verifyWebhookSignature } from '../src/services/pesapal.js';
import crypto from 'crypto';

describe('PesaPal webhook validation', () => {
  it('validates signature', () => {
    const body = JSON.stringify({ hello: 'world' });
    const secret = 'test-secret';
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyWebhookSignature(body, signature, secret)).toBe(true);
  });
});
