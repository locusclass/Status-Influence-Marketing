export const ACCOUNT_ROLE_ADMIN = 'ADMIN';
export const ACCOUNT_ROLE_ADVERTISER = 'ADVERTISER';
export const ACCOUNT_ROLE_DISTRIBUTOR = 'DISTRIBUTOR';
export const ACCOUNT_ROLE_DUAL_USER = 'DUAL_USER';
export function normalizeAccountRole(value) {
    const role = String(value ?? '').trim().toUpperCase();
    if (role === ACCOUNT_ROLE_ADMIN)
        return ACCOUNT_ROLE_ADMIN;
    if (role === ACCOUNT_ROLE_ADVERTISER)
        return ACCOUNT_ROLE_ADVERTISER;
    if (role === ACCOUNT_ROLE_DUAL_USER)
        return ACCOUNT_ROLE_DUAL_USER;
    return ACCOUNT_ROLE_DISTRIBUTOR;
}
export function normalizeActiveRole(activeRole, accountRole) {
    const normalizedAccountRole = normalizeAccountRole(accountRole);
    const role = String(activeRole ?? '').trim().toUpperCase();
    if (role === ACCOUNT_ROLE_ADMIN)
        return ACCOUNT_ROLE_ADMIN;
    if (role === ACCOUNT_ROLE_ADVERTISER)
        return ACCOUNT_ROLE_ADVERTISER;
    if (role === ACCOUNT_ROLE_DISTRIBUTOR)
        return ACCOUNT_ROLE_DISTRIBUTOR;
    if (normalizedAccountRole === ACCOUNT_ROLE_ADMIN)
        return ACCOUNT_ROLE_ADMIN;
    if (normalizedAccountRole === ACCOUNT_ROLE_ADVERTISER) {
        return ACCOUNT_ROLE_ADVERTISER;
    }
    return ACCOUNT_ROLE_DISTRIBUTOR;
}
export function canAccessAdvertiserFeatures(accountRole) {
    const role = normalizeAccountRole(accountRole);
    return (role === ACCOUNT_ROLE_ADMIN ||
        role === ACCOUNT_ROLE_ADVERTISER ||
        role === ACCOUNT_ROLE_DUAL_USER);
}
export function canAccessDistributorFeatures(accountRole) {
    const role = normalizeAccountRole(accountRole);
    return (role === ACCOUNT_ROLE_ADMIN ||
        role === ACCOUNT_ROLE_DISTRIBUTOR ||
        role === ACCOUNT_ROLE_DUAL_USER);
}
export function buildAuthClaims(user) {
    const role = normalizeAccountRole(user.role);
    const activeRole = normalizeActiveRole(user.active_role, role);
    return {
        sub: user.id,
        role,
        active_role: activeRole,
    };
}
export function buildUserSession(user) {
    const role = normalizeAccountRole(user.role);
    const activeRole = normalizeActiveRole(user.active_role, role);
    const maxStatusViewers12h = Number(user.max_status_viewers_12h ?? 0);
    const currentAdvertiserViewers = Number(user.current_advertiser_viewers ?? 0);
    const privateContractRateUgx = Number(user.private_contract_rate_ugx ?? 0);
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
        max_status_viewers_12h: Math.max(0, Number.isFinite(maxStatusViewers12h) ? Math.trunc(maxStatusViewers12h) : 0),
        current_advertiser_viewers: Math.max(0, Number.isFinite(currentAdvertiserViewers)
            ? Math.trunc(currentAdvertiserViewers)
            : 0),
        private_contract_rate_ugx: Math.max(0, Number.isFinite(privateContractRateUgx)
            ? Math.trunc(privateContractRateUgx)
            : 0),
        last_login_at: user.last_login_at ?? null,
        last_seen_at: user.last_seen_at ?? null,
        is_online: user.is_online === true,
        requires_distributor_capacity_setup: false,
    };
}
