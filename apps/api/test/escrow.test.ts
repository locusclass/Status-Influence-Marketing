import { describe, it, expect, beforeAll } from 'vitest';
import { getTestPool, applySchema } from './db.js';

const pool = getTestPool();

describe('Escrow idempotency', () => {
  if (!pool) {
    it('skipped: TEST_DATABASE_URL not set', () => expect(true).toBe(true));
    return;
  }

  beforeAll(async () => {
    await applySchema(pool);
  });

  it('prevents double payout using unique proof_id', async () => {
    const user = await pool.query("INSERT INTO users (email, phone, password_hash, role) VALUES ('a@b.com','+254700000001','x','DISTRIBUTOR') RETURNING *");
    const campaign = await pool.query("INSERT INTO campaigns (advertiser_id, title, platform, payout_amount, budget_total, start_date, end_date) VALUES ($1,'t','WHATSAPP_STATUS',100,1000,'2024-01-01','2024-12-31') RETURNING *", [user.rows[0].id]);
    const escrow = await pool.query('INSERT INTO escrow_ledger (campaign_id, amount_total, amount_available, status) VALUES ($1,1000,1000,\'FUNDED\') RETURNING *', [campaign.rows[0].id]);
    const session = await pool.query('INSERT INTO verification_sessions (user_id, campaign_id, platform, challenge_code, challenge_phrase, expires_at) VALUES ($1,$2,\'WHATSAPP_STATUS\',\'ABC123\',\'alpha beta gamma\', now() + interval \'1 hour\') RETURNING *', [user.rows[0].id, campaign.rows[0].id]);
    const proof = await pool.query('INSERT INTO proofs (session_id, user_id, video_url) VALUES ($1,$2,\'file://video\') RETURNING *', [session.rows[0].id, user.rows[0].id]);

    await pool.query('INSERT INTO payout_requests (proof_id, user_id, amount) VALUES ($1,$2,100)', [proof.rows[0].id, user.rows[0].id]);
    const dup = await pool.query('INSERT INTO payout_requests (proof_id, user_id, amount) VALUES ($1,$2,100) ON CONFLICT (proof_id) DO NOTHING RETURNING *', [proof.rows[0].id, user.rows[0].id]);
    expect(dup.rows.length).toBe(0);
  });
});
