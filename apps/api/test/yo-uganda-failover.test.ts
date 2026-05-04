import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();

vi.mock('undici', () => ({
  fetch: fetchMock,
}));

const YO_ENV_KEYS = [
  'YO_PROXY_URL',
  'YO_BASE_URL',
  'YO_API_URL',
  'YO_API_URL_FALLBACK',
  'YO_FALLBACK_BASE_URL',
  'YO_API_USERNAME',
  'YO_API_PASSWORD',
] as const;

const ORIGINAL_ENV = new Map(
  YO_ENV_KEYS.map((key) => [key, process.env[key]] as const)
);

async function loadService(
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
  return import('../src/services/yoUganda.js');
}

afterEach(() => {
  fetchMock.mockReset();
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

describe('YO Uganda failover handling', () => {
  it('retries a configured direct YO endpoint when the gateway proxy times out', async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () =>
          '{"error":"YO proxy request failed","details":"timeout of 30000ms exceeded"}',
      } as any)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          '<?xml version="1.0" encoding="UTF-8"?><AutoCreate><Response><Status>OK</Status><StatusCode>0</StatusCode><TransactionReference>yo-ref-123</TransactionReference></Response></AutoCreate>',
      } as any);

    const { initiateMobileMoneyCollection } = await loadService({
      YO_PROXY_URL: 'http://34.79.189.141:3000/yo',
      YO_API_URL: 'https://paymentsapi1.yo.co.ug/ybs/task.php',
      YO_API_USERNAME: 'demo-user',
      YO_API_PASSWORD: 'demo-pass',
    });

    const response = await initiateMobileMoneyCollection({
      amount: 1000,
      phoneNumber: '0700000000',
      narrative: 'Test payment',
      reference: 'merchant-ref-123',
    });

    expect(response.transactionReference).toBe('yo-ref-123');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      'http://34.79.189.141:3000/yo/ybs/task.php'
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      'https://paymentsapi1.yo.co.ug/ybs/task.php'
    );
  });

  it('does not bypass the gateway for ordinary upstream errors', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      text: async () => '{"error":"invalid_request"}',
    } as any);

    const { initiateMobileMoneyCollection } = await loadService({
      YO_PROXY_URL: 'http://34.79.189.141:3000/yo',
      YO_API_URL: 'https://paymentsapi1.yo.co.ug/ybs/task.php',
      YO_API_USERNAME: 'demo-user',
      YO_API_PASSWORD: 'demo-pass',
    });

    await expect(
      initiateMobileMoneyCollection({
        amount: 1000,
        phoneNumber: '0700000000',
        narrative: 'Test payment',
        reference: 'merchant-ref-123',
      })
    ).rejects.toThrow(
      'YO Uganda request failed: 400 {"error":"invalid_request"}'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('posts exact-case proxy field names for collection requests', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        '<?xml version="1.0" encoding="UTF-8"?><AutoCreate><Response><Status>OK</Status><StatusCode>0</StatusCode><TransactionReference>yo-ref-456</TransactionReference></Response></AutoCreate>',
    } as any);

    const { initiateMobileMoneyCollection } = await loadService({
      YO_PROXY_URL: 'http://34.79.189.141:3000/yo',
      YO_API_USERNAME: 'demo-user',
      YO_API_PASSWORD: 'demo-api-key',
    });

    await initiateMobileMoneyCollection({
      amount: 1500,
      phoneNumber: '0700000000',
      narrative: 'Prime test payment',
      reference: 'merchant-ref-456',
      network: 'MTN',
    });

    const [, requestInit] = fetchMock.mock.calls[0] ?? [];
    const body = String(requestInit?.body ?? '');

    expect(body).toContain('Method=acdepositfunds');
    expect(body).toContain('APIUsername=demo-user');
    expect(body).toContain('APIPassword=demo-api-key');
    expect(body).toContain('Amount=1500');
    expect(body).toContain('NonBlocking=TRUE');
    expect(body).toContain('Account=256700000000');
    expect(body).toContain('AccountProviderCode=MTN_UGANDA');
    expect(body).not.toContain('method=');
    expect(/(?:^|&)Authorization=/.test(body)).toBe(false);
    expect(body).not.toContain('AccountAuthorization=');
    expect(body).not.toContain('PhoneNumber=');
    expect(body).not.toContain('Provider=');
  });
});
