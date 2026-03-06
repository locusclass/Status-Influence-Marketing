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
  full_name TEXT NOT NULL DEFAULT '',
  email TEXT UNIQUE NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADVERTISER', 'DISTRIBUTOR', 'ADMIN')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'BANNED')),
  country TEXT NOT NULL DEFAULT 'UG',
  preferred_currency TEXT NOT NULL DEFAULT 'UGX',
  can_multi_contract BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  ALTER TABLE users
    ADD CONSTRAINT users_role_check CHECK (role IN ('ADVERTISER', 'DISTRIBUTOR', 'ADMIN'));
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
  ALTER TABLE users
    ADD CONSTRAINT users_status_check CHECK (status IN ('ACTIVE', 'SUSPENDED', 'BANNED'));
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'full_name'
  ) THEN
    ALTER TABLE users
      ADD COLUMN full_name TEXT NOT NULL DEFAULT '';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'status'
  ) THEN
    ALTER TABLE users
      ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'
      CHECK (status IN ('ACTIVE', 'SUSPENDED', 'BANNED'));
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'country'
  ) THEN
    ALTER TABLE users
      ADD COLUMN country TEXT NOT NULL DEFAULT 'UG';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'preferred_currency'
  ) THEN
    ALTER TABLE users
      ADD COLUMN preferred_currency TEXT NOT NULL DEFAULT 'UGX';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'can_multi_contract'
  ) THEN
    ALTER TABLE users
      ADD COLUMN can_multi_contract BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advertiser_id UUID NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('WHATSAPP_STATUS', 'TIKTOK', 'INSTAGRAM', 'X')),
  payout_amount INTEGER NOT NULL,
  budget_total INTEGER NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('TEXT', 'IMAGE', 'VIDEO')),
  media_text TEXT,
  media_url TEXT,
  terms_keep_hours INTEGER NOT NULL DEFAULT 12,
  terms_min_views INTEGER,
  terms_requirement TEXT NOT NULL DEFAULT 'DURATION' CHECK (terms_requirement IN ('DURATION', 'VIEWS', 'BOTH')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'media_type'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN media_type TEXT NOT NULL DEFAULT 'TEXT' CHECK (media_type IN ('TEXT', 'IMAGE', 'VIDEO'));
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'media_text'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN media_text TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'media_url'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN media_url TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'status'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE'
      CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED'));
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'terms_keep_hours'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN terms_keep_hours INTEGER NOT NULL DEFAULT 12;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'terms_min_views'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN terms_min_views INTEGER;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'terms_requirement'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN terms_requirement TEXT NOT NULL DEFAULT 'DURATION'
      CHECK (terms_requirement IN ('DURATION', 'VIEWS', 'BOTH'));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  distributor_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'COMPLETED', 'CANCELLED')),
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  post_deadline_at TIMESTAMPTZ,
  contract_deadline_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'contracts' AND column_name = 'accepted_at'
  ) THEN
    ALTER TABLE contracts
      ADD COLUMN accepted_at TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'contracts' AND column_name = 'post_deadline_at'
  ) THEN
    ALTER TABLE contracts
      ADD COLUMN post_deadline_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'contracts' AND column_name = 'contract_deadline_at'
  ) THEN
    ALTER TABLE contracts
      ADD COLUMN contract_deadline_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'contracts' AND column_name = 'completed_at'
  ) THEN
    ALTER TABLE contracts
      ADD COLUMN completed_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'contracts' AND column_name = 'cancelled_at'
  ) THEN
    ALTER TABLE contracts
      ADD COLUMN cancelled_at TIMESTAMPTZ;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS verification_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  platform TEXT NOT NULL CHECK (platform IN ('WHATSAPP_STATUS', 'TIKTOK', 'INSTAGRAM', 'X')),
  challenge_code TEXT NOT NULL,
  challenge_phrase TEXT NOT NULL,
  script JSONB,
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
  review_reasons JSONB,
  meta JSONB,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'VERIFIED', 'REJECTED', 'MANUAL_REVIEW')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'verification_sessions' AND column_name = 'script'
  ) THEN
    ALTER TABLE verification_sessions
      ADD COLUMN script JSONB;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'proofs' AND column_name = 'review_reasons'
  ) THEN
    ALTER TABLE proofs
      ADD COLUMN review_reasons JSONB;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'proofs' AND column_name = 'meta'
  ) THEN
    ALTER TABLE proofs
      ADD COLUMN meta JSONB;
  END IF;
END $$;

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
  currency TEXT NOT NULL DEFAULT 'UGX',
  balance_available INTEGER NOT NULL DEFAULT 0,
  balance_escrow INTEGER NOT NULL DEFAULT 0,
  balance INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'wallets' AND column_name = 'currency'
  ) THEN
    ALTER TABLE wallets
      ADD COLUMN currency TEXT NOT NULL DEFAULT 'UGX';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'wallets' AND column_name = 'balance_available'
  ) THEN
    ALTER TABLE wallets
      ADD COLUMN balance_available INTEGER NOT NULL DEFAULT 0;
    UPDATE wallets SET balance_available = balance;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'wallets' AND column_name = 'balance_escrow'
  ) THEN
    ALTER TABLE wallets
      ADD COLUMN balance_escrow INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$;

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

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'admin_audit_logs' AND column_name = 'actor_id' AND data_type = 'uuid'
  ) THEN
    ALTER TABLE admin_audit_logs
      ALTER COLUMN actor_id TYPE TEXT
      USING actor_id::text;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS job_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  status job_status NOT NULL DEFAULT 'QUEUED',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error TEXT,
  retry_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'job_queue' AND column_name = 'retry_reason'
  ) THEN
    ALTER TABLE job_queue
      ADD COLUMN retry_reason TEXT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_job_queue_run ON job_queue(status, run_at);
CREATE INDEX IF NOT EXISTS idx_job_queue_created_at ON job_queue(created_at);
CREATE INDEX IF NOT EXISTS idx_job_queue_status ON job_queue(status);
CREATE INDEX IF NOT EXISTS idx_proofs_session ON proofs(session_id);
CREATE INDEX IF NOT EXISTS idx_trust_events_user ON trust_events(user_id);
CREATE INDEX IF NOT EXISTS idx_pesapal_txn_ref ON pesapal_transactions(merchant_reference);
CREATE INDEX IF NOT EXISTS idx_users_created_at ON users(created_at);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_campaigns_created_at ON campaigns(created_at);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE INDEX IF NOT EXISTS idx_proofs_created_at ON proofs(created_at);
CREATE INDEX IF NOT EXISTS idx_proofs_status ON proofs(status);
CREATE INDEX IF NOT EXISTS idx_payouts_created_at ON payout_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payout_requests(status);
CREATE INDEX IF NOT EXISTS idx_escrows_created_at ON escrow_ledger(created_at);
CREATE INDEX IF NOT EXISTS idx_escrows_status ON escrow_ledger(status);
CREATE INDEX IF NOT EXISTS idx_contracts_created_at ON contracts(created_at);
CREATE INDEX IF NOT EXISTS idx_contracts_status ON contracts(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_active_contract_per_campaign ON contracts(campaign_id) WHERE status='ACTIVE';
CREATE INDEX IF NOT EXISTS idx_wallets_created_at ON wallets(created_at);
CREATE INDEX IF NOT EXISTS idx_pesapal_created_at ON pesapal_transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_pesapal_status ON pesapal_transactions(status);
CREATE INDEX IF NOT EXISTS idx_webhooks_received_at ON pesapal_webhook_events(received_at);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON admin_audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON admin_audit_logs(action);
