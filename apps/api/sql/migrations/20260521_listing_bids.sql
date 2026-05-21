-- Live bid negotiation system for negotiable listings
-- Three tables: sessions, individual bids, and generated quotations

CREATE TABLE IF NOT EXISTS listing_bid_sessions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id   UUID NOT NULL REFERENCES advert_listings(id) ON DELETE CASCADE,
  buyer_token  VARCHAR(64) NOT NULL UNIQUE,
  status       VARCHAR(20) NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'agreed', 'withdrawn', 'expired')),
  listing_price NUMERIC(15,2),
  agreed_price  NUMERIC(15,2),
  currency      VARCHAR(10) NOT NULL DEFAULT 'UGX',
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lbs_listing  ON listing_bid_sessions(listing_id);
CREATE INDEX IF NOT EXISTS idx_lbs_token    ON listing_bid_sessions(buyer_token);
CREATE INDEX IF NOT EXISTS idx_lbs_status   ON listing_bid_sessions(status);

CREATE TABLE IF NOT EXISTS listing_bids (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID NOT NULL REFERENCES listing_bid_sessions(id) ON DELETE CASCADE,
  party       VARCHAR(10) NOT NULL CHECK (party IN ('buyer', 'seller')),
  amount      NUMERIC(15,2) NOT NULL,
  is_accepted BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lb_session ON listing_bids(session_id);

CREATE TABLE IF NOT EXISTS listing_quotations (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id   UUID NOT NULL REFERENCES listing_bid_sessions(id),
  listing_id   UUID NOT NULL REFERENCES advert_listings(id),
  quote_number VARCHAR(20) NOT NULL UNIQUE,
  agreed_price NUMERIC(15,2) NOT NULL,
  currency     VARCHAR(10) NOT NULL DEFAULT 'UGX',
  buyer_name   VARCHAR(200) NOT NULL,
  buyer_phone  VARCHAR(50)  NOT NULL,
  buyer_email  VARCHAR(200),
  bid_count    INTEGER NOT NULL DEFAULT 0,
  valid_until  TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lq_session ON listing_quotations(session_id);
CREATE INDEX IF NOT EXISTS idx_lq_listing ON listing_quotations(listing_id);
