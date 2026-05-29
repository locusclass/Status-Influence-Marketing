-- Ambassador subscription system
-- 1,000 UGX billed per calendar month
-- Ambassadors must have an active subscription to accept / execute contracts
-- Admins can waive the subscription for any ambassador

CREATE TABLE IF NOT EXISTS ambassador_subscriptions (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ambassador_id       UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period_start        DATE        NOT NULL,   -- first day of the billing month (e.g. 2026-05-01)
  amount              INTEGER     NOT NULL DEFAULT 1000,
  currency            TEXT        NOT NULL DEFAULT 'UGX',
  payment_reference   TEXT,                  -- populated once payment is confirmed
  paid_at             TIMESTAMPTZ,
  is_waived           BOOLEAN     NOT NULL DEFAULT false,
  waived_by_admin_id  UUID        REFERENCES admin_users(id),
  waived_at           TIMESTAMPTZ,
  waived_note         TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (ambassador_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_amb_subs_ambassador_period
  ON ambassador_subscriptions (ambassador_id, period_start DESC);

CREATE INDEX IF NOT EXISTS idx_amb_subs_period_start
  ON ambassador_subscriptions (period_start DESC);
