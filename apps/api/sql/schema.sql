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

CREATE SEQUENCE IF NOT EXISTS user_public_id_seq
  MINVALUE 1000000000
  START WITH 1000000000
  MAXVALUE 9999999999
  NO CYCLE;

CREATE OR REPLACE FUNCTION generate_user_numeric_public_id()
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  next_value BIGINT;
BEGIN
  next_value := nextval('user_public_id_seq');
  IF next_value > 9999999999 THEN
    RAISE EXCEPTION 'user_public_id_seq exhausted';
  END IF;

  RETURN lpad(next_value::text, 10, '0');
END;
$$;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id TEXT NOT NULL DEFAULT generate_user_numeric_public_id(),
  full_name TEXT NOT NULL DEFAULT '',
  email TEXT UNIQUE NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  whatsapp_verified BOOLEAN NOT NULL DEFAULT FALSE,
  whatsapp_verified_at TIMESTAMPTZ,
  whatsapp_jid TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('BUSINESS', 'AMBASSADOR', 'DUAL_USER', 'ADMIN')),
  active_role TEXT NOT NULL DEFAULT 'AMBASSADOR' CHECK (active_role IN ('BUSINESS', 'AMBASSADOR', 'ADMIN')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'BANNED')),
  country TEXT NOT NULL DEFAULT 'UG',
  preferred_currency TEXT NOT NULL DEFAULT 'UGX',
  can_multi_contract BOOLEAN NOT NULL DEFAULT FALSE,
  max_status_viewers_12h INTEGER NOT NULL DEFAULT 0,
  private_contract_rate_ugx INTEGER NOT NULL DEFAULT 0,
  current_business_viewers INTEGER NOT NULL DEFAULT 0,
  privacy_policy_accepted_version TEXT,
  privacy_policy_accepted_at TIMESTAMPTZ,
  platform_policy_accepted_version TEXT,
  platform_policy_accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'active_role'
  ) THEN
    ALTER TABLE users
      ADD COLUMN active_role TEXT NOT NULL DEFAULT 'AMBASSADOR'
      CHECK (active_role IN ('BUSINESS', 'AMBASSADOR', 'ADMIN'));
  END IF;
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
  ALTER TABLE users
    ADD CONSTRAINT users_role_check CHECK (role IN ('BUSINESS', 'AMBASSADOR', 'DUAL_USER', 'ADMIN'));
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_active_role_check;
  ALTER TABLE users
    ADD CONSTRAINT users_active_role_check CHECK (active_role IN ('BUSINESS', 'AMBASSADOR', 'ADMIN'));
  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
  ALTER TABLE users
    ADD CONSTRAINT users_status_check CHECK (status IN ('ACTIVE', 'SUSPENDED', 'BANNED'));
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'public_id'
  ) THEN
    ALTER TABLE users
      ADD COLUMN public_id TEXT NOT NULL DEFAULT generate_user_numeric_public_id();
  END IF;
  ALTER TABLE users
    ALTER COLUMN public_id
    SET DEFAULT generate_user_numeric_public_id();
  PERFORM setval(
    'user_public_id_seq',
    GREATEST(
      COALESCE(
        (
          SELECT MAX(public_id::bigint)
          FROM users
          WHERE public_id ~ '^[1-9][0-9]{9}$'
        ),
        1000000000
      ),
      COALESCE((SELECT last_value FROM user_public_id_seq), 1000000000)
    ),
    true
  );
  UPDATE users
  SET public_id = generate_user_numeric_public_id()
  WHERE public_id IS NULL
     OR btrim(public_id) = ''
     OR public_id !~ '^[1-9][0-9]{9}$';
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
      WHEN role = 'BUSINESS' THEN 'BUSINESS'
      WHEN role = 'DUAL_USER' AND (active_role IS NULL OR btrim(active_role) = '') THEN 'AMBASSADOR'
      ELSE COALESCE(NULLIF(active_role, ''), 'AMBASSADOR')
    END
  WHERE active_role IS NULL
     OR btrim(active_role) = ''
     OR (role = 'ADMIN' AND active_role <> 'ADMIN')
     OR (role = 'BUSINESS' AND active_role NOT IN ('BUSINESS', 'ADMIN'))
     OR (role = 'AMBASSADOR' AND active_role NOT IN ('AMBASSADOR', 'ADMIN'));
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
    WHERE table_name = 'users' AND column_name = 'private_contract_rate_ugx'
  ) THEN
    ALTER TABLE users
      ADD COLUMN private_contract_rate_ugx INTEGER NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'current_business_viewers'
  ) THEN
    ALTER TABLE users
      ADD COLUMN current_business_viewers INTEGER NOT NULL DEFAULT 0;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'privacy_policy_accepted_version'
  ) THEN
    ALTER TABLE users
      ADD COLUMN privacy_policy_accepted_version TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'privacy_policy_accepted_at'
  ) THEN
    ALTER TABLE users
      ADD COLUMN privacy_policy_accepted_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'platform_policy_accepted_version'
  ) THEN
    ALTER TABLE users
      ADD COLUMN platform_policy_accepted_version TEXT;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'platform_policy_accepted_at'
  ) THEN
    ALTER TABLE users
      ADD COLUMN platform_policy_accepted_at TIMESTAMPTZ;
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
  business_id UUID NOT NULL REFERENCES users(id),
  parent_campaign_id UUID REFERENCES campaigns(id),
  assigned_ambassador_id UUID REFERENCES users(id),
  assigned_phone TEXT,
  title TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('WHATSAPP_STATUS')),
  execution_mode TEXT NOT NULL DEFAULT 'PRIVATE_CONTRACT' CHECK (execution_mode IN ('PRIVATE_CONTRACT', 'OPEN_BUDGET')),
  visibility TEXT NOT NULL DEFAULT 'PUBLIC' CHECK (visibility IN ('PUBLIC', 'PRIVATE')),
  payout_amount INTEGER NOT NULL,
  budget_total INTEGER NOT NULL,
  impression_target INTEGER,
  platform_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 0,
  business_wallet_mode TEXT NOT NULL DEFAULT 'CAMPAIGN_ONLY',
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
    WHERE table_name = 'campaigns' AND column_name = 'assigned_ambassador_id'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN assigned_ambassador_id UUID REFERENCES users(id);
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
    WHERE table_name = 'campaigns' AND column_name = 'business_wallet_mode'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN business_wallet_mode TEXT NOT NULL DEFAULT 'CAMPAIGN_ONLY';
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
    ADD CONSTRAINT campaigns_platform_check CHECK (platform IN ('WHATSAPP_STATUS'));
END $$;

CREATE TABLE IF NOT EXISTS contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  ambassador_id UUID NOT NULL REFERENCES users(id),
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
  platform TEXT NOT NULL CHECK (platform IN ('WHATSAPP_STATUS')),
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
    ADD CONSTRAINT verification_sessions_platform_check CHECK (platform IN ('WHATSAPP_STATUS'));
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
  platform_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 15,
  platform_fee_amount INTEGER NOT NULL DEFAULT 0,
  net_amount INTEGER,
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

CREATE TABLE IF NOT EXISTS countries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'INACTIVE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO countries (name, code, status)
VALUES ('Global Temp', 'GLOBAL_TEMP', 'ACTIVE')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS divisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id UUID NOT NULL REFERENCES countries(id),
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('CITY', 'UNIVERSITY', 'DISTRICT', 'OTHER')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS country_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  country_id UUID NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('PRIMARY', 'SECONDARY')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, country_id)
);

CREATE TABLE IF NOT EXISTS division_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  division_id UUID NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, division_id)
);

CREATE TABLE IF NOT EXISTS admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN', 'ADMIN')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED', 'DELETED')),
  created_by_super_admin_id UUID REFERENCES users(id),
  suspended_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS admin_user_modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  module_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admin_user_id, module_key)
);

CREATE TABLE IF NOT EXISTS admin_user_country_scopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  country_id UUID NOT NULL REFERENCES countries(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admin_user_id, country_id)
);

CREATE TABLE IF NOT EXISTS admin_user_division_scopes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_user_id UUID NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  division_id UUID NOT NULL REFERENCES divisions(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admin_user_id, division_id)
);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'admin_audit_logs' AND column_name = 'country_id'
  ) THEN
    ALTER TABLE admin_audit_logs
      ADD COLUMN country_id UUID REFERENCES countries(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'admin_audit_logs' AND column_name = 'division_id'
  ) THEN
    ALTER TABLE admin_audit_logs
      ADD COLUMN division_id UUID REFERENCES divisions(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'escrow_ledger' AND column_name = 'country_id'
  ) THEN
    ALTER TABLE escrow_ledger
      ADD COLUMN country_id UUID REFERENCES countries(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'escrow_ledger' AND column_name = 'division_id'
  ) THEN
    ALTER TABLE escrow_ledger
      ADD COLUMN division_id UUID REFERENCES divisions(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'payout_requests' AND column_name = 'country_id'
  ) THEN
    ALTER TABLE payout_requests
      ADD COLUMN country_id UUID REFERENCES countries(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'payout_requests' AND column_name = 'division_id'
  ) THEN
    ALTER TABLE payout_requests
      ADD COLUMN division_id UUID REFERENCES divisions(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'wallet_withdrawals' AND column_name = 'country_id'
  ) THEN
    ALTER TABLE wallet_withdrawals
      ADD COLUMN country_id UUID REFERENCES countries(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'wallet_withdrawals' AND column_name = 'division_id'
  ) THEN
    ALTER TABLE wallet_withdrawals
      ADD COLUMN division_id UUID REFERENCES divisions(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'proofs' AND column_name = 'country_id'
  ) THEN
    ALTER TABLE proofs
      ADD COLUMN country_id UUID REFERENCES countries(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'proofs' AND column_name = 'division_id'
  ) THEN
    ALTER TABLE proofs
      ADD COLUMN division_id UUID REFERENCES divisions(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'verification_sessions' AND column_name = 'country_id'
  ) THEN
    ALTER TABLE verification_sessions
      ADD COLUMN country_id UUID REFERENCES countries(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'verification_sessions' AND column_name = 'division_id'
  ) THEN
    ALTER TABLE verification_sessions
      ADD COLUMN division_id UUID REFERENCES divisions(id);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'admin_role'
  ) THEN
    ALTER TABLE users
      ADD COLUMN admin_role TEXT NOT NULL DEFAULT 'USER';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'country_id'
  ) THEN
    ALTER TABLE users
      ADD COLUMN country_id UUID REFERENCES countries(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'users' AND column_name = 'division_id'
  ) THEN
    ALTER TABLE users
      ADD COLUMN division_id UUID REFERENCES divisions(id);
  END IF;

  ALTER TABLE users DROP CONSTRAINT IF EXISTS users_admin_role_check;
  ALTER TABLE users
    ADD CONSTRAINT users_admin_role_check
    CHECK (admin_role IN ('SUPER_ADMIN', 'ADMIN', 'COUNTRY_ADMIN', 'DIVISION_ADMIN', 'USER'));
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'country_id'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN country_id UUID REFERENCES countries(id);
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'campaigns' AND column_name = 'division_id'
  ) THEN
    ALTER TABLE campaigns
      ADD COLUMN division_id UUID REFERENCES divisions(id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS earnings_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  country_id UUID NOT NULL REFERENCES countries(id),
  division_id UUID REFERENCES divisions(id),
  campaign_id UUID NOT NULL REFERENCES campaigns(id),
  gross_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  platform_fee NUMERIC(18,2) NOT NULL DEFAULT 0,
  country_share NUMERIC(18,2) NOT NULL DEFAULT 0,
  division_share NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_platform_revenue NUMERIC(18,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payouts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('COUNTRY_ADMIN', 'DIVISION_ADMIN')),
  amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID')),
  country_id UUID REFERENCES countries(id),
  division_id UUID REFERENCES divisions(id),
  paid_at TIMESTAMPTZ,
  paid_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO countries (name, code, status)
SELECT DISTINCT
  CASE
    WHEN upper(NULLIF(btrim(u.country), '')) = 'GLOBAL_TEMP' THEN 'Global Temp'
    WHEN NULLIF(btrim(u.country), '') IS NULL THEN 'Global Temp'
    ELSE upper(btrim(u.country))
  END AS name,
  CASE
    WHEN NULLIF(btrim(u.country), '') IS NULL THEN 'GLOBAL_TEMP'
    ELSE upper(btrim(u.country))
  END AS code,
  'ACTIVE'
FROM users u
ON CONFLICT (code) DO NOTHING;

UPDATE users u
SET country_id = c.id
FROM countries c
WHERE c.code = COALESCE(NULLIF(upper(btrim(u.country)), ''), 'GLOBAL_TEMP')
  AND u.country_id IS NULL;

UPDATE users
SET admin_role = 'SUPER_ADMIN'
WHERE admin_role = 'USER'
  AND (role = 'ADMIN' OR active_role = 'ADMIN');

INSERT INTO country_admins (user_id, country_id, role)
SELECT u.id, u.country_id, 'PRIMARY'
FROM users u
WHERE u.admin_role = 'COUNTRY_ADMIN'
  AND u.country_id IS NOT NULL
ON CONFLICT (user_id, country_id) DO NOTHING;

INSERT INTO admin_users (
  user_id,
  role,
  status,
  created_by_super_admin_id
)
SELECT
  u.id,
  CASE
    WHEN UPPER(COALESCE(u.admin_role, '')) = 'SUPER_ADMIN' THEN 'SUPER_ADMIN'
    WHEN UPPER(COALESCE(u.admin_role, '')) IN ('ADMIN', 'COUNTRY_ADMIN', 'DIVISION_ADMIN') THEN 'ADMIN'
    WHEN u.role = 'ADMIN' OR u.active_role = 'ADMIN' THEN 'SUPER_ADMIN'
    ELSE NULL
  END AS role,
  CASE
    WHEN UPPER(COALESCE(u.status, '')) = 'SUSPENDED' THEN 'SUSPENDED'
    WHEN UPPER(COALESCE(u.status, '')) = 'BANNED' THEN 'DELETED'
    ELSE 'ACTIVE'
  END AS status,
  NULL::uuid
FROM users u
WHERE (
  UPPER(COALESCE(u.admin_role, '')) IN ('SUPER_ADMIN', 'ADMIN', 'COUNTRY_ADMIN', 'DIVISION_ADMIN')
  OR u.role = 'ADMIN'
  OR u.active_role = 'ADMIN'
)
ON CONFLICT (user_id) DO UPDATE
SET
  role = EXCLUDED.role,
  status = EXCLUDED.status,
  updated_at = NOW();

INSERT INTO admin_user_modules (admin_user_id, module_key)
SELECT
  au.id,
  module_key
FROM admin_users au
CROSS JOIN UNNEST(
  ARRAY[
    'OPERATIONS',
    'COUNTRIES',
    'DIVISIONS',
    'USERS',
    'CAMPAIGNS',
    'DRAFTS',
    'PROOFS',
    'SESSIONS',
    'RISK',
    'WALLETS',
    'WITHDRAWALS',
    'FINANCE',
    'PAYOUT_REQUESTS',
    'MANAGER_PAYOUTS',
    'ESCROWS',
    'CONTRACTS',
    'GATEWAY',
    'JOBS',
    'AUDIT_LOGS'
  ]::text[]
) AS module_key
ON CONFLICT (admin_user_id, module_key) DO NOTHING;

INSERT INTO admin_user_modules (admin_user_id, module_key)
SELECT au.id, 'ADMIN_MANAGEMENT'
FROM admin_users au
WHERE au.role = 'SUPER_ADMIN'
ON CONFLICT (admin_user_id, module_key) DO NOTHING;

INSERT INTO admin_user_country_scopes (admin_user_id, country_id)
SELECT DISTINCT
  au.id,
  ca.country_id
FROM admin_users au
JOIN country_admins ca ON ca.user_id = au.user_id
ON CONFLICT (admin_user_id, country_id) DO NOTHING;

INSERT INTO admin_user_country_scopes (admin_user_id, country_id)
SELECT DISTINCT
  au.id,
  u.country_id
FROM admin_users au
JOIN users u ON u.id = au.user_id
LEFT JOIN admin_user_country_scopes scopes
  ON scopes.admin_user_id = au.id
 AND scopes.country_id = u.country_id
WHERE UPPER(COALESCE(u.admin_role, '')) = 'COUNTRY_ADMIN'
  AND u.country_id IS NOT NULL
  AND scopes.id IS NULL
ON CONFLICT (admin_user_id, country_id) DO NOTHING;

INSERT INTO admin_user_division_scopes (admin_user_id, division_id)
SELECT DISTINCT
  au.id,
  da.division_id
FROM admin_users au
JOIN division_admins da ON da.user_id = au.user_id
ON CONFLICT (admin_user_id, division_id) DO NOTHING;

INSERT INTO admin_user_division_scopes (admin_user_id, division_id)
SELECT DISTINCT
  au.id,
  u.division_id
FROM admin_users au
JOIN users u ON u.id = au.user_id
LEFT JOIN admin_user_division_scopes scopes
  ON scopes.admin_user_id = au.id
 AND scopes.division_id = u.division_id
WHERE UPPER(COALESCE(u.admin_role, '')) = 'DIVISION_ADMIN'
  AND u.division_id IS NOT NULL
  AND scopes.id IS NULL
ON CONFLICT (admin_user_id, division_id) DO NOTHING;

UPDATE campaigns c
SET country_id = COALESCE(c.country_id, business.country_id, fallback.id),
    division_id = COALESCE(c.division_id, business.division_id)
FROM users business
CROSS JOIN LATERAL (
  SELECT id
  FROM countries
  WHERE code = 'GLOBAL_TEMP'
  LIMIT 1
) AS fallback
WHERE business.id = c.business_id
  AND (c.country_id IS NULL OR c.division_id IS NULL);

CREATE OR REPLACE FUNCTION ensure_country_scope(input_code TEXT)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  normalized_code TEXT := upper(COALESCE(NULLIF(btrim(input_code), ''), 'GLOBAL_TEMP'));
  target_id UUID;
BEGIN
  SELECT id
  INTO target_id
  FROM countries
  WHERE code = normalized_code
  LIMIT 1;

  IF target_id IS NULL THEN
    INSERT INTO countries (name, code, status)
    VALUES (
      CASE
        WHEN normalized_code = 'GLOBAL_TEMP' THEN 'Global Temp'
        ELSE normalized_code
      END,
      normalized_code,
      'ACTIVE'
    )
    ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code
    RETURNING id INTO target_id;
  END IF;

  RETURN target_id;
END;
$$;

CREATE OR REPLACE FUNCTION sync_user_tenant_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  resolved_country_code TEXT;
  division_country_id UUID;
BEGIN
  IF NEW.division_id IS NOT NULL THEN
    SELECT country_id
    INTO division_country_id
    FROM divisions
    WHERE id = NEW.division_id
    LIMIT 1;

    IF division_country_id IS NOT NULL THEN
      NEW.country_id := division_country_id;
    END IF;
  END IF;

  IF NEW.country_id IS NULL THEN
    NEW.country_id := ensure_country_scope(NEW.country);
  END IF;

  SELECT code
  INTO resolved_country_code
  FROM countries
  WHERE id = NEW.country_id
  LIMIT 1;

  IF resolved_country_code IS NOT NULL THEN
    NEW.country := resolved_country_code;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_sync_tenant_scope ON users;
CREATE TRIGGER trg_users_sync_tenant_scope
BEFORE INSERT OR UPDATE OF country, country_id, division_id
ON users
FOR EACH ROW
EXECUTE FUNCTION sync_user_tenant_scope();

CREATE OR REPLACE FUNCTION sync_campaign_tenant_scope()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  business_country_id UUID;
  business_division_id UUID;
  division_country_id UUID;
BEGIN
  IF NEW.division_id IS NOT NULL THEN
    SELECT country_id
    INTO division_country_id
    FROM divisions
    WHERE id = NEW.division_id
    LIMIT 1;

    IF division_country_id IS NOT NULL THEN
      NEW.country_id := division_country_id;
    END IF;
  END IF;

  IF NEW.business_id IS NOT NULL THEN
    SELECT country_id, division_id
    INTO business_country_id, business_division_id
    FROM users
    WHERE id = NEW.business_id
    LIMIT 1;

    IF NEW.country_id IS NULL THEN
      NEW.country_id := business_country_id;
    END IF;

    IF NEW.division_id IS NULL THEN
      NEW.division_id := business_division_id;
    END IF;
  END IF;

  IF NEW.country_id IS NULL THEN
    NEW.country_id := ensure_country_scope('GLOBAL_TEMP');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_campaigns_sync_tenant_scope ON campaigns;
CREATE TRIGGER trg_campaigns_sync_tenant_scope
BEFORE INSERT OR UPDATE OF business_id, country_id, division_id
ON campaigns
FOR EACH ROW
EXECUTE FUNCTION sync_campaign_tenant_scope();

CREATE UNIQUE INDEX IF NOT EXISTS uq_country_admin_primary
  ON country_admins(country_id)
  WHERE role = 'PRIMARY';
CREATE UNIQUE INDEX IF NOT EXISTS uq_earnings_ledger_campaign_id
  ON earnings_ledger(campaign_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_payouts_scope_period
  ON payouts(
    user_id,
    role,
    country_id,
    COALESCE(division_id, '00000000-0000-0000-0000-000000000000'::uuid),
    period_start,
    period_end
  );
CREATE INDEX IF NOT EXISTS idx_users_country_id ON users(country_id);
CREATE INDEX IF NOT EXISTS idx_users_division_id ON users(division_id);
CREATE INDEX IF NOT EXISTS idx_users_admin_role ON users(admin_role);
CREATE INDEX IF NOT EXISTS idx_campaigns_country_id ON campaigns(country_id);
CREATE INDEX IF NOT EXISTS idx_campaigns_division_id ON campaigns(division_id);
CREATE INDEX IF NOT EXISTS idx_divisions_country_id ON divisions(country_id);
CREATE INDEX IF NOT EXISTS idx_country_admins_country_id ON country_admins(country_id);
CREATE INDEX IF NOT EXISTS idx_division_admins_division_id ON division_admins(division_id);
CREATE INDEX IF NOT EXISTS idx_admin_users_role_status ON admin_users(role, status);
CREATE INDEX IF NOT EXISTS idx_admin_users_created_by ON admin_users(created_by_super_admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_user_modules_module_key ON admin_user_modules(module_key);
CREATE INDEX IF NOT EXISTS idx_admin_user_country_scopes_country_id ON admin_user_country_scopes(country_id);
CREATE INDEX IF NOT EXISTS idx_admin_user_division_scopes_division_id ON admin_user_division_scopes(division_id);
CREATE INDEX IF NOT EXISTS idx_earnings_ledger_country_id ON earnings_ledger(country_id);
CREATE INDEX IF NOT EXISTS idx_earnings_ledger_division_id ON earnings_ledger(division_id);
CREATE INDEX IF NOT EXISTS idx_payouts_role_status ON payouts(role, status);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_country_id ON admin_audit_logs(country_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_division_id ON admin_audit_logs(division_id);
CREATE INDEX IF NOT EXISTS idx_escrow_ledger_country_id ON escrow_ledger(country_id);
CREATE INDEX IF NOT EXISTS idx_escrow_ledger_division_id ON escrow_ledger(division_id);
CREATE INDEX IF NOT EXISTS idx_payout_requests_country_id ON payout_requests(country_id);
CREATE INDEX IF NOT EXISTS idx_payout_requests_division_id ON payout_requests(division_id);
CREATE INDEX IF NOT EXISTS idx_wallet_withdrawals_country_id ON wallet_withdrawals(country_id);
CREATE INDEX IF NOT EXISTS idx_wallet_withdrawals_division_id ON wallet_withdrawals(division_id);
CREATE INDEX IF NOT EXISTS idx_proofs_country_id ON proofs(country_id);
CREATE INDEX IF NOT EXISTS idx_proofs_division_id ON proofs(division_id);
CREATE INDEX IF NOT EXISTS idx_verification_sessions_country_id ON verification_sessions(country_id);
CREATE INDEX IF NOT EXISTS idx_verification_sessions_division_id ON verification_sessions(division_id);
