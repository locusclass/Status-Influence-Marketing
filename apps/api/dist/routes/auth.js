import crypto from 'crypto';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { withTransaction } from '../db.js';
import { UserRepo } from '../repositories/userRepo.js';
import { hashPassword, verifyPassword } from '../services/auth.js';
import { resolveCountry } from '../countryResolver.js';
const registerSchema = z.object({
    full_name: z.string().min(2).max(120),
    email: z.string().email(),
    phone: z.string().min(7).max(20),
    password: z.string().min(8),
    role: z.enum(['ADVERTISER', 'DISTRIBUTOR']),
    country: z.string().min(2),
});
const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
});
const googleAuthSchema = z.object({
    id_token: z.string().min(20),
    role: z.enum(['ADVERTISER', 'DISTRIBUTOR']),
    country: z.string().min(2),
    full_name: z.string().min(2).max(120).optional(),
    avatar_url: z.string().url().max(1024).optional(),
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
async function upsertGoogleProfile(client, userId, fullName, photoUrl) {
    await ensureUserProfilesTable(client);
    await client.query(`
    INSERT INTO user_profiles (user_id, full_name, avatar_url, updated_at)
    VALUES ($1, $2, NULLIF($3, ''), NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET
      full_name = EXCLUDED.full_name,
      avatar_url = COALESCE(EXCLUDED.avatar_url, user_profiles.avatar_url),
      updated_at = NOW()
    `, [userId, fullName, photoUrl]);
    if (await usersHasColumn(client, 'full_name')) {
        await client.query('UPDATE users SET full_name=$2 WHERE id=$1', [
            userId,
            fullName,
        ]);
    }
}
function buildSyntheticPhone(sub) {
    const hash = crypto.createHash('sha256').update(sub).digest('hex');
    const digits = hash
        .split('')
        .map((ch) => (ch.charCodeAt(0) % 10).toString())
        .join('')
        .slice(0, 9);
    return `+999${digits}`;
}
function buildSyntheticPassword(sub, email) {
    const seed = crypto
        .createHash('sha256')
        .update(`prime_status_google::${sub}::${email}`)
        .digest('hex');
    return `Gp!${seed.substring(0, 18)}a9`;
}
export async function authRoutes(app) {
    const userRepo = new UserRepo();
    const googleClient = new OAuth2Client();
    const googleAudience = (process.env.GOOGLE_CLIENT_ID ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    app.get('/auth/register', async () => {
        return {
            ok: true,
            method: 'POST',
            note: 'Use POST /auth/register with JSON body { full_name, email, phone, password, role, country }.',
        };
    });
    app.post('/auth/register', async (request, reply) => {
        const parsed = registerSchema.safeParse(request.body);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        const body = parsed.data;
        const countryData = resolveCountry(body.country);
        const user = await withTransaction(async (client) => {
            const existing = await userRepo.findByEmail(client, body.email);
            if (existing) {
                reply.code(400);
                return { error: 'email_taken' };
            }
            const created = await userRepo.createUser(client, body.full_name, body.email, body.phone, hashPassword(body.password), body.role, countryData.iso2, countryData.currency);
            await userRepo.ensureWallet(client, created.id, countryData.currency);
            return created;
        });
        if (user.error)
            return user;
        const token = app.jwt.sign({
            sub: user.id,
            role: user.role,
        });
        return {
            token,
            user: {
                id: user.id,
                full_name: user.full_name ?? '',
                email: user.email,
                role: user.role,
                phone: user.phone,
                country: user.country,
                currency: user.currency ?? user.preferred_currency ?? 'UGX',
                can_multi_contract: user.can_multi_contract ?? false,
                dialCode: countryData.dialCode,
            },
        };
    });
    app.post('/auth/login', async (request, reply) => {
        const parsed = loginSchema.safeParse(request.body);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        const body = parsed.data;
        const user = await withTransaction(async (client) => userRepo.findByEmail(client, body.email));
        if (!user || !verifyPassword(body.password, user.password_hash)) {
            reply.code(401);
            return { error: 'invalid_credentials' };
        }
        const token = app.jwt.sign({
            sub: user.id,
            role: user.role,
        });
        return {
            token,
            user: {
                id: user.id,
                full_name: user.full_name ?? '',
                email: user.email,
                role: user.role,
                phone: user.phone,
                country: user.country,
                currency: user.currency ?? user.preferred_currency ?? 'UGX',
                can_multi_contract: user.can_multi_contract ?? false,
            },
        };
    });
    app.post('/auth/google', async (request, reply) => {
        const parsed = googleAuthSchema.safeParse(request.body);
        if (!parsed.success) {
            reply.code(400);
            return { error: 'validation_failed', issues: parsed.error.issues };
        }
        if (googleAudience.length === 0) {
            reply.code(500);
            return { error: 'google_auth_not_configured' };
        }
        const body = parsed.data;
        const countryData = resolveCountry(body.country);
        let payload;
        try {
            const ticket = await googleClient.verifyIdToken({
                idToken: body.id_token,
                audience: googleAudience,
            });
            payload = ticket.getPayload();
        }
        catch {
            reply.code(401);
            return { error: 'invalid_google_token' };
        }
        const email = String(payload?.email ?? '').trim().toLowerCase();
        const sub = String(payload?.sub ?? '').trim();
        const verified = Boolean(payload?.email_verified);
        if (!email || !verified || !sub) {
            reply.code(401);
            return { error: 'invalid_google_identity' };
        }
        const fullName = (body.full_name?.trim() || String(payload?.name ?? '').trim() || email.split('@')[0] || 'Prime Status User')
            .slice(0, 120);
        const photoUrl = String(body.avatar_url?.trim() || payload?.picture || '')
            .trim()
            .slice(0, 1024);
        const user = await withTransaction(async (client) => {
            const existing = await userRepo.findByEmail(client, email);
            if (existing) {
                await upsertGoogleProfile(client, existing.id, fullName, photoUrl);
                return existing;
            }
            const syntheticPhone = buildSyntheticPhone(sub);
            const syntheticPassword = buildSyntheticPassword(sub, email);
            const created = await userRepo.createUser(client, fullName, email, syntheticPhone, hashPassword(syntheticPassword), body.role, countryData.iso2, countryData.currency);
            await userRepo.ensureWallet(client, created.id, countryData.currency);
            await upsertGoogleProfile(client, created.id, fullName, photoUrl);
            return created;
        });
        const token = app.jwt.sign({
            sub: user.id,
            role: user.role,
        });
        return {
            token,
            user: {
                id: user.id,
                full_name: user.full_name ?? fullName,
                email: user.email,
                role: user.role,
                phone: user.phone,
                country: user.country,
                currency: user.currency ?? user.preferred_currency ?? 'UGX',
                can_multi_contract: user.can_multi_contract ?? false,
                avatar_url: photoUrl || null,
                dialCode: countryData.dialCode,
            },
        };
    });
}
