import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { fileURLToPath } from 'url';

export function getTestPool() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
  return new Pool({ connectionString: url });
}

async function hasExpectedSchema(pool: Pool) {
  const result = await pool.query(`
    SELECT
      EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'users'
      ) AS has_users,
      EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'countries'
      ) AS has_countries,
      EXISTS (
        SELECT 1
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'admin_users'
      ) AS has_admin_users,
      EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'proofs'
          AND column_name = 'country_id'
      ) AS has_proof_country_scope
  `);
  const row = result.rows[0] ?? {};
  return (
    row.has_users === true &&
    row.has_countries === true &&
    row.has_admin_users === true &&
    row.has_proof_country_scope === true
  );
}

export async function applySchema(pool: Pool) {
  if (await hasExpectedSchema(pool)) {
    return;
  }
  const schemaPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../sql/schema.sql'
  );
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
}
