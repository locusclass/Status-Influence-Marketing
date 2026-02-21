import { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance) {
  app.get('/', async () => {
    return {
      ok: true,
      name: 'Bakule API',
      docs: '/docs',
      health: '/health',
      ts: new Date().toISOString(),
    };
  });

  app.get('/health', async () => {
    return { ok: true, ts: new Date().toISOString() };
  });
}
