import { Pool } from 'pg';
import { config } from './config.js';
/**
 * Validate DATABASE_URL early so failure is explicit.
 */
if (!config.databaseUrl) {
    console.error('FATAL: DATABASE_URL is not defined.');
    process.exit(1);
}
/**
 * Railway PostgreSQL requires SSL.
 * rejectUnauthorized:false is required because Railway uses managed certificates.
 */
export const pool = new Pool({
    connectionString: config.databaseUrl,
    ssl: {
        rejectUnauthorized: false
    }
});
/**
 * Optional: log connection errors clearly instead of silent crashes
 */
pool.on('error', (err) => {
    console.error('Unexpected PostgreSQL pool error:', err);
});
/**
 * Transaction helper with safe rollback handling
 */
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
/**
 * Simple query helper
 */
export async function query(text, params) {
    const result = await pool.query(text, params);
    return result.rows;
}
