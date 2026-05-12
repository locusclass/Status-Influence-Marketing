-- Admin controls for advert listing availability and promotion.

ALTER TABLE advert_listings
  ADD COLUMN IF NOT EXISTS access_state TEXT NOT NULL DEFAULT 'PUBLIC'
    CHECK (access_state IN ('PUBLIC', 'REVOKED', 'BANNED', 'CLOSED')),
  ADD COLUMN IF NOT EXISTS is_promoted BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS admin_action_note TEXT,
  ADD COLUMN IF NOT EXISTS admin_action_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS admin_action_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_advert_listings_access_state
  ON advert_listings(access_state);

CREATE INDEX IF NOT EXISTS idx_advert_listings_promoted
  ON advert_listings(is_promoted)
  WHERE is_promoted = TRUE;
