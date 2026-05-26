import { Pool } from 'pg';
import { config } from './config.js';
const databaseUrl = config.databaseUrl.trim();
const databaseConnectionTimeoutMillis = Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 30000);
if (!databaseUrl) {
    throw new Error('FATAL_STARTUP_CONFIGURATION: DATABASE_URL is not defined.');
}
export const pool = new Pool({
    connectionString: databaseUrl,
    ssl: /localhost|127\.0\.0\.1/i.test(databaseUrl)
        ? false
        : {
            rejectUnauthorized: false,
        },
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: Number.isFinite(databaseConnectionTimeoutMillis) &&
        databaseConnectionTimeoutMillis > 0
        ? databaseConnectionTimeoutMillis
        : 30000,
});
pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err);
});
export async function withTransaction(fn) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    }
    catch (err) {
        try {
            await client.query('ROLLBACK');
        }
        catch (rollbackErr) {
            console.error('Rollback failed:', rollbackErr);
        }
        throw err;
    }
    finally {
        client.release();
    }
}
