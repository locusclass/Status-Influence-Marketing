-- Enforce campaign completeness before funding:
-- A campaign must have both an attached advert listing AND media
-- before it can be funded. This is enforced at the API layer in the
-- fund endpoints. This migration adds supporting indexes for the
-- completeness checks that run on every fund request.

CREATE INDEX IF NOT EXISTS idx_advert_listings_campaign_active
  ON advert_listings(campaign_id)
  WHERE status != 'CANCELLED';

-- Index used to quickly check if a campaign has media attached
CREATE INDEX IF NOT EXISTS idx_campaigns_has_media
  ON campaigns(id)
  WHERE media_url IS NOT NULL
     OR (media_type = 'TEXT' AND media_text IS NOT NULL);
