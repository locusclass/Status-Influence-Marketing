import { PoolClient } from 'pg';
import {
  ADMIN_ROLE_COUNTRY_ADMIN,
  ADMIN_ROLE_DIVISION_ADMIN,
  ADMIN_ROLE_SUPER_ADMIN,
  ADMIN_ROLE_USER,
  type AdminDashboardRole,
  normalizeAdminDashboardRole,
} from '@prime/shared';
import { resolveCountry } from '../countryResolver.js';
import { hashPassword } from './auth.js';

export type DashboardAccessContext = {
  user_id: string;
  email: string;
  role: string;
  active_role: string;
  admin_role: AdminDashboardRole;
  country_id: string | null;
  division_id: string | null;
  country_code: string | null;
  country_name: string | null;
  division_name: string | null;
};

export type AdminAssignmentInput = {
  user_id?: string;
  full_name?: string;
  email?: string;
  phone?: string;
  password?: string;
};

function normalizeAccountRole(user: Record<string, unknown>) {
  return String(user.role ?? '').trim().toUpperCase();
}

function normalizeActiveRole(user: Record<string, unknown>) {
  return String(user.active_role ?? user.role ?? '').trim().toUpperCase();
}

export function resolveAdminRoleFromRecord(
  user: Record<string, unknown> | null | undefined
): AdminDashboardRole {
  const explicit = normalizeAdminDashboardRole(user?.admin_role);
  if (explicit !== ADMIN_ROLE_USER) {
    return explicit;
  }

  const accountRole = normalizeAccountRole(user ?? {});
  const activeRole = normalizeActiveRole(user ?? {});
  if (accountRole === 'ADMIN' || activeRole === 'ADMIN') {
    return ADMIN_ROLE_SUPER_ADMIN;
  }

  return ADMIN_ROLE_USER;
}

export function mapDashboardAccessRecord(
  row: Record<string, unknown> | null | undefined
): DashboardAccessContext | null {
  if (!row?.id) {
    return null;
  }

  return {
    user_id: String(row.id),
    email: String(row.email ?? ''),
    role: String(row.role ?? ''),
    active_role: String(row.active_role ?? row.role ?? ''),
    admin_role: resolveAdminRoleFromRecord(row),
    country_id: row.country_id ? String(row.country_id) : null,
    division_id: row.division_id ? String(row.division_id) : null,
    country_code: row.country_code ? String(row.country_code) : null,
    country_name: row.country_name ? String(row.country_name) : null,
    division_name: row.division_name ? String(row.division_name) : null,
  };
}

export async function loadDashboardAccessContext(
  client: PoolClient,
  userId: string
) {
  const res = await client.query(
    `
    SELECT
      u.id,
      u.email,
      u.role,
      u.active_role,
      u.admin_role,
      u.country_id,
      u.division_id,
      c.code AS country_code,
      c.name AS country_name,
      d.name AS division_name
    FROM users u
    LEFT JOIN countries c ON c.id = u.country_id
    LEFT JOIN divisions d ON d.id = u.division_id
    WHERE u.id = $1
    LIMIT 1
    `,
    [userId]
  );

  return mapDashboardAccessRecord(res.rows[0]);
}

export function getRequestDashboardAccess(request: any): DashboardAccessContext {
  const claims = (request.user ?? {}) as Record<string, unknown>;
  return {
    user_id: String(claims.sub ?? ''),
    email: String(claims.email ?? ''),
    role: String(claims.role ?? ''),
    active_role: String(claims.active_role ?? claims.role ?? ''),
    admin_role: resolveAdminRoleFromRecord(claims),
    country_id: claims.country_id ? String(claims.country_id) : null,
    division_id: claims.division_id ? String(claims.division_id) : null,
    country_code: claims.country_code ? String(claims.country_code) : null,
    country_name: claims.country_name ? String(claims.country_name) : null,
    division_name: claims.division_name ? String(claims.division_name) : null,
  };
}

export function requireRole(roles: AdminDashboardRole[]) {
  return async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const access = getRequestDashboardAccess(request);
    if (access.admin_role === ADMIN_ROLE_SUPER_ADMIN) {
      return;
    }

    if (!roles.includes(access.admin_role)) {
      return reply.code(403).send({ error: 'forbidden' });
    }
  };
}

async function getCountryRecord(client: PoolClient, countryId: string) {
  const res = await client.query(
    `
    SELECT id, name, code
    FROM countries
    WHERE id = $1
    LIMIT 1
    `,
    [countryId]
  );
  return res.rows[0] ?? null;
}

function resolveAdminCountryProfile(code: string | null | undefined) {
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
  } catch {
    return fallback;
  }
}

async function createAdminUser(
  client: PoolClient,
  input: Required<Pick<AdminAssignmentInput, 'full_name' | 'email' | 'phone' | 'password'>>,
  adminRole: AdminDashboardRole,
  countryId: string,
  divisionId: string | null
) {
  const country = await getCountryRecord(client, countryId);
  if (!country) {
    throw new Error('country_not_found');
  }

  const countryProfile = resolveAdminCountryProfile(
    String(country.code ?? '').trim().toUpperCase()
  );

  const existingEmail = await client.query(
    `SELECT id FROM users WHERE email = $1 LIMIT 1`,
    [input.email.trim().toLowerCase()]
  );
  if (existingEmail.rows[0]) {
    throw new Error('email_taken');
  }

  const existingPhone = await client.query(
    `SELECT id FROM users WHERE phone = $1 LIMIT 1`,
    [input.phone.trim()]
  );
  if (existingPhone.rows[0]) {
    throw new Error('phone_taken');
  }

  const inserted = await client.query(
    `
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
    `,
    [
      input.full_name.trim(),
      input.email.trim().toLowerCase(),
      input.phone.trim(),
      hashPassword(input.password),
      countryProfile.iso2,
      countryProfile.currency,
      adminRole,
      countryId,
      divisionId,
    ]
  );

  return inserted.rows[0] as Record<string, unknown>;
}

async function getOrCreateAdminAssignee(
  client: PoolClient,
  input: AdminAssignmentInput,
  adminRole: AdminDashboardRole,
  countryId: string,
  divisionId: string | null
) {
  if (input.user_id) {
    const existing = await client.query(
      `
      SELECT
        u.*,
        c.code AS country_code
      FROM users u
      LEFT JOIN countries c ON c.id = u.country_id
      WHERE u.id = $1
      LIMIT 1
      `,
      [input.user_id]
    );
    if (!existing.rows[0]) {
      throw new Error('user_not_found');
    }

    return existing.rows[0] as Record<string, unknown>;
  }

  if (!input.full_name || !input.email || !input.phone || !input.password) {
    throw new Error('assignment_user_payload_required');
  }

  return createAdminUser(
    client,
    {
      full_name: input.full_name,
      email: input.email,
      phone: input.phone,
      password: input.password,
    },
    adminRole,
    countryId,
    divisionId
  );
}

async function canReassignUserToCountry(
  client: PoolClient,
  user: Record<string, unknown>,
  targetCountryId: string
) {
  const currentCountryId = user.country_id ? String(user.country_id) : null;
  if (!currentCountryId || currentCountryId === targetCountryId) {
    return true;
  }

  const currentCountry = await client.query(
    `
    SELECT code
    FROM countries
    WHERE id = $1
    LIMIT 1
    `,
    [currentCountryId]
  );
  const currentCode = String(currentCountry.rows[0]?.code ?? '')
    .trim()
    .toUpperCase();
  return currentCode === 'GLOBAL_TEMP';
}

export async function assignCountryAdmin(
  client: PoolClient,
  countryId: string,
  input: AdminAssignmentInput,
  assignmentRole: 'PRIMARY' | 'SECONDARY'
) {
  const country = await getCountryRecord(client, countryId);
  if (!country) {
    throw new Error('country_not_found');
  }

  const assignee = await getOrCreateAdminAssignee(
    client,
    input,
    ADMIN_ROLE_COUNTRY_ADMIN,
    countryId,
    null
  );

  if (!(await canReassignUserToCountry(client, assignee, countryId))) {
    throw new Error('user_country_mismatch');
  }

  if (assignmentRole === 'PRIMARY') {
    await client.query(
      `
      UPDATE country_admins
      SET role = 'SECONDARY'
      WHERE country_id = $1
        AND role = 'PRIMARY'
      `,
      [countryId]
    );
  }

  const assignment = await client.query(
    `
    INSERT INTO country_admins (user_id, country_id, role)
    VALUES ($1,$2,$3)
    ON CONFLICT (user_id, country_id)
    DO UPDATE SET role = EXCLUDED.role
    RETURNING *
    `,
    [assignee.id, countryId, assignmentRole]
  );

  await client.query(
    `
    UPDATE users
    SET admin_role = $2,
        role = 'ADMIN',
        active_role = 'ADMIN',
        country_id = $3,
        division_id = NULL,
        country = $4
    WHERE id = $1
    `,
    [
      assignee.id,
      ADMIN_ROLE_COUNTRY_ADMIN,
      countryId,
      String(country.code ?? 'UG').trim().toUpperCase() || 'UG',
    ]
  );

  const access = await loadDashboardAccessContext(client, String(assignee.id));
  return {
    assignment: assignment.rows[0] ?? null,
    access,
  };
}

export async function assignDivisionAdmin(
  client: PoolClient,
  divisionId: string,
  input: AdminAssignmentInput,
  assignmentRole: string
) {
  const divisionRes = await client.query(
    `
    SELECT
      d.id,
      d.name,
      d.country_id,
      c.code AS country_code
    FROM divisions d
    JOIN countries c ON c.id = d.country_id
    WHERE d.id = $1
    LIMIT 1
    `,
    [divisionId]
  );
  const division = divisionRes.rows[0];
  if (!division?.id) {
    throw new Error('division_not_found');
  }

  const assignee = await getOrCreateAdminAssignee(
    client,
    input,
    ADMIN_ROLE_DIVISION_ADMIN,
    String(division.country_id),
    divisionId
  );

  if (!(await canReassignUserToCountry(client, assignee, String(division.country_id)))) {
    throw new Error('user_country_mismatch');
  }

  const assignment = await client.query(
    `
    INSERT INTO division_admins (user_id, division_id, role)
    VALUES ($1,$2,$3)
    ON CONFLICT (user_id, division_id)
    DO UPDATE SET role = EXCLUDED.role
    RETURNING *
    `,
    [assignee.id, divisionId, assignmentRole]
  );

  await client.query(
    `
    UPDATE users
    SET admin_role = $2,
        role = 'ADMIN',
        active_role = 'ADMIN',
        country_id = $3,
        division_id = $4,
        country = $5
    WHERE id = $1
    `,
    [
      assignee.id,
      ADMIN_ROLE_DIVISION_ADMIN,
      division.country_id,
      divisionId,
      String(division.country_code ?? 'UG').trim().toUpperCase() || 'UG',
    ]
  );

  const access = await loadDashboardAccessContext(client, String(assignee.id));
  return {
    assignment: assignment.rows[0] ?? null,
    access,
  };
}
