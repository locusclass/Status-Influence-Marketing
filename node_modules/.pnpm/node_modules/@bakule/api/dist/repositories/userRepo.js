export class UserRepo {
    async getUsersColumns(client) {
        const res = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name = ANY($1::text[])
      `, [['full_name', 'can_multi_contract']]);
        const columns = new Set(res.rows.map((r) => r.column_name));
        return {
            hasFullName: columns.has('full_name'),
            hasCanMultiContract: columns.has('can_multi_contract'),
        };
    }
    async createUser(client, fullName, email, phone, passwordHash, role, country, currency) {
        const { hasFullName, hasCanMultiContract } = await this.getUsersColumns(client);
        const insertColumns = [
            ...(hasFullName ? ['full_name'] : []),
            'email',
            'phone',
            'password_hash',
            'role',
            'country',
            'preferred_currency',
        ];
        const values = [
            ...(hasFullName ? [fullName] : []),
            email,
            phone,
            passwordHash,
            role,
            country,
            currency,
        ];
        const placeholders = insertColumns.map((_, i) => `$${i + 1}`).join(', ');
        const canMultiReturning = hasCanMultiContract
            ? 'can_multi_contract'
            : 'false::boolean AS can_multi_contract';
        const res = await client.query(`
      INSERT INTO users (
        ${insertColumns.join(', ')}
      )
      VALUES (${placeholders})
      RETURNING id, email, role, phone, country, preferred_currency, ${canMultiReturning}
      `, values);
        const user = res.rows[0];
        user.full_name = hasFullName ? user.full_name ?? fullName : fullName;
        if (typeof user.can_multi_contract !== 'boolean') {
            user.can_multi_contract = false;
        }
        return user;
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
