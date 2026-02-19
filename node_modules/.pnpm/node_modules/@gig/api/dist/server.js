import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import multipart from '@fastify/multipart';
import { config } from './config.js';
import { authRoutes, campaignRoutes, healthRoutes, paymentRoutes, uploadRoutes, verificationRoutes, accountRoutes } from './routes/index.js';
export function buildServer() {
    const app = Fastify({ logger: true });
    app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
        req.rawBody = body;
        try {
            const json = JSON.parse(body.toString());
            done(null, json);
        }
        catch (err) {
            done(err, undefined);
        }
    });
    app.register(cors, { origin: config.corsOrigin });
    app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
    app.register(jwt, { secret: config.jwtSecret });
    app.register(multipart);
    app.decorate('authenticate', async (request, reply) => {
        try {
            await request.jwtVerify();
        }
        catch {
            reply.code(401).send({ error: 'unauthorized' });
        }
    });
    app.register(swagger, {
        openapi: {
            info: {
                title: 'Gig Marketing API',
                version: '0.1.0'
            }
        }
    });
    app.register(swaggerUi, { routePrefix: '/docs' });
    app.register(healthRoutes);
    app.register(authRoutes);
    app.register(campaignRoutes);
    app.register(verificationRoutes);
    app.register(uploadRoutes);
    app.register(paymentRoutes);
    app.register(accountRoutes);
    return app;
}
