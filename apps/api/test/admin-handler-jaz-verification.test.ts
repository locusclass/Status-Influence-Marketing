import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildAuthClaims } from '../src/services/roles.js';
import {
  CURRENT_PLATFORM_POLICY_VERSION,
  CURRENT_PRIVACY_POLICY_VERSION,
  ensurePolicyAcceptanceColumns,
} from '../src/services/policies.js';
import { ensureUserSignalSchema } from '../src/services/userSignals.js';
import { ensureViewerVerificationSchema } from '../src/services/viewerVerification.js';
import { applySchema, getTestPool } from './db.js';

const pool = getTestPool();
let app: any;

async function resetDatabase() {
  if (!pool) return;
  const tablesRes = await pool.query(`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
    ORDER BY tablename
  `);
  const tables = tablesRes.rows
    .map((row: any) => String(row.tablename ?? '').trim())
    .filter((name: string) => name.length > 0);
  if (tables.length > 0) {
    const quoted = tables.map((name: string) => `"${name}"`).join(', ');
    await pool.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
  }
  await applySchema(pool);
  await ensurePolicyAcceptanceColumns(pool);
  await ensureUserSignalSchema(pool);
  await ensureViewerVerificationSchema(pool);
}

async function insertCountry(code: string, name: string) {
  const result = await pool!.query(
    `
    INSERT INTO countries (name, code, status)
    VALUES ($1, $2, 'ACTIVE')
    RETURNING *
    `,
    [name, code]
  );
  return result.rows[0];
}

async function insertUser(input: {
  email: string;
  phone: string;
  full_name?: string;
  role?: string;
  active_role?: string;
  admin_role?: string;
  country?: string;
  country_id?: string | null;
  division_id?: string | null;
}) {
  const result = await pool!.query(
    `
    INSERT INTO users (
      full_name,
      email,
      phone,
      password_hash,
      role,
      active_role,
      admin_role,
      country,
      preferred_currency,
      country_id,
      division_id
    )
    VALUES ($1, $2, $3, 'test-hash', $4, $5, $6, $7, 'UGX', $8, $9)
    RETURNING *
    `,
    [
      input.full_name ?? 'Prime User',
      input.email,
      input.phone,
      input.role ?? 'AMBASSADOR',
      input.active_role ?? (input.role ?? 'AMBASSADOR'),
      input.admin_role ?? 'USER',
      input.country ?? 'UG',
      input.country_id ?? null,
      input.division_id ?? null,
    ]
  );
  return result.rows[0];
}

async function acceptRequiredPolicies(userId: string) {
  await pool!.query(
    `
    UPDATE users
    SET privacy_policy_accepted_version = $2,
        privacy_policy_accepted_at = NOW(),
        platform_policy_accepted_version = $3,
        platform_policy_accepted_at = NOW()
    WHERE id = $1
    `,
    [userId, CURRENT_PRIVACY_POLICY_VERSION, CURRENT_PLATFORM_POLICY_VERSION]
  );
}

describe('Admin handler jaz and viewer verification flows', () => {
  if (!pool) {
    it('skipped: TEST_DATABASE_URL not set', () => expect(true).toBe(true));
    return;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
    process.env.SKIP_OPTIONAL_STARTUP_WARMUPS = '1';
    delete process.env.TEST_ROUTE_SCOPE;
    const serverModule = await import('../src/server.js');
    app = serverModule.buildServer();
    await applySchema(pool);
    await app.ready();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.SKIP_OPTIONAL_STARTUP_WARMUPS;
  });

  it('keeps Handler\'s Jaz live and messaging working even when profile tables were not precreated', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const admin = await insertUser({
      email: 'handler-admin@prime.test',
      phone: '+256700100001',
      full_name: 'Handler Admin',
      role: 'ADMIN',
      active_role: 'ADMIN',
      admin_role: 'SUPER_ADMIN',
      country_id: ug.id,
    });
    const adminToken = app.jwt.sign(buildAuthClaims(admin));

    const liveBefore = await app.inject({
      method: 'GET',
      url: '/api/admin/handler-jaz/live',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(liveBefore.statusCode).toBe(200);
    expect(liveBefore.json()).toMatchObject({
      room: {
        key: 'HANDLER_JAZ',
      },
      me: {
        user_id: admin.id,
        has_identity: false,
      },
      participants: [],
      messages: [],
    });

    const identity = await app.inject({
      method: 'POST',
      url: '/api/admin/handler-jaz/identity',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { handle: 'ops_admin' },
    });
    expect(identity.statusCode).toBe(200);

    const sent = await app.inject({
      method: 'POST',
      url: '/api/admin/handler-jaz/messages',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { body: 'Ops ready on verification.' },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json()).toMatchObject({
      message: {
        sender_handle: 'ops_admin',
        body: 'Ops ready on verification.',
      },
    });

    const room = await app.inject({
      method: 'GET',
      url: '/api/admin/handler-jaz/room',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(room.statusCode).toBe(200);
    const roomJson = room.json();
    expect(roomJson.participants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user_id: admin.id,
          handle: 'ops_admin',
          is_available: true,
        }),
      ])
    );
    expect(roomJson.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sender_user_id: admin.id,
          sender_handle: 'ops_admin',
          body: 'Ops ready on verification.',
        }),
      ])
    );
  });

  it('rejects Handler Jaz access when the token is not backed by a stored admin account', async () => {
    const adminToken = app.jwt.sign({
      sub: 'ariaka-access',
      role: 'ADMIN',
      active_role: 'ADMIN',
      admin_role: 'SUPER_ADMIN',
    });

    const room = await app.inject({
      method: 'GET',
      url: '/api/admin/handler-jaz/room',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(room.statusCode).toBe(403);
    expect(room.json()).toMatchObject({
      error: 'forbidden',
    });

    const live = await app.inject({
      method: 'GET',
      url: '/api/admin/handler-jaz/live',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(live.statusCode).toBe(403);
    expect(live.json()).toMatchObject({
      error: 'forbidden',
    });
  });

  it('approves viewer verification and exposes the result through account profile and notifications', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const admin = await insertUser({
      email: 'verifier-admin@prime.test',
      phone: '+256700100002',
      full_name: 'Verifier Admin',
      role: 'ADMIN',
      active_role: 'ADMIN',
      admin_role: 'SUPER_ADMIN',
      country_id: ug.id,
    });
    const ambassador = await insertUser({
      email: 'verified-ambassador@prime.test',
      phone: '+256700100003',
      full_name: 'Verified Ambassador',
      role: 'AMBASSADOR',
      active_role: 'AMBASSADOR',
      country_id: ug.id,
    });
    await acceptRequiredPolicies(String(ambassador.id));

    const recordingRes = await pool!.query(
      `
      INSERT INTO ambassador_verification_recordings (user_id, video_url)
      VALUES ($1, $2)
      RETURNING id
      `,
      [ambassador.id, '/uploads/files/test-verification.mp4?mime=video%2Fmp4']
    );
    const recordingId = String(recordingRes.rows[0].id);

    const adminToken = app.jwt.sign(buildAuthClaims(admin));
    const ambassadorToken = app.jwt.sign(buildAuthClaims(ambassador));

    const queue = await app.inject({
      method: 'GET',
      url: '/api/admin/user-verifications?status=PENDING',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(queue.statusCode).toBe(200);
    expect(queue.json().verifications).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: recordingId,
          user_id: ambassador.id,
          status: 'PENDING',
        }),
      ])
    );

    const approved = await app.inject({
      method: 'PATCH',
      url: `/api/admin/user-verifications/${recordingId}/approve`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        viewer_count: 1450,
        admin_note: 'Viewer list is clear and stable.',
      },
    });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      ok: true,
      viewer_count: 1450,
    });

    const profile = await app.inject({
      method: 'GET',
      url: '/api/account/me',
      headers: { authorization: `Bearer ${ambassadorToken}` },
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json()).toMatchObject({
      profile: {
        max_status_viewers_12h: 1450,
        viewer_count_verified: true,
        verified_viewer_count: 1450,
      },
    });
    expect(
      profile.json().profile.viewer_count_verification_expires_at
    ).toEqual(expect.any(String));

    const notifications = await app.inject({
      method: 'GET',
      url: '/api/account/notifications?limit=10',
      headers: { authorization: `Bearer ${ambassadorToken}` },
    });
    expect(notifications.statusCode).toBe(200);
    expect(notifications.json()).toMatchObject({
      unread_count: 1,
      notifications: [
        expect.objectContaining({
          category: 'ACCOUNT_VERIFICATION',
          title: 'Viewer count verified',
          meta: expect.objectContaining({
            viewer_count: 1450,
            verified_viewer_count: 1450,
            verification_status: 'APPROVED',
            admin_note: 'Viewer list is clear and stable.',
          }),
        }),
      ],
    });
  });

  it('rejects viewer verification and records the rejection notification for the mobile inbox', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const admin = await insertUser({
      email: 'reject-admin@prime.test',
      phone: '+256700100004',
      full_name: 'Reject Admin',
      role: 'ADMIN',
      active_role: 'ADMIN',
      admin_role: 'SUPER_ADMIN',
      country_id: ug.id,
    });
    const ambassador = await insertUser({
      email: 'rejected-ambassador@prime.test',
      phone: '+256700100005',
      full_name: 'Rejected Ambassador',
      role: 'AMBASSADOR',
      active_role: 'AMBASSADOR',
      country_id: ug.id,
    });
    await acceptRequiredPolicies(String(ambassador.id));

    const recordingRes = await pool!.query(
      `
      INSERT INTO ambassador_verification_recordings (user_id, video_url)
      VALUES ($1, $2)
      RETURNING id
      `,
      [ambassador.id, '/uploads/files/test-rejected.mp4?mime=video%2Fmp4']
    );
    const recordingId = String(recordingRes.rows[0].id);

    const adminToken = app.jwt.sign(buildAuthClaims(admin));
    const ambassadorToken = app.jwt.sign(buildAuthClaims(ambassador));

    const rejected = await app.inject({
      method: 'PATCH',
      url: `/api/admin/user-verifications/${recordingId}/reject`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        admin_note: 'Viewer list is cropped. Re-record with the full sheet visible.',
      },
    });
    expect(rejected.statusCode).toBe(200);
    expect(rejected.json()).toMatchObject({ ok: true });

    const notifications = await app.inject({
      method: 'GET',
      url: '/api/account/notifications?limit=10',
      headers: { authorization: `Bearer ${ambassadorToken}` },
    });
    expect(notifications.statusCode).toBe(200);
    expect(notifications.json()).toMatchObject({
      unread_count: 1,
      notifications: [
        expect.objectContaining({
          category: 'ACCOUNT_VERIFICATION',
          title: 'Verification recording rejected',
          body: expect.stringContaining('cropped'),
          meta: expect.objectContaining({
            verification_status: 'REJECTED',
            admin_note:
              'Viewer list is cropped. Re-record with the full sheet visible.',
            requires_resubmission: true,
          }),
        }),
      ],
    });
  });
});

