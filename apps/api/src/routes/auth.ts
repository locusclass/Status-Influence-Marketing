import crypto from 'crypto';
import { FastifyInstance } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import { z } from 'zod';
import { withTransaction } from '../db.js';
import { UserRepo } from '../repositories/userRepo.js';
import { hashPassword, verifyPassword } from '../services/auth.js';
import { resolveCountry } from '../countryResolver.js';
import { ensurePublicIdColumns } from '../services/publicId.js';
import { buildAuthClaims, buildUserSession } from '../services/roles.js';

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

export async function authRoutes(app: FastifyInstance) {
  const userRepo = new UserRepo();
  const googleClient = new OAuth2Client();
  const googleAudience = (
    process.env.GOOGLE_CLIENT_ID ?? process.env.GOOGLE_CLIENT_IDS ?? ''
  )
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
      await ensurePublicIdColumns(client);
      const existing = await userRepo.findByEmail(client, body.email);
      if (existing) {
        reply.code(400);
        return { error: 'email_taken' } as any;
      }
      const existingByPhone = await client.query(
        'SELECT id FROM users WHERE phone=$1 LIMIT 1',
        [body.phone]
      );
      if (existingByPhone.rows[0]) {
        reply.code(400);
        return { error: 'phone_taken' } as any;
      }

      const created = await userRepo.createUser(
        client,
        body.full_name,
        body.email,
        body.phone,
        hashPassword(body.password),
        body.role,
        countryData.iso2,
        countryData.currency
      );
      await userRepo.ensureWallet(client, created.id, countryData.currency);
      return created;
    });

    if ((user as any).error) return user;

    const token = app.jwt.sign(buildAuthClaims(user));

    return {
      token,
      user: {
        ...buildUserSession(user),
        full_name: user.full_name ?? '',
        dialCode: countryData.dialCode,
        whatsapp_verified: false,
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

    const token = app.jwt.sign(buildAuthClaims(user));

    return {
      token,
      user: {
        ...buildUserSession(user),
        full_name: user.full_name ?? '',
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
      return {
        error: 'google_auth_not_configured',
        detail:
          'Set GOOGLE_CLIENT_ID on the API server to the Google OAuth web client ID used by Firebase Auth.',
      };
    }

    const body = parsed.data;
    const countryData = resolveCountry(body.country);

    let payload: any;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: body.id_token,
        audience: googleAudience,
      });
      payload = ticket.getPayload();
    } catch {
      reply.code(401);
      return {
        error: 'invalid_google_token',
        detail:
          'The Google ID token could not be verified against the configured client ID.',
      };
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
      await ensurePublicIdColumns(client);
      const existing = await userRepo.findByEmail(client, email);
      const typedPhone = body.phone.trim();
      if (existing) {
        if (typedPhone && typedPhone !== String(existing.phone ?? '').trim()) {
          const phoneOwner = await client.query(
            `SELECT id FROM users WHERE phone=$1 LIMIT 1`,
            [typedPhone]
          );
          const ownerId = String(phoneOwner.rows[0]?.id ?? '');
          if (ownerId && ownerId !== String(existing.id)) {
            reply.code(400);
            return { error: 'phone_taken' } as any;
          }

          await client.query(
            `UPDATE users SET phone=$2 WHERE id=$1`,
            [existing.id, typedPhone]
          );
        }

        await upsertGoogleProfile(client, existing.id, fullName, photoUrl);
        if (String(existing.role ?? '').trim().toUpperCase() !== body.role) {
          await client.query(
            `
            UPDATE users
            SET role='DUAL_USER',
                active_role=$2
            WHERE id=$1
            `,
            [existing.id, body.role]
          );
        } else {
          await client.query(
            'UPDATE users SET active_role=$2 WHERE id=$1',
            [existing.id, body.role]
          );
        }
        const refreshed = await userRepo.findByEmail(client, email);
        return refreshed ?? existing;
      }

      const phoneOwner = await client.query(
        `SELECT id FROM users WHERE phone=$1 LIMIT 1`,
        [typedPhone]
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
        typedPhone,
        hashPassword(syntheticPassword),
        body.role,
        countryData.iso2,
        countryData.currency
      );
      await userRepo.ensureWallet(client, created.id, countryData.currency);
      await upsertGoogleProfile(client, created.id, fullName, photoUrl);
      return created;
    });

    if ((user as any)?.error) {
      return user as any;
    }

    const refreshedUser = await withTransaction(async (client) =>
      userRepo.findByEmail(client, email)
    );

    const sessionUser = refreshedUser ?? user;
    const token = app.jwt.sign(buildAuthClaims(sessionUser));

    return {
      token,
      user: {
        ...buildUserSession(sessionUser),
        full_name: sessionUser.full_name ?? fullName,
        avatar_url: photoUrl || null,
        dialCode: countryData.dialCode,
      },
    };
  });
}

