CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'verification_decision') THEN
    CREATE TYPE verification_decision AS ENUM ('VERIFIED', 'REJECTED', 'MANUAL_REVIEW');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'escrow_status') THEN
    CREATE TYPE escrow_status AS ENUM ('PENDING', 'FUNDED', 'PARTIALLY_DISBURSED', 'COMPLETED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'payout_status') THEN
    CREATE TYPE payout_status AS ENUM ('REQUESTED', 'PROCESSING', 'PAID', 'FAILED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'job_status') THEN
    CREATE TYPE job_status AS ENUM ('QUEUED', 'PROCESSING', 'RETRY', 'FAILED', 'DONE');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pesapal_txn_status') THEN
    CREATE TYPE pesapal_txn_status AS ENUM ('PENDING', 'COMPLETED', 'FAILED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADVERTISER', 'DISTRIBUTOR')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_id UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('WHATSAPP_STATUS', 'TIKTOK', 'INSTAGRAM', 'X')),
  payout_amount INTEGER NOT NULL,
  budget_total INTEGER NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  distributor_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS verification_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  platform TEXT NOT NULL CHECK (platform IN ('WHATSAPP_STATUS', 'TIKTOK', 'INSTAGRAM', 'X')),
  challenge_code TEXT NOT NULL,
  challenge_phrase TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS proofs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES verification_sessions(id),
  user_id UUID NOT NULL REFERENCES users(id),
  video_url TEXT NOT NULL,
  decision verification_decision,
  observed_views INTEGER,
  observed_post_hash TEXT,
  challenge_seen BOOLEAN,
  confidence NUMERIC(5,2),
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED', 'MANUAL_REVIEW')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trust_scores (
  user_id UUID PRIMARY KEY REFERENCES users(id),
  score INTEGER NOT NULL DEFAULT 50,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS trust_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('VERIFIED', 'REJECTED', 'MANUAL_REVIEW')),
  delta INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS device_fingerprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  fingerprint_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id),
  balance INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS wallet_txns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets(id),
  amount INTEGER NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('CREDIT', 'DEBIT')),
  reference TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS escrow_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  status escrow_status NOT NULL DEFAULT 'PENDING',
  amount_total INTEGER NOT NULL,
  amount_available INTEGER NOT NULL,
  pesapal_txn_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payout_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proof_id UUID NOT NULL UNIQUE REFERENCES proofs(id),
  user_id UUID NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  status payout_status NOT NULL DEFAULT 'REQUESTED',
  pesapal_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pesapal_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  escrow_id UUID REFERENCES escrow_ledger(id),
  type TEXT NOT NULL CHECK (type IN ('FUNDING', 'PAYOUT')),
  amount INTEGER NOT NULL,
  status pesapal_txn_status NOT NULL DEFAULT 'PENDING',
  merchant_reference TEXT NOT NULL,
  transaction_reference TEXT,
  raw_payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pesapal_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id TEXT NOT NULL UNIQUE,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status job_status NOT NULL DEFAULT 'QUEUED',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_queue_run ON job_queue(status, run_at);
CREATE INDEX IF NOT EXISTS idx_proofs_session ON proofs(session_id);
CREATE INDEX IF NOT EXISTS idx_trust_events_user ON trust_events(user_id);
CREATE INDEX IF NOT EXISTS idx_pesapal_txn_ref ON pesapal_transactions(merchant_reference);
