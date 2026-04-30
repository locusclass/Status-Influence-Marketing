import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildAuthClaims } from '../src/services/roles.js';
import { applySchema, getTestPool } from './db.js';

const pool = getTestPool();
let app: any;

async function resetDatabase() {
  if (!pool) return;
  await pool.query(`
    TRUNCATE TABLE
      promoter_profile_reviews,
      chat_offer_group_votes,
      chat_offer_events,
      chat_group_price_overrides,
      chat_group_deal_threads,
      chat_group_memberships,
      chat_groups,
      chat_typing_states,
      chat_messages,
      chat_thread_members,
      chat_threads,
      proofs,
      verification_sessions,
      payouts,
      earnings_ledger,
      escrow_ledger,
      contracts,
      campaigns,
      wallet_txns,
      wallets,
      division_admins,
      country_admins,
      divisions,
      users,
      countries
    CASCADE
  `);
  await applySchema(pool);
}

async function insertUser(input: {
  fullName: string;
  email: string;
  phone: string;
  role: 'ADVERTISER' | 'DISTRIBUTOR' | 'DUAL_USER';
  activeRole?: 'ADVERTISER' | 'DISTRIBUTOR';
  privateContractRateUgx?: number;
  maxStatusViewers12h?: number;
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
      status,
      private_contract_rate_ugx,
      max_status_viewers_12h
    )
    VALUES ($1, $2, $3, 'x', $4, $5, 'ACTIVE', $6, $7)
    RETURNING *
    `,
    [
      input.fullName,
      input.email,
      input.phone,
      input.role,
      input.activeRole ?? input.role,
      input.privateContractRateUgx ?? 4000,
      input.maxStatusViewers12h ?? 1200,
    ]
  );
  return result.rows[0];
}

async function insertChatGroup(input: {
  name: string;
  description?: string;
  createdBy: string;
  memberIds: string[];
}) {
  const thread = await pool!.query(
    `
    INSERT INTO chat_threads (kind, title, created_by)
    VALUES ('GROUP_ROOM', $1, $2)
    RETURNING *
    `,
    [input.name, input.createdBy]
  );
  const group = await pool!.query(
    `
    INSERT INTO chat_groups (
      public_id,
      thread_id,
      name,
      description,
      public_price_ugx,
      created_by,
      updated_at
    )
    VALUES ($1, $2, $3, $4, 0, $5, NOW())
    RETURNING *
    `,
    [`grp-${input.name.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 8)}`, thread.rows[0].id, input.name, input.description ?? '', input.createdBy]
  );

  for (const memberId of input.memberIds) {
    await pool!.query(
      `
      INSERT INTO chat_group_memberships (
        group_id,
        user_id,
        role,
        status,
        invited_by,
        joined_at,
        responded_at,
        updated_at
      )
      VALUES ($1, $2, 'MEMBER', 'ACTIVE', $3, NOW(), NOW(), NOW())
      `,
      [group.rows[0].id, memberId, input.createdBy]
    );
  }

  await pool!.query(
    `
    INSERT INTO chat_group_memberships (
      group_id,
      user_id,
      role,
      status,
      invited_by,
      joined_at,
      responded_at,
      updated_at
    )
    VALUES ($1, $2, 'ADMIN', 'ACTIVE', $2, NOW(), NOW(), NOW())
    ON CONFLICT (group_id, user_id) DO NOTHING
    `,
    [group.rows[0].id, input.createdBy]
  );

  return group.rows[0];
}

describe('Beneficiary discovery', () => {
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

  it('finds promoters by name and by phone with or without country code', async () => {
    const advertiser = await insertUser({
      fullName: 'Advertiser Search',
      email: 'advertiser-search@example.com',
      phone: '+256700000001',
      role: 'ADVERTISER',
      activeRole: 'ADVERTISER',
      privateContractRateUgx: 0,
    });
    const promoter = await insertUser({
      fullName: 'Amina Nansubuga',
      email: 'amina@example.com',
      phone: '+256700123456',
      role: 'DISTRIBUTOR',
      activeRole: 'DISTRIBUTOR',
      privateContractRateUgx: 8500,
    });
    const token = app.jwt.sign(buildAuthClaims(advertiser));

    const byName = await app.inject({
      method: 'GET',
      url: '/campaigns/distributor-lookup?q=Amina',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(byName.statusCode).toBe(200);
    expect(byName.json()).toMatchObject({
      distributor: {
        id: promoter.id,
        full_name: 'Amina Nansubuga',
      },
    });

    const byLocalPhone = await app.inject({
      method: 'GET',
      url: '/campaigns/distributor-lookup?phone=0700123456',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(byLocalPhone.statusCode).toBe(200);
    expect(byLocalPhone.json()).toMatchObject({
      distributor: {
        id: promoter.id,
        phone: '+256700123456',
      },
    });

    const byNationalNumber = await app.inject({
      method: 'GET',
      url: '/promoters/lookup?phone=700123456',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(byNationalNumber.statusCode).toBe(200);
    expect(byNationalNumber.json()).toMatchObject({
      profile: {
        id: promoter.id,
        display_name: 'Amina Nansubuga',
      },
    });
  });

  it('finds beneficiary groups by group name and member phone variants', async () => {
    const advertiser = await insertUser({
      fullName: 'Advertiser Group Search',
      email: 'advertiser-group@example.com',
      phone: '+256700000002',
      role: 'ADVERTISER',
      activeRole: 'ADVERTISER',
      privateContractRateUgx: 0,
    });
    const promoter = await insertUser({
      fullName: 'Daniel Kato',
      email: 'daniel@example.com',
      phone: '+256701234567',
      role: 'DISTRIBUTOR',
      activeRole: 'DISTRIBUTOR',
      privateContractRateUgx: 9200,
    });
    await insertChatGroup({
      name: 'Kampala Movers',
      description: 'High-response group',
      createdBy: promoter.id,
      memberIds: [promoter.id],
    });
    const token = app.jwt.sign(buildAuthClaims(advertiser));

    const byName = await app.inject({
      method: 'GET',
      url: '/campaigns/group-lookup?q=Kampala Movers',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(byName.statusCode).toBe(200);
    expect(byName.json()).toMatchObject({
      group: {
        name: 'Kampala Movers',
        member_count: 1,
      },
    });

    const byMemberPhone = await app.inject({
      method: 'GET',
      url: '/campaigns/group-lookup?q=0701234567',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(byMemberPhone.statusCode).toBe(200);
    expect(byMemberPhone.json()).toMatchObject({
      group: {
        name: 'Kampala Movers',
        member_count: 1,
      },
    });
  });
});
