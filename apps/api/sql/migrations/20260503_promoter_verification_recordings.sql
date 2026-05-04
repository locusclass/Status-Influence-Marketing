-- Stores WhatsApp status screen recordings submitted by promoters
-- for admin review to set their verified 12h viewer count.
CREATE TABLE IF NOT EXISTS promoter_verification_recordings (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_url             TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING','APPROVED','REJECTED')),
  approved_viewer_count INTEGER,
  admin_note            TEXT,
  reviewed_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pvr_user_id_idx    ON promoter_verification_recordings(user_id);
CREATE INDEX IF NOT EXISTS pvr_status_idx     ON promoter_verification_recordings(status);
CREATE INDEX IF NOT EXISTS pvr_created_at_idx ON promoter_verification_recordings(created_at DESC);

-- Allow observed_views to be stored on proofs (idempotent)
ALTER TABLE proofs ADD COLUMN IF NOT EXISTS observed_views INTEGER;
