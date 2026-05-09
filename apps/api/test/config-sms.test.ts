import { afterEach, describe, expect, it, vi } from 'vitest';

const SMS_ENV_KEYS = ['AT_USERNAME', 'AT_API_KEY', 'AT_SENDER_ID'] as const;

const ORIGINAL_ENV = new Map(
  SMS_ENV_KEYS.map((key) => [key, process.env[key]] as const)
);

async function loadConfig(
  env: Partial<Record<(typeof SMS_ENV_KEYS)[number], string>>
) {
  for (const key of SMS_ENV_KEYS) {
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(env)) {
    if (value != null) {
      process.env[key as (typeof SMS_ENV_KEYS)[number]] = value;
    }
  }

  vi.resetModules();
  return import('../src/config.js');
}

afterEach(() => {
  for (const key of SMS_ENV_KEYS) {
    const original = ORIGINAL_ENV.get(key);
    if (original == null) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
  vi.resetModules();
});

describe('Africa\'s Talking startup config', () => {
  it('uses sandbox endpoint when AT_USERNAME is sandbox', async () => {
    const configModule = await loadConfig({
      AT_USERNAME: 'sandbox',
      AT_API_KEY: 'sandbox-key',
      AT_SENDER_ID: 'PRIMESTATUS',
    });

    expect(configModule.config.africaTalking.environment).toBe('sandbox');
    expect(configModule.config.africaTalking.baseUrl).toBe(
      'https://api.sandbox.africastalking.com/version1/messaging'
    );
    expect(configModule.hasAfricaTalkingCredentials()).toBe(true);
  });

  it('uses live endpoint for non-sandbox usernames', async () => {
    const configModule = await loadConfig({
      AT_USERNAME: 'prime-status',
      AT_API_KEY: 'live-key',
      AT_SENDER_ID: 'PRIMESTATUS',
    });

    expect(configModule.config.africaTalking.environment).toBe('live');
    expect(configModule.config.africaTalking.baseUrl).toBe(
      'https://api.africastalking.com/version1/messaging'
    );
  });
});
