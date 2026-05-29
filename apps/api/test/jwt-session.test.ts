import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import { afterEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;
const ORIGINAL_JWT_PREVIOUS_SECRETS = process.env.JWT_PREVIOUS_SECRETS;

afterEach(() => {
  if (ORIGINAL_JWT_SECRET == null) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
  }
  if (ORIGINAL_JWT_PREVIOUS_SECRETS == null) {
    delete process.env.JWT_PREVIOUS_SECRETS;
  } else {
    process.env.JWT_PREVIOUS_SECRETS = ORIGINAL_JWT_PREVIOUS_SECRETS;
  }
  vi.resetModules();
});

describe('JWT session verification', () => {
  it('accepts tokens signed with a configured previous secret', async () => {
    process.env.JWT_SECRET = 'current-secret';
    process.env.JWT_PREVIOUS_SECRETS = 'previous-secret';
    vi.resetModules();

    const { verifyRequestJwt } = await import('../src/services/jwtSession.js');
    const app = Fastify();
    await app.register(jwt, {
      secret: 'current-secret',
      sign: { expiresIn: '30d' },
    });
    await app.ready();

    const legacyToken = app.jwt.sign(
      { sub: 'user-1', role: 'BUSINESS' },
      { key: 'previous-secret' }
    );
    const request = {
      headers: {
        authorization: `Bearer ${legacyToken}`,
      },
    };

    const decoded = await verifyRequestJwt(app, request);

    expect(decoded).toMatchObject({ sub: 'user-1', role: 'BUSINESS' });
    expect((request as any).user).toMatchObject({
      sub: 'user-1',
      role: 'BUSINESS',
    });

    await app.close();
  });
});
