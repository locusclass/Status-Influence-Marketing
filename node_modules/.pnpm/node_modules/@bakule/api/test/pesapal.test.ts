import crypto from 'crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { verifyWebhookSignature } from '../src/services/pesapal.js';

describe('PesaPal webhook validation', () => {
  it('validates signature', () => {
    const body = JSON.stringify({ hello: 'world' });
    const secret = 'test-secret';
    const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
    expect(verifyWebhookSignature(body, signature, secret)).toBe(true);
  });

  it('uses UGX for campaign funding instead of user preference currency', () => {
    const routeSource = readFileSync(
      resolve(process.cwd(), 'src/routes/campaigns.ts'),
      'utf8'
    );
    expect(routeSource).toContain("const pesapalCurrency = 'UGX'");
    expect(routeSource).toContain('currency: pesapalCurrency');
  });
});
