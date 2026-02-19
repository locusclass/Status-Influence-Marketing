import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

export function getTestPool() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return null;
  return new Pool({ connectionString: url });
}

export async function applySchema(pool: Pool) {
  const schemaPath = path.resolve(process.cwd(), 'apps/api/sql/schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
}
