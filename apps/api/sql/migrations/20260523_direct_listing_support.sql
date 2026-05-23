-- Allow direct product-page listings that have no taxonomy classification
ALTER TABLE advert_listings ALTER COLUMN listing_type_id DROP NOT NULL;

-- Rich block content authored in the mobile product-page builder
ALTER TABLE advert_listings
  ADD COLUMN IF NOT EXISTS content_blocks JSONB NOT NULL DEFAULT '[]'::jsonb;
