import { ADMIN_MODULE_ADMIN_MANAGEMENT, ADMIN_MODULE_OVERVIEW, ADMIN_ROLE_ADMIN, ADMIN_ROLE_COUNTRY_ADMIN, ADMIN_ROLE_DIVISION_ADMIN, ADMIN_ROLE_SUPER_ADMIN, ADMIN_ROLE_USER, ALL_ADMIN_MODULE_KEYS, LEGACY_COUNTRY_ADMIN_MODULE_KEYS, LEGACY_TENANT_ADMIN_MODULE_KEYS, normalizeAdminDashboardRole, normalizeAdminModuleKey, } from '@prime/shared';
import { withTransaction } from '../db.js';
import { resolveCountry } from '../countryResolver.js';
import { hashPassword } from './auth.js';
const EMERGENCY_ADMIN_USER_ID = 'ariaka-access';
const EMERGENCY_ADMIN_EMAIL = 'ariaka-access@local';
function normalizeAccountRole(user) {
    return String(user.role ?? '').trim().toUpperCase();
}
function normalizeActiveRole(user) {
    return String(user.active_role ?? user.role ?? '').trim().toUpperCase();
}
function normalizeAdminAccountRole(value) {
    const role = normalizeAdminDashboardRole(value);
    if (role === ADMIN_ROLE_COUNTRY_ADMIN || role === ADMIN_ROLE_DIVISION_ADMIN) {
        return ADMIN_ROLE_ADMIN;
    }
    return role;
}
function normalizeAdminStatus(value) {
    const status = String(value ?? '').trim().toUpperCase();
    if (status === 'SUSPENDED')
        return 'SUSPENDED';
    if (status === 'DELETED' || status === 'BANNED')
        return 'DELETED';
    if (status === 'ACTIVE')
        return 'ACTIVE';
    return 'NONE';
}
function uniqueStrings(values) {
    return Array.from(new Set(values
        .map((value) => value?.trim())
        .filter((value) => Boolean(value))));
}
function uniqueModules(values) {
    return Array.from(new Set(values.filter((value) => Boolean(value))));
}
function sanitizeAssignedModuleKeys(role, moduleKeys) {
    const filtered = [];
    for (const raw of moduleKeys) {
        const normalized = normalizeAdminModuleKey(raw);
        if (!normalized || normalized === ADMIN_MODULE_OVERVIEW) {
            continue;
        }
        if (normalized === ADMIN_MODULE_ADMIN_MANAGEMENT &&
            role !== ADMIN_ROLE_SUPER_ADMIN) {
            continue;
        }
        filtered.push(normalized);
    }
    return uniqueModules(filtered);
}
function modulesForLegacyRole(legacyRole) {
    if (legacyRole === ADMIN_ROLE_SUPER_ADMIN) {
        return ALL_ADMIN_MODULE_KEYS;
    }
    if (legacyRole === ADMIN_ROLE_COUNTRY_ADMIN) {
        return uniqueModules([
            ADMIN_MODULE_OVERVIEW,
            ...LEGACY_COUNTRY_ADMIN_MODULE_KEYS,
        ]);
    }
    if (legacyRole === ADMIN_ROLE_DIVISION_ADMIN ||
        legacyRole === ADMIN_ROLE_ADMIN) {
        return uniqueModules([
            ADMIN_MODULE_OVERVIEW,
            ...LEGACY_TENANT_ADMIN_MODULE_KEYS,
        ]);
    }
    return [];
}
function visibleModulesForAccess(role, storedModules, legacyRole) {
    if (role === ADMIN_ROLE_SUPER_ADMIN) {
        return Array.from(ALL_ADMIN_MODULE_KEYS);
    }
    if (role !== ADMIN_ROLE_ADMIN) {
        return [];
    }
    const base = storedModules.length > 0 ? storedModules : modulesForLegacyRole(legacyRole);
    return uniqueModules([ADMIN_MODULE_OVERVIEW, ...base]);
}
function roleForLegacyScope(user) {
    const explicit = normalizeAdminDashboardRole(user.admin_role);
    if (explicit !== ADMIN_ROLE_USER) {
        return explicit;
    }
    const accountRole = normalizeAccountRole(user);
    const activeRole = normalizeActiveRole(user);
    if (accountRole === 'ADMIN' || activeRole === 'ADMIN') {
        return ADMIN_ROLE_SUPER_ADMIN;
    }
    return ADMIN_ROLE_USER;
}
function buildEmergencyDashboardAccess() {
    const modules = Array.from(ALL_ADMIN_MODULE_KEYS);
    return {
        user_id: EMERGENCY_ADMIN_USER_ID,
        email: EMERGENCY_ADMIN_EMAIL,
        role: 'ADMIN',
        active_role: 'ADMIN',
        admin_role: ADMIN_ROLE_SUPER_ADMIN,
        legacy_admin_role: ADMIN_ROLE_SUPER_ADMIN,
        admin_status: 'ACTIVE',
        permissions: modules,
        module_keys: modules,
        admin_user_id: null,
        created_by_super_admin_id: null,
        last_login_at: null,
        country_id: null,
        division_id: null,
        country_code: null,
        country_name: null,
        division_name: null,
        country_ids: [],
        division_ids: [],
        country_scopes: [],
        division_scopes: [],
    };
}
export function resolveAdminRoleFromRecord(user) {
    if (!user) {
        return ADMIN_ROLE_USER;
    }
    return roleForLegacyScope(user);
}
function mapDashboardAccessFromClaims(claims) {
    const role = normalizeAdminAccountRole(claims.admin_role);
    const modules = role === ADMIN_ROLE_SUPER_ADMIN
        ? Array.from(ALL_ADMIN_MODULE_KEYS)
        : role === ADMIN_ROLE_ADMIN
            ? [ADMIN_MODULE_OVERVIEW]
            : [];
    return {
        user_id: String(claims.sub ?? ''),
        email: String(claims.email ?? ''),
        role: String(claims.role ?? ''),
        active_role: String(claims.active_role ?? claims.role ?? ''),
        admin_role: role,
        legacy_admin_role: normalizeAdminDashboardRole(claims.admin_role),
        admin_status: role === ADMIN_ROLE_USER ? 'NONE' : 'ACTIVE',
        permissions: modules,
        module_keys: modules,
        admin_user_id: claims.admin_user_id ? String(claims.admin_user_id) : null,
        created_by_super_admin_id: claims.created_by_super_admin_id
            ? String(claims.created_by_super_admin_id)
            : null,
        last_login_at: claims.last_login_at ? String(claims.last_login_at) : null,
        country_id: claims.country_id ? String(claims.country_id) : null,
        division_id: claims.division_id ? String(claims.division_id) : null,
        country_code: claims.country_code ? String(claims.country_code) : null,
        country_name: claims.country_name ? String(claims.country_name) : null,
        division_name: claims.division_name ? String(claims.division_name) : null,
        country_ids: claims.country_id ? [String(claims.country_id)] : [],
        division_ids: claims.division_id ? [String(claims.division_id)] : [],
        country_scopes: claims.country_id
            ? [
                {
                    id: String(claims.country_id),
                    code: claims.country_code ? String(claims.country_code) : null,
                    name: claims.country_name ? String(claims.country_name) : null,
                },
            ]
            : [],
        division_scopes: claims.division_id
            ? [
                {
                    id: String(claims.division_id),
                    name: claims.division_name ? String(claims.division_name) : null,
                    type: null,
                    country_id: claims.country_id ? String(claims.country_id) : null,
                    country_code: claims.country_code
                        ? String(claims.country_code)
                        : null,
                    country_name: claims.country_name
                        ? String(claims.country_name)
                        : null,
                },
            ]
            : [],
    };
}
export function mapDashboardAccessRecord(row) {
    if (!row?.id) {
        return null;
    }
    const claims = {
        sub: row.id,
        email: row.email,
        role: row.role,
        active_role: row.active_role ?? row.role,
        admin_role: row.admin_role,
        country_id: row.country_id,
        division_id: row.division_id,
        country_code: row.country_code,
        country_name: row.country_name,
        division_name: row.division_name,
    };
    return mapDashboardAccessFromClaims(claims);
}
async function loadStoredModules(client, adminUserId) {
    const res = await client.query(`
    SELECT module_key
    FROM admin_user_modules
    WHERE admin_user_id = $1
    ORDER BY module_key ASC
    `, [adminUserId]);
    return sanitizeAssignedModuleKeys(ADMIN_ROLE_ADMIN, res.rows.map((row) => row.module_key));
}
async function loadCountryScopes(client, adminUserId) {
    const res = await client.query(`
    SELECT
      c.id,
      c.code,
      c.name
    FROM admin_user_country_scopes scopes
    JOIN countries c ON c.id = scopes.country_id
    WHERE scopes.admin_user_id = $1
    ORDER BY c.name ASC, c.code ASC
    `, [adminUserId]);
    return res.rows.map((row) => ({
        id: String(row.id),
        code: row.code ? String(row.code) : null,
        name: row.name ? String(row.name) : null,
    }));
}
async function loadDivisionScopes(client, adminUserId) {
    const res = await client.query(`
    SELECT
      d.id,
      d.name,
      d.type,
      d.country_id,
      c.code AS country_code,
      c.name AS country_name
    FROM admin_user_division_scopes scopes
    JOIN divisions d ON d.id = scopes.division_id
    JOIN countries c ON c.id = d.country_id
    WHERE scopes.admin_user_id = $1
    ORDER BY c.name ASC, d.name ASC
    `, [adminUserId]);
    return res.rows.map((row) => ({
        id: String(row.id),
        name: row.name ? String(row.name) : null,
        type: row.type ? String(row.type) : null,
        country_id: row.country_id ? String(row.country_id) : null,
        country_code: row.country_code ? String(row.country_code) : null,
        country_name: row.country_name ? String(row.country_name) : null,
    }));
}
function mergeCountryScopes(persisted, legacy) {
    const byId = new Map();
    for (const scope of [...persisted, ...legacy]) {
        byId.set(scope.id, scope);
    }
    return Array.from(byId.values());
}
function mergeDivisionScopes(persisted, legacy) {
    const byId = new Map();
    for (const scope of [...persisted, ...legacy]) {
        byId.set(scope.id, scope);
    }
    return Array.from(byId.values());
}
export async function loadDashboardAccessContext(client, userId) {
    if (userId === EMERGENCY_ADMIN_USER_ID) {
        return buildEmergencyDashboardAccess();
    }
    const res = await client.query(`
    SELECT
      u.id,
      u.email,
      u.role,
      u.active_role,
      u.status AS user_status,
      u.admin_role AS legacy_admin_role,
      u.country_id,
      u.division_id,
      c.code AS country_code,
      c.name AS country_name,
      d.name AS division_name,
      au.id AS admin_user_id,
      au.role AS admin_account_role,
      au.status AS admin_account_status,
      au.created_by_super_admin_id,
      au.last_login_at
    FROM users u
    LEFT JOIN countries c ON c.id = u.country_id
    LEFT JOIN divisions d ON d.id = u.division_id
    LEFT JOIN admin_users au ON au.user_id = u.id
    WHERE u.id = $1
    LIMIT 1
    `, [userId]);
    const row = res.rows[0];
    if (!row?.id) {
        return null;
    }
    const legacyRole = roleForLegacyScope({
        role: row.role,
        active_role: row.active_role,
        admin_role: row.legacy_admin_role,
    });
    const adminRole = row.admin_user_id
        ? normalizeAdminAccountRole(row.admin_account_role)
        : normalizeAdminAccountRole(legacyRole);
    const userStatus = normalizeAdminStatus(row.user_status);
    const persistedAdminStatus = row.admin_user_id != null
        ? normalizeAdminStatus(row.admin_account_status)
        : userStatus;
    const effectiveAdminStatus = userStatus === 'ACTIVE' ? persistedAdminStatus : userStatus;
    const persistedModules = row.admin_user_id != null
        ? await loadStoredModules(client, String(row.admin_user_id))
        : [];
    const persistedCountryScopes = row.admin_user_id != null
        ? await loadCountryScopes(client, String(row.admin_user_id))
        : [];
    const persistedDivisionScopes = row.admin_user_id != null
        ? await loadDivisionScopes(client, String(row.admin_user_id))
        : [];
    const legacyCountryScopes = legacyRole === ADMIN_ROLE_COUNTRY_ADMIN && row.country_id
        ? [
            {
                id: String(row.country_id),
                code: row.country_code ? String(row.country_code) : null,
                name: row.country_name ? String(row.country_name) : null,
            },
        ]
        : [];
    const legacyDivisionScopes = legacyRole === ADMIN_ROLE_DIVISION_ADMIN && row.division_id
        ? [
            {
                id: String(row.division_id),
                name: row.division_name ? String(row.division_name) : null,
                type: null,
                country_id: row.country_id ? String(row.country_id) : null,
                country_code: row.country_code ? String(row.country_code) : null,
                country_name: row.country_name ? String(row.country_name) : null,
            },
        ]
        : [];
    const countryScopes = mergeCountryScopes(persistedCountryScopes, legacyCountryScopes);
    const divisionScopes = mergeDivisionScopes(persistedDivisionScopes, legacyDivisionScopes);
    const primaryDivision = divisionScopes[0] ?? null;
    const primaryCountry = countryScopes[0] ??
        (primaryDivision?.country_id
            ? {
                id: primaryDivision.country_id,
                code: primaryDivision.country_code,
                name: primaryDivision.country_name,
            }
            : null);
    const visibleModules = visibleModulesForAccess(adminRole, persistedModules, legacyRole);
    return {
        user_id: String(row.id),
        email: String(row.email ?? ''),
        role: String(row.role ?? ''),
        active_role: String(row.active_role ?? row.role ?? ''),
        admin_role: adminRole,
        legacy_admin_role: legacyRole,
        admin_status: adminRole === ADMIN_ROLE_USER ? 'NONE' : effectiveAdminStatus,
        permissions: visibleModules,
        module_keys: visibleModules,
        admin_user_id: row.admin_user_id ? String(row.admin_user_id) : null,
        created_by_super_admin_id: row.created_by_super_admin_id
            ? String(row.created_by_super_admin_id)
            : null,
        last_login_at: row.last_login_at ? String(row.last_login_at) : null,
        country_id: primaryCountry?.id ?? (row.country_id ? String(row.country_id) : null),
        division_id: primaryDivision?.id ?? (row.division_id ? String(row.division_id) : null),
        country_code: primaryCountry?.code ?? (row.country_code ? String(row.country_code) : null),
        country_name: primaryCountry?.name ?? (row.country_name ? String(row.country_name) : null),
        division_name: primaryDivision?.name ?? (row.division_name ? String(row.division_name) : null),
        country_ids: uniqueStrings(countryScopes.map((scope) => scope.id)),
        division_ids: uniqueStrings(divisionScopes.map((scope) => scope.id)),
        country_scopes: countryScopes,
        division_scopes: divisionScopes,
    };
}
export function getRequestDashboardAccess(request) {
    const cached = request.adminAccess;
    if (cached) {
        return cached;
    }
    const claims = (request.user ?? {});
    if (String(claims.sub ?? '') === EMERGENCY_ADMIN_USER_ID) {
        return buildEmergencyDashboardAccess();
    }
    return mapDashboardAccessFromClaims(claims);
}
function canSatisfyRole(access, requiredRole) {
    if (access.admin_role === ADMIN_ROLE_SUPER_ADMIN) {
        return true;
    }
    switch (requiredRole) {
        case ADMIN_ROLE_ADMIN:
            return access.admin_role === ADMIN_ROLE_ADMIN;
        case ADMIN_ROLE_COUNTRY_ADMIN:
            return access.country_scopes.length > 0;
        case ADMIN_ROLE_DIVISION_ADMIN:
            return access.division_scopes.length > 0;
        case ADMIN_ROLE_SUPER_ADMIN:
            return false;
        default:
            return access.admin_role === requiredRole;
    }
}
export function requireRole(roles) {
    return async (request, reply) => {
        try {
            await request.jwtVerify();
        }
        catch {
            return reply.code(401).send({ error: 'unauthorized' });
        }
        const userId = String(request.user?.sub ?? '').trim();
        const access = await withTransaction(async (client) => loadDashboardAccessContext(client, userId));
        if (!access || access.admin_role === ADMIN_ROLE_USER) {
            return reply.code(403).send({ error: 'forbidden' });
        }
        if (access.admin_status !== 'ACTIVE') {
            return reply
                .code(403)
                .send({ error: access.admin_status === 'SUSPENDED' ? 'admin_suspended' : 'forbidden' });
        }
        request.adminAccess = access;
        if (!roles.some((role) => canSatisfyRole(access, role))) {
            return reply.code(403).send({ error: 'forbidden' });
        }
    };
}
export function isSuperDashboardAccess(access) {
    return access.admin_role === ADMIN_ROLE_SUPER_ADMIN;
}
export function hasAdminModuleAccess(access, moduleKey) {
    const normalized = normalizeAdminModuleKey(moduleKey);
    if (!normalized) {
        return false;
    }
    if (access.admin_role === ADMIN_ROLE_SUPER_ADMIN) {
        return true;
    }
    if (access.admin_status !== 'ACTIVE') {
        return false;
    }
    if (normalized === ADMIN_MODULE_OVERVIEW) {
        return access.admin_role === ADMIN_ROLE_ADMIN;
    }
    return access.permissions.includes(normalized);
}
export function appendDashboardTenantScope(state, access, scope) {
    if (isSuperDashboardAccess(access)) {
        return;
    }
    const clauses = [];
    if (access.division_ids.length > 0 && scope.division) {
        clauses.push(`${scope.division} = ANY($${state.idx}::uuid[])`);
        state.params.push(access.division_ids);
        state.idx += 1;
    }
    if (access.country_ids.length > 0) {
        clauses.push(`${scope.country} = ANY($${state.idx}::uuid[])`);
        state.params.push(access.country_ids);
        state.idx += 1;
    }
    if (clauses.length == 0) {
        state.conditions.push('1 = 0');
        return;
    }
    state.conditions.push(clauses.length == 1 ? clauses[0] : `(${clauses.join(' OR ')})`);
}
export function matchesDashboardTenantScope(access, row) {
    if (!row)
        return false;
    if (isSuperDashboardAccess(access)) {
        return true;
    }
    const rowDivisionId = row.division_id ? String(row.division_id) : null;
    if (rowDivisionId && access.division_ids.includes(rowDivisionId)) {
        return true;
    }
    const rowCountryId = row.country_id ? String(row.country_id) : null;
    return Boolean(rowCountryId && access.country_ids.includes(rowCountryId));
}
export async function ensureAdminAccountRecord(client, input) {
    const normalizedRole = normalizeAdminAccountRole(input.role);
    if (normalizedRole !== ADMIN_ROLE_SUPER_ADMIN &&
        normalizedRole !== ADMIN_ROLE_ADMIN) {
        throw new Error('invalid_admin_role');
    }
    const status = normalizeAdminStatus(input.status ?? 'ACTIVE');
    const suspendedAt = status === 'SUSPENDED' ? new Date().toISOString() : null;
    const deletedAt = status === 'DELETED' ? new Date().toISOString() : null;
    const res = await client.query(`
    INSERT INTO admin_users (
      user_id,
      role,
      status,
      created_by_super_admin_id,
      suspended_at,
      deleted_at,
      updated_at
    )
    VALUES ($1,$2,$3,$4,$5,$6,NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET
      role = EXCLUDED.role,
      status = EXCLUDED.status,
      created_by_super_admin_id = COALESCE(
        admin_users.created_by_super_admin_id,
        EXCLUDED.created_by_super_admin_id
      ),
      suspended_at = EXCLUDED.suspended_at,
      deleted_at = EXCLUDED.deleted_at,
      updated_at = NOW()
    RETURNING *
    `, [
        input.userId,
        normalizedRole,
        status === 'NONE' ? 'ACTIVE' : status,
        input.createdBySuperAdminId ?? null,
        suspendedAt,
        deletedAt,
    ]);
    await client.query(`
    UPDATE users
    SET role = 'ADMIN',
        active_role = 'ADMIN',
        admin_role = $2
    WHERE id = $1
    `, [input.userId, normalizedRole]);
    return res.rows[0];
}
export async function grantAdminModuleAssignments(client, adminUserId, role, moduleKeys) {
    const modules = sanitizeAssignedModuleKeys(role, moduleKeys);
    if (modules.length === 0) {
        return;
    }
    await client.query(`
    INSERT INTO admin_user_modules (admin_user_id, module_key, updated_at)
    SELECT $1, module_key, NOW()
    FROM UNNEST($2::text[]) AS module_key
    ON CONFLICT (admin_user_id, module_key)
    DO UPDATE SET updated_at = NOW()
    `, [adminUserId, modules]);
}
export async function replaceAdminModuleAssignments(client, adminUserId, role, moduleKeys) {
    const modules = sanitizeAssignedModuleKeys(role, moduleKeys);
    if (modules.length === 0) {
        await client.query(`DELETE FROM admin_user_modules WHERE admin_user_id = $1`, [adminUserId]);
        return;
    }
    await client.query(`
    DELETE FROM admin_user_modules
    WHERE admin_user_id = $1
      AND module_key <> ALL($2::text[])
    `, [adminUserId, modules]);
    await grantAdminModuleAssignments(client, adminUserId, role, modules);
}
export async function grantAdminCountryScopes(client, adminUserId, countryIds) {
    const normalized = uniqueStrings(Array.from(countryIds, (value) => String(value ?? '').trim()));
    if (normalized.length === 0) {
        return;
    }
    await client.query(`
    INSERT INTO admin_user_country_scopes (admin_user_id, country_id)
    SELECT $1, country_id::uuid
    FROM UNNEST($2::text[]) AS country_id
    ON CONFLICT (admin_user_id, country_id)
    DO NOTHING
    `, [adminUserId, normalized]);
}
export async function grantAdminDivisionScopes(client, adminUserId, divisionIds) {
    const normalized = uniqueStrings(Array.from(divisionIds, (value) => String(value ?? '').trim()));
    if (normalized.length === 0) {
        return;
    }
    await client.query(`
    INSERT INTO admin_user_division_scopes (admin_user_id, division_id)
    SELECT $1, division_id::uuid
    FROM UNNEST($2::text[]) AS division_id
    ON CONFLICT (admin_user_id, division_id)
    DO NOTHING
    `, [adminUserId, normalized]);
}
export async function replaceAdminScopeAssignments(client, adminUserId, input) {
    const countryIds = uniqueStrings(Array.from(input.countryIds ?? [], (value) => String(value ?? '').trim()));
    const divisionIds = uniqueStrings(Array.from(input.divisionIds ?? [], (value) => String(value ?? '').trim()));
    if (countryIds.length === 0) {
        await client.query(`DELETE FROM admin_user_country_scopes WHERE admin_user_id = $1`, [adminUserId]);
    }
    else {
        await client.query(`
      DELETE FROM admin_user_country_scopes
      WHERE admin_user_id = $1
        AND country_id::text <> ALL($2::text[])
      `, [adminUserId, countryIds]);
        await grantAdminCountryScopes(client, adminUserId, countryIds);
    }
    if (divisionIds.length === 0) {
        await client.query(`DELETE FROM admin_user_division_scopes WHERE admin_user_id = $1`, [adminUserId]);
    }
    else {
        await client.query(`
      DELETE FROM admin_user_division_scopes
      WHERE admin_user_id = $1
        AND division_id::text <> ALL($2::text[])
      `, [adminUserId, divisionIds]);
        await grantAdminDivisionScopes(client, adminUserId, divisionIds);
    }
}
export async function ensurePersistedDashboardAccess(client, userId, createdBySuperAdminId) {
    const current = await loadDashboardAccessContext(client, userId);
    if (!current || current.admin_role === ADMIN_ROLE_USER || current.admin_user_id) {
        return current;
    }
    const account = await ensureAdminAccountRecord(client, {
        userId,
        role: current.admin_role,
        status: current.admin_status === 'NONE' ? 'ACTIVE' : current.admin_status,
        createdBySuperAdminId,
    });
    await replaceAdminModuleAssignments(client, String(account.id), current.admin_role, current.permissions);
    await replaceAdminScopeAssignments(client, String(account.id), {
        countryIds: current.country_ids,
        divisionIds: current.division_ids,
    });
    return loadDashboardAccessContext(client, userId);
}
export async function touchAdminLogin(client, userId, createdBySuperAdminId) {
    const access = await ensurePersistedDashboardAccess(client, userId, createdBySuperAdminId);
    if (!access || access.admin_role === ADMIN_ROLE_USER || !access.admin_user_id) {
        return access;
    }
    await client.query(`
    UPDATE admin_users
    SET last_login_at = NOW(),
        updated_at = NOW()
    WHERE id = $1
    `, [access.admin_user_id]);
    return loadDashboardAccessContext(client, userId);
}
async function getCountryRecord(client, countryId) {
    const res = await client.query(`
    SELECT id, name, code
    FROM countries
    WHERE id = $1
    LIMIT 1
    `, [countryId]);
    return res.rows[0] ?? null;
}
function resolveAdminCountryProfile(code) {
    const fallback = {
        iso2: 'UG',
        currency: 'UGX',
    };
    if (!code) {
        return fallback;
    }
    try {
        const resolved = resolveCountry(code);
        return {
            iso2: resolved.iso2,
            currency: resolved.currency,
        };
    }
    catch {
        return fallback;
    }
}
async function createAdminUser(client, input, adminRole, countryId, divisionId) {
    const country = await getCountryRecord(client, countryId);
    if (!country) {
        throw new Error('country_not_found');
    }
    const countryProfile = resolveAdminCountryProfile(String(country.code ?? '').trim().toUpperCase());
    const existingEmail = await client.query(`SELECT id FROM users WHERE email = $1 LIMIT 1`, [input.email.trim().toLowerCase()]);
    if (existingEmail.rows[0]) {
        throw new Error('email_taken');
    }
    const existingPhone = await client.query(`SELECT id FROM users WHERE phone = $1 LIMIT 1`, [input.phone.trim()]);
    if (existingPhone.rows[0]) {
        throw new Error('phone_taken');
    }
    const inserted = await client.query(`
    INSERT INTO users (
      full_name,
      email,
      phone,
      password_hash,
      role,
      active_role,
      country,
      preferred_currency,
      admin_role,
      country_id,
      division_id
    )
    VALUES ($1,$2,$3,$4,'ADMIN','ADMIN',$5,$6,$7,$8,$9)
    RETURNING *
    `, [
        input.full_name.trim(),
        input.email.trim().toLowerCase(),
        input.phone.trim(),
        hashPassword(input.password),
        countryProfile.iso2,
        countryProfile.currency,
        adminRole,
        countryId,
        divisionId,
    ]);
    return inserted.rows[0];
}
async function getOrCreateAdminAssignee(client, input, adminRole, countryId, divisionId) {
    if (input.user_id) {
        const existing = await client.query(`
      SELECT
        u.*,
        c.code AS country_code
      FROM users u
      LEFT JOIN countries c ON c.id = u.country_id
      WHERE u.id = $1
      LIMIT 1
      `, [input.user_id]);
        if (!existing.rows[0]) {
            throw new Error('user_not_found');
        }
        return existing.rows[0];
    }
    if (!input.full_name || !input.email || !input.phone || !input.password) {
        throw new Error('assignment_user_payload_required');
    }
    return createAdminUser(client, {
        full_name: input.full_name,
        email: input.email,
        phone: input.phone,
        password: input.password,
    }, adminRole, countryId, divisionId);
}
async function canReassignUserToCountry(client, user, targetCountryId) {
    const currentCountryId = user.country_id ? String(user.country_id) : null;
    if (!currentCountryId || currentCountryId === targetCountryId) {
        return true;
    }
    const currentCountry = await client.query(`
    SELECT code
    FROM countries
    WHERE id = $1
    LIMIT 1
    `, [currentCountryId]);
    const currentCode = String(currentCountry.rows[0]?.code ?? '')
        .trim()
        .toUpperCase();
    return currentCode === 'GLOBAL_TEMP';
}
export async function assignCountryAdmin(client, countryId, input, assignmentRole, options) {
    const country = await getCountryRecord(client, countryId);
    if (!country) {
        throw new Error('country_not_found');
    }
    const assignee = await getOrCreateAdminAssignee(client, input, ADMIN_ROLE_COUNTRY_ADMIN, countryId, null);
    if (!(await canReassignUserToCountry(client, assignee, countryId))) {
        throw new Error('user_country_mismatch');
    }
    if (assignmentRole === 'PRIMARY') {
        await client.query(`
      UPDATE country_admins
      SET role = 'SECONDARY'
      WHERE country_id = $1
        AND role = 'PRIMARY'
      `, [countryId]);
    }
    const assignment = await client.query(`
    INSERT INTO country_admins (user_id, country_id, role)
    VALUES ($1,$2,$3)
    ON CONFLICT (user_id, country_id)
    DO UPDATE SET role = EXCLUDED.role
    RETURNING *
    `, [assignee.id, countryId, assignmentRole]);
    await client.query(`
    UPDATE users
    SET admin_role = $2,
        role = 'ADMIN',
        active_role = 'ADMIN',
        country_id = $3,
        division_id = NULL,
        country = $4
    WHERE id = $1
    `, [
        assignee.id,
        ADMIN_ROLE_COUNTRY_ADMIN,
        countryId,
        String(country.code ?? 'UG').trim().toUpperCase() || 'UG',
    ]);
    const account = await ensureAdminAccountRecord(client, {
        userId: String(assignee.id),
        role: ADMIN_ROLE_ADMIN,
        status: 'ACTIVE',
        createdBySuperAdminId: options?.createdBySuperAdminId ?? null,
    });
    await grantAdminModuleAssignments(client, String(account.id), ADMIN_ROLE_ADMIN, LEGACY_COUNTRY_ADMIN_MODULE_KEYS);
    await grantAdminCountryScopes(client, String(account.id), [countryId]);
    const access = await loadDashboardAccessContext(client, String(assignee.id));
    return {
        assignment: assignment.rows[0] ?? null,
        access,
    };
}
export async function assignDivisionAdmin(client, divisionId, input, assignmentRole, options) {
    const divisionRes = await client.query(`
    SELECT
      d.id,
      d.name,
      d.country_id,
      c.code AS country_code
    FROM divisions d
    JOIN countries c ON c.id = d.country_id
    WHERE d.id = $1
    LIMIT 1
    `, [divisionId]);
    const division = divisionRes.rows[0];
    if (!division?.id) {
        throw new Error('division_not_found');
    }
    const assignee = await getOrCreateAdminAssignee(client, input, ADMIN_ROLE_DIVISION_ADMIN, String(division.country_id), divisionId);
    if (!(await canReassignUserToCountry(client, assignee, String(division.country_id)))) {
        throw new Error('user_country_mismatch');
    }
    const assignment = await client.query(`
    INSERT INTO division_admins (user_id, division_id, role)
    VALUES ($1,$2,$3)
    ON CONFLICT (user_id, division_id)
    DO UPDATE SET role = EXCLUDED.role
    RETURNING *
    `, [assignee.id, divisionId, assignmentRole]);
    await client.query(`
    UPDATE users
    SET admin_role = $2,
        role = 'ADMIN',
        active_role = 'ADMIN',
        country_id = $3,
        division_id = $4,
        country = $5
    WHERE id = $1
    `, [
        assignee.id,
        ADMIN_ROLE_DIVISION_ADMIN,
        division.country_id,
        divisionId,
        String(division.country_code ?? 'UG').trim().toUpperCase() || 'UG',
    ]);
    const account = await ensureAdminAccountRecord(client, {
        userId: String(assignee.id),
        role: ADMIN_ROLE_ADMIN,
        status: 'ACTIVE',
        createdBySuperAdminId: options?.createdBySuperAdminId ?? null,
    });
    await grantAdminModuleAssignments(client, String(account.id), ADMIN_ROLE_ADMIN, LEGACY_TENANT_ADMIN_MODULE_KEYS);
    await grantAdminDivisionScopes(client, String(account.id), [divisionId]);
    const access = await loadDashboardAccessContext(client, String(assignee.id));
    return {
        assignment: assignment.rows[0] ?? null,
        access,
    };
}
