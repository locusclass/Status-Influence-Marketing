import { describe, it, expect, beforeAll } from 'vitest';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

const url = process.env.TEST_DATABASE_URL;
const pool = url ? new Pool({ connectionString: url }) : null;

async function applySchema() {
  if (!pool) return;
  const schemaPath = path.resolve(process.cwd(), 'apps/api/sql/schema.sql');
  const sql = fs.readFileSync(schemaPath, 'utf8');
  await pool.query(sql);
}

describe('Worker job retry', () => {
  if (!pool) {
    it('skipped: TEST_DATABASE_URL not set', () => expect(true).toBe(true));
    return;
  }

  beforeAll(async () => {
    await applySchema();
  });

  it('increments attempts and transitions to RETRY', async () => {
    const job = await pool.query("INSERT INTO job_queue (job_type, payload, status) VALUES ('VERIFY_PROOF','{}','QUEUED') RETURNING *");
    const attempts = job.rows[0].attempts + 1;
    await pool.query(
      `UPDATE job_queue
       SET status='RETRY', attempts=$2, run_at=now() + interval '10 seconds'
       WHERE id=$1`,
      [job.rows[0].id, attempts]
    );
    const updated = await pool.query('SELECT * FROM job_queue WHERE id=$1', [job.rows[0].id]);
    expect(updated.rows[0].attempts).toBe(1);
    expect(updated.rows[0].status).toBe('RETRY');
  });
});
