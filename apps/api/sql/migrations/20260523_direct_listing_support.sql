-- Migration: direct listing support (marketplace / campaign-free listings)
-- Applied live via psql on 2026-05-23; recorded here for reproducibility.

-- Allow listings created without a listing_type (marketplace direct listings).
ALTER TABLE advert_listings ALTER COLUMN listing_type_id DROP NOT NULL;

-- Store rich content blocks (images, text, embeds) as ordered JSONB.
ALTER TABLE advert_listings ADD COLUMN IF NOT EXISTS content_blocks JSONB;
