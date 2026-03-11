import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { withTransaction } from '../db.js';
import { hashPassword, verifyPassword } from '../services/auth.js';
import { requestPayout } from '../services/pesapal.js';
import { whatsappVerificationService } from '../services/whatsappVerification.js';
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
const accountWhatsappVerifySchema = z.object({
    phone: z.string().trim().min(7).max(20).optional(),
});
const walletWithdrawSchema = z.object({
    amount: z.number().int().positive(),
    phone: z.string().trim().min(7).max(20).optional(),
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
async function ensureWhatsappColumns(client) {
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS whatsapp_verified BOOLEAN NOT NULL DEFAULT FALSE;
  `);
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS whatsapp_verified_at TIMESTAMPTZ;
  `);
    await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS whatsapp_jid TEXT;
  `);
}
async function ensureWalletTables(client) {
    await client.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      currency TEXT NOT NULL DEFAULT 'UGX',
      balance_available INTEGER NOT NULL DEFAULT 0,
      balance_escrow INTEGER NOT NULL DEFAULT 0,
      balance INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await client.query(`
    ALTER TABLE wallets
      ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'UGX'
  `);
    await client.query(`
    ALTER TABLE wallets
      ADD COLUMN IF NOT EXISTS balance_available INTEGER NOT NULL DEFAULT 0
  `);
    await client.query(`
    ALTER TABLE wallets
      ADD COLUMN IF NOT EXISTS balance_escrow INTEGER NOT NULL DEFAULT 0
  `);
    await client.query(`
    ALTER TABLE wallets
      ADD COLUMN IF NOT EXISTS balance INTEGER NOT NULL DEFAULT 0
  `);
    await client.query(`
    UPDATE wallets
    SET balance_available = COALESCE(balance_available, balance, 0),
        balance = COALESCE(balance, balance_available, 0)
    WHERE balance_available <> COALESCE(balance, balance_available, 0)
       OR balance <> COALESCE(balance_available, balance, 0)
  `);
    await client.query(`
    CREATE TABLE IF NOT EXISTS wallet_txns (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('CREDIT', 'DEBIT')),
      reference TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await client.query(`
    CREATE TABLE IF NOT EXISTS wallet_withdrawals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      wallet_id UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'UGX',
      receiver_phone TEXT NOT NULL,
      status payout_status NOT NULL DEFAULT 'PROCESSING',
      pesapal_reference TEXT UNIQUE,
      failure_reason TEXT,
      paid_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}
async function ensureWalletForUser(client, userId) {
    await ensureWalletTables(client);
    const existing = await client.query(`SELECT * FROM wallets WHERE user_id=$1 LIMIT 1`, [userId]);
    if (existing.rows[0]) {
        return existing.rows[0];
    }
    const userRes = await client.query(`SELECT preferred_currency FROM users WHERE id=$1 LIMIT 1`, [userId]);
    const currency = (userRes.rows[0]?.preferred_currency ?? 'UGX')
        .toString()
        .trim()
        .toUpperCase();
    const created = await client.query(`
    INSERT INTO wallets (user_id, currency, balance_available, balance_escrow, balance)
    VALUES ($1,$2,0,0,0)
    RETURNING *
    `, [userId, currency]);
    return created.rows[0];
}
async function refundWalletWithdrawal(client, withdrawal, reason) {
    if (!withdrawal || withdrawal.status === 'FAILED') {
        return withdrawal;
    }
    await client.query(`
    UPDATE wallets
    SET balance_available = balance_available + $2,
        balance = balance + $2
    WHERE id=$1
    `, [withdrawal.wallet_id, withdrawal.amount]);
    await client.query(`
    INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
    VALUES ($1,$2,'CREDIT',$3)
    `, [
        withdrawal.wallet_id,
        withdrawal.amount,
        `${withdrawal.pesapal_reference ?? withdrawal.id}:REFUND`,
    ]);
    const updated = await client.query(`
    UPDATE wallet_withdrawals
    SET status='FAILED',
        failure_reason=$2,
        failed_at=NOW()
    WHERE id=$1
    RETURNING *
    `, [withdrawal.id, reason]);
    return updated.rows[0] ?? withdrawal;
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
            await ensureWhatsappColumns(client);
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
          COALESCE(u.whatsapp_verified, FALSE) AS whatsapp_verified,
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
    app.patch('/account/whatsapp/verify', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = request.user.sub;
        const parsed = accountWhatsappVerifySchema.safeParse(request.body ?? {});
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        return withTransaction(async (client) => {
            await ensureWhatsappColumns(client);
            const userRes = await client.query(`SELECT id, phone FROM users WHERE id=$1 LIMIT 1`, [userId]);
            const user = userRes.rows[0];
            if (!user) {
                reply.code(404);
                return { error: 'user_not_found' };
            }
            const incomingPhone = parsed.data.phone?.trim() ?? '';
            const candidatePhone = incomingPhone.length > 0 ? incomingPhone : String(user.phone ?? '').trim();
            if (candidatePhone.length === 0) {
                reply.code(400);
                return { error: 'invalid_phone_number' };
            }
            const verification = await whatsappVerificationService.verifyPhone(candidatePhone);
            if (!verification.ok) {
                if (verification.reason === 'invalid_phone') {
                    reply.code(400);
                    return { error: 'invalid_phone_number' };
                }
                if (verification.reason === 'pairing_required') {
                    reply.code(202);
                    return {
                        status: 'pending_whatsapp_link',
                        pairing_code: verification.pairingCode ?? null,
                        pairing_phone: verification.pairingPhone ?? null,
                        detail: verification.detail,
                    };
                }
                if (verification.reason === 'provider_unavailable') {
                    reply.code(503);
                    return {
                        error: 'whatsapp_verification_unavailable',
                        detail: verification.detail,
                    };
                }
                reply.code(404);
                return {
                    error: 'whatsapp_number_not_registered',
                    detail: verification.detail,
                };
            }
            const owner = await client.query(`SELECT id FROM users WHERE phone=$1 LIMIT 1`, [verification.normalizedPhone]);
            const ownerId = String(owner.rows[0]?.id ?? '');
            if (ownerId && ownerId != userId) {
                reply.code(400);
                return { error: 'phone_taken' };
            }
            await client.query(`
          UPDATE users
          SET
            phone = $2,
            whatsapp_verified = TRUE,
            whatsapp_verified_at = NOW(),
            whatsapp_jid = $3
          WHERE id = $1
          `, [userId, verification.normalizedPhone, verification.jid]);
            return {
                ok: true,
                whatsapp_verified: true,
                phone: verification.normalizedPhone,
                jid: verification.jid,
            };
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
            await ensureWhatsappColumns(client);
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
                    whatsapp_verified: user.whatsapp_verified ?? false,
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
            const campaignRes = await client.query('SELECT id FROM campaigns WHERE advertiser_id=$1', [userId]);
            const campaignIds = campaignRes.rows.map((row) => row.id);
            const sessionRes = await client.query(`
        SELECT id
        FROM verification_sessions
        WHERE user_id=$1 OR campaign_id = ANY($2::uuid[])
        `, [userId, campaignIds]);
            const sessionIds = sessionRes.rows.map((row) => row.id);
            const proofRes = await client.query(`
        SELECT id
        FROM proofs
        WHERE user_id=$1 OR session_id = ANY($2::uuid[])
        `, [userId, sessionIds]);
            const proofIds = proofRes.rows.map((row) => row.id);
            const walletRes = await client.query('SELECT id FROM wallets WHERE user_id=$1', [userId]);
            const walletIds = walletRes.rows.map((row) => row.id);
            await client.query(`
        DELETE FROM payout_requests
        WHERE user_id=$1 OR proof_id = ANY($2::uuid[])
        `, [userId, proofIds]);
            await client.query(`
        DELETE FROM pesapal_transactions
        WHERE escrow_id IN (
          SELECT id FROM escrow_ledger WHERE campaign_id = ANY($1::uuid[])
        )
        `, [campaignIds]);
            await client.query(`
        DELETE FROM escrow_ledger
        WHERE campaign_id = ANY($1::uuid[])
        `, [campaignIds]);
            await client.query(`
        DELETE FROM wallet_txns
        WHERE wallet_id = ANY($1::uuid[])
        `, [walletIds]);
            await client.query(`
        DELETE FROM proofs
        WHERE id = ANY($1::uuid[]) OR user_id=$2 OR session_id = ANY($3::uuid[])
        `, [proofIds, userId, sessionIds]);
            await client.query(`
        DELETE FROM verification_sessions
        WHERE id = ANY($1::uuid[]) OR user_id=$2 OR campaign_id = ANY($3::uuid[])
        `, [sessionIds, userId, campaignIds]);
            await client.query(`
        DELETE FROM contracts
        WHERE distributor_id=$1 OR campaign_id = ANY($2::uuid[])
        `, [userId, campaignIds]);
            await client.query(`
        DELETE FROM campaigns
        WHERE advertiser_id=$1
        `, [userId]);
            await client.query('DELETE FROM trust_events WHERE user_id=$1', [userId]);
            await client.query('DELETE FROM trust_scores WHERE user_id=$1', [userId]);
            await client.query('DELETE FROM device_fingerprints WHERE user_id=$1', [userId]);
            await client.query('DELETE FROM user_profiles WHERE user_id=$1', [userId]);
            await client.query('DELETE FROM wallets WHERE user_id=$1', [userId]);
            await client.query('DELETE FROM users WHERE id=$1', [userId]);
            return { ok: true, deleted: true };
        });
    });
    app.get('/wallet', { preHandler: [app.authenticate] }, async (request) => {
        const userId = request.user.sub;
        const data = await withTransaction(async (client) => {
            await ensureWalletForUser(client, userId);
            const walletRes = await client.query('SELECT * FROM wallets WHERE user_id=$1', [userId]);
            const wallet = walletRes.rows[0];
            const txnsRes = await client.query(`SELECT * FROM wallet_txns WHERE wallet_id=$1 ORDER BY created_at DESC LIMIT 20`, [wallet?.id]);
            return { wallet, txns: txnsRes.rows };
        });
        return data;
    });
    app.post('/wallet/withdraw', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = request.user.sub;
        const parsed = walletWithdrawSchema.safeParse(request.body);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        let payoutPayload = null;
        const result = await withTransaction(async (client) => {
            await ensureWhatsappColumns(client);
            const wallet = await ensureWalletForUser(client, userId);
            const userRes = await client.query(`SELECT email, phone, preferred_currency FROM users WHERE id=$1 LIMIT 1`, [userId]);
            const user = userRes.rows[0];
            if (!user) {
                reply.code(404);
                return { error: 'user_not_found' };
            }
            const receiverPhone = (parsed.data.phone?.trim() || String(user.phone ?? '').trim());
            if (!receiverPhone) {
                reply.code(400);
                return { error: 'missing_payout_phone' };
            }
            const amount = parsed.data.amount;
            const lockedWalletRes = await client.query(`SELECT * FROM wallets WHERE id=$1 FOR UPDATE`, [wallet.id]);
            const lockedWallet = lockedWalletRes.rows[0];
            const balanceAvailable = Number(lockedWallet?.balance_available ?? 0);
            if (!lockedWallet || balanceAvailable < amount) {
                reply.code(400);
                return { error: 'insufficient_wallet_balance' };
            }
            const currency = (user.preferred_currency ?? lockedWallet.currency ?? 'UGX')
                .toString()
                .trim()
                .toUpperCase();
            const reference = `WD-${uuid()}`;
            const updatedWalletRes = await client.query(`
        UPDATE wallets
        SET balance_available = balance_available - $2,
            balance = GREATEST(balance - $2, 0)
        WHERE id=$1 AND balance_available >= $2
        RETURNING *
        `, [wallet.id, amount]);
            if (!updatedWalletRes.rows[0]) {
                reply.code(400);
                return { error: 'insufficient_wallet_balance' };
            }
            await client.query(`
        INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
        VALUES ($1,$2,'DEBIT',$3)
        `, [wallet.id, amount, reference]);
            const withdrawalRes = await client.query(`
        INSERT INTO wallet_withdrawals (
          wallet_id,
          user_id,
          amount,
          currency,
          receiver_phone,
          status,
          pesapal_reference
        )
        VALUES ($1,$2,$3,$4,$5,'PROCESSING',$6)
        RETURNING *
        `, [wallet.id, userId, amount, currency, receiverPhone, reference]);
            payoutPayload = {
                amount,
                currency,
                reference,
                receiverName: user.email?.split('@')[0] ?? 'User',
                receiverPhone,
            };
            return {
                ok: true,
                withdrawal: withdrawalRes.rows[0],
                wallet: updatedWalletRes.rows[0],
            };
        });
        if (!result?.ok || !payoutPayload) {
            return result;
        }
        const payout = payoutPayload;
        try {
            await requestPayout({
                amount: payout.amount,
                currency: payout.currency,
                narration: `Wallet withdrawal ${payout.reference}`,
                reference: payout.reference,
                receiverName: payout.receiverName,
                receiverPhone: payout.receiverPhone,
            });
        }
        catch (error) {
            await withTransaction(async (client) => {
                await ensureWalletTables(client);
                const withdrawalRes = await client.query(`SELECT * FROM wallet_withdrawals WHERE pesapal_reference=$1 LIMIT 1`, [payout.reference]);
                const withdrawal = withdrawalRes.rows[0];
                if (!withdrawal)
                    return;
                await refundWalletWithdrawal(client, withdrawal, error?.message ?? 'withdrawal_request_failed');
            });
            reply.code(502);
            return {
                error: 'withdrawal_request_failed',
                detail: error?.message ?? 'Withdrawal provider rejected the request.',
            };
        }
        return result;
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
