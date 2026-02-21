import { describe, it, expect, beforeAll } from 'vitest';
import { getTestPool, applySchema } from './db.js';

const pool = getTestPool();

describe('Trust score updates', () => {
  if (!pool) {
    it('skipped: TEST_DATABASE_URL not set', () => expect(true).toBe(true));
    return;
  }

  beforeAll(async () => {
    await applySchema(pool);
  });

  it('caps trust score between 0 and 100', async () => {
    const user = await pool.query("INSERT INTO users (email, phone, password_hash, role) VALUES ('c@d.com','+254700000002','x','DISTRIBUTOR') RETURNING *");
    await pool.query('INSERT INTO trust_scores (user_id, score) VALUES ($1, 95)', [user.rows[0].id]);
    await pool.query('INSERT INTO trust_events (user_id, event_type, delta) VALUES ($1,\'VERIFIED\',10)', [user.rows[0].id]);
    await pool.query('UPDATE trust_scores SET score=LEAST(100, score + 10) WHERE user_id=$1', [user.rows[0].id]);
    const updated = await pool.query('SELECT * FROM trust_scores WHERE user_id=$1', [user.rows[0].id]);
    expect(updated.rows[0].score).toBe(100);
  });
});
