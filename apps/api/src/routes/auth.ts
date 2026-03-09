import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { withTransaction } from '../db.js';
import { UserRepo } from '../repositories/userRepo.js';
import { hashPassword, verifyPassword } from '../services/auth.js';
import { whatsappVerificationService } from '../services/whatsappVerification.js';
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
  phone: z.string().min(7).max(20),
  country: z.string().min(2),
  full_name: z.string().min(2).max(120).optional(),
  avatar_url: z.string().url().max(1024).optional(),
});

async function ensureUserProfilesTable(client: any) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS user_profiles (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      full_name TEXT NOT NULL DEFAULT '',
      avatar_url TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function usersHasColumn(client: any, columnName: string) {
  const res = await client.query(
    `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='users'
      AND column_name=$1
    LIMIT 1
    `,
    [columnName]
  );
  return Boolean(res.rowCount);
}

async function upsertGoogleProfile(
  client: any,
  userId: string,
  fullName: string,
  photoUrl: string
) {
  await ensureUserProfilesTable(client);
  await client.query(
    `
    INSERT INTO user_profiles (user_id, full_name, avatar_url, updated_at)
    VALUES ($1, $2, NULLIF($3, ''), NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET
      full_name = EXCLUDED.full_name,
      avatar_url = COALESCE(EXCLUDED.avatar_url, user_profiles.avatar_url),
      updated_at = NOW()
    `,
    [userId, fullName, photoUrl]
  );

  if (await usersHasColumn(client, 'full_name')) {
    await client.query('UPDATE users SET full_name=$2 WHERE id=$1', [
      userId,
      fullName,
    ]);
  }
}

function buildSyntheticPassword(sub: string, email: string) {
  const seed = crypto
    .createHash('sha256')
    .update(`prime_status_google::${sub}::${email}`)
    .digest('hex');
  return `Gp!${seed.substring(0, 18)}a9`;
}

async function ensureWhatsappColumns(client: any) {
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

async function verifyAndPersistWhatsapp(
  client: any,
  userId: string,
  phone: string
) {
  const verification = await whatsappVerificationService.verifyPhone(phone);
  if (!verification.ok) return verification;

  const owner = await client.query(
    `SELECT id FROM users WHERE phone=$1 LIMIT 1`,
    [verification.normalizedPhone]
  );
  const ownerId = String(owner.rows[0]?.id ?? '');
  if (ownerId && ownerId !== userId) {
    return {
      ok: false,
      normalizedPhone: verification.normalizedPhone,
      reason: 'not_on_whatsapp',
      detail: 'Phone number is already linked to another account.',
      provider: verification.provider,
    } as const;
  }

  await client.query(
    `
    UPDATE users
    SET
      phone = $2,
      whatsapp_verified = TRUE,
      whatsapp_verified_at = NOW(),
      whatsapp_jid = $3
    WHERE id = $1
    `,
    [userId, verification.normalizedPhone, verification.jid]
  );

  return verification;
}

export async function authRoutes(app: FastifyInstance) {
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
    const verification = await whatsappVerificationService.verifyPhone(body.phone);
    if (!verification.ok) {
      if (verification.reason === 'invalid_phone') {
        reply.code(400);
        return { error: 'invalid_phone_number' };
      }
      if (verification.reason === 'provider_unavailable') {
        reply.code(503);
        return { error: 'whatsapp_verification_unavailable' };
      }
      reply.code(403);
      return { error: 'whatsapp_number_not_registered' };
    }

    const user = await withTransaction(async (client) => {
      await ensureWhatsappColumns(client);
      const existing = await userRepo.findByEmail(client, body.email);
      if (existing) {
        reply.code(400);
        return { error: 'email_taken' } as any;
      }
      const existingByPhone = await client.query(
        'SELECT id FROM users WHERE phone=$1 LIMIT 1',
        [verification.normalizedPhone]
      );
      if (existingByPhone.rows[0]) {
        reply.code(400);
        return { error: 'phone_taken' } as any;
      }

      const created = await userRepo.createUser(
        client,
        body.full_name,
        body.email,
        verification.normalizedPhone,
        hashPassword(body.password),
        body.role,
        countryData.iso2,
        countryData.currency
      );

      await client.query(
        `
        UPDATE users
        SET
          whatsapp_verified = TRUE,
          whatsapp_verified_at = NOW(),
          whatsapp_jid = $2
        WHERE id = $1
        `,
        [created.id, verification.jid]
      );
      await userRepo.ensureWallet(client, created.id, countryData.currency);
      return created;
    });

    if ((user as any).error) return user;

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
        whatsapp_verified: true,
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

    const user = await withTransaction(async (client) =>
      userRepo.findByEmail(client, body.email)
    );

    if (!user || !verifyPassword(body.password, user.password_hash)) {
      reply.code(401);
      return { error: 'invalid_credentials' };
    }

    const whatsapp = await withTransaction(async (client) => {
      await ensureWhatsappColumns(client);
      return verifyAndPersistWhatsapp(client, user.id, user.phone);
    });

    if (!whatsapp.ok) {
      if (whatsapp.reason === 'invalid_phone') {
        reply.code(400);
        return { error: 'invalid_phone_number' };
      }
      if (whatsapp.reason === 'provider_unavailable') {
        reply.code(503);
        return { error: 'whatsapp_verification_unavailable' };
      }
      reply.code(403);
      return { error: 'whatsapp_number_not_registered' };
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
        phone: whatsapp.normalizedPhone,
        country: user.country,
        currency: user.currency ?? user.preferred_currency ?? 'UGX',
        can_multi_contract: user.can_multi_contract ?? false,
        whatsapp_verified: true,
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
    const verification = await whatsappVerificationService.verifyPhone(body.phone);
    if (!verification.ok) {
      if (verification.reason === 'invalid_phone') {
        reply.code(400);
        return { error: 'invalid_phone_number' };
      }
      if (verification.reason === 'provider_unavailable') {
        reply.code(503);
        return { error: 'whatsapp_verification_unavailable' };
      }
      reply.code(403);
      return { error: 'whatsapp_number_not_registered' };
    }

    let payload: any;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: body.id_token,
        audience: googleAudience,
      });
      payload = ticket.getPayload();
    } catch {
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

    const fullName =
      (body.full_name?.trim() || String(payload?.name ?? '').trim() || email.split('@')[0] || 'Prime Status User')
        .slice(0, 120);
    const photoUrl = String(
      body.avatar_url?.trim() || payload?.picture || ''
    )
      .trim()
      .slice(0, 1024);

    const user = await withTransaction(async (client) => {
      await ensureWhatsappColumns(client);
      const existing = await userRepo.findByEmail(client, email);
      if (existing) {
        const verified = await verifyAndPersistWhatsapp(
          client,
          existing.id,
          verification.normalizedPhone
        );
        if (!verified.ok) return verified as any;
        await upsertGoogleProfile(client, existing.id, fullName, photoUrl);
        const refreshed = await userRepo.findByEmail(client, email);
        return refreshed ?? existing;
      }

      const phoneOwner = await client.query(
        `SELECT id FROM users WHERE phone=$1 LIMIT 1`,
        [verification.normalizedPhone]
      );
      if (phoneOwner.rows[0]) {
        reply.code(400);
        return { error: 'phone_taken' } as any;
      }

      const syntheticPassword = buildSyntheticPassword(sub, email);
      const created = await userRepo.createUser(
        client,
        fullName,
        email,
        verification.normalizedPhone,
        hashPassword(syntheticPassword),
        body.role,
        countryData.iso2,
        countryData.currency
      );
      const verified = await verifyAndPersistWhatsapp(
        client,
        created.id,
        verification.normalizedPhone
      );
      if (!verified.ok) return verified as any;
      await userRepo.ensureWallet(client, created.id, countryData.currency);
      await upsertGoogleProfile(client, created.id, fullName, photoUrl);
      return created;
    });

    if ((user as any)?.ok === false) {
      const failure = user as any;
      if (failure.reason === 'invalid_phone') {
        reply.code(400);
        return { error: 'invalid_phone_number' };
      }
      if (failure.reason === 'provider_unavailable') {
        reply.code(503);
        return { error: 'whatsapp_verification_unavailable' };
      }
      reply.code(403);
      return { error: 'whatsapp_number_not_registered' };
    }

    if ((user as any)?.error) {
      return user as any;
    }

    const refreshedUser = await withTransaction(async (client) =>
      userRepo.findByEmail(client, email)
    );

    const token = app.jwt.sign({
      sub: (refreshedUser ?? user).id,
      role: (refreshedUser ?? user).role,
    });

    return {
      token,
      user: {
        id: (refreshedUser ?? user).id,
        full_name: (refreshedUser ?? user).full_name ?? fullName,
        email: (refreshedUser ?? user).email,
        role: (refreshedUser ?? user).role,
        phone: (refreshedUser ?? user).phone,
        country: (refreshedUser ?? user).country,
        currency:
          (refreshedUser ?? user).currency ??
          (refreshedUser ?? user).preferred_currency ??
          'UGX',
        can_multi_contract: (refreshedUser ?? user).can_multi_contract ?? false,
        avatar_url: photoUrl || null,
        dialCode: countryData.dialCode,
        whatsapp_verified: true,
      },
    };
  });
}
