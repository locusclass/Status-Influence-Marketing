-- Allow draft listings to exist without a campaign (no payment yet)
ALTER TABLE advert_listings ALTER COLUMN campaign_id DROP NOT NULL;

-- Per-listing secret token — owner uses this to preview their draft before payment
ALTER TABLE advert_listings
  ADD COLUMN IF NOT EXISTS preview_token UUID NOT NULL DEFAULT gen_random_uuid();

CREATE UNIQUE INDEX IF NOT EXISTS idx_advert_listings_preview_token
  ON advert_listings(preview_token);
