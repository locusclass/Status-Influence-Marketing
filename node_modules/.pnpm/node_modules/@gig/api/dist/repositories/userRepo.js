export class UserRepo {
    async createUser(client, email, phone, passwordHash, role) {
        const res = await client.query('INSERT INTO users (email, phone, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, email, role, phone', [email, phone, passwordHash, role]);
        return res.rows[0];
    }
    async findByEmail(client, email) {
        const res = await client.query('SELECT * FROM users WHERE email=$1', [email]);
        return res.rows[0];
    }
    async ensureWallet(client, userId) {
        const res = await client.query('SELECT * FROM wallets WHERE user_id=$1', [userId]);
        if (res.rows[0])
            return res.rows[0];
        const create = await client.query('INSERT INTO wallets (user_id) VALUES ($1) RETURNING *', [userId]);
        return create.rows[0];
    }
}
