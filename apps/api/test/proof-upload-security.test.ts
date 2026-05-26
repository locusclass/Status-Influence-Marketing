import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildAuthClaims } from '../src/services/roles.js';
import { applySchema, getTestPool } from './db.js';

const pool = getTestPool();
let app: any;

async function resetDatabase() {
  if (!pool) return;
  const tablesRes = await pool.query(`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `);
  const tables = tablesRes.rows
    .map((row: any) => String(row.tablename ?? '').trim())
    .filter((name: string) => name.length > 0);
  if (tables.length > 0) {
    const quoted = tables.map((name: string) => `"${name}"`).join(', ');
    await pool.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
  }
  await applySchema(pool);
  await pool.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS privacy_policy_accepted_version TEXT,
      ADD COLUMN IF NOT EXISTS privacy_policy_accepted_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS platform_policy_accepted_version TEXT,
      ADD COLUMN IF NOT EXISTS platform_policy_accepted_at TIMESTAMPTZ
  `);
}

async function insertAcceptedUser() {
  const result = await pool!.query(
    `
    INSERT INTO users (
      full_name,
      email,
      phone,
      password_hash,
      role,
      active_role,
      country,
      preferred_currency,
      status,
      privacy_policy_accepted_version,
      privacy_policy_accepted_at,
      platform_policy_accepted_version,
      platform_policy_accepted_at,
      max_status_viewers_12h
    )
    VALUES (
      'Proof User',
      'proof-user@prime.test',
      '+256700900001',
      'x',
      'AMBASSADOR',
      'AMBASSADOR',
      'UG',
      'UGX',
      'ACTIVE',
      '2026-01',
      now(),
      '2026-01',
      now(),
      1000
    )
    RETURNING *
    `
  );
  return result.rows[0];
}

describe('Proof upload security hardening', () => {
  if (!pool) {
    it('skipped: TEST_DATABASE_URL not set', () => expect(true).toBe(true));
    return;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
    const serverModule = await import('../src/server.js');
    app = serverModule.buildServer();
    await applySchema(pool);
    await app.ready();
  }, 120000);

  beforeEach(async () => {
    await resetDatabase();
  }, 120000);

  afterAll(async () => {
    await app.close();
    await pool.end();
  }, 120000);

  it('stores proof videos behind the protected media route', async () => {
    const user = await insertAcceptedUser();
    const businessRes = await pool!.query(
      `
      INSERT INTO users (
        full_name, email, phone, password_hash, role, active_role, country, preferred_currency, status,
        privacy_policy_accepted_version, privacy_policy_accepted_at, platform_policy_accepted_version, platform_policy_accepted_at
      )
      VALUES (
        'Proof Business', 'proof-business@prime.test', '+256700900002', 'x',
        'BUSINESS', 'BUSINESS', 'UG', 'UGX', 'ACTIVE',
        '2026-01', now(), '2026-01', now()
      )
      RETURNING *
      `
    );
    const business = businessRes.rows[0];
    const campaignRes = await pool!.query(
      `
      INSERT INTO campaigns (
        business_id, title, platform, payout_amount, budget_total, media_type, media_url,
        start_date, end_date, visibility, execution_mode, status
      )
      VALUES (
        $1, 'Proof Campaign', 'WHATSAPP_STATUS', 2500, 2500, 'IMAGE',
        'https://example.com/reference.jpg', '2026-01-01', '2026-12-31',
        'PRIVATE', 'PRIVATE_CONTRACT', 'ACTIVE'
      )
      RETURNING *
      `,
      [business.id]
    );
    const campaign = campaignRes.rows[0];

    await pool!.query(
      `INSERT INTO contracts (campaign_id, ambassador_id, status) VALUES ($1, $2, 'ACTIVE')`,
      [campaign.id, user.id]
    );

    const sessionRes = await pool!.query(
      `
      INSERT INTO verification_sessions (
        user_id, campaign_id, platform, challenge_code, challenge_phrase, script, expires_at, status
      )
      VALUES (
        $1, $2, 'WHATSAPP_STATUS', 'TEST123', 'blue mango', '[]'::jsonb,
        now() + interval '1 hour', 'ACTIVE'
      )
      RETURNING *
      `,
      [user.id, campaign.id]
    );
    const session = sessionRes.rows[0];

    const assetId = '11111111-1111-1111-1111-111111111111';
    const objectName = `proofs/${user.id}/proof-video.mp4`;
    await pool!.query(
      `
      INSERT INTO media_assets (
        id, owner_user_id, campaign_id, asset_type, upload_purpose, mime_type,
        processing_status, moderation_status, verification_status, original_storage_path
      )
      VALUES (
        $1, $2, $3, 'video', 'ambassador_proof_screen_recording', 'video/mp4',
        'uploaded', 'pending', 'pending', $4
      )
      `,
      [assetId, user.id, campaign.id, objectName]
    );

    const token = app.jwt.sign(buildAuthClaims(user));
    const response = await app.inject({
      method: 'POST',
      url: '/api/verification/proofs',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        session_id: session.id,
        proof_video_url: `https://evil.example/uploads/files/${encodeURIComponent(objectName)}?mime=video%2Fmp4`,
        device_fingerprint: 'device-fingerprint-123456',
        client_meta: {
          recording_started_at: '2026-01-01T10:00:00.000Z',
          recording_stopped_at: '2026-01-01T10:01:00.000Z',
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().proof).toMatchObject({
      video_url: `/uploads/media/${assetId}`,
    });

    const proofRes = await pool!.query(
      'SELECT video_url, meta FROM proofs WHERE session_id=$1 LIMIT 1',
      [session.id]
    );
    expect(proofRes.rows[0].video_url).toBe(`/uploads/media/${assetId}`);
    expect(proofRes.rows[0].meta).toMatchObject({
      upload_asset_id: assetId,
      upload_storage_path: objectName,
      upload_mime_type: 'video/mp4',
    });
  });

  it('does not expose proof objects through the public file proxy', async () => {
    const user = await insertAcceptedUser();
    const objectName = `proofs/${user.id}/proof-video.mp4`;
    await pool!.query(
      `
      INSERT INTO media_assets (
        id, owner_user_id, asset_type, upload_purpose, mime_type,
        processing_status, moderation_status, verification_status, original_storage_path
      )
      VALUES (
        '22222222-2222-2222-2222-222222222222',
        $1,
        'video',
        'ambassador_proof_screen_recording',
        'video/mp4',
        'uploaded',
        'pending',
        'pending',
        $2
      )
      `,
      [user.id, objectName]
    );

    const response = await app.inject({
      method: 'GET',
      url: `/uploads/files/${encodeURIComponent(objectName)}?mime=video%2Fmp4`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'not_found' });
  });
});
