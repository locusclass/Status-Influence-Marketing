import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import {
  maskErrorResponsePayload,
  normalizePublicErrorCode,
} from '../src/errorResponses.js';

function buildMaskedTestServer() {
  const app = Fastify();

  app.addHook('preSerialization', async (_request, reply, payload) => {
    return maskErrorResponsePayload(payload, reply.statusCode);
  });

  app.setErrorHandler((error, _request, reply) => {
    const statusCode = (error as any)?.statusCode ?? 500;
    reply.status(statusCode).send({
      error: normalizePublicErrorCode((error as any)?.code ?? error.message, statusCode),
    });
  });

  app.get('/mask/thrown', async () => {
    throw Object.assign(new Error('unsupported_platform:tiktok'), {
      statusCode: 400,
    });
  });

  app.get('/mask/manual', async (_request, reply) => {
    return reply.code(502).send({
      error: 'yo_uganda_initiate_failed',
      detail: 'YO Uganda request failed: 503 gateway timeout',
    });
  });

  app.post('/mask/json', async () => ({ ok: true }));

  return app;
}

describe('backend error masking', () => {
  it('adds a safe user message for thrown application errors', async () => {
    const app = buildMaskedTestServer();

    const response = await app.inject({
      method: 'GET',
      url: '/mask/thrown',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'unsupported_platform',
      error: 'This platform is not supported.',
      message: 'This platform is not supported.',
    });
    expect(response.body).not.toContain('tiktok');

    await app.close();
  });

  it('strips runtime details from provider failures', async () => {
    const app = buildMaskedTestServer();

    const response = await app.inject({
      method: 'GET',
      url: '/mask/manual',
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      code: 'yo_uganda_initiate_failed',
      error: 'We could not start the payment right now. Please try again.',
      message: 'We could not start the payment right now. Please try again.',
    });
    expect(response.json()).not.toHaveProperty('detail');

    await app.close();
  });

  it('masks invalid JSON parser errors', async () => {
    const app = buildMaskedTestServer();

    const response = await app.inject({
      method: 'POST',
      url: '/mask/json',
      headers: {
        'content-type': 'application/json',
      },
      payload: '{"broken":',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: 'invalid_request_body',
      error:
        'We could not read that request. Please check the information and try again.',
      message:
        'We could not read that request. Please check the information and try again.',
    });
    expect(response.body).not.toContain('Unexpected token');
    expect(response.body).not.toContain('Unexpected end of JSON input');

    await app.close();
  });
});
