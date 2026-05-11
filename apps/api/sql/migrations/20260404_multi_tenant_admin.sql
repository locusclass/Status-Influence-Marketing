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

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS admin_role TEXT NOT NULL DEFAULT 'USER';
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS country_id UUID REFERENCES countries(id);
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS division_id UUID REFERENCES divisions(id);
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_admin_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_admin_role_check
  CHECK (admin_role IN ('SUPER_ADMIN', 'ADMIN', 'COUNTRY_ADMIN', 'DIVISION_ADMIN', 'USER'));

ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS country_id UUID REFERENCES countries(id);
ALTER TABLE campaigns
  ADD COLUMN IF NOT EXISTS division_id UUID REFERENCES divisions(id);

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
CREATE INDEX IF NOT EXISTS idx_earnings_ledger_country_id ON earnings_ledger(country_id);
CREATE INDEX IF NOT EXISTS idx_earnings_ledger_division_id ON earnings_ledger(division_id);
CREATE INDEX IF NOT EXISTS idx_payouts_role_status ON payouts(role, status);
