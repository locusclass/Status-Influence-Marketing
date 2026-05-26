import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hashPassword } from '../src/services/auth.js';
import { buildAuthClaims } from '../src/services/roles.js';
import { applySchema, getTestPool } from './db.js';

const pool = getTestPool();
let app: any;

async function resetDatabase() {
  if (!pool) return;
  const tablesRes = await pool.query(`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `);
  const tables = tablesRes.rows
    .map((row: any) => String(row.tablename ?? '').trim())
    .filter((name: string) => name.length > 0);
  if (tables.length > 0) {
    const quoted = tables.map((name: string) => `"${name}"`).join(', ');
    await pool.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
  }
  await applySchema(pool);
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS privacy_policy_accepted_version TEXT,
      ADD COLUMN IF NOT EXISTS privacy_policy_accepted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS platform_policy_accepted_version TEXT,
      ADD COLUMN IF NOT EXISTS platform_policy_accepted_at TIMESTAMPTZ
  `);
}

async function insertUser(status: 'ACTIVE' | 'SUSPENDED' | 'BANNED') {
  const result = await pool!.query(
    `
    INSERT INTO users (
      full_name,
      email,
      phone,
      password_hash,
      role,
      active_role,
      country,
      preferred_currency,
      status,
      privacy_policy_accepted_version,
      privacy_policy_accepted_at,
      platform_policy_accepted_version,
      platform_policy_accepted_at
    )
    VALUES (
      $1, $2, $3, $4,
      'BUSINESS', 'BUSINESS', 'UG', 'UGX', $5,
      '2026-01', now(), '2026-01', now()
    )
    RETURNING *
    `,
    [
      `Session ${status}`,
      `${status.toLowerCase()}@prime.test`,
      `+2567${Math.floor(Math.random() * 1_000_000_000)
        .toString()
        .padStart(9, '0')}`,
      hashPassword('Password123!'),
      status,
    ]
  );
  return result.rows[0];
}

describe('Session security hardening', () => {
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

  beforeEach(async () => {
    await resetDatabase();
  }, 120000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  }, 120000);

  it('issues expiring JWTs for active logins', async () => {
    const user = await insertUser('ACTIVE');

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: user.email,
        password: 'Password123!',
      },
    });

    expect(response.statusCode).toBe(200);
    const token = String(response.json().token ?? '');
    const decoded = app.jwt.decode(token) as Record<string, any>;
    expect(typeof decoded.exp).toBe('number');
    expect(Number(decoded.exp)).toBeGreaterThan(Number(decoded.iat ?? 0));
  });

  it('blocks suspended users from logging in', async () => {
    const user = await insertUser('SUSPENDED');

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: user.email,
        password: 'Password123!',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'account_suspended' });
  });

  it('blocks banned users from logging in', async () => {
    const user = await insertUser('BANNED');

    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: {
        email: user.email,
        password: 'Password123!',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'account_disabled' });
  });

  it('rejects suspended tokens on authenticated routes', async () => {
    const user = await insertUser('SUSPENDED');
    const token = app.jwt.sign(buildAuthClaims(user));

    const response = await app.inject({
      method: 'GET',
      url: '/api/account/policies',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'account_suspended' });
  });
});
