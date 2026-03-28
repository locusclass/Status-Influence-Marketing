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

CREATE OR REPLACE FUNCTION generate_pronounceable_public_id(prefix TEXT)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  consonants TEXT[] := ARRAY[
    'b','d','f','g','k','l','m','n','p','r','s','t','v','z'
  ];
  vowels TEXT[] := ARRAY['a','e','i','o','u'];
  output TEXT := lower(prefix) || '-';
  idx INTEGER;
BEGIN
  FOR idx IN 1..4 LOOP
    output := output
      || consonants[1 + floor(random() * array_length(consonants, 1))::int]
      || vowels[1 + floor(random() * array_length(vowels, 1))::int];
  END LOOP;

  output := output || lpad(floor(random() * 100)::int::text, 2, '0');
  RETURN output;
END;
$$;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id TEXT NOT NULL DEFAULT generate_pronounceable_public_id('usr'),
  full_name TEXT NOT NULL DEFAULT '',
  email TEXT UNIQUE NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  whatsapp_verified BOOLEAN NOT NULL DEFAULT FALSE,
  whatsapp_verified_at TIMESTAMPTZ,
  whatsapp_jid TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ADVERTISER', 'DISTRIBUTOR', 'DUAL_USER', 'ADMIN')),
  active_role TEXT NOT NULL DEFAULT 'DISTRIBUTOR' CHECK (active_role IN ('ADVERTISER', 'DISTRIBUTOR', 'ADMIN')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'BANNED')),
  country TEXT NOT NULL DEFAULT 'UG',
  preferred_currency TEXT NOT NULL DEFAULT 'UGX',
  can_multi_contract BOOLEAN NOT NULL DEFAULT FALSE,
  max_status_viewers_12h INTEGER NOT NULL DEFAULT 0,
  current_advertiser_viewers INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'active_role'
  ) THEN
    ALTER TABLE users
      ADD COLUMN active_role TEXT NOT NULL DEFAULT 'DISTRIBUTOR'
      CHECK (active_role IN ('ADVERTISER', 'DISTRIBUTOR', 'ADMIN'));
  END IF;
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  ALTER TABLE users
    ADD CONSTRAINT users_role_check CHECK (role IN ('ADVERTISER', 'DISTRIBUTOR', 'DUAL_USER', 'ADMIN'));
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_active_role_check;
  ALTER TABLE users
    ADD CONSTRAINT users_active_role_check CHECK (active_role IN ('ADVERTISER', 'DISTRIBUTOR', 'ADMIN'));
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
  ALTER TABLE users
    ADD CONSTRAINT users_status_check CHECK (status IN ('ACTIVE', 'SUSPENDED', 'BANNED'));
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'public_id'
  ) THEN
    ALTER TABLE users
      ADD COLUMN public_id TEXT NOT NULL DEFAULT generate_pronounceable_public_id('usr');
  END IF;
  UPDATE users
  SET public_id = generate_pronounceable_public_id('usr')
  WHERE public_id IS NULL OR btrim(public_id) = '';
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
  UPDATE users
  SET active_role = CASE
      WHEN role = 'ADMIN' THEN 'ADMIN'
      WHEN role = 'ADVERTISER' THEN 'ADVERTISER'
      WHEN role = 'DUAL_USER' AND (active_role IS NULL OR btrim(active_role) = '') THEN 'DISTRIBUTOR'
      ELSE COALESCE(NULLIF(active_role, ''), 'DISTRIBUTOR')
    END
  WHERE active_role IS NULL
     OR btrim(active_role) = ''
     OR (role = 'ADMIN' AND active_role <> 'ADMIN')
     OR (role = 'ADVERTISER' AND active_role NOT IN ('ADVERTISER', 'ADMIN'))
     OR (role = 'DISTRIBUTOR' AND active_role NOT IN ('DISTRIBUTOR', 'ADMIN'));
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
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'max_status_viewers_12h'
  ) THEN
    ALTER TABLE users
      ADD COLUMN max_status_viewers_12h INTEGER NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'current_advertiser_viewers'
  ) THEN
    ALTER TABLE users
      ADD COLUMN current_advertiser_viewers INTEGER NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'whatsapp_verified'
  ) THEN
    ALTER TABLE users
      ADD COLUMN whatsapp_verified BOOLEAN NOT NULL DEFAULT FALSE;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'whatsapp_verified_at'
  ) THEN
    ALTER TABLE users
      ADD COLUMN whatsapp_verified_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'whatsapp_jid'
  ) THEN
    ALTER TABLE users
      ADD COLUMN whatsapp_jid TEXT;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id TEXT NOT NULL DEFAULT generate_pronounceable_public_id('cmp'),
  advertiser_id UUID NOT NULL REFERENCES users(id),
  parent_campaign_id UUID REFERENCES campaigns(id),
  assigned_distributor_id UUID REFERENCES users(id),
  assigned_phone TEXT,
  title TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('WHATSAPP_STATUS', 'TIKTOK', 'X')),
  execution_mode TEXT NOT NULL DEFAULT 'PRIVATE_CONTRACT' CHECK (execution_mode IN ('PRIVATE_CONTRACT', 'OPEN_BUDGET')),
  visibility TEXT NOT NULL DEFAULT 'PUBLIC' CHECK (visibility IN ('PUBLIC', 'PRIVATE')),
  payout_amount INTEGER NOT NULL,
  budget_total INTEGER NOT NULL,
  impression_target INTEGER,
  platform_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  advertiser_wallet_mode TEXT NOT NULL DEFAULT 'CAMPAIGN_ONLY',
  last_allocated_at TIMESTAMPTZ,
  allocation_round INTEGER NOT NULL DEFAULT 0,
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
    WHERE table_name = 'campaigns' AND column_name = 'public_id'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN public_id TEXT NOT NULL DEFAULT generate_pronounceable_public_id('cmp');
  END IF;
  UPDATE campaigns
  SET public_id = generate_pronounceable_public_id('cmp')
  WHERE public_id IS NULL OR btrim(public_id) = '';
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'parent_campaign_id'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN parent_campaign_id UUID REFERENCES campaigns(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'assigned_distributor_id'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN assigned_distributor_id UUID REFERENCES users(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'assigned_phone'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN assigned_phone TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'execution_mode'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'PRIVATE_CONTRACT'
      CHECK (execution_mode IN ('PRIVATE_CONTRACT', 'OPEN_BUDGET'));
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'visibility'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN visibility TEXT NOT NULL DEFAULT 'PUBLIC'
      CHECK (visibility IN ('PUBLIC', 'PRIVATE'));
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'impression_target'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN impression_target INTEGER;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'platform_fee_percent'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN platform_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'advertiser_wallet_mode'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN advertiser_wallet_mode TEXT NOT NULL DEFAULT 'CAMPAIGN_ONLY';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'last_allocated_at'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN last_allocated_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'allocation_round'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN allocation_round INTEGER NOT NULL DEFAULT 0;
  END IF;
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

DO $$ BEGIN
  ALTER TABLE campaigns DROP CONSTRAINT IF EXISTS campaigns_platform_check;
  ALTER TABLE campaigns
    ADD CONSTRAINT campaigns_platform_check CHECK (platform IN ('WHATSAPP_STATUS', 'TIKTOK', 'X'));
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
  platform TEXT NOT NULL CHECK (platform IN ('WHATSAPP_STATUS', 'TIKTOK', 'X')),
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

DO $$ BEGIN
  ALTER TABLE verification_sessions DROP CONSTRAINT IF EXISTS verification_sessions_platform_check;
  ALTER TABLE verification_sessions
    ADD CONSTRAINT verification_sessions_platform_check CHECK (platform IN ('WHATSAPP_STATUS', 'TIKTOK', 'X'));
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

CREATE TABLE IF NOT EXISTS wallet_withdrawals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets(id),
  user_id UUID NOT NULL REFERENCES users(id),
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'UGX',
  receiver_phone TEXT NOT NULL,
  mobile_money_network TEXT,
  status payout_status NOT NULL DEFAULT 'PROCESSING',
  pesapal_reference TEXT UNIQUE,
  failure_reason TEXT,
  paid_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
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
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_public_id ON users(public_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_created_at ON campaigns(created_at);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns(status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_campaigns_public_id ON campaigns(public_id);
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
