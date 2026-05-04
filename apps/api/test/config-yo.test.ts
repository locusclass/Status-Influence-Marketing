import { afterEach, describe, expect, it, vi } from 'vitest';

const YO_ENV_KEYS = [
  'YO_PROXY_URL',
  'YO_BASE_URL',
  'YO_API_URL',
  'YO_AUTHORIZATION',
  'YO_API_USERNAME',
  'YO_API_PASSWORD',
] as const;

const ORIGINAL_ENV = new Map(
  YO_ENV_KEYS.map((key) => [key, process.env[key]] as const)
);

async function loadConfig(
  env: Partial<Record<(typeof YO_ENV_KEYS)[number], string>>
) {
  for (const key of YO_ENV_KEYS) {
    delete process.env[key];
  }

  for (const [key, value] of Object.entries(env)) {
    if (value) {
      process.env[key as (typeof YO_ENV_KEYS)[number]] = value;
    }
  }

  vi.resetModules();
  return import('../src/config.js');
}

afterEach(() => {
  for (const key of YO_ENV_KEYS) {
    const original = ORIGINAL_ENV.get(key);
    if (original == null) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
  vi.resetModules();
});

describe('YO Uganda startup config validation', () => {
  it('fails clearly when YO_AUTHORIZATION is missing', async () => {
    const configModule = await loadConfig({
      YO_PROXY_URL: 'http://34.79.189.141:3000/yo',
    });

    const issues = configModule.getStartupConfigIssues();

    expect(issues).toContain(
      'YO_AUTHORIZATION is not set. Required for YO Uganda AccountAuthorization.'
    );
    expect(
      configModule.isFatalStartupIssue(
        'YO_AUTHORIZATION is not set. Required for YO Uganda AccountAuthorization.'
      )
    ).toBe(true);
  });

  it('accepts proxy-mode YO config without legacy API credentials', async () => {
    const configModule = await loadConfig({
      YO_PROXY_URL: 'http://34.79.189.141:3000/yo',
      YO_AUTHORIZATION: 'demo-authorization',
    });

    const issues = configModule.getStartupConfigIssues();

    expect(issues).not.toContain('YO_API_USERNAME is missing');
    expect(issues).not.toContain('YO_API_PASSWORD is missing');
    expect(configModule.hasYoClientCredentials()).toBe(true);
  });
});
