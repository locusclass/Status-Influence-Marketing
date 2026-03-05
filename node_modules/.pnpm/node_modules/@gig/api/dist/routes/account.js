import { withTransaction } from '../db.js';
export async function accountRoutes(app) {
    const parsePaging = (query) => {
        const limitRaw = Number(query?.limit ?? 50);
        const offsetRaw = Number(query?.offset ?? 0);
        const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
        const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
        return { limit, offset };
    };
    app.get('/wallet', { preHandler: [app.authenticate] }, async (request) => {
        const userId = request.user.sub;
        const data = await withTransaction(async (client) => {
            const walletRes = await client.query('SELECT * FROM wallets WHERE user_id=$1', [userId]);
            const wallet = walletRes.rows[0];
            const txnsRes = await client.query(`SELECT * FROM wallet_txns WHERE wallet_id=$1 ORDER BY created_at DESC LIMIT 20`, [wallet?.id]);
            return { wallet, txns: txnsRes.rows };
        });
        return data;
    });
    app.get('/proofs', { preHandler: [app.authenticate] }, async (request) => {
        const userId = request.user.sub;
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const proofs = await withTransaction(async (client) => {
            const res = await client.query(`SELECT p.id,
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
         ORDER BY p.created_at DESC
         LIMIT $2 OFFSET $3`, [userId, limit, offset]);
            return res.rows;
        });
        return { proofs };
    });
    app.get('/dashboard/summary', { preHandler: [app.authenticate] }, async (request) => {
        const userId = request.user.sub;
        const role = request.user.role;
        return withTransaction(async (client) => {
            if (role === 'ADVERTISER') {
                const campaignsRes = await client.query(`SELECT c.id,
                  c.title,
                  c.created_at,
                  latest.latest_created_at
           FROM campaigns c
           LEFT JOIN LATERAL (
             SELECT MAX(p.created_at) AS latest_created_at
             FROM proofs p
             JOIN verification_sessions s ON s.id = p.session_id
             WHERE s.campaign_id = c.id
           ) latest ON true
           WHERE c.advertiser_id=$1
           ORDER BY c.created_at DESC
           LIMIT 200`, [userId]);
                return { advertiser_campaigns: campaignsRes.rows };
            }
            const distributorRes = await client.query(`SELECT
           COUNT(*) FILTER (WHERE status='PENDING' OR status='MANUAL_REVIEW')::int AS pending_or_review_count
         FROM proofs
         WHERE user_id=$1`, [userId]);
            return {
                distributor: {
                    pending_or_review_count: distributorRes.rows[0]?.pending_or_review_count ?? 0
                }
            };
        });
    });
    app.get('/proofs/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = request.user.sub;
        const params = request.params;
        const proof = await withTransaction(async (client) => {
            const res = await client.query(`SELECT p.id,
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
         LIMIT 1`, [userId, params.id]);
            return res.rows[0];
        });
        if (!proof) {
            reply.code(404);
            return { error: 'proof_not_found' };
        }
        return { proof };
    });
    app.get('/contracts/me', { preHandler: [app.authenticate] }, async (request) => {
        const userId = request.user.sub;
        const query = request.query;
        const { limit, offset } = parsePaging(query);
        const status = (query?.status ?? '').toString().toUpperCase();
        return withTransaction(async (client) => {
            const params = [userId];
            let where = 'WHERE ctr.distributor_id=$1';
            if (status) {
                params.push(status);
                where += ` AND ctr.status=$${params.length}`;
            }
            params.push(limit, offset);
            const res = await client.query(`SELECT ctr.*,
                c.title AS campaign_title,
                c.platform,
                c.media_type,
                c.media_text,
                c.media_url,
                c.payout_amount,
                c.terms_keep_hours,
                c.terms_min_views,
                c.terms_requirement
         FROM contracts ctr
         JOIN campaigns c ON c.id = ctr.campaign_id
         ${where}
         ORDER BY ctr.created_at DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
            return { contracts: res.rows };
        });
    });
}
