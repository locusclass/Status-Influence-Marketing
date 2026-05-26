-- ============================================================
-- Prime Status: Vendor Commerce Ecosystem
-- Migration: 20260526_vendor_system.sql
-- ============================================================
-- Creates the full vendor infrastructure:
--   vendor_profiles, vendor_inquiries, negotiation_threads,
--   negotiation_messages, vendor_boost_plans, vendor_boosts,
--   vendor_analytics_events
-- Extends advert_listings with vendor linkage + product fields
-- All changes are backward-compatible (IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
-- ============================================================

-- ─────────────────────────────────────────────
-- VENDOR PROFILES
-- Central vendor account — one per user (unique index on user_id)
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vendor_profiles (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vendor_name           TEXT        NOT NULL,
  slug                  TEXT        NOT NULL,
  logo_url              TEXT,
  banner_url            TEXT,
  description           TEXT,
  phone_number          TEXT,
  whatsapp_number       TEXT,
  email                 TEXT,
  business_location     TEXT,
  business_category     TEXT,
  social_instagram      TEXT,
  social_facebook       TEXT,
  social_twitter        TEXT,
  social_tiktok         TEXT,
  website_url           TEXT,
  -- verification & status
  verification_status   TEXT        NOT NULL DEFAULT 'UNVERIFIED'
                        CHECK (verification_status IN ('UNVERIFIED', 'PENDING', 'VERIFIED')),
  trust_badges          TEXT[]      NOT NULL DEFAULT '{}',
  status                TEXT        NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED')),
  is_featured           BOOLEAN     NOT NULL DEFAULT FALSE,
  -- counters (updated by triggers / background jobs)
  total_views           BIGINT      NOT NULL DEFAULT 0,
  total_sales           BIGINT      NOT NULL DEFAULT 0,
  total_negotiations    BIGINT      NOT NULL DEFAULT 0,
  total_inquiries       BIGINT      NOT NULL DEFAULT 0,
  qr_scan_count         BIGINT      NOT NULL DEFAULT 0,
  follower_count        BIGINT      NOT NULL DEFAULT 0,
  -- extra metadata (hours, delivery areas, etc.)
  metadata              JSONB       NOT NULL DEFAULT '{}',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_user       ON vendor_profiles(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vendor_slug       ON vendor_profiles(slug);
CREATE        INDEX IF NOT EXISTS idx_vendor_status     ON vendor_profiles(status);
CREATE        INDEX IF NOT EXISTS idx_vendor_featured   ON vendor_profiles(is_featured) WHERE is_featured = TRUE;
CREATE        INDEX IF NOT EXISTS idx_vendor_verify     ON vendor_profiles(verification_status);
CREATE        INDEX IF NOT EXISTS idx_vendor_created    ON vendor_profiles(created_at DESC);

-- ─────────────────────────────────────────────
-- EXTEND advert_listings WITH VENDOR FIELDS
-- All backward-compatible; existing rows keep defaults
-- ─────────────────────────────────────────────

ALTER TABLE advert_listings ADD COLUMN IF NOT EXISTS vendor_id        UUID    REFERENCES vendor_profiles(id) ON DELETE SET NULL;
ALTER TABLE advert_listings ADD COLUMN IF NOT EXISTS listing_kind     TEXT    NOT NULL DEFAULT 'PRODUCT'
  CHECK (listing_kind IN ('PRODUCT', 'SERVICE'));
ALTER TABLE advert_listings ADD COLUMN IF NOT EXISTS tags             TEXT[]  NOT NULL DEFAULT '{}';
ALTER TABLE advert_listings ADD COLUMN IF NOT EXISTS condition        TEXT
  CHECK (condition IN ('NEW', 'USED', 'REFURBISHED') OR condition IS NULL);
ALTER TABLE advert_listings ADD COLUMN IF NOT EXISTS stock_status     TEXT    NOT NULL DEFAULT 'IN_STOCK'
  CHECK (stock_status IN ('IN_STOCK', 'OUT_OF_STOCK', 'LIMITED', 'MADE_TO_ORDER'));
ALTER TABLE advert_listings ADD COLUMN IF NOT EXISTS delivery_options TEXT[]  NOT NULL DEFAULT '{}';
ALTER TABLE advert_listings ADD COLUMN IF NOT EXISTS smart_link       TEXT;
ALTER TABLE advert_listings ADD COLUMN IF NOT EXISTS qr_scan_count    BIGINT  NOT NULL DEFAULT 0;
ALTER TABLE advert_listings ADD COLUMN IF NOT EXISTS views_7d         BIGINT  NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_al_vendor ON advert_listings(vendor_id) WHERE vendor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_al_kind   ON advert_listings(listing_kind);
CREATE INDEX IF NOT EXISTS idx_al_tags   ON advert_listings USING GIN(tags);

-- ─────────────────────────────────────────────
-- VENDOR INQUIRIES
-- Buyer messages sent from marketplace / storefront
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vendor_inquiries (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       UUID        NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  listing_id      UUID        REFERENCES advert_listings(id) ON DELETE SET NULL,
  buyer_user_id   UUID        REFERENCES users(id) ON DELETE SET NULL,
  buyer_name      TEXT,
  buyer_phone     TEXT,
  buyer_whatsapp  TEXT,
  buyer_email     TEXT,
  message         TEXT        NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'NEW'
                  CHECK (status IN ('NEW', 'READ', 'REPLIED', 'CLOSED')),
  reply           TEXT,
  replied_at      TIMESTAMPTZ,
  source          TEXT        NOT NULL DEFAULT 'MARKETPLACE'
                  CHECK (source IN ('MARKETPLACE', 'STOREFRONT', 'QR', 'LINK', 'DIRECT')),
  ip_address      TEXT,
  metadata        JSONB       NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vi_vendor    ON vendor_inquiries(vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vi_listing   ON vendor_inquiries(listing_id);
CREATE INDEX IF NOT EXISTS idx_vi_status    ON vendor_inquiries(status);
CREATE INDEX IF NOT EXISTS idx_vi_buyer     ON vendor_inquiries(buyer_user_id);

-- ─────────────────────────────────────────────
-- NEGOTIATION THREADS
-- One thread per buyer/listing pair
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS negotiation_threads (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      UUID          NOT NULL REFERENCES advert_listings(id) ON DELETE CASCADE,
  vendor_id       UUID          NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  buyer_user_id   UUID          REFERENCES users(id) ON DELETE SET NULL,
  buyer_token     TEXT,
  buyer_name      TEXT,
  buyer_phone     TEXT,
  listing_price   NUMERIC(15,2),
  final_price     NUMERIC(15,2),
  currency        TEXT          NOT NULL DEFAULT 'UGX',
  status          TEXT          NOT NULL DEFAULT 'ACTIVE'
                  CHECK (status IN ('ACTIVE', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'WITHDRAWN')),
  message_count   INTEGER       NOT NULL DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW() + INTERVAL '48 hours',
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nt_listing  ON negotiation_threads(listing_id);
CREATE INDEX IF NOT EXISTS idx_nt_vendor   ON negotiation_threads(vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_nt_buyer    ON negotiation_threads(buyer_user_id);
CREATE INDEX IF NOT EXISTS idx_nt_status   ON negotiation_threads(status);

-- ─────────────────────────────────────────────
-- NEGOTIATION MESSAGES
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS negotiation_messages (
  id            UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id     UUID          NOT NULL REFERENCES negotiation_threads(id) ON DELETE CASCADE,
  party         TEXT          NOT NULL CHECK (party IN ('BUYER', 'VENDOR')),
  message_type  TEXT          NOT NULL DEFAULT 'TEXT'
                CHECK (message_type IN ('TEXT', 'OFFER', 'COUNTER_OFFER', 'ACCEPT', 'REJECT', 'SYSTEM')),
  content       TEXT          NOT NULL,
  offer_amount  NUMERIC(15,2),
  currency      TEXT          NOT NULL DEFAULT 'UGX',
  is_read       BOOLEAN       NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_nm_thread  ON negotiation_messages(thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_nm_unread  ON negotiation_messages(thread_id, is_read) WHERE is_read = FALSE;

-- ─────────────────────────────────────────────
-- BOOST PLANS (catalog)
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vendor_boost_plans (
  id              UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT          NOT NULL,
  slug            TEXT          NOT NULL UNIQUE,
  duration_hours  INTEGER       NOT NULL DEFAULT 24,
  price_ugx       NUMERIC(15,2) NOT NULL,
  price_usd       NUMERIC(15,2),
  boost_type      TEXT          NOT NULL
                  CHECK (boost_type IN ('LISTING', 'STOREFRONT', 'CATEGORY')),
  impressions     INTEGER,
  description     TEXT,
  is_active       BOOLEAN       NOT NULL DEFAULT TRUE,
  sort_order      INTEGER       NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- VENDOR BOOSTS (active instances)
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vendor_boosts (
  id          UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id   UUID          NOT NULL REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  listing_id  UUID          REFERENCES advert_listings(id) ON DELETE SET NULL,
  plan_id     UUID          REFERENCES vendor_boost_plans(id),
  boost_type  TEXT          NOT NULL
              CHECK (boost_type IN ('LISTING', 'STOREFRONT', 'CATEGORY')),
  target_slug TEXT,
  status      TEXT          NOT NULL DEFAULT 'ACTIVE'
              CHECK (status IN ('PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED')),
  starts_at   TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  ends_at     TIMESTAMPTZ   NOT NULL,
  impressions INTEGER       NOT NULL DEFAULT 0,
  clicks      INTEGER       NOT NULL DEFAULT 0,
  cost_ugx    NUMERIC(15,2) NOT NULL DEFAULT 0,
  payment_ref TEXT,
  created_at  TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vb_vendor   ON vendor_boosts(vendor_id);
CREATE INDEX IF NOT EXISTS idx_vb_listing  ON vendor_boosts(listing_id) WHERE listing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vb_status   ON vendor_boosts(status, ends_at);
CREATE INDEX IF NOT EXISTS idx_vb_active   ON vendor_boosts(ends_at) WHERE status = 'ACTIVE';

-- ─────────────────────────────────────────────
-- ANALYTICS EVENTS
-- Append-only event stream for vendor analytics
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS vendor_analytics_events (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id   UUID        REFERENCES vendor_profiles(id) ON DELETE CASCADE,
  listing_id  UUID        REFERENCES advert_listings(id) ON DELETE CASCADE,
  event_type  TEXT        NOT NULL CHECK (event_type IN (
    'STOREFRONT_VIEW', 'LISTING_VIEW', 'INQUIRY_SENT',
    'NEGOTIATION_STARTED', 'QR_SCAN', 'LINK_CLICK',
    'WHATSAPP_CLICK', 'PHONE_CLICK', 'BOOST_IMPRESSION',
    'BOOST_CLICK', 'SHARE'
  )),
  source      TEXT,
  ip_address  TEXT,
  user_agent  TEXT,
  referrer    TEXT,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial indexes for the most common query patterns
CREATE INDEX IF NOT EXISTS idx_vae_vendor_day  ON vendor_analytics_events(vendor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vae_listing_day ON vendor_analytics_events(listing_id, created_at DESC)
  WHERE listing_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_vae_type        ON vendor_analytics_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vae_views       ON vendor_analytics_events(vendor_id, created_at DESC)
  WHERE event_type = 'STOREFRONT_VIEW';

-- ─────────────────────────────────────────────
-- SEED: DEFAULT BOOST PLANS
-- ─────────────────────────────────────────────

INSERT INTO vendor_boost_plans (name, slug, duration_hours, price_ugx, boost_type, impressions, description, sort_order)
VALUES
  ('Starter Boost',     'listing-starter-24h',    24,   5000,  'LISTING',    1000,  '24-hour listing highlight in marketplace search',        1),
  ('Pro Boost',         'listing-pro-72h',         72,  12000, 'LISTING',    5000,  '3-day featured placement with priority search ranking',   2),
  ('Power Boost',       'listing-power-7d',       168,  25000, 'LISTING',   15000, '7-day power placement — homepage + category features',    3),
  ('Storefront Basic',  'storefront-basic-24h',    24,  10000, 'STOREFRONT', 2000,  'Feature your entire storefront for 24 hours',            4),
  ('Storefront Pro',    'storefront-pro-7d',      168,  40000, 'STOREFRONT',20000, '7-day storefront spotlight on marketplace homepage',       5)
ON CONFLICT (slug) DO NOTHING;
