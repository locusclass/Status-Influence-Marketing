import { Pool, PoolClient } from 'pg';
import { config } from './config.js';

const isVitestRuntime =
  String(process.env.VITEST ?? '').trim().toLowerCase() === 'true';
const databaseUrl =
  isVitestRuntime && String(process.env.TEST_DATABASE_URL ?? '').trim().length > 0
    ? String(process.env.TEST_DATABASE_URL).trim()
    : config.databaseUrl;
const databaseConnectionTimeoutMillis = Number(
  process.env.DB_CONNECTION_TIMEOUT_MS ?? 30000
);

/**
 * Validate DATABASE_URL early so failure is explicit.
 */
if (!databaseUrl) {
  throw new Error('FATAL_STARTUP_CONFIGURATION: DATABASE_URL is not defined.');
}

/**
 * Railway PostgreSQL requires SSL.
 * rejectUnauthorized:false is required because Railway uses managed certificates.
 */
export const pool = new Pool({
  connectionString: databaseUrl,
  ssl:
    /localhost|127\.0\.0\.1/i.test(databaseUrl)
      ? false
      : {
          rejectUnauthorized: false
        },
  max: 10,                   // cap concurrent DB connections (Railway free tier limit)
  idleTimeoutMillis: 30000,  // release idle connections after 30 s
  connectionTimeoutMillis:
    Number.isFinite(databaseConnectionTimeoutMillis) &&
    databaseConnectionTimeoutMillis > 0
      ? databaseConnectionTimeoutMillis
      : 30000,
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
export async function withTransaction<T>(
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('Rollback failed:', rollbackErr);
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Simple query helper
 */
export async function query<T = any>(
  text: string,
  params?: any[]
): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}
