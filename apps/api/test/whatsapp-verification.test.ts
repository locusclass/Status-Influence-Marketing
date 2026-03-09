import { afterEach, describe, expect, it, vi } from 'vitest';

describe('WhatsApp verification service', () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env.WHATSAPP_VERIFICATION_MODE;
    delete process.env.WHATSAPP_MOCK_ALLOWED_PREFIXES;
  });

  it('accepts allowed numbers in mock mode', async () => {
    process.env.WHATSAPP_VERIFICATION_MODE = 'mock';
    process.env.WHATSAPP_MOCK_ALLOWED_PREFIXES = '+256,+254';

    const mod = await import('../src/services/whatsappVerification.js');
    const result = await mod.whatsappVerificationService.verifyPhone(
      '+256700123456'
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.normalizedPhone).toBe('+256700123456');
    }
  });

  it('rejects disallowed numbers in mock mode', async () => {
    process.env.WHATSAPP_VERIFICATION_MODE = 'mock';
    process.env.WHATSAPP_MOCK_ALLOWED_PREFIXES = '+256';

    const mod = await import('../src/services/whatsappVerification.js');
    const result = await mod.whatsappVerificationService.verifyPhone(
      '+233200123456'
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_on_whatsapp');
    }
  });
});
