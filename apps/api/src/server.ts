// apps/api/src/server.ts

import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import multipart from '@fastify/multipart';
import { config, hasValidFlutterwaveKeys } from './config.js';
import {
  authRoutes,
  campaignRoutes,
  healthRoutes,
  paymentRoutes,
  uploadRoutes,
  verificationRoutes,
  accountRoutes,
  adminRoutes
} from './routes/index.js';

export function buildServer() {
  const app = Fastify({
    pluginTimeout: Number(process.env.FASTIFY_PLUGIN_TIMEOUT ?? 30000),
    logger: {
      level: process.env.LOG_LEVEL ?? 'info'
    }
  });

  const defaultAllowedOrigins = [
    'https://primestatus.site',
    'https://*.primestatus.site',
    'https://prime-status-1f0ad.firebaseapp.com',
    'https://prime-status-1f0ad.web.app',
    'http://localhost:*',
    'http://127.0.0.1:*',
  ];

  const configuredOrigins = config.corsOrigin
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const allowedOrigins = [
    ...configuredOrigins,
    ...defaultAllowedOrigins,
  ].filter((origin, index, list) => list.indexOf(origin) === index);

  const isOriginAllowed = (origin?: string) => {
    if (!origin) return true;
    if (allowedOrigins.includes('*')) return true;

    const wildcardMatch = (value: string, mask: string) => {
      if (!mask.includes('*')) return value === mask;
      const segments = mask.split('*');
      let cursor = 0;

      for (let index = 0; index < segments.length; index += 1) {
        const segment = segments[index] ?? '';
        if (!segment) continue;
        const foundAt = value.indexOf(segment, cursor);
        if (foundAt < 0) return false;
        if (index === 0 && !mask.startsWith('*') && foundAt !== 0) return false;
        cursor = foundAt + segment.length;
      }

      const last = segments[segments.length - 1] ?? '';
      if (!mask.endsWith('*') && !value.endsWith(last)) return false;
      return true;
    };

    for (const allowed of allowedOrigins) {
      if (!allowed) continue;
      if (wildcardMatch(origin, allowed)) return true;
    }
    return false;
  };

  app.register(cors, {
    origin: (origin, cb) => {
      cb(null, isOriginAllowed(origin));
    },
    credentials: true,
  });

  app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  });

  app.register(jwt, {
    secret: config.jwtSecret,
  });

  app.register(multipart);

  app.addContentTypeParser(
    /^application\/([a-z0-9.+-]+\+)?json(?:;.*)?$/i,
    { parseAs: 'string' },
    (request: any, body: string, done) => {
      request.rawBody = body;
      if (!body) {
        done(null, {});
        return;
      }

      try {
        done(null, JSON.parse(body));
      } catch (error) {
        done(error as Error, undefined);
      }
    }
  );

  app.addHook('onRequest', async (request) => {
    request.log.info(
      {
        reqId: request.id,
        method: request.method,
        url: request.url,
        ip: request.ip,
        userAgent: request.headers['user-agent']
      },
      `request:start ${request.method} ${request.url}`
    );
  });

  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        reqId: request.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        responseTimeMs: Number(reply.elapsedTime.toFixed(1))
      },
      `request:done ${request.method} ${request.url} -> ${reply.statusCode}`
    );
  });

  app.addHook('onError', async (request, reply, error) => {
    request.log.error(
      {
        reqId: request.id,
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        err: error
      },
      `request:error ${request.method} ${request.url}`
    );
  });

  app.setErrorHandler((error, request, reply) => {
    request.log.error(
      {
        reqId: request.id,
        method: request.method,
        url: request.url,
        err: error
      },
      `unhandled:error ${request.method} ${request.url}`
    );

    if (reply.sent) return;
    reply.status(error.statusCode ?? 500).send({
      error: error.statusCode && error.statusCode < 500 ? error.message : 'internal_server_error'
    });
  });

  app.decorate('authenticate', async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.decorate('adminOnly', async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
      const role = (request.user as any)?.role as string | undefined;
      if (role !== 'ADMIN') {
        return reply.code(403).send({ error: 'forbidden' });
      }
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.register(swagger, {
    openapi: {
      info: {
        title: 'Prime API',
        version: '0.1.0',
      },
    },
  });

  app.register(swaggerUi, { routePrefix: '/docs' });

  const registerRoutes = (instance: FastifyInstance) => {
    instance.register(healthRoutes);
    instance.register(authRoutes);
    instance.register(campaignRoutes);
    instance.register(verificationRoutes);
    instance.register(uploadRoutes);
    instance.register(paymentRoutes);
    instance.register(accountRoutes);
    instance.register(adminRoutes);
  };

  // Routes
  registerRoutes(app);
  app.register(async (instance) => registerRoutes(instance), { prefix: '/api' });

  // Final payment-provider configuration
  app.addHook('onReady', async () => {
    if (!config.flutterwave.secretKey) {
      app.log.warn('FLUTTERWAVE_SECRET_KEY is not set. Checkout creation, verification, and transfers will fail.');
    } else {
      app.log.info(
        { provider: 'FLUTTERWAVE' },
        'Flutterwave payments configured'
      );
    }

    if (!hasValidFlutterwaveKeys()) {
      app.log.warn('Flutterwave credentials are incomplete. Payments will fail.');
    }

    if (!config.flutterwave.webhookSecretHash) {
      app.log.warn('FLUTTERWAVE_WEBHOOK_SECRET_HASH is not set. Webhook verification is disabled.');
    }
  });

  return app;
}

