export class UserRepo {
    async createUser(client, fullName, email, phone, passwordHash, role, country, currency) {
        const res = await client.query(`
      INSERT INTO users (
        full_name,
        email,
        phone,
        password_hash,
        role,
        country,
        preferred_currency
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7)
      RETURNING id, full_name, email, role, phone, country, preferred_currency, can_multi_contract
      `, [fullName, email, phone, passwordHash, role, country, currency]);
        return res.rows[0];
    }
    async findByEmail(client, email) {
        const res = await client.query(`SELECT * FROM users WHERE email=$1`, [email]);
        return res.rows[0];
    }
    async ensureWallet(client, userId, currency) {
        const existing = await client.query(`SELECT * FROM wallets WHERE user_id=$1`, [userId]);
        if (existing.rows[0])
            return existing.rows[0];
        const created = await client.query(`
      INSERT INTO wallets (
        user_id,
        currency,
        balance_available,
        balance_escrow
      )
      VALUES ($1,$2,0,0)
      RETURNING *
      `, [userId, currency]);
        return created.rows[0];
    }
}
