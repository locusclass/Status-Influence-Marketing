import { afterEach, describe, expect, it, vi } from 'vitest';

const GATEWAY_BASE_URL = 'http://34.79.189.141:3000/yo';
const GATEWAY_TASK_URL = `${GATEWAY_BASE_URL}/ybs/task.php`;

const YO_ENV_KEYS = [
  'YO_BASE_URL',
  'YO_API_URL',
  'YO_API_URL_FALLBACK',
  'YO_FALLBACK_BASE_URL',
  'YO_ALLOW_DIRECT_API_BYPASS',
  'FLUTTERWAVE_BASE_URL',
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
      process.env[key] = value;
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

describe('YO Uganda URL configuration', () => {
  it('prefers YO_BASE_URL and appends the task path when no trailing slash is present', async () => {
    const { config, resolveYoBaseUrl } = await loadConfig({
      YO_BASE_URL: GATEWAY_BASE_URL,
      YO_API_URL: 'https://paymentsapi1.yo.co.ug/ybs/task.php',
    });

    expect(config.yo.baseUrl).toBe(GATEWAY_TASK_URL);
    expect(resolveYoBaseUrl()).toBe(GATEWAY_TASK_URL);
  });

  it('normalizes YO_BASE_URL with a trailing slash', async () => {
    const { resolveYoBaseUrl } = await loadConfig({
      YO_BASE_URL: `${GATEWAY_BASE_URL}/`,
    });

    expect(resolveYoBaseUrl()).toBe(GATEWAY_TASK_URL);
  });

  it('keeps a full YO task URL unchanged', async () => {
    const { resolveYoBaseUrl } = await loadConfig({
      YO_BASE_URL: GATEWAY_TASK_URL,
    });

    expect(resolveYoBaseUrl()).toBe(GATEWAY_TASK_URL);
  });

  it('rewrites the legacy direct YO_API_URL to the gateway by default', async () => {
    const { resolveYoBaseUrl, resolveYoDirectFailoverBaseUrls } =
      await loadConfig({
      YO_API_URL: 'https://paymentsapi1.yo.co.ug/ybs/task.php',
    });

    expect(resolveYoBaseUrl()).toBe(GATEWAY_TASK_URL);
    expect(resolveYoDirectFailoverBaseUrls()).toEqual([
      'https://paymentsapi1.yo.co.ug/ybs/task.php',
    ]);
  });

  it('allows an explicit direct-host bypass for the legacy YO_API_URL', async () => {
    const { config, resolveYoBaseUrl } = await loadConfig({
      YO_API_URL: 'https://paymentsapi1.yo.co.ug/ybs/task.php',
      YO_ALLOW_DIRECT_API_BYPASS: 'true',
    });

    expect(config.yo.allowDirectApiBypass).toBe(true);
    expect(resolveYoBaseUrl()).toBe(
      'https://paymentsapi1.yo.co.ug/ybs/task.php'
    );
  });

  it('collapses duplicated /yo and /ybs/task.php segments', async () => {
    const { resolveYoBaseUrl } = await loadConfig({
      YO_BASE_URL: `${GATEWAY_BASE_URL}/yo/ybs/task.php/ybs/task.php`,
    });

    expect(resolveYoBaseUrl()).toBe(GATEWAY_TASK_URL);
  });

  it('keeps the fallback on the gateway unless explicitly configured otherwise', async () => {
    const { resolveYoFallbackBaseUrl } = await loadConfig({
      YO_BASE_URL: GATEWAY_BASE_URL,
    });

    expect(resolveYoFallbackBaseUrl()).toBe(GATEWAY_TASK_URL);
  });

  it('rewrites a direct YO_API_URL_FALLBACK to the gateway by default', async () => {
    const { resolveYoFallbackBaseUrl, resolveYoDirectFailoverBaseUrls } =
      await loadConfig({
      YO_API_URL_FALLBACK: 'https://paymentsapi2.yo.co.ug/ybs/task.php',
    });

    expect(resolveYoFallbackBaseUrl()).toBe(GATEWAY_TASK_URL);
    expect(resolveYoDirectFailoverBaseUrls()).toEqual([
      'https://paymentsapi2.yo.co.ug/ybs/task.php',
    ]);
  });
});
