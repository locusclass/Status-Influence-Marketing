import { z } from 'zod';
import { withTransaction } from '../db.js';
import { hashPassword, verifyPassword } from '../services/auth.js';
const accountProfileSchema = z.object({
    full_name: z.string().trim().min(2).max(120),
    country: z.string().trim().min(2).max(3).optional(),
});
const accountPasswordSchema = z.object({
    current_password: z.string().min(8),
    new_password: z.string().min(8),
});
const accountAvatarSchema = z.object({
    avatar_url: z.string().url().max(1024),
});
const accountRoleSchema = z.object({
    role: z.enum(['ADVERTISER', 'DISTRIBUTOR']),
});
async function ensureUserProfilesTable(client) {
    await client.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL DEFAULT '',
      avatar_url TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
async function usersHasColumn(client, columnName) {
    const res = await client.query(`
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='users'
      AND column_name=$1
    LIMIT 1
    `, [columnName]);
    return Boolean(res.rowCount);
}
export async function accountRoutes(app) {
    const parsePaging = (query) => {
        const limitRaw = Number(query?.limit ?? 50);
        const offsetRaw = Number(query?.offset ?? 0);
        const limit = Number.isFinite(limitRaw)
            ? Math.min(Math.max(limitRaw, 1), 200)
            : 50;
        const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
        return { limit, offset };
    };
    app.get('/account/me', { preHandler: [app.authenticate] }, async (request) => {
        const userId = request.user.sub;
        return withTransaction(async (client) => {
            await ensureUserProfilesTable(client);
            const hasFullName = await usersHasColumn(client, 'full_name');
            const fullNameSelect = hasFullName
                ? 'COALESCE(NULLIF(u.full_name, \'\'), p.full_name, \'\')'
                : 'COALESCE(p.full_name, \'\')';
            const res = await client.query(`
        SELECT
          u.id,
          u.email,
          u.role,
          u.phone,
          u.country,
          u.preferred_currency AS currency,
          ${fullNameSelect} AS full_name,
          p.avatar_url,
          p.updated_at
        FROM users u
        LEFT JOIN user_profiles p ON p.user_id = u.id
        WHERE u.id = $1
        LIMIT 1
        `, [userId]);
            return { profile: res.rows[0] ?? null };
        });
    });
    app.patch('/account/me', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = request.user.sub;
        const parsed = accountProfileSchema.safeParse(request.body);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        const body = parsed.data;
        return withTransaction(async (client) => {
            await ensureUserProfilesTable(client);
            await client.query(`
          INSERT INTO user_profiles (user_id, full_name, updated_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (user_id)
          DO UPDATE SET
            full_name = EXCLUDED.full_name,
            updated_at = NOW()
          `, [userId, body.full_name]);
            if (body.country && body.country.trim().length > 0) {
                await client.query('UPDATE users SET country=$2 WHERE id=$1', [
                    userId,
                    body.country.trim().toUpperCase(),
                ]);
            }
            return { ok: true };
        });
    });
    app.patch('/account/avatar', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = request.user.sub;
        const parsed = accountAvatarSchema.safeParse(request.body);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        const body = parsed.data;
        return withTransaction(async (client) => {
            await ensureUserProfilesTable(client);
            await client.query(`
          INSERT INTO user_profiles (user_id, avatar_url, updated_at)
          VALUES ($1, $2, NOW())
          ON CONFLICT (user_id)
          DO UPDATE SET
            avatar_url = EXCLUDED.avatar_url,
            updated_at = NOW()
          `, [userId, body.avatar_url]);
            return { ok: true };
        });
    });
    app.patch('/account/password', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = request.user.sub;
        const parsed = accountPasswordSchema.safeParse(request.body);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        const body = parsed.data;
        return withTransaction(async (client) => {
            const userRes = await client.query(`SELECT id, password_hash FROM users WHERE id=$1 LIMIT 1`, [userId]);
            const user = userRes.rows[0];
            if (!user || !verifyPassword(body.current_password, user.password_hash)) {
                reply.code(401);
                return { error: 'invalid_credentials' };
            }
            await client.query('UPDATE users SET password_hash=$2 WHERE id=$1', [
                userId,
                hashPassword(body.new_password),
            ]);
            return { ok: true };
        });
    });
    app.patch('/account/role', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = request.user.sub;
        const parsed = accountRoleSchema.safeParse(request.body);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        const body = parsed.data;
        return withTransaction(async (client) => {
            await client.query('UPDATE users SET role=$2 WHERE id=$1', [
                userId,
                body.role,
            ]);
            const hasCanMultiContract = await usersHasColumn(client, 'can_multi_contract');
            const canMultiSelect = hasCanMultiContract
                ? 'can_multi_contract'
                : 'false::boolean AS can_multi_contract';
            const res = await client.query(`
          SELECT
            id,
            email,
            role,
            phone,
            country,
            preferred_currency AS currency,
            ${canMultiSelect}
          FROM users
          WHERE id=$1
          LIMIT 1
          `, [userId]);
            const user = res.rows[0];
            if (!user) {
                reply.code(404);
                return { error: 'user_not_found' };
            }
            const token = app.jwt.sign({
                sub: user.id,
                role: user.role,
            });
            return {
                ok: true,
                token,
                user: {
                    id: user.id,
                    email: user.email,
                    role: user.role,
                    phone: user.phone,
                    country: user.country,
                    currency: user.currency ?? 'UGX',
                    can_multi_contract: user.can_multi_contract ?? false,
                },
            };
        });
    });
    app.delete('/account/me', { preHandler: [app.authenticate] }, async (request) => {
        const userId = request.user.sub;
        return withTransaction(async (client) => {
            await ensureUserProfilesTable(client);
            await client.query('DELETE FROM user_profiles WHERE user_id=$1', [userId]);
            await client.query(`
        UPDATE users
        SET
          email = CONCAT('deleted+', id::text, '@deleted.local'),
          phone = CONCAT('deleted-', LEFT(id::text, 8)),
          password_hash = $2
        WHERE id=$1
        `, [userId, hashPassword(`deleted-${userId}-${Date.now()}`)]);
            return { ok: true };
        });
    });
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
