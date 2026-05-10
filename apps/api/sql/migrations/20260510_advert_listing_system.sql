-- Advert Listing System
-- Extends campaign creation into a smart commerce listing builder

-- ─────────────────────────────────────────────
-- TAXONOMY
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS advert_categories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  icon          TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS advert_subcategories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id   UUID NOT NULL REFERENCES advert_categories(id) ON DELETE CASCADE,
  slug          TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS advert_listing_types (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subcategory_id   UUID NOT NULL REFERENCES advert_subcategories(id) ON DELETE CASCADE,
  slug             TEXT UNIQUE NOT NULL,
  name             TEXT NOT NULL,
  sort_order       INTEGER NOT NULL DEFAULT 0,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────
-- DYNAMIC FIELD DEFINITIONS (Shopify taxonomy attributes pattern)
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS advert_field_definitions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_type_id UUID NOT NULL REFERENCES advert_listing_types(id) ON DELETE CASCADE,
  field_key       TEXT NOT NULL,
  label           TEXT NOT NULL,
  field_type      TEXT NOT NULL CHECK (field_type IN (
    'TEXT', 'TEXTAREA', 'SELECT', 'MULTISELECT',
    'NUMBER', 'CURRENCY', 'BOOLEAN', 'DATE', 'LOCATION', 'PHONE', 'EMAIL', 'URL'
  )),
  is_required     BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  placeholder     TEXT,
  helper_text     TEXT,
  section_group   TEXT,
  min_length      INTEGER,
  max_length      INTEGER,
  min_value       NUMERIC,
  max_value       NUMERIC,
  UNIQUE (listing_type_id, field_key)
);

CREATE TABLE IF NOT EXISTS advert_field_options (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  field_def_id      UUID NOT NULL REFERENCES advert_field_definitions(id) ON DELETE CASCADE,
  option_value      TEXT NOT NULL,
  option_label      TEXT NOT NULL,
  sort_order        INTEGER NOT NULL DEFAULT 0
);

-- ─────────────────────────────────────────────
-- LISTINGS (main commerce record)
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS advert_listings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id         UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  business_id         UUID NOT NULL REFERENCES users(id),
  listing_type_id     UUID NOT NULL REFERENCES advert_listing_types(id),
  slug                TEXT UNIQUE NOT NULL,
  title               TEXT NOT NULL,
  summary             TEXT NOT NULL,
  description         TEXT NOT NULL,
  price               NUMERIC,
  currency            TEXT NOT NULL DEFAULT 'UGX',
  is_negotiable       BOOLEAN NOT NULL DEFAULT FALSE,
  location_text       TEXT,
  latitude            NUMERIC,
  longitude           NUMERIC,
  cta_whatsapp        TEXT,
  cta_phone           TEXT,
  cta_email           TEXT,
  cta_url             TEXT,
  status              TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','EXPIRED','CANCELLED')),
  expires_at          TIMESTAMPTZ,
  listing_quality_score INTEGER NOT NULL DEFAULT 0,
  views_total         INTEGER NOT NULL DEFAULT 0,
  views_unique        INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_advert_listings_campaign ON advert_listings(campaign_id);
CREATE INDEX IF NOT EXISTS idx_advert_listings_business ON advert_listings(business_id);
CREATE INDEX IF NOT EXISTS idx_advert_listings_status   ON advert_listings(status);

-- ─────────────────────────────────────────────
-- DYNAMIC FIELD VALUES
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS advert_listing_field_values (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id    UUID NOT NULL REFERENCES advert_listings(id) ON DELETE CASCADE,
  field_key     TEXT NOT NULL,
  field_value   TEXT,
  UNIQUE (listing_id, field_key)
);

-- ─────────────────────────────────────────────
-- MEDIA
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS advert_media (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      UUID NOT NULL REFERENCES advert_listings(id) ON DELETE CASCADE,
  media_pack      TEXT NOT NULL DEFAULT 'PRODUCT_GALLERY' CHECK (media_pack IN ('AMBASSADOR_PACK','PRODUCT_GALLERY')),
  media_type      TEXT NOT NULL CHECK (media_type IN ('IMAGE','VIDEO','DOCUMENT')),
  url             TEXT NOT NULL,
  thumbnail_url   TEXT,
  file_name       TEXT,
  mime_type       TEXT,
  file_size_bytes BIGINT,
  duration_secs   NUMERIC,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  views           INTEGER NOT NULL DEFAULT 0,
  plays           INTEGER NOT NULL DEFAULT 0,
  watch_time_secs NUMERIC NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_advert_media_listing ON advert_media(listing_id);

-- ─────────────────────────────────────────────
-- TRACKING LINKS (per Ambassador)
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS advert_tracking_links (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      UUID NOT NULL REFERENCES advert_listings(id) ON DELETE CASCADE,
  ambassador_id   UUID NOT NULL REFERENCES users(id),
  ambassador_code TEXT UNIQUE NOT NULL,
  visits          INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0,
  cta_taps        INTEGER NOT NULL DEFAULT 0,
  offers_generated INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (listing_id, ambassador_id)
);

-- ─────────────────────────────────────────────
-- ANALYTICS: PAGE SESSIONS
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS advert_page_sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id            UUID NOT NULL REFERENCES advert_listings(id) ON DELETE CASCADE,
  ambassador_code       TEXT,
  visitor_fingerprint   TEXT,
  session_start         TIMESTAMPTZ NOT NULL DEFAULT now(),
  session_end           TIMESTAMPTZ,
  session_duration_secs INTEGER,
  scroll_depth_pct      INTEGER,
  device_type           TEXT,
  country_code          TEXT,
  referrer              TEXT,
  is_return_visitor     BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_advert_sessions_listing ON advert_page_sessions(listing_id);
CREATE INDEX IF NOT EXISTS idx_advert_sessions_code    ON advert_page_sessions(ambassador_code);

-- ─────────────────────────────────────────────
-- ANALYTICS: ENGAGEMENT EVENTS
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS advert_engagement_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID REFERENCES advert_page_sessions(id) ON DELETE SET NULL,
  listing_id      UUID NOT NULL REFERENCES advert_listings(id) ON DELETE CASCADE,
  ambassador_code TEXT,
  event_type      TEXT NOT NULL CHECK (event_type IN (
    'PAGE_VIEW','CTA_TAP','WHATSAPP_TAP','PHONE_TAP','EMAIL_TAP',
    'MAP_OPEN','GALLERY_OPEN','OFFER_START','NEGOTIATION_START',
    'OUTBOUND_TAP','SHARE_TAP','CONVERSION_INTENT'
  )),
  event_meta      JSONB,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_advert_events_listing ON advert_engagement_events(listing_id);
CREATE INDEX IF NOT EXISTS idx_advert_events_type    ON advert_engagement_events(event_type);

-- ─────────────────────────────────────────────
-- ANALYTICS: MEDIA INTERACTIONS
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS advert_media_interactions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            UUID REFERENCES advert_page_sessions(id) ON DELETE SET NULL,
  media_id              UUID NOT NULL REFERENCES advert_media(id) ON DELETE CASCADE,
  listing_id            UUID NOT NULL REFERENCES advert_listings(id) ON DELETE CASCADE,
  ambassador_code       TEXT,
  interaction_type      TEXT NOT NULL CHECK (interaction_type IN (
    'IMAGE_VIEW','VIDEO_PLAY','VIDEO_PAUSE','VIDEO_COMPLETE','DOCUMENT_OPEN'
  )),
  watch_duration_secs   NUMERIC,
  completion_pct        NUMERIC,
  occurred_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_advert_media_interact_listing ON advert_media_interactions(listing_id);
CREATE INDEX IF NOT EXISTS idx_advert_media_interact_media   ON advert_media_interactions(media_id);

-- ─────────────────────────────────────────────
-- ANALYTICS: ROLLUPS (daily aggregations)
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS advert_analytics_rollups (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      UUID NOT NULL REFERENCES advert_listings(id) ON DELETE CASCADE,
  rollup_date     DATE NOT NULL,
  visits          INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0,
  cta_taps        INTEGER NOT NULL DEFAULT 0,
  whatsapp_taps   INTEGER NOT NULL DEFAULT 0,
  phone_taps      INTEGER NOT NULL DEFAULT 0,
  gallery_opens   INTEGER NOT NULL DEFAULT 0,
  offer_starts    INTEGER NOT NULL DEFAULT 0,
  avg_session_secs NUMERIC NOT NULL DEFAULT 0,
  UNIQUE (listing_id, rollup_date)
);

-- ─────────────────────────────────────────────
-- OFFERS / NEGOTIATIONS
-- ─────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS advert_offers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id      UUID NOT NULL REFERENCES advert_listings(id) ON DELETE CASCADE,
  offeror_name    TEXT NOT NULL,
  offeror_phone   TEXT,
  offeror_email   TEXT,
  offer_amount    NUMERIC,
  currency        TEXT NOT NULL DEFAULT 'UGX',
  offer_message   TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN (
    'PENDING','ACCEPTED','REJECTED','COUNTERED','CONTACTED','CLOSED'
  )),
  counter_amount  NUMERIC,
  counter_message TEXT,
  business_note   TEXT,
  visitor_fingerprint TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_advert_offers_listing ON advert_offers(listing_id);

CREATE TABLE IF NOT EXISTS advert_offer_messages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id    UUID NOT NULL REFERENCES advert_offers(id) ON DELETE CASCADE,
  sender_role TEXT NOT NULL CHECK (sender_role IN ('BUYER','BUSINESS')),
  message     TEXT NOT NULL,
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
