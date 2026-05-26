import { ADMIN_ROLE_USER, normalizeAdminDashboardRole, } from '@prime/shared';
import { buildPolicyAcceptanceState } from './policies.js';
export const ACCOUNT_ROLE_ADMIN = 'ADMIN';
export const ACCOUNT_ROLE_BUSINESS = 'BUSINESS';
export const ACCOUNT_ROLE_AMBASSADOR = 'AMBASSADOR';
export const ACCOUNT_ROLE_DUAL_USER = 'DUAL_USER';
function normalizeLegacyRoleValue(value) {
    const role = String(value ?? '').trim().toUpperCase();
    if (role == 'ADVERTISER')
        return ACCOUNT_ROLE_BUSINESS;
    if (role == 'PROMOTER' || role == 'DISTRIBUTOR') {
        return ACCOUNT_ROLE_AMBASSADOR;
    }
    return role;
}
function extractRoleSource(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value;
        if (record.role != null)
            return record.role;
        if (record.active_role != null)
            return record.active_role;
    }
    return value;
}
export function normalizeAccountRole(value) {
    const role = normalizeLegacyRoleValue(extractRoleSource(value));
    if (role === ACCOUNT_ROLE_ADMIN)
        return ACCOUNT_ROLE_ADMIN;
    if (role === ACCOUNT_ROLE_BUSINESS)
        return ACCOUNT_ROLE_BUSINESS;
    if (role === ACCOUNT_ROLE_DUAL_USER)
        return ACCOUNT_ROLE_DUAL_USER;
    return ACCOUNT_ROLE_AMBASSADOR;
}
export function normalizeActiveRole(activeRole, accountRole) {
    const normalizedAccountRole = normalizeAccountRole(accountRole);
    const role = normalizeLegacyRoleValue(activeRole);
    if (role === ACCOUNT_ROLE_ADMIN)
        return ACCOUNT_ROLE_ADMIN;
    if (role === ACCOUNT_ROLE_BUSINESS)
        return ACCOUNT_ROLE_BUSINESS;
    if (role === ACCOUNT_ROLE_AMBASSADOR)
        return ACCOUNT_ROLE_AMBASSADOR;
    if (normalizedAccountRole === ACCOUNT_ROLE_ADMIN)
        return ACCOUNT_ROLE_ADMIN;
    if (normalizedAccountRole === ACCOUNT_ROLE_BUSINESS) {
        return ACCOUNT_ROLE_BUSINESS;
    }
    return ACCOUNT_ROLE_AMBASSADOR;
}
export function canAccessBusinessFeatures(accountRole) {
    const role = normalizeAccountRole(accountRole);
    return (role === ACCOUNT_ROLE_ADMIN ||
        role === ACCOUNT_ROLE_BUSINESS ||
        role === ACCOUNT_ROLE_DUAL_USER);
}
export function canAccessAmbassadorFeatures(accountRole) {
    const role = normalizeAccountRole(accountRole);
    return (role === ACCOUNT_ROLE_ADMIN ||
        role === ACCOUNT_ROLE_AMBASSADOR ||
        role === ACCOUNT_ROLE_DUAL_USER);
}
export function normalizeRequestedUserRole(value) {
    const role = normalizeLegacyRoleValue(value);
    if (role === ACCOUNT_ROLE_BUSINESS)
        return ACCOUNT_ROLE_BUSINESS;
    if (role === ACCOUNT_ROLE_AMBASSADOR)
        return ACCOUNT_ROLE_AMBASSADOR;
    return null;
}
export function normalizeUserAccountStatus(value) {
    const status = String(value ?? 'ACTIVE').trim().toUpperCase();
    if (status === 'SUSPENDED')
        return 'SUSPENDED';
    if (status === 'BANNED')
        return 'BANNED';
    return 'ACTIVE';
}
export function isUserAccountActive(value) {
    return normalizeUserAccountStatus(value) === 'ACTIVE';
}
export function resolveDisabledAccountErrorCode(value) {
    return normalizeUserAccountStatus(value) === 'SUSPENDED'
        ? 'account_suspended'
        : 'account_disabled';
}
export function buildAuthClaims(user) {
    const role = normalizeAccountRole(user.role);
    const activeRole = normalizeActiveRole(user.active_role, role);
    const adminRole = normalizeAdminDashboardRole(user.admin_role) !== ADMIN_ROLE_USER
        ? normalizeAdminDashboardRole(user.admin_role)
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
export function buildUserSession(user) {
    const role = normalizeAccountRole(user.role);
    const activeRole = normalizeActiveRole(user.active_role, role);
    const adminRole = normalizeAdminDashboardRole(user.admin_role) !== ADMIN_ROLE_USER
        ? normalizeAdminDashboardRole(user.admin_role)
        : ADMIN_ROLE_USER;
    const maxStatusViewers12h = Number(user.max_status_viewers_12h ?? 0);
    const currentBusinessViewers = Number(user.current_business_viewers ?? 0);
    const privateContractRateUgx = Number(user.private_contract_rate_ugx ?? 0);
    const privateContractRate24hUgx = Number(user.private_contract_rate_24h_ugx ?? 0);
    const pricePrivacyMode = String(user.price_privacy_mode ?? 'NEGOTIABLE')
        .trim()
        .toUpperCase();
    const accountStatus = normalizeUserAccountStatus(user.status);
    return {
        id: String(user.id ?? ''),
        public_id: String(user.public_id ?? ''),
        email: String(user.email ?? ''),
        status: accountStatus,
        status_reason: user.status_reason == null ? null : String(user.status_reason),
        status_reason_updated_at: user.status_reason_updated_at ?? null,
        role,
        active_role: activeRole,
        admin_role: adminRole,
        phone: String(user.phone ?? ''),
        whatsapp_verified: Boolean(user.whatsapp_verified ?? false),
        country: String(user.country ?? ''),
        country_id: user.country_id == null ? null : String(user.country_id),
        division_id: user.division_id == null ? null : String(user.division_id),
        country_code: user.country_code == null ? null : String(user.country_code),
        country_name: user.country_name == null ? null : String(user.country_name),
        division_name: user.division_name == null ? null : String(user.division_name),
        currency: String(user.currency ?? user.preferred_currency ?? 'UGX'),
        can_multi_contract: Boolean(user.can_multi_contract ?? false),
        max_status_viewers_12h: Math.max(0, Number.isFinite(maxStatusViewers12h) ? Math.trunc(maxStatusViewers12h) : 0),
        current_business_viewers: Math.max(0, Number.isFinite(currentBusinessViewers)
            ? Math.trunc(currentBusinessViewers)
            : 0),
        private_contract_rate_ugx: Math.max(0, Number.isFinite(privateContractRateUgx)
            ? Math.trunc(privateContractRateUgx)
            : 0),
        private_contract_rate_24h_ugx: Math.max(0, Number.isFinite(privateContractRate24hUgx)
            ? Math.trunc(privateContractRate24hUgx)
            : 0),
        price_privacy_mode: pricePrivacyMode === 'FIXED' ? 'FIXED' : 'NEGOTIABLE',
        last_login_at: user.last_login_at ?? null,
        last_seen_at: user.last_seen_at ?? null,
        is_online: user.is_online === true,
        requires_ambassador_capacity_setup: canAccessAmbassadorFeatures(role) &&
            Math.max(0, Number.isFinite(maxStatusViewers12h) ? Math.trunc(maxStatusViewers12h) : 0) === 0,
        ...buildPolicyAcceptanceState(user),
    };
}
