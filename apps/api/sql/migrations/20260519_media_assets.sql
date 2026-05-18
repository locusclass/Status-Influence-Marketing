-- media_assets: tracks every uploaded file with full lifecycle metadata.
-- upload_purpose drives access-control, size limits, and processing rules.

CREATE TABLE IF NOT EXISTS media_assets (
  id                      TEXT        PRIMARY KEY,
  owner_user_id           UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  campaign_id             UUID        REFERENCES campaigns(id) ON DELETE SET NULL,
  ambassador_id           UUID        REFERENCES users(id) ON DELETE SET NULL,
  proof_id                UUID        REFERENCES proofs(id) ON DELETE SET NULL,
  asset_type              TEXT        NOT NULL DEFAULT 'image'
                            CHECK (asset_type IN ('image', 'video', 'document')),
  upload_purpose          TEXT        NOT NULL
                            CHECK (upload_purpose IN (
                              'campaign_banner', 'campaign_gallery', 'campaign_video',
                              'landing_page_media', 'ambassador_proof_screenshot',
                              'ambassador_proof_screen_recording',
                              'user_avatar', 'business_logo', 'admin_attachment'
                            )),
  mime_type               TEXT        NOT NULL,
  file_size_bytes         BIGINT,
  original_storage_path   TEXT,
  optimized_storage_path  TEXT,
  thumbnail_storage_path  TEXT,
  sha256_hash             TEXT,
  width                   INTEGER,
  height                  INTEGER,
  duration_seconds        NUMERIC(10, 3),
  processing_status       TEXT        NOT NULL DEFAULT 'pending_upload'
                            CHECK (processing_status IN (
                              'pending_upload', 'uploaded', 'processing',
                              'ready', 'failed', 'deleted'
                            )),
  moderation_status       TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (moderation_status IN ('pending', 'approved', 'rejected')),
  verification_status     TEXT        NOT NULL DEFAULT 'not_required'
                            CHECK (verification_status IN (
                              'not_required', 'pending', 'passed', 'failed', 'needs_admin_review'
                            )),
  signed_url_expires_at   TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_media_assets_owner
  ON media_assets(owner_user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_media_assets_campaign
  ON media_assets(campaign_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_media_assets_proof
  ON media_assets(proof_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_media_assets_purpose
  ON media_assets(upload_purpose, processing_status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_media_assets_pending_upload
  ON media_assets(created_at) WHERE processing_status = 'pending_upload' AND deleted_at IS NULL;
