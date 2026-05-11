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

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_admin_role_check;
ALTER TABLE users
  ADD CONSTRAINT users_admin_role_check
  CHECK (admin_role IN ('SUPER_ADMIN', 'ADMIN', 'COUNTRY_ADMIN', 'DIVISION_ADMIN', 'USER'));

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

CREATE INDEX IF NOT EXISTS idx_admin_users_role_status ON admin_users(role, status);
CREATE INDEX IF NOT EXISTS idx_admin_users_created_by ON admin_users(created_by_super_admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_user_modules_module_key ON admin_user_modules(module_key);
CREATE INDEX IF NOT EXISTS idx_admin_user_country_scopes_country_id ON admin_user_country_scopes(country_id);
CREATE INDEX IF NOT EXISTS idx_admin_user_division_scopes_division_id ON admin_user_division_scopes(division_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_country_id ON admin_audit_logs(country_id);
CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_division_id ON admin_audit_logs(division_id);
