import { FastifyInstance } from 'fastify';
import { withTransaction } from '../db.js';

export async function accountRoutes(app: FastifyInstance) {
  app.get('/wallet', { preHandler: [app.authenticate] }, async (request) => {
    const userId = (request.user as any).sub as string;
    const data = await withTransaction(async (client) => {
      const walletRes = await client.query('SELECT * FROM wallets WHERE user_id=$1', [userId]);
      const wallet = walletRes.rows[0];
      const txnsRes = await client.query(
        `SELECT * FROM wallet_txns WHERE wallet_id=$1 ORDER BY created_at DESC LIMIT 20`,
        [wallet?.id]
      );
      return { wallet, txns: txnsRes.rows };
    });
    return data;
  });

  app.get('/proofs', { preHandler: [app.authenticate] }, async (request) => {
    const userId = (request.user as any).sub as string;
    const proofs = await withTransaction(async (client) => {
      const res = await client.query(
        `SELECT p.id,
                p.status,
                p.decision,
                p.observed_views,
                p.observed_post_hash,
                p.challenge_seen,
                p.confidence,
                p.video_url,
                p.created_at,
                c.title AS campaign_title
         FROM proofs p
         JOIN verification_sessions s ON s.id = p.session_id
         JOIN campaigns c ON c.id = s.campaign_id
         WHERE p.user_id=$1
         ORDER BY p.created_at DESC`,
        [userId]
      );
      return res.rows;
    });
    return { proofs };
  });

  app.get('/proofs/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = (request.user as any).sub as string;
    const params = request.params as { id: string };
    const proof = await withTransaction(async (client) => {
      const res = await client.query(
        `SELECT p.id,
                p.status,
                p.decision,
                p.observed_views,
                p.observed_post_hash,
                p.challenge_seen,
                p.confidence,
                p.video_url,
                p.created_at,
                c.title AS campaign_title
         FROM proofs p
         JOIN verification_sessions s ON s.id = p.session_id
         JOIN campaigns c ON c.id = s.campaign_id
         WHERE p.user_id=$1 AND p.id=$2
         LIMIT 1`,
        [userId, params.id]
      );
      return res.rows[0];
    });
    if (!proof) {
      reply.code(404);
      return { error: 'proof_not_found' };
    }
    return { proof };
  });
}
