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
  advertiser_id: string;
  title: string;
  country_id: string;
  division_id?: string | null;
  budget_total?: number;
  payout_amount?: number;
}) {
  const result = await pool!.query(
    `
    INSERT INTO campaigns (
      advertiser_id,
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
      input.advertiser_id,
      input.title,
      input.payout_amount ?? 100,
      input.budget_total ?? 1000,
      input.country_id,
      input.division_id ?? null,
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
      role: 'ADVERTISER',
      active_role: 'ADVERTISER',
      country: 'UG',
      country_id: ug.id,
    });
    const keUser = await insertUser({
      email: 'ke-user@prime.test',
      phone: '+254700000203',
      role: 'ADVERTISER',
      active_role: 'ADVERTISER',
      country: 'KE',
      country_id: ke.id,
    });

    await insertCampaign({
      advertiser_id: ugAdmin.id,
      title: 'UG Campaign',
      country_id: ug.id,
    });
    await insertCampaign({
      advertiser_id: keUser.id,
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
      role: 'ADVERTISER',
      active_role: 'ADVERTISER',
      country: 'UG',
      country_id: ug.id,
      division_id: kampala.id,
    });
    const guluUser = await insertUser({
      email: 'gulu-user@prime.test',
      phone: '+256700000303',
      role: 'ADVERTISER',
      active_role: 'ADVERTISER',
      country: 'UG',
      country_id: ug.id,
      division_id: gulu.id,
    });

    const kampalaCampaign = await insertCampaign({
      advertiser_id: admin.id,
      title: 'Kampala Campaign',
      country_id: ug.id,
      division_id: kampala.id,
    });
    const guluCampaign = await insertCampaign({
      advertiser_id: guluUser.id,
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
    const advertiser = await insertUser({
      email: 'advertiser@prime.test',
      phone: '+256700000401',
      role: 'ADVERTISER',
      active_role: 'ADVERTISER',
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
        [ug.id, advertiser.id]
      )
    ).rows[0];
    const campaign = await insertCampaign({
      advertiser_id: advertiser.id,
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
    const advertiser = await insertUser({
      email: 'owner@prime.test',
      phone: '+256700000501',
      role: 'ADVERTISER',
      active_role: 'ADVERTISER',
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
        [ug.id, advertiser.id]
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
      advertiser_id: advertiser.id,
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
});
