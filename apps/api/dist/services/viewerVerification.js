export async function ensureViewerVerificationSchema(client) {
    await client.query(`
    CREATE TABLE IF NOT EXISTS ambassador_verification_recordings (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      video_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PENDING',
      approved_viewer_count INTEGER,
      admin_note TEXT,
      reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      video_expires_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await client.query(`
    ALTER TABLE ambassador_verification_recordings
      ADD COLUMN IF NOT EXISTS approved_viewer_count INTEGER
  `);
    await client.query(`
    ALTER TABLE ambassador_verification_recordings
      ADD COLUMN IF NOT EXISTS admin_note TEXT
  `);
    await client.query(`
    ALTER TABLE ambassador_verification_recordings
      ADD COLUMN IF NOT EXISTS reviewed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL
  `);
    await client.query(`
    ALTER TABLE ambassador_verification_recordings
      ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ
  `);
    await client.query(`
    ALTER TABLE ambassador_verification_recordings
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
  `);
    await client.query(`
    ALTER TABLE ambassador_verification_recordings
      ADD COLUMN IF NOT EXISTS video_expires_at TIMESTAMPTZ
  `);
    await client.query(`
    ALTER TABLE ambassador_verification_recordings
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);
    await client.query(`
    ALTER TABLE ambassador_verification_recordings
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);
    await client.query(`
    ALTER TABLE ambassador_verification_recordings
      ALTER COLUMN status SET DEFAULT 'PENDING'
  `);
    await client.query(`
    UPDATE ambassador_verification_recordings
    SET status = 'PENDING'
    WHERE status IS NULL OR BTRIM(status) = ''
  `);
    await client.query(`
    UPDATE ambassador_verification_recordings
    SET status = 'PENDING'
    WHERE UPPER(BTRIM(status)) NOT IN ('PENDING', 'APPROVED', 'REJECTED')
  `);
    await client.query(`
    ALTER TABLE ambassador_verification_recordings
      DROP CONSTRAINT IF EXISTS ambassador_verification_recordings_status_check
  `);
    await client.query(`
    ALTER TABLE ambassador_verification_recordings
      ADD CONSTRAINT ambassador_verification_recordings_status_check
      CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED'))
  `);
    await client.query(`
    UPDATE ambassador_verification_recordings
    SET expires_at = reviewed_at + INTERVAL '30 days'
    WHERE status = 'APPROVED'
      AND reviewed_at IS NOT NULL
      AND expires_at IS NULL
  `);
    await client.query(`
    UPDATE ambassador_verification_recordings
    SET video_expires_at = reviewed_at + INTERVAL '24 hours'
    WHERE reviewed_at IS NOT NULL
      AND video_expires_at IS NULL
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS pvr_user_id_idx
    ON ambassador_verification_recordings (user_id)
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS pvr_status_idx
    ON ambassador_verification_recordings (status)
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS pvr_created_at_idx
    ON ambassador_verification_recordings (created_at DESC)
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS amb_verif_recordings_video_expires_idx
    ON ambassador_verification_recordings (video_expires_at)
    WHERE video_expires_at IS NOT NULL
  `);
}
export function buildActiveViewerVerificationJoin(userAlias = 'u', joinAlias = 'viewer_verification') {
    return `
    LEFT JOIN LATERAL (
      SELECT
        rec.id,
        COALESCE(rec.approved_viewer_count, 0)::int AS approved_viewer_count,
        rec.reviewed_at,
        rec.expires_at
      FROM ambassador_verification_recordings rec
      WHERE rec.user_id = ${userAlias}.id
        AND rec.status = 'APPROVED'
        AND COALESCE(rec.expires_at, NOW()) >= NOW()
      ORDER BY
        COALESCE(rec.reviewed_at, rec.created_at) DESC,
        rec.created_at DESC
      LIMIT 1
    ) ${joinAlias} ON TRUE
  `;
}
export function buildViewerVerificationFields(joinAlias = 'viewer_verification') {
    return `
    CASE WHEN ${joinAlias}.id IS NOT NULL THEN TRUE ELSE FALSE END AS viewer_count_verified,
    COALESCE(${joinAlias}.approved_viewer_count, 0)::int AS verified_viewer_count,
    ${joinAlias}.reviewed_at AS viewer_count_verified_at,
    ${joinAlias}.expires_at AS viewer_count_verification_expires_at
  `;
}
