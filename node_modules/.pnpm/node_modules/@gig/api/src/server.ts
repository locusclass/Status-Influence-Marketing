// apps/api/src/server.ts

import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import {
  authRoutes,
  campaignRoutes,
  healthRoutes,
  paymentRoutes,
  uploadRoutes,
  verificationRoutes,
  accountRoutes
} from './routes/index.js';

export function buildServer() {
  const app = Fastify({ logger: true });

  app.register(cors, {
    origin: true,
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

  app.decorate('authenticate', async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: 'unauthorized' });
    }
  });

  app.register(swagger, {
    openapi: {
      info: {
        title: 'Bakule API',
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
  };

  // Routes
  registerRoutes(app);
  app.register(async (instance) => registerRoutes(instance), { prefix: '/api' });

  // 🔒 Final stabilized PesaPal configuration
  app.addHook('onReady', async () => {
    if (!config.pesapal.ipnId) {
      app.log.warn('PESAPAL_IPN_ID is not set. Payments will fail.');
    } else {
      app.log.info(
        { ipnId: config.pesapal.ipnId },
        'PesaPal IPN locked'
      );
    }

    if (!config.pesapal.callbackUrl) {
      app.log.warn('PESAPAL_CALLBACK_URL is not set.');
    }

    if (!config.pesapal.consumerKey || !config.pesapal.consumerSecret) {
      app.log.warn('PesaPal credentials are not fully configured.');
    }
  });

  return app;
}
