import { afterEach, describe, expect, it } from 'vitest';

import { buildServer } from '../src/server.js';

const originalNodeEnv = process.env.NODE_ENV;
const originalVitestEnv = process.env.VITEST;
const originalSkipWarmups = process.env.SKIP_OPTIONAL_STARTUP_WARMUPS;
const originalTestRouteScope = process.env.TEST_ROUTE_SCOPE;

afterEach(() => {
  if (originalNodeEnv == null) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }

  if (originalVitestEnv == null) {
    delete process.env.VITEST;
  } else {
    process.env.VITEST = originalVitestEnv;
  }

  if (originalSkipWarmups == null) {
    delete process.env.SKIP_OPTIONAL_STARTUP_WARMUPS;
  } else {
    process.env.SKIP_OPTIONAL_STARTUP_WARMUPS = originalSkipWarmups;
  }

  if (originalTestRouteScope == null) {
    delete process.env.TEST_ROUTE_SCOPE;
  } else {
    process.env.TEST_ROUTE_SCOPE = originalTestRouteScope;
  }
});

describe('server route-scope guard', () => {
  it('keeps /api routes mounted when TEST_ROUTE_SCOPE leaks outside test startup', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.VITEST;
    delete process.env.SKIP_OPTIONAL_STARTUP_WARMUPS;
    process.env.TEST_ROUTE_SCOPE = 'admin';

    const app = buildServer();
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
    });

    expect(response.statusCode).toBe(200);

    await app.close();
  });
});
