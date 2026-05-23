import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applySchema, getTestPool } from './db.js';

const pool = getTestPool();
let app: any;

describe('Authenticated routes with missing users', () => {
  if (!pool) {
    it('skipped: TEST_DATABASE_URL not set', () => expect(true).toBe(true));
    return;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
    const serverModule = await import('../src/server.js');
    app = serverModule.buildServer();
    await applySchema(pool);
    await app.ready();
  }, 120000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  }, 120000);

  it('rejects stale tokens before bypass and protected account routes diverge', async () => {
    const token = app.jwt.sign({
      sub: '11111111-1111-1111-1111-111111111111',
      role: 'BUSINESS',
      active_role: 'BUSINESS',
      admin_role: 'USER',
    });

    const accountProfile = await app.inject({
      method: 'GET',
      url: '/api/account/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(accountProfile.statusCode).toBe(401);

    const policies = await app.inject({
      method: 'GET',
      url: '/api/account/policies',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(policies.statusCode).toBe(401);

    const campaigns = await app.inject({
      method: 'GET',
      url: '/api/campaigns?limit=20&offset=0',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(campaigns.statusCode).toBe(401);
  }, 120000);
});
