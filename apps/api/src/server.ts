import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { registerIpnUrl } from './services/pesapal.js';
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

  // Routes
  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(campaignRoutes);
  app.register(verificationRoutes);
  app.register(uploadRoutes);
  app.register(paymentRoutes);
  app.register(accountRoutes);

  app.addHook('onReady', async () => {
    if (!config.pesapal.ipnId && config.pesapal.callbackUrl) {
      setImmediate(async () => {
        try {
          const result = await registerIpnUrl();

          // 🔍 Force visible raw logging
          console.log(
            '[pesapal] raw ipn registration response:',
            JSON.stringify(result, null, 2)
          );

          const ipnId =
            result?.ipn_id ??
            result?.ipnId ??
            result?.data?.ipn_id ??
            result?.data?.ipnId;

          if (ipnId) {
            config.pesapal.ipnId = String(ipnId);
            app.log.info({ ipnId }, 'pesapal ipn registered');
          } else {
            app.log.warn(
              { result },
              'pesapal ipn register returned no ipn_id'
            );
          }
        } catch (error) {
          app.log.warn({ error }, 'pesapal ipn register failed');
        }
      });
    }
  });

  return app;
}
