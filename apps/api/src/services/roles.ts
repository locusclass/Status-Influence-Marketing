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
}) {
  const role = normalizeAccountRole(user.role);
  const activeRole = normalizeActiveRole(user.active_role, role);
  return {
    sub: user.id,
    role,
    active_role: activeRole,
  };
}

export function buildUserSession(user: Record<string, unknown>) {
  const role = normalizeAccountRole(user.role);
  const activeRole = normalizeActiveRole(user.active_role, role);
  return {
    id: String(user.id ?? ''),
    public_id: String(user.public_id ?? ''),
    email: String(user.email ?? ''),
    role,
    active_role: activeRole,
    phone: String(user.phone ?? ''),
    whatsapp_verified: Boolean(user.whatsapp_verified ?? false),
    country: String(user.country ?? ''),
    currency: String(user.currency ?? user.preferred_currency ?? 'UGX'),
    can_multi_contract: Boolean(user.can_multi_contract ?? false),
  };
}
