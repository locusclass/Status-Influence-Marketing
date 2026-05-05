-- 24-hour ad rate for ambassadors (separate from the existing 12h rate)
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS private_contract_rate_24h_ugx INTEGER NOT NULL DEFAULT 0;

-- Verification expiry: approved counts are valid for 30 days
ALTER TABLE ambassador_verification_recordings
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Back-fill: any already-approved recordings expire 30 days after review
UPDATE ambassador_verification_recordings
SET expires_at = reviewed_at + INTERVAL '30 days'
WHERE status = 'APPROVED' AND reviewed_at IS NOT NULL AND expires_at IS NULL;
