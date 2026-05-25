import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  generateMonthlyPayouts,
  recordCampaignRevenueEntry,
} from '@prime/shared';
import { buildAuthClaims } from '../src/services/roles.js';
import { applySchema, getTestPool } from './db.js';

const pool = getTestPool();
let app: any;

async function resetDatabase() {
  if (!pool) return;
  await pool.query(`
    TRUNCATE TABLE
      admin_audit_logs,
      payouts,
      earnings_ledger,
      division_admins,
      country_admins,
      divisions,
      campaigns,
      wallet_txns,
      wallets,
      users,
      countries
    CASCADE
  `);
  await applySchema(pool);
}

async function insertCountry(code: string, name: string) {
  const result = await pool!.query(
    `
    INSERT INTO countries (name, code, status)
    VALUES ($1,$2,'ACTIVE')
    ON CONFLICT (code) DO UPDATE
      SET name = EXCLUDED.name,
          status = EXCLUDED.status
    RETURNING *
    `,
    [name, code]
  );
  return result.rows[0];
}

async function insertUser(input: {
  email: string;
  phone: string;
  full_name?: string;
  role?: string;
  active_role?: string;
  admin_role?: string;
  country?: string;
  country_id?: string | null;
  division_id?: string | null;
}) {
  const result = await pool!.query(
    `
    INSERT INTO users (
      full_name,
      email,
      phone,
      password_hash,
      role,
      active_role,
      admin_role,
      country,
      preferred_currency,
      country_id,
      division_id
    )
    VALUES ($1,$2,$3,'test-hash',$4,$5,$6,$7,'UGX',$8,$9)
    RETURNING *
    `,
    [
      input.full_name ?? 'Prime Admin',
      input.email,
      input.phone,
      input.role ?? 'ADMIN',
      input.active_role ?? 'ADMIN',
      input.admin_role ?? 'USER',
      input.country ?? 'UG',
      input.country_id ?? null,
      input.division_id ?? null,
    ]
  );
  return result.rows[0];
}

async function insertCampaign(input: {
  business_id: string;
  title: string;
  country_id: string;
  division_id?: string | null;
  budget_total?: number;
  payout_amount?: number;
}) {
  const result = await pool!.query(
    `
    INSERT INTO campaigns (
      business_id,
      title,
      platform,
      payout_amount,
      budget_total,
      media_type,
      start_date,
      end_date,
      country_id,
      division_id,
      status
    )
    VALUES ($1,$2,'WHATSAPP_STATUS',$3,$4,'TEXT','2026-03-01','2026-03-31',$5,$6,'COMPLETED')
    RETURNING *
    `,
    [
      input.business_id,
      input.title,
      input.payout_amount ?? 100,
      input.budget_total ?? 1000,
      input.country_id,
      input.division_id ?? null,
    ]
  );
  return result.rows[0];
}

async function insertVerificationSession(input: {
  user_id: string;
  campaign_id: string;
}) {
  const result = await pool!.query(
    `
    INSERT INTO verification_sessions (
      user_id,
      campaign_id,
      platform,
      challenge_code,
      challenge_phrase,
      expires_at
    )
    VALUES ($1,$2,'WHATSAPP_STATUS','123456','prime-proof', now() + interval '1 day')
    RETURNING *
    `,
    [input.user_id, input.campaign_id]
  );
  return result.rows[0];
}

async function insertProof(input: {
  session_id: string;
  user_id: string;
  status?: string;
}) {
  const result = await pool!.query(
    `
    INSERT INTO proofs (
      session_id,
      user_id,
      video_url,
      status
    )
    VALUES ($1,$2,'https://example.com/proof.mp4',$3)
    RETURNING *
    `,
    [input.session_id, input.user_id, input.status ?? 'VERIFIED']
  );
  return result.rows[0];
}

async function insertPayoutRequest(input: {
  proof_id: string;
  user_id: string;
  amount?: number;
  status?: string;
}) {
  const result = await pool!.query(
    `
    INSERT INTO payout_requests (
      proof_id,
      user_id,
      amount,
      status
    )
    VALUES ($1,$2,$3,$4)
    RETURNING *
    `,
    [
      input.proof_id,
      input.user_id,
      input.amount ?? 100,
      input.status ?? 'REQUESTED',
    ]
  );
  return result.rows[0];
}

describe('Tenant admin architecture', () => {
  if (!pool) {
    it('skipped: TEST_DATABASE_URL not set', () => expect(true).toBe(true));
    return;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
    process.env.SKIP_OPTIONAL_STARTUP_WARMUPS = '1';
    process.env.TEST_ROUTE_SCOPE = 'admin';
    const serverModule = await import('../src/server.js');
    app = serverModule.buildServer();
    await applySchema(pool);
    await app.ready();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
    delete process.env.SKIP_OPTIONAL_STARTUP_WARMUPS;
    delete process.env.TEST_ROUTE_SCOPE;
  });

  it('rejects dashboard access for admin claims without a persisted admin record', async () => {
    const token = app.jwt.sign({
      sub: 'ariaka-access',
      role: 'ADMIN',
      active_role: 'ADMIN',
      admin_role: 'SUPER_ADMIN',
    });

    const dashboardAccess = await app.inject({
      method: 'GET',
      url: '/dashboard/access',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(dashboardAccess.statusCode).toBe(403);
    expect(dashboardAccess.json()).toMatchObject({ code: 'forbidden' });
  });

  it('lets a persisted super admin reach dashboard routes', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const superAdmin = await insertUser({
      email: 'dashboard-super-admin@prime.test',
      phone: '+256700000000',
      admin_role: 'SUPER_ADMIN',
      country: 'UG',
      country_id: ug.id,
    });
    const token = app.jwt.sign(
      buildAuthClaims({
        ...superAdmin,
        country_id: ug.id,
      })
    );

    const dashboardAccess = await app.inject({
      method: 'GET',
      url: '/dashboard/access',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(dashboardAccess.statusCode).toBe(200);
    expect(dashboardAccess.json()).toMatchObject({
      access: {
        user_id: superAdmin.id,
        admin_role: 'SUPER_ADMIN',
        admin_status: 'ACTIVE',
      },
    });

    const overview = await app.inject({
      method: 'GET',
      url: '/admin/overview',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      users: expect.any(Number),
      campaigns: expect.any(Number),
      proofs: expect.any(Number),
    });
  });

  it('lets a super admin create, permission, and suspend an admin account with audit logs', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const superAdmin = await insertUser({
      email: 'super-admin@prime.test',
      phone: '+256700000001',
      admin_role: 'SUPER_ADMIN',
      country: 'UG',
      country_id: ug.id,
    });
    const superToken = app.jwt.sign(
      buildAuthClaims({
        ...superAdmin,
        country_id: ug.id,
      })
    );

    const created = await app.inject({
      method: 'POST',
      url: '/admin/admins',
      headers: { authorization: `Bearer ${superToken}` },
      payload: {
        full_name: 'Scoped Admin',
        email: 'scoped-admin@prime.test',
        phone: '+256700000002',
        password: 'AdminPass123!',
        role: 'ADMIN',
        module_keys: [],
        country_ids: [ug.id],
      },
    });
    expect(created.statusCode).toBe(200);
    const createdBody = created.json() as {
      admin: { id: string; role: string; admin_status: string };
    };
    expect(createdBody.admin).toMatchObject({
      role: 'ADMIN',
      admin_status: 'ACTIVE',
    });

    const permissioned = await app.inject({
      method: 'PUT',
      url: `/admin/admins/${createdBody.admin.id}/permissions`,
      headers: { authorization: `Bearer ${superToken}` },
      payload: {
        module_keys: ['USERS'],
      },
    });
    expect(permissioned.statusCode).toBe(200);
    expect(permissioned.json()).toMatchObject({
      admin: {
        id: createdBody.admin.id,
      },
    });

    const createdUserRes = await pool.query(
      `
      SELECT *
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [createdBody.admin.id]
    );
    const createdUser = createdUserRes.rows[0];
    expect(createdUser).toBeTruthy();

    const adminToken = app.jwt.sign(
      buildAuthClaims({
        ...createdUser,
        admin_role: 'ADMIN',
        country_id: ug.id,
      })
    );

    const overview = await app.inject({
      method: 'GET',
      url: '/admin/overview',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(overview.statusCode).toBe(200);

    const usersAllowed = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(usersAllowed.statusCode).toBe(200);

    const contractsBlocked = await app.inject({
      method: 'GET',
      url: '/admin/contracts',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(contractsBlocked.statusCode).toBe(403);

    const suspended = await app.inject({
      method: 'PATCH',
      url: `/admin/admins/${createdBody.admin.id}/status`,
      headers: { authorization: `Bearer ${superToken}` },
      payload: {
        status: 'SUSPENDED',
      },
    });
    expect(suspended.statusCode).toBe(200);
    expect(suspended.json()).toMatchObject({
      admin: {
        id: createdBody.admin.id,
        admin_status: 'SUSPENDED',
      },
    });

    const suspendedOverview = await app.inject({
      method: 'GET',
      url: '/admin/overview',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(suspendedOverview.statusCode).toBe(403);
    expect(suspendedOverview.json()).toMatchObject({
      code: 'admin_suspended',
    });

    const auditRows = await pool.query(
      `
      SELECT action
      FROM admin_audit_logs
      WHERE target_id = $1
      ORDER BY created_at ASC
      `,
      [createdBody.admin.id]
    );
    expect(auditRows.rows.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'ADMIN_CREATED',
        'ADMIN_PERMISSIONS_ASSIGNED',
        'ADMIN_SUSPENDED',
      ])
    );
  });

  it('records subscription waivers against the persisted admin account id', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const superAdmin = await insertUser({
      email: 'super-admin-waiver@prime.test',
      phone: '+256700000011',
      admin_role: 'SUPER_ADMIN',
      country: 'UG',
      country_id: ug.id,
    });
    const superToken = app.jwt.sign(
      buildAuthClaims({
        ...superAdmin,
        country_id: ug.id,
      })
    );

    const created = await app.inject({
      method: 'POST',
      url: '/admin/admins',
      headers: { authorization: `Bearer ${superToken}` },
      payload: {
        full_name: 'Subscription Admin',
        email: 'subscription-admin@prime.test',
        phone: '+256700000012',
        password: 'AdminPass123!',
        role: 'ADMIN',
        module_keys: [],
        country_ids: [ug.id],
      },
    });
    expect(created.statusCode).toBe(200);
    const createdBody = created.json() as {
      admin: { id: string };
    };

    const createdUserRes = await pool!.query(
      `
      SELECT *
      FROM users
      WHERE id = $1
      LIMIT 1
      `,
      [createdBody.admin.id]
    );
    const createdUser = createdUserRes.rows[0];
    expect(createdUser).toBeTruthy();

    const createdAdminRes = await pool!.query(
      `
      SELECT id
      FROM admin_users
      WHERE user_id = $1
      LIMIT 1
      `,
      [createdBody.admin.id]
    );
    const createdAdmin = createdAdminRes.rows[0];
    expect(createdAdmin?.id).toBeTruthy();

    const ambassador = await insertUser({
      email: 'subscription-ambassador@prime.test',
      phone: '+256700000013',
      full_name: 'Subscription Ambassador',
      role: 'AMBASSADOR',
      active_role: 'AMBASSADOR',
      admin_role: 'USER',
      country: 'UG',
      country_id: ug.id,
    });

    const adminToken = app.jwt.sign(
      buildAuthClaims({
        ...createdUser,
        admin_role: 'ADMIN',
        country_id: ug.id,
      })
    );

    const waived = await app.inject({
      method: 'POST',
      url: `/admin/ambassador-subscriptions/${ambassador.id}/waive`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        period: '2026-05-01',
        note: 'manager waiver',
      },
    });
    expect(waived.statusCode).toBe(200);
    expect(waived.json()).toMatchObject({ ok: true });

    const storedRes = await pool!.query(
      `
      SELECT
        ambassador_id,
        period_start::text AS period_start,
        is_waived,
        waived_by_admin_id,
        waived_note
      FROM ambassador_subscriptions
      WHERE ambassador_id = $1 AND period_start = $2
      LIMIT 1
      `,
      [ambassador.id, '2026-05-01']
    );
    expect(storedRes.rows[0]).toMatchObject({
      ambassador_id: ambassador.id,
      period_start: '2026-05-01',
      is_waived: true,
      waived_by_admin_id: createdAdmin.id,
      waived_note: 'manager waiver',
    });
  });

  it('returns a conflict when a super admin creates a managed admin with a duplicate identity', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const superAdmin = await insertUser({
      email: 'super-admin-dup@prime.test',
      phone: '+256700000020',
      admin_role: 'SUPER_ADMIN',
      country: 'UG',
      country_id: ug.id,
    });
    await insertUser({
      email: 'existing-admin@prime.test',
      phone: '+256700000021',
      country: 'UG',
      country_id: ug.id,
    });
    const superToken = app.jwt.sign(
      buildAuthClaims({
        ...superAdmin,
        country_id: ug.id,
      })
    );

    const duplicateEmail = await app.inject({
      method: 'POST',
      url: '/admin/admins',
      headers: { authorization: `Bearer ${superToken}` },
      payload: {
        full_name: 'Duplicate Email Admin',
        email: 'existing-admin@prime.test',
        phone: '+256700000022',
        password: 'AdminPass123!',
        role: 'ADMIN',
        module_keys: [],
        country_ids: [ug.id],
      },
    });
    expect(duplicateEmail.statusCode).toBe(409);
    expect(duplicateEmail.json()).toMatchObject({ code: 'email_taken' });

    const duplicatePhone = await app.inject({
      method: 'POST',
      url: '/admin/admins',
      headers: { authorization: `Bearer ${superToken}` },
      payload: {
        full_name: 'Duplicate Phone Admin',
        email: 'fresh-admin@prime.test',
        phone: '+256700000021',
        password: 'AdminPass123!',
        role: 'ADMIN',
        module_keys: [],
        country_ids: [ug.id],
      },
    });
    expect(duplicatePhone.statusCode).toBe(409);
    expect(duplicatePhone.json()).toMatchObject({ code: 'phone_taken' });
  });

  it('returns a bad request when admin scope assignments reference unknown tenants', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const superAdmin = await insertUser({
      email: 'super-admin-scope@prime.test',
      phone: '+256700000030',
      admin_role: 'SUPER_ADMIN',
      country: 'UG',
      country_id: ug.id,
    });
    const superToken = app.jwt.sign(
      buildAuthClaims({
        ...superAdmin,
        country_id: ug.id,
      })
    );

    const invalidCountry = await app.inject({
      method: 'POST',
      url: '/admin/admins',
      headers: { authorization: `Bearer ${superToken}` },
      payload: {
        full_name: 'Invalid Country Scope',
        email: 'invalid-country-scope@prime.test',
        phone: '+256700000031',
        password: 'AdminPass123!',
        role: 'ADMIN',
        module_keys: [],
        country_ids: ['11111111-1111-4111-8111-111111111111'],
      },
    });
    expect(invalidCountry.statusCode).toBe(400);
    expect(invalidCountry.json()).toMatchObject({
      code: 'country_scope_not_found',
    });

    const invalidDivision = await app.inject({
      method: 'POST',
      url: '/admin/admins',
      headers: { authorization: `Bearer ${superToken}` },
      payload: {
        full_name: 'Invalid Division Scope',
        email: 'invalid-division-scope@prime.test',
        phone: '+256700000032',
        password: 'AdminPass123!',
        role: 'ADMIN',
        module_keys: [],
        country_ids: [ug.id],
        division_ids: ['22222222-2222-4222-8222-222222222222'],
      },
    });
    expect(invalidDivision.statusCode).toBe(400);
    expect(invalidDivision.json()).toMatchObject({
      code: 'division_scope_not_found',
    });
  });

  it('enforces RBAC boundaries for super, country, and division admins', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const division = (
      await pool.query(
        `
        INSERT INTO divisions (country_id, name, type)
        VALUES ($1,'Kampala','CITY')
        RETURNING *
        `,
        [ug.id]
      )
    ).rows[0];

    const countryAdmin = await insertUser({
      email: 'country@prime.test',
      phone: '+256700000101',
      admin_role: 'COUNTRY_ADMIN',
      country: 'UG',
      country_id: ug.id,
    });
    const divisionAdmin = await insertUser({
      email: 'division@prime.test',
      phone: '+256700000102',
      admin_role: 'DIVISION_ADMIN',
      country: 'UG',
      country_id: ug.id,
      division_id: division.id,
    });

    const countryToken = app.jwt.sign(
      buildAuthClaims({
        ...countryAdmin,
        country_id: ug.id,
      })
    );
    const divisionToken = app.jwt.sign(
      buildAuthClaims({
        ...divisionAdmin,
        country_id: ug.id,
        division_id: division.id,
      })
    );

    const blocked = await app.inject({
      method: 'GET',
      url: '/admin/global-stats',
      headers: { authorization: `Bearer ${countryToken}` },
    });
    expect(blocked.statusCode).toBe(403);

    const countryAllowed = await app.inject({
      method: 'GET',
      url: '/country/analytics',
      headers: { authorization: `Bearer ${countryToken}` },
    });
    expect(countryAllowed.statusCode).toBe(200);

    const divisionBlocked = await app.inject({
      method: 'GET',
      url: '/division/overview',
      headers: { authorization: `Bearer ${countryToken}` },
    });
    expect(divisionBlocked.statusCode).toBe(403);

    const divisionAllowed = await app.inject({
      method: 'GET',
      url: '/division/overview',
      headers: { authorization: `Bearer ${divisionToken}` },
    });
    expect(divisionAllowed.statusCode).toBe(200);
  });

  it('isolates country dashboard data to the current country', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const ke = await insertCountry('KE', 'Kenya');

    const ugAdmin = await insertUser({
      email: 'ug-admin@prime.test',
      phone: '+256700000201',
      admin_role: 'COUNTRY_ADMIN',
      country: 'UG',
      country_id: ug.id,
    });
    await insertUser({
      email: 'ug-user@prime.test',
      phone: '+256700000202',
      role: 'BUSINESS',
      active_role: 'BUSINESS',
      country: 'UG',
      country_id: ug.id,
    });
    const keUser = await insertUser({
      email: 'ke-user@prime.test',
      phone: '+254700000203',
      role: 'BUSINESS',
      active_role: 'BUSINESS',
      country: 'KE',
      country_id: ke.id,
    });

    await insertCampaign({
      business_id: ugAdmin.id,
      title: 'UG Campaign',
      country_id: ug.id,
    });
    await insertCampaign({
      business_id: keUser.id,
      title: 'KE Campaign',
      country_id: ke.id,
    });

    const token = app.jwt.sign(
      buildAuthClaims({
        ...ugAdmin,
        country_id: ug.id,
      })
    );

    const usersResponse = await app.inject({
      method: 'GET',
      url: '/country/users',
      headers: { authorization: `Bearer ${token}` },
    });
    const usersBody = usersResponse.json() as { users: Array<{ email: string }> };
    expect(usersResponse.statusCode).toBe(200);
    expect(usersBody.users.every((user) => user.email.endsWith('@prime.test'))).toBe(
      true
    );
    expect(usersBody.users.some((user) => user.email === 'ke-user@prime.test')).toBe(
      false
    );

    const campaignsResponse = await app.inject({
      method: 'GET',
      url: '/country/campaigns',
      headers: { authorization: `Bearer ${token}` },
    });
    const campaignsBody = campaignsResponse.json() as {
      campaigns: Array<{ title: string }>;
    };
    expect(campaignsResponse.statusCode).toBe(200);
    expect(campaignsBody.campaigns.map((campaign) => campaign.title)).toEqual([
      'UG Campaign',
    ]);
  });

  it('scopes shared admin users routes to the manager tenant', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const ke = await insertCountry('KE', 'Kenya');

    const ugAdmin = await insertUser({
      email: 'ug-scope-admin@prime.test',
      phone: '+256700000221',
      admin_role: 'COUNTRY_ADMIN',
      country: 'UG',
      country_id: ug.id,
    });
    const ugUser = await insertUser({
      email: 'ug-library-user@prime.test',
      phone: '+256700000222',
      role: 'BUSINESS',
      active_role: 'BUSINESS',
      country: 'UG',
      country_id: ug.id,
    });
    const keUser = await insertUser({
      email: 'ke-library-user@prime.test',
      phone: '+254700000223',
      role: 'BUSINESS',
      active_role: 'BUSINESS',
      country: 'KE',
      country_id: ke.id,
    });

    const token = app.jwt.sign(
      buildAuthClaims({
        ...ugAdmin,
        country_id: ug.id,
      })
    );

    const usersResponse = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(usersResponse.statusCode).toBe(200);
    const usersBody = usersResponse.json() as { users: Array<{ email: string }> };
    expect(usersBody.users.some((user) => user.email == ugUser.email)).toBe(true);
    expect(usersBody.users.some((user) => user.email == keUser.email)).toBe(false);

    const blockedDetail = await app.inject({
      method: 'GET',
      url: `/admin/users/${keUser.id}/detail`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(blockedDetail.statusCode).toBe(404);
  });

  it('blocks tenant managers from promoting users into global admin accounts', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const manager = await insertUser({
      email: 'tenant-manager@prime.test',
      phone: '+256700000231',
      admin_role: 'COUNTRY_ADMIN',
      country: 'UG',
      country_id: ug.id,
    });
    const target = await insertUser({
      email: 'target-user@prime.test',
      phone: '+256700000232',
      role: 'BUSINESS',
      active_role: 'BUSINESS',
      country: 'UG',
      country_id: ug.id,
    });

    const token = app.jwt.sign(
      buildAuthClaims({
        ...manager,
        country_id: ug.id,
      })
    );

    const response = await app.inject({
      method: 'PATCH',
      url: `/admin/users/${target.id}/role`,
      headers: { authorization: `Bearer ${token}` },
      payload: { role: 'ADMIN' },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'forbidden' });

    const userRes = await pool.query(
      'SELECT role, active_role FROM users WHERE id = $1 LIMIT 1',
      [target.id]
    );
    expect(userRes.rows[0]).toMatchObject({
      role: 'BUSINESS',
      active_role: 'BUSINESS',
    });
  });

  it('scopes shared payout request moderation to the caller tenant', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const ke = await insertCountry('KE', 'Kenya');

    const manager = await insertUser({
      email: 'ug-payout-manager@prime.test',
      phone: '+256700000241',
      admin_role: 'COUNTRY_ADMIN',
      country: 'UG',
      country_id: ug.id,
    });
    const ugBusiness = await insertUser({
      email: 'ug-payout-user@prime.test',
      phone: '+256700000242',
      role: 'BUSINESS',
      active_role: 'BUSINESS',
      country: 'UG',
      country_id: ug.id,
    });
    const keBusiness = await insertUser({
      email: 'ke-payout-user@prime.test',
      phone: '+254700000243',
      role: 'BUSINESS',
      active_role: 'BUSINESS',
      country: 'KE',
      country_id: ke.id,
    });

    const ugCampaign = await insertCampaign({
      business_id: ugBusiness.id,
      title: 'UG payout campaign',
      country_id: ug.id,
    });
    const keCampaign = await insertCampaign({
      business_id: keBusiness.id,
      title: 'KE payout campaign',
      country_id: ke.id,
    });
    const ugSession = await insertVerificationSession({
      user_id: ugBusiness.id,
      campaign_id: ugCampaign.id,
    });
    const keSession = await insertVerificationSession({
      user_id: keBusiness.id,
      campaign_id: keCampaign.id,
    });
    const ugProof = await insertProof({
      session_id: ugSession.id,
      user_id: ugBusiness.id,
    });
    const keProof = await insertProof({
      session_id: keSession.id,
      user_id: keBusiness.id,
    });
    const ugRequest = await insertPayoutRequest({
      proof_id: ugProof.id,
      user_id: ugBusiness.id,
    });
    const keRequest = await insertPayoutRequest({
      proof_id: keProof.id,
      user_id: keBusiness.id,
    });

    const token = app.jwt.sign(
      buildAuthClaims({
        ...manager,
        country_id: ug.id,
      })
    );

    const listResponse = await app.inject({
      method: 'GET',
      url: '/admin/payout-requests',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listResponse.statusCode).toBe(200);
    const listBody = listResponse.json() as {
      payouts: Array<{ id: string }>;
    };
    expect(listBody.payouts.map((item) => item.id)).toContain(ugRequest.id);
    expect(listBody.payouts.map((item) => item.id)).not.toContain(keRequest.id);

    const blockedUpdate = await app.inject({
      method: 'PATCH',
      url: `/admin/payout-requests/${keRequest.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'PROCESSING' },
    });
    expect(blockedUpdate.statusCode).toBe(404);

    const allowedUpdate = await app.inject({
      method: 'PATCH',
      url: `/admin/payout-requests/${ugRequest.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'PROCESSING' },
    });
    expect(allowedUpdate.statusCode).toBe(200);
    expect(allowedUpdate.json()).toMatchObject({
      payout: {
        id: ugRequest.id,
        status: 'PROCESSING',
      },
    });
  });

  it('isolates division dashboard data and moderation to the current division', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const kampala = (
      await pool.query(
        `
        INSERT INTO divisions (country_id, name, type)
        VALUES ($1,'Kampala','CITY')
        RETURNING *
        `,
        [ug.id]
      )
    ).rows[0];
    const gulu = (
      await pool.query(
        `
        INSERT INTO divisions (country_id, name, type)
        VALUES ($1,'Gulu','CITY')
        RETURNING *
        `,
        [ug.id]
      )
    ).rows[0];

    const admin = await insertUser({
      email: 'kampala-admin@prime.test',
      phone: '+256700000301',
      admin_role: 'DIVISION_ADMIN',
      country: 'UG',
      country_id: ug.id,
      division_id: kampala.id,
    });
    await insertUser({
      email: 'kampala-user@prime.test',
      phone: '+256700000302',
      role: 'BUSINESS',
      active_role: 'BUSINESS',
      country: 'UG',
      country_id: ug.id,
      division_id: kampala.id,
    });
    const guluUser = await insertUser({
      email: 'gulu-user@prime.test',
      phone: '+256700000303',
      role: 'BUSINESS',
      active_role: 'BUSINESS',
      country: 'UG',
      country_id: ug.id,
      division_id: gulu.id,
    });

    const kampalaCampaign = await insertCampaign({
      business_id: admin.id,
      title: 'Kampala Campaign',
      country_id: ug.id,
      division_id: kampala.id,
    });
    const guluCampaign = await insertCampaign({
      business_id: guluUser.id,
      title: 'Gulu Campaign',
      country_id: ug.id,
      division_id: gulu.id,
    });

    const token = app.jwt.sign(
      buildAuthClaims({
        ...admin,
        country_id: ug.id,
        division_id: kampala.id,
      })
    );

    const usersResponse = await app.inject({
      method: 'GET',
      url: '/division/users',
      headers: { authorization: `Bearer ${token}` },
    });
    const usersBody = usersResponse.json() as { users: Array<{ email: string }> };
    expect(usersResponse.statusCode).toBe(200);
    expect(usersBody.users.some((user) => user.email === 'gulu-user@prime.test')).toBe(
      false
    );

    const campaignsResponse = await app.inject({
      method: 'GET',
      url: '/division/campaigns',
      headers: { authorization: `Bearer ${token}` },
    });
    const campaignsBody = campaignsResponse.json() as {
      campaigns: Array<{ title: string }>;
    };
    expect(campaignsResponse.statusCode).toBe(200);
    expect(campaignsBody.campaigns.map((campaign) => campaign.title)).toEqual([
      'Kampala Campaign',
    ]);

    const blockedModeration = await app.inject({
      method: 'POST',
      url: `/division/campaigns/${guluCampaign.id}/moderate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'PAUSED' },
    });
    expect(blockedModeration.statusCode).toBe(404);

    const allowedModeration = await app.inject({
      method: 'POST',
      url: `/division/campaigns/${kampalaCampaign.id}/moderate`,
      headers: { authorization: `Bearer ${token}` },
      payload: { status: 'PAUSED' },
    });
    expect(allowedModeration.statusCode).toBe(200);
  });

  it('calculates revenue splits correctly for completed campaigns', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const business = await insertUser({
      email: 'business@prime.test',
      phone: '+256700000401',
      role: 'BUSINESS',
      active_role: 'BUSINESS',
      country: 'UG',
      country_id: ug.id,
    });
    const division = (
      await pool.query(
        `
        INSERT INTO divisions (country_id, name, type, created_by)
        VALUES ($1,'Makerere','UNIVERSITY',$2)
        RETURNING *
        `,
        [ug.id, business.id]
      )
    ).rows[0];
    const campaign = await insertCampaign({
      business_id: business.id,
      title: 'Revenue Campaign',
      country_id: ug.id,
      division_id: division.id,
      budget_total: 1000,
    });

    await recordCampaignRevenueEntry(pool, campaign.id);

    const ledger = await pool.query(
      `
      SELECT *
      FROM earnings_ledger
      WHERE campaign_id = $1
      LIMIT 1
      `,
      [campaign.id]
    );

    expect(Number(ledger.rows[0].gross_amount)).toBe(1000);
    expect(Number(ledger.rows[0].platform_fee)).toBe(150);
    expect(Number(ledger.rows[0].country_share)).toBe(22.5);
    expect(Number(ledger.rows[0].division_share)).toBe(22.5);
    expect(Number(ledger.rows[0].net_platform_revenue)).toBe(105);
  });

  it('aggregates manager payouts and credits wallets automatically', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const business = await insertUser({
      email: 'owner@prime.test',
      phone: '+256700000501',
      role: 'BUSINESS',
      active_role: 'BUSINESS',
      country: 'UG',
      country_id: ug.id,
    });
    const countryAdmin = await insertUser({
      email: 'country-manager@prime.test',
      phone: '+256700000502',
      admin_role: 'COUNTRY_ADMIN',
      country: 'UG',
      country_id: ug.id,
    });
    const division = (
      await pool.query(
        `
        INSERT INTO divisions (country_id, name, type, created_by)
        VALUES ($1,'Entebbe','CITY',$2)
        RETURNING *
        `,
        [ug.id, business.id]
      )
    ).rows[0];
    const divisionAdmin = await insertUser({
      email: 'division-manager@prime.test',
      phone: '+256700000503',
      admin_role: 'DIVISION_ADMIN',
      country: 'UG',
      country_id: ug.id,
      division_id: division.id,
    });

    await pool.query(
      `
      INSERT INTO country_admins (user_id, country_id, role)
      VALUES ($1,$2,'PRIMARY')
      `,
      [countryAdmin.id, ug.id]
    );
    await pool.query(
      `
      INSERT INTO division_admins (user_id, division_id, role)
      VALUES ($1,$2,'MANAGER')
      `,
      [divisionAdmin.id, division.id]
    );

    const campaign = await insertCampaign({
      business_id: business.id,
      title: 'Monthly Share Campaign',
      country_id: ug.id,
      division_id: division.id,
      budget_total: 1000,
    });

    await recordCampaignRevenueEntry(pool, campaign.id);
    await pool.query(
      `
      UPDATE earnings_ledger
      SET created_at = '2026-03-20T10:00:00Z'
      WHERE campaign_id = $1
      `,
      [campaign.id]
    );

    const result = await generateMonthlyPayouts(
      pool,
      new Date('2026-04-01T00:00:00Z')
    );

    expect(result.country_admin_payouts_created).toBe(1);
    expect(result.division_admin_payouts_created).toBe(1);
    expect(result.wallet_credits_applied).toBe(2);

    const payouts = await pool.query(
      `
      SELECT user_id, amount, status
      FROM payouts
      ORDER BY user_id ASC
      `
    );
    expect(payouts.rows.every((row) => row.status === 'PAID')).toBe(true);
    expect(payouts.rows.map((row) => Number(row.amount)).sort((a, b) => a - b)).toEqual([
      23,
      23,
    ]);

    const wallets = await pool.query(
      `
      SELECT user_id, balance_available, balance
      FROM wallets
      WHERE user_id IN ($1, $2)
      ORDER BY user_id ASC
      `,
      [countryAdmin.id, divisionAdmin.id]
    );
    expect(
      wallets.rows.map((row) => Number(row.balance_available)).sort((a, b) => a - b)
    ).toEqual([23, 23]);
    expect(
      wallets.rows.map((row) => Number(row.balance)).sort((a, b) => a - b)
    ).toEqual([23, 23]);
  });

  it('limits manager payout visibility and payment actions to the active tenant', async () => {
    const ug = await insertCountry('UG', 'Uganda');
    const ke = await insertCountry('KE', 'Kenya');
    const kampala = (
      await pool.query(
        `
        INSERT INTO divisions (country_id, name, type)
        VALUES ($1,'Kampala','CITY')
        RETURNING *
        `,
        [ug.id]
      )
    ).rows[0];
    const gulu = (
      await pool.query(
        `
        INSERT INTO divisions (country_id, name, type)
        VALUES ($1,'Gulu','CITY')
        RETURNING *
        `,
        [ug.id]
      )
    ).rows[0];

    const ugCountryManager = await insertUser({
      email: 'country-payout-manager@prime.test',
      phone: '+256700000511',
      admin_role: 'COUNTRY_ADMIN',
      country: 'UG',
      country_id: ug.id,
    });
    const kampalaManager = await insertUser({
      email: 'kampala-payout-manager@prime.test',
      phone: '+256700000512',
      admin_role: 'DIVISION_ADMIN',
      country: 'UG',
      country_id: ug.id,
      division_id: kampala.id,
    });
    const guluManager = await insertUser({
      email: 'gulu-payout-manager@prime.test',
      phone: '+256700000513',
      admin_role: 'DIVISION_ADMIN',
      country: 'UG',
      country_id: ug.id,
      division_id: gulu.id,
    });
    const kenyaManager = await insertUser({
      email: 'kenya-payout-manager@prime.test',
      phone: '+254700000514',
      admin_role: 'COUNTRY_ADMIN',
      country: 'KE',
      country_id: ke.id,
    });

    await pool.query(
      `
      INSERT INTO payouts (
        user_id,
        role,
        amount,
        period_start,
        period_end,
        status,
        country_id,
        division_id
      )
      VALUES
        ($1,'DIVISION_ADMIN',25,'2026-03-01','2026-03-31','PENDING',$2,$3),
        ($4,'DIVISION_ADMIN',30,'2026-03-01','2026-03-31','PENDING',$2,$5),
        ($6,'COUNTRY_ADMIN',35,'2026-03-01','2026-03-31','PENDING',$7,NULL)
      `,
      [kampalaManager.id, ug.id, kampala.id, guluManager.id, gulu.id, kenyaManager.id, ke.id]
    );

    const kampalaPayoutRes = await pool.query(
      'SELECT * FROM payouts WHERE user_id = $1 LIMIT 1',
      [kampalaManager.id]
    );
    const guluPayoutRes = await pool.query(
      'SELECT * FROM payouts WHERE user_id = $1 LIMIT 1',
      [guluManager.id]
    );
    const kenyaPayoutRes = await pool.query(
      'SELECT * FROM payouts WHERE user_id = $1 LIMIT 1',
      [kenyaManager.id]
    );
    const kampalaPayout = kampalaPayoutRes.rows[0];
    const guluPayout = guluPayoutRes.rows[0];
    const kenyaPayout = kenyaPayoutRes.rows[0];

    const countryToken = app.jwt.sign(
      buildAuthClaims({
        ...ugCountryManager,
        country_id: ug.id,
      })
    );
    const divisionToken = app.jwt.sign(
      buildAuthClaims({
        ...kampalaManager,
        country_id: ug.id,
        division_id: kampala.id,
      })
    );

    const countryList = await app.inject({
      method: 'GET',
      url: '/admin/payouts',
      headers: { authorization: `Bearer ${countryToken}` },
    });
    expect(countryList.statusCode).toBe(200);
    const countryBody = countryList.json() as {
      payouts: Array<{ id: string }>;
    };
    expect(countryBody.payouts.map((item) => item.id)).toContain(kampalaPayout.id);
    expect(countryBody.payouts.map((item) => item.id)).toContain(guluPayout.id);
    expect(countryBody.payouts.map((item) => item.id)).not.toContain(kenyaPayout.id);

    const divisionList = await app.inject({
      method: 'GET',
      url: '/admin/payouts',
      headers: { authorization: `Bearer ${divisionToken}` },
    });
    expect(divisionList.statusCode).toBe(200);
    const divisionBody = divisionList.json() as {
      payouts: Array<{ id: string }>;
    };
    expect(divisionBody.payouts.map((item) => item.id)).toEqual([kampalaPayout.id]);

    const blockedPayment = await app.inject({
      method: 'POST',
      url: `/admin/payouts/${guluPayout.id}/pay`,
      headers: { authorization: `Bearer ${divisionToken}` },
    });
    expect(blockedPayment.statusCode).toBe(404);

    const allowedPayment = await app.inject({
      method: 'POST',
      url: `/admin/payouts/${kampalaPayout.id}/pay`,
      headers: { authorization: `Bearer ${divisionToken}` },
    });
    expect(allowedPayment.statusCode).toBe(200);
    expect(allowedPayment.json()).toMatchObject({
      payout: {
        id: kampalaPayout.id,
        status: 'PAID',
      },
    });

    const walletRes = await pool.query(
      'SELECT balance_available, balance FROM wallets WHERE user_id = $1 LIMIT 1',
      [kampalaManager.id]
    );
    expect(Number(walletRes.rows[0]?.balance_available ?? 0)).toBe(25);
    expect(Number(walletRes.rows[0]?.balance ?? 0)).toBe(25);
  });
});
