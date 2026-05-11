ALTER TABLE chat_group_deal_threads
  ADD COLUMN IF NOT EXISTS advertiser_id UUID REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE chat_group_deal_threads
  ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE chat_group_deal_threads
  ADD COLUMN IF NOT EXISTS media_url TEXT;

ALTER TABLE chat_group_deal_threads
  ADD COLUMN IF NOT EXISTS media_type TEXT;

UPDATE chat_group_deal_threads
SET business_id = COALESCE(business_id, advertiser_id),
    advertiser_id = COALESCE(advertiser_id, business_id)
WHERE business_id IS NULL
   OR advertiser_id IS NULL
   OR business_id IS DISTINCT FROM advertiser_id;

CREATE UNIQUE INDEX IF NOT EXISTS chat_group_deal_threads_group_id_business_id_key
  ON chat_group_deal_threads (group_id, business_id);

CREATE INDEX IF NOT EXISTS chat_group_deal_threads_business_idx
  ON chat_group_deal_threads (business_id, updated_at DESC);

ALTER TABLE chat_group_price_overrides
  ADD COLUMN IF NOT EXISTS advertiser_id UUID REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE chat_group_price_overrides
  ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES users(id) ON DELETE CASCADE;

UPDATE chat_group_price_overrides
SET business_id = COALESCE(business_id, advertiser_id),
    advertiser_id = COALESCE(advertiser_id, business_id)
WHERE business_id IS NULL
   OR advertiser_id IS NULL
   OR business_id IS DISTINCT FROM advertiser_id;

CREATE UNIQUE INDEX IF NOT EXISTS chat_group_price_overrides_group_id_business_id_key
  ON chat_group_price_overrides (group_id, business_id);
