-- Track when verification recording video should be purged (24h after review)
ALTER TABLE ambassador_verification_recordings
  ADD COLUMN IF NOT EXISTS video_expires_at TIMESTAMPTZ;

-- Back-fill: any already-reviewed recordings expire 24h after their review
UPDATE ambassador_verification_recordings
SET video_expires_at = reviewed_at + INTERVAL '24 hours'
WHERE reviewed_at IS NOT NULL AND video_expires_at IS NULL;

-- Track when an ambassador explicitly declines a private contract invitation
ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS declined_at TIMESTAMPTZ;

ALTER TABLE contracts
  ADD COLUMN IF NOT EXISTS declined_by_user_id UUID REFERENCES users(id);

-- Ensure indexes for filtering
CREATE INDEX IF NOT EXISTS contracts_campaign_status_idx
  ON contracts (campaign_id, status);

CREATE INDEX IF NOT EXISTS contracts_distributor_status_idx
  ON contracts (distributor_id, status);

-- Ensure verification recordings have proper index for cleanup jobs
CREATE INDEX IF NOT EXISTS amb_verif_recordings_video_expires_idx
  ON ambassador_verification_recordings (video_expires_at)
  WHERE video_expires_at IS NOT NULL;
