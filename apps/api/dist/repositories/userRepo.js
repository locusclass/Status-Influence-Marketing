import { ensurePublicIdColumns } from '../services/publicId.js';
export class UserRepo {
    async getUsersColumns(client) {
        const res = await client.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'users'
        AND column_name = ANY($1::text[])
      `, [[
                'full_name',
                'can_multi_contract',
                'max_status_viewers_12h',
                'private_contract_rate_ugx',
            ]]);
        const columns = new Set(res.rows.map((r) => r.column_name));
        return {
            hasFullName: columns.has('full_name'),
            hasCanMultiContract: columns.has('can_multi_contract'),
            hasMaxStatusViewers12h: columns.has('max_status_viewers_12h'),
            hasPrivateContractRateUgx: columns.has('private_contract_rate_ugx'),
        };
    }
    async createUser(client, fullName, email, phone, passwordHash, role, country, currency, maxStatusViewers12h) {
        await ensurePublicIdColumns(client);
        const { hasFullName, hasCanMultiContract, hasMaxStatusViewers12h, hasPrivateContractRateUgx, } = await this.getUsersColumns(client);
        const insertColumns = [
            ...(hasFullName ? ['full_name'] : []),
            'email',
            'phone',
            'password_hash',
            'role',
            'active_role',
            'country',
            'preferred_currency',
            ...(hasMaxStatusViewers12h ? ['max_status_viewers_12h'] : []),
        ];
        const values = [
            ...(hasFullName ? [fullName] : []),
            email,
            phone,
            passwordHash,
            role,
            role,
            country,
            currency,
            ...(hasMaxStatusViewers12h ? [Math.max(0, Number(maxStatusViewers12h ?? 0))] : []),
        ];
        const placeholders = insertColumns.map((_, i) => `$${i + 1}`).join(', ');
        const canMultiReturning = hasCanMultiContract
            ? 'can_multi_contract'
            : 'false::boolean AS can_multi_contract';
        const maxStatusViewersReturning = hasMaxStatusViewers12h
            ? 'max_status_viewers_12h'
            : '0::int AS max_status_viewers_12h';
        const privateContractRateReturning = hasPrivateContractRateUgx
            ? 'private_contract_rate_ugx'
            : '0::int AS private_contract_rate_ugx';
        const res = await client.query(`
      INSERT INTO users (
        ${insertColumns.join(', ')}
      )
      VALUES (${placeholders})
      RETURNING id, public_id, email, role, active_role, phone, country, preferred_currency, ${canMultiReturning}, ${maxStatusViewersReturning}, ${privateContractRateReturning}
      `, values);
        const user = res.rows[0];
        user.full_name = hasFullName ? user.full_name ?? fullName : fullName;
        if (typeof user.can_multi_contract !== 'boolean') {
            user.can_multi_contract = false;
        }
        user.max_status_viewers_12h = Math.max(0, Number(user.max_status_viewers_12h ?? maxStatusViewers12h ?? 0));
        user.private_contract_rate_ugx = Math.max(0, Number(user.private_contract_rate_ugx ?? 0));
        return user;
    }
    async findByEmail(client, email) {
        await ensurePublicIdColumns(client);
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
