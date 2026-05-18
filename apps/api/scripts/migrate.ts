import pg from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgresql://postgres:hcPKIzQcqStkMyJGsBUTGqiJyrRcdfvO@switchback.proxy.rlwy.net:24747/railway';

const MIGRATIONS_DIR = path.join(__dirname, '..', 'sql', 'migrations');

async function run() {
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // Ensure tracking table exists
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id         SERIAL PRIMARY KEY,
      name       TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await pool.query('SELECT name FROM _migrations')).rows.map((r: any) => r.name)
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let ran = 0;
  let skipped = 0;

  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file}`);
      skipped++;
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8').replace(/\\\$/g, '$');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      console.log(`  ✓     ${file}`);
      ran++;
    } catch (err: any) {
      await client.query('ROLLBACK');
      console.error(`  ✗     ${file}\n        ${err.message}`);
    } finally {
      client.release();
    }
  }

  await pool.end();
  console.log(`\nDone — ${ran} applied, ${skipped} already up to date.`);
}

run().catch((err) => { console.error(err); process.exit(1); });
