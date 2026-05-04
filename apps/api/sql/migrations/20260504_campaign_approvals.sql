-- Campaign approval workflow + admin settings

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS approval_status VARCHAR(20) DEFAULT 'APPROVED',
  ADD COLUMN IF NOT EXISTS approval_deadline TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by_user_id UUID REFERENCES users(id);

-- All existing campaigns are already approved
UPDATE campaigns
  SET approval_status = 'APPROVED', approved_at = created_at
  WHERE approval_status IS NULL OR approval_status = '';

CREATE TABLE IF NOT EXISTS admin_settings (
  key   VARCHAR(100) PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO admin_settings (key, value)
  VALUES ('campaign_approval_mode', 'MANUAL')
  ON CONFLICT (key) DO NOTHING;
