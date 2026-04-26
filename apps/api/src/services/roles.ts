import {
  ADMIN_ROLE_SUPER_ADMIN,
  ADMIN_ROLE_USER,
  normalizeAdminDashboardRole,
} from '@prime/shared';

export const ACCOUNT_ROLE_ADMIN = 'ADMIN';
export const ACCOUNT_ROLE_ADVERTISER = 'ADVERTISER';
export const ACCOUNT_ROLE_DISTRIBUTOR = 'DISTRIBUTOR';
export const ACCOUNT_ROLE_DUAL_USER = 'DUAL_USER';

export type AccountRole =
  | typeof ACCOUNT_ROLE_ADMIN
  | typeof ACCOUNT_ROLE_ADVERTISER
  | typeof ACCOUNT_ROLE_DISTRIBUTOR
  | typeof ACCOUNT_ROLE_DUAL_USER;

export type ActiveRole =
  | typeof ACCOUNT_ROLE_ADMIN
  | typeof ACCOUNT_ROLE_ADVERTISER
  | typeof ACCOUNT_ROLE_DISTRIBUTOR;

export function normalizeAccountRole(value: unknown): AccountRole {
  const role = String(value ?? '').trim().toUpperCase();
  if (role === ACCOUNT_ROLE_ADMIN) return ACCOUNT_ROLE_ADMIN;
  if (role === ACCOUNT_ROLE_ADVERTISER) return ACCOUNT_ROLE_ADVERTISER;
  if (role === ACCOUNT_ROLE_DUAL_USER) return ACCOUNT_ROLE_DUAL_USER;
  return ACCOUNT_ROLE_DISTRIBUTOR;
}

export function normalizeActiveRole(
  activeRole: unknown,
  accountRole: unknown
): ActiveRole {
  const normalizedAccountRole = normalizeAccountRole(accountRole);
  const role = String(activeRole ?? '').trim().toUpperCase();
  if (role === ACCOUNT_ROLE_ADMIN) return ACCOUNT_ROLE_ADMIN;
  if (role === ACCOUNT_ROLE_ADVERTISER) return ACCOUNT_ROLE_ADVERTISER;
  if (role === ACCOUNT_ROLE_DISTRIBUTOR) return ACCOUNT_ROLE_DISTRIBUTOR;
  if (normalizedAccountRole === ACCOUNT_ROLE_ADMIN) return ACCOUNT_ROLE_ADMIN;
  if (normalizedAccountRole === ACCOUNT_ROLE_ADVERTISER) {
    return ACCOUNT_ROLE_ADVERTISER;
  }
  return ACCOUNT_ROLE_DISTRIBUTOR;
}

export function canAccessAdvertiserFeatures(accountRole: unknown) {
  const role = normalizeAccountRole(accountRole);
  return (
    role === ACCOUNT_ROLE_ADMIN ||
    role === ACCOUNT_ROLE_ADVERTISER ||
    role === ACCOUNT_ROLE_DUAL_USER
  );
}

export function canAccessDistributorFeatures(accountRole: unknown) {
  const role = normalizeAccountRole(accountRole);
  return (
    role === ACCOUNT_ROLE_ADMIN ||
    role === ACCOUNT_ROLE_DISTRIBUTOR ||
    role === ACCOUNT_ROLE_DUAL_USER
  );
}

export function buildAuthClaims(user: {
  id: string;
  role?: unknown;
  active_role?: unknown;
  admin_role?: unknown;
  country_id?: unknown;
  division_id?: unknown;
  country_code?: unknown;
  country_name?: unknown;
  division_name?: unknown;
}) {
  const role = normalizeAccountRole(user.role);
  const activeRole = normalizeActiveRole(user.active_role, role);
  const adminRole =
    normalizeAdminDashboardRole(user.admin_role) !== ADMIN_ROLE_USER
      ? normalizeAdminDashboardRole(user.admin_role)
      : role === ACCOUNT_ROLE_ADMIN || activeRole === ACCOUNT_ROLE_ADMIN
          ? ADMIN_ROLE_SUPER_ADMIN
          : ADMIN_ROLE_USER;
  return {
    sub: user.id,
    role,
    active_role: activeRole,
    admin_role: adminRole,
    country_id: user.country_id ?? null,
    division_id: user.division_id ?? null,
    country_code: user.country_code ?? null,
    country_name: user.country_name ?? null,
    division_name: user.division_name ?? null,
  };
}

export function buildUserSession(user: Record<string, unknown>) {
  const role = normalizeAccountRole(user.role);
  const activeRole = normalizeActiveRole(user.active_role, role);
  const adminRole =
    normalizeAdminDashboardRole(user.admin_role) !== ADMIN_ROLE_USER
      ? normalizeAdminDashboardRole(user.admin_role)
      : role === ACCOUNT_ROLE_ADMIN || activeRole === ACCOUNT_ROLE_ADMIN
          ? ADMIN_ROLE_SUPER_ADMIN
          : ADMIN_ROLE_USER;
  const maxStatusViewers12h = Number(user.max_status_viewers_12h ?? 0);
  const currentAdvertiserViewers = Number(user.current_advertiser_viewers ?? 0);
  const privateContractRateUgx = Number(user.private_contract_rate_ugx ?? 0);
  const pricePrivacyMode = String(
    user.price_privacy_mode ?? 'NEGOTIABLE'
  )
    .trim()
    .toUpperCase();
  const accountStatus = String(user.status ?? 'ACTIVE').trim().toUpperCase();
  return {
    id: String(user.id ?? ''),
    public_id: String(user.public_id ?? ''),
    email: String(user.email ?? ''),
    status:
      accountStatus === 'SUSPENDED' || accountStatus === 'BANNED'
        ? accountStatus
        : 'ACTIVE',
    status_reason:
      user.status_reason == null ? null : String(user.status_reason),
    status_reason_updated_at: user.status_reason_updated_at ?? null,
    role,
    active_role: activeRole,
    admin_role: adminRole,
    phone: String(user.phone ?? ''),
    whatsapp_verified: Boolean(user.whatsapp_verified ?? false),
    country: String(user.country ?? ''),
    country_id: user.country_id == null ? null : String(user.country_id),
    division_id: user.division_id == null ? null : String(user.division_id),
    country_code:
      user.country_code == null ? null : String(user.country_code),
    country_name:
      user.country_name == null ? null : String(user.country_name),
    division_name:
      user.division_name == null ? null : String(user.division_name),
    currency: String(user.currency ?? user.preferred_currency ?? 'UGX'),
    can_multi_contract: Boolean(user.can_multi_contract ?? false),
    max_status_viewers_12h: Math.max(0, Number.isFinite(maxStatusViewers12h) ? Math.trunc(maxStatusViewers12h) : 0),
    current_advertiser_viewers: Math.max(
      0,
      Number.isFinite(currentAdvertiserViewers)
        ? Math.trunc(currentAdvertiserViewers)
        : 0
    ),
    private_contract_rate_ugx: Math.max(
      0,
      Number.isFinite(privateContractRateUgx)
        ? Math.trunc(privateContractRateUgx)
        : 0
    ),
    price_privacy_mode:
      pricePrivacyMode === 'FIXED' ? 'FIXED' : 'NEGOTIABLE',
    last_login_at: user.last_login_at ?? null,
    last_seen_at: user.last_seen_at ?? null,
    is_online: user.is_online === true,
    requires_distributor_capacity_setup: false,
  };
}
