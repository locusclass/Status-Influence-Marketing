-- Marketplace listing plans catalog and business subscriptions.
-- Prices are authoritative in code (campaignPackages.ts); this table is for
-- runtime lookups and subscription records.

CREATE TABLE IF NOT EXISTS marketplace_listing_plans (
  code            TEXT PRIMARY KEY,
  label           TEXT NOT NULL,
  price_ugx_monthly INTEGER NOT NULL CHECK (price_ugx_monthly > 0),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order      SMALLINT NOT NULL DEFAULT 0
);

INSERT INTO marketplace_listing_plans (code, label, price_ugx_monthly, sort_order) VALUES
  ('BASIC',            'Basic Listing',     10000, 1),
  ('FEATURED',         'Featured Listing',  25000, 2),
  ('PREMIUM',          'Premium Listing',   50000, 3),
  ('MARKETPLACE_PLUS', 'Marketplace Plus', 100000, 4)
ON CONFLICT (code) DO UPDATE
  SET label             = EXCLUDED.label,
      price_ugx_monthly = EXCLUDED.price_ugx_monthly,
      sort_order        = EXCLUDED.sort_order;

-- Business listing subscriptions (paid monthly).
CREATE TABLE IF NOT EXISTS business_listing_subscriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_code         TEXT NOT NULL REFERENCES marketplace_listing_plans(code),
  currency          TEXT NOT NULL DEFAULT 'UGX',
  amount            INTEGER NOT NULL,
  period_start      DATE NOT NULL DEFAULT CURRENT_DATE,
  valid_until       TIMESTAMPTZ,
  paid_at           TIMESTAMPTZ,
  is_waived         BOOLEAN NOT NULL DEFAULT FALSE,
  waived_by_admin_id UUID REFERENCES users(id),
  payment_reference TEXT,
  -- auto-qualified: business reached spend threshold via campaigns, no payment needed
  auto_qualified    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bls_business_id ON business_listing_subscriptions(business_id);
CREATE INDEX IF NOT EXISTS idx_bls_period      ON business_listing_subscriptions(period_start);
