-- Tie listing lifetime to campaign duration
-- Adds admin override and improves expiry enforcement

ALTER TABLE advert_listings
  ADD COLUMN IF NOT EXISTS admin_keep_alive BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS campaign_start_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS campaign_end_at   TIMESTAMPTZ;

-- Back-fill campaign window for any existing listings from the campaigns table
UPDATE advert_listings al
SET
  campaign_start_at = COALESCE(
    c.start_date::TIMESTAMPTZ,
    al.created_at
  ),
  campaign_end_at = COALESCE(
    c.end_date::TIMESTAMPTZ,
    c.start_date::TIMESTAMPTZ + (COALESCE(c.terms_keep_hours, 12) * INTERVAL '1 hour'),
    al.created_at + INTERVAL '12 hours'
  )
FROM campaigns c
WHERE c.id = al.campaign_id
  AND al.campaign_start_at IS NULL;

-- Expire any listings whose campaign has already ended (unless admin_keep_alive)
UPDATE advert_listings
SET status = 'EXPIRED'
WHERE status = 'ACTIVE'
  AND admin_keep_alive = FALSE
  AND campaign_end_at IS NOT NULL
  AND campaign_end_at < now();

-- Index for the expiry sweep query
CREATE INDEX IF NOT EXISTS idx_advert_listings_campaign_end
  ON advert_listings (campaign_end_at)
  WHERE status = 'ACTIVE' AND admin_keep_alive = FALSE;
