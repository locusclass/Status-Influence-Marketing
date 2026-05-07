ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS execution_meta JSONB;
