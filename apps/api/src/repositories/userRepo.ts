import { PoolClient } from 'pg';

export class UserRepo {

  async createUser(
    client: PoolClient,
    email: string,
    phone: string,
    passwordHash: string,
    role: 'ADVERTISER' | 'DISTRIBUTOR',
    country: string,
    currency: string
  ) {
    const res = await client.query(
      `
      INSERT INTO users (
        email,
        phone,
        password_hash,
        role,
        country,
        preferred_currency
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING id, email, role, phone, country, preferred_currency
      `,
      [email, phone, passwordHash, role, country, currency]
    );

    return res.rows[0];
  }

  async findByEmail(client: PoolClient, email: string) {
    const res = await client.query(
      `SELECT * FROM users WHERE email=$1`,
      [email]
    );

    return res.rows[0];
  }

  async ensureWallet(
    client: PoolClient,
    userId: string,
    currency: string
  ) {
    const existing = await client.query(
      `SELECT * FROM wallets WHERE user_id=$1`,
      [userId]
    );

    if (existing.rows[0]) return existing.rows[0];

    const created = await client.query(
      `
      INSERT INTO wallets (
        user_id,
        currency,
        balance_available,
        balance_escrow
      )
      VALUES ($1,$2,0,0)
      RETURNING *
      `,
      [userId, currency]
    );

    return created.rows[0];
  }
}
