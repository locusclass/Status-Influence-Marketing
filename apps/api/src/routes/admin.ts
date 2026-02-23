import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction } from '../db.js';
import { hashPassword } from '../services/auth.js';

const UpdateUserRoleSchema = z.object({
  role: z.enum(['ADMIN', 'ADVERTISER', 'DISTRIBUTOR'])
});

const UpdateUserStatusSchema = z.object({
  status: z.enum(['ACTIVE', 'SUSPENDED', 'BANNED'])
});

const ResetPasswordSchema = z.object({
  password: z.string().min(8)
});

const UpdateProofSchema = z.object({
  status: z.enum(['PENDING', 'VERIFIED', 'REJECTED', 'MANUAL_REVIEW']).optional(),
  decision: z.enum(['VERIFIED', 'REJECTED', 'MANUAL_REVIEW']).optional()
});

const UpdatePayoutSchema = z.object({
  status: z.enum(['REQUESTED', 'PROCESSING', 'PAID', 'FAILED'])
});

const UpdateEscrowSchema = z.object({
  status: z.enum(['PENDING', 'FUNDED', 'PARTIALLY_DISBURSED', 'COMPLETED'])
});

const UpdateCampaignSchema = z.object({
  title: z.string().min(3).max(120).optional(),
  platform: z.enum(['WHATSAPP_STATUS', 'TIKTOK', 'INSTAGRAM', 'X']).optional(),
  payout_amount: z.number().int().positive().optional(),
  budget_total: z.number().int().positive().optional(),
  start_date: z.string().optional(),
  end_date: z.string().optional(),
  media_type: z.enum(['TEXT', 'IMAGE', 'VIDEO']).optional(),
  media_text: z.string().trim().max(2000).nullable().optional(),
  media_url: z.string().url().nullable().optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED']).optional()
});

const UpdateContractSchema = z.object({
  status: z.enum(['ACTIVE', 'COMPLETED', 'CANCELLED']).optional(),
  distributor_id: z.string().uuid().optional()
});

const AdjustWalletSchema = z.object({
  amount: z.number().int().positive(),
  direction: z.enum(['CREDIT', 'DEBIT']),
  reference: z.string().min(3).max(120).optional()
});

const UpdateJobSchema = z.object({
  status: z.enum(['QUEUED', 'PROCESSING', 'RETRY', 'FAILED', 'DONE']).optional(),
  attempts: z.number().int().min(0).optional(),
  last_error: z.string().optional().nullable()
});

export async function adminRoutes(app: FastifyInstance) {
  app.get('/admin/overview', { preHandler: [app.adminOnly] }, async () => {
    return withTransaction(async (client) => {
      const users = await client.query('SELECT COUNT(*)::int AS count FROM users');
      const campaigns = await client.query('SELECT COUNT(*)::int AS count FROM campaigns');
      const proofs = await client.query('SELECT COUNT(*)::int AS count FROM proofs');
      const payouts = await client.query('SELECT COUNT(*)::int AS count FROM payout_requests');
      const escrows = await client.query('SELECT COUNT(*)::int AS count FROM escrow_ledger');
      const pesapal = await client.query('SELECT COUNT(*)::int AS count FROM pesapal_transactions');
      return {
        users: users.rows[0]?.count ?? 0,
        campaigns: campaigns.rows[0]?.count ?? 0,
        proofs: proofs.rows[0]?.count ?? 0,
        payouts: payouts.rows[0]?.count ?? 0,
        escrows: escrows.rows[0]?.count ?? 0,
        pesapal_transactions: pesapal.rows[0]?.count ?? 0
      };
    });
  });

  app.get('/admin/users', { preHandler: [app.adminOnly] }, async () => {
    return withTransaction(async (client) => {
      const res = await client.query('SELECT * FROM users ORDER BY created_at DESC LIMIT 500');
      return { users: res.rows };
    });
  });

  app.patch('/admin/users/:id/role', { preHandler: [app.adminOnly] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = UpdateUserRoleSchema.parse(request.body);
    const result = await withTransaction(async (client) => {
      const res = await client.query(
        'UPDATE users SET role=$2 WHERE id=$1 RETURNING *',
        [params.id, body.role]
      );
      return res.rows[0];
    });
    if (!result) {
      reply.code(404);
      return { error: 'user_not_found' };
    }
    return { user: result };
  });

  app.patch('/admin/users/:id/status', { preHandler: [app.adminOnly] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = UpdateUserStatusSchema.parse(request.body);
    const result = await withTransaction(async (client) => {
      const res = await client.query(
        'UPDATE users SET status=$2 WHERE id=$1 RETURNING *',
        [params.id, body.status]
      );
      return res.rows[0];
    });
    if (!result) {
      reply.code(404);
      return { error: 'user_not_found' };
    }
    return { user: result };
  });

  app.patch('/admin/users/:id/password', { preHandler: [app.adminOnly] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = ResetPasswordSchema.parse(request.body);
    const result = await withTransaction(async (client) => {
      const res = await client.query(
        'UPDATE users SET password_hash=$2 WHERE id=$1 RETURNING id, email, role',
        [params.id, hashPassword(body.password)]
      );
      return res.rows[0];
    });
    if (!result) {
      reply.code(404);
      return { error: 'user_not_found' };
    }
    return { user: result };
  });

  app.get('/admin/campaigns', { preHandler: [app.adminOnly] }, async () => {
    return withTransaction(async (client) => {
      const res = await client.query('SELECT * FROM campaigns ORDER BY created_at DESC LIMIT 500');
      return { campaigns: res.rows };
    });
  });

  app.patch('/admin/campaigns/:id', { preHandler: [app.adminOnly] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = UpdateCampaignSchema.parse(request.body);
    const res = await withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE campaigns SET
          title=COALESCE($2, title),
          platform=COALESCE($3, platform),
          payout_amount=COALESCE($4, payout_amount),
          budget_total=COALESCE($5, budget_total),
          media_type=COALESCE($6, media_type),
          media_text=COALESCE($7, media_text),
          media_url=COALESCE($8, media_url),
          status=COALESCE($9, status),
          start_date=COALESCE($10, start_date),
          end_date=COALESCE($11, end_date)
         WHERE id=$1
         RETURNING *`,
        [
          params.id,
          body.title ?? null,
          body.platform ?? null,
          body.payout_amount ?? null,
          body.budget_total ?? null,
          body.media_type ?? null,
          body.media_text ?? null,
          body.media_url ?? null,
          body.status ?? null,
          body.start_date ?? null,
          body.end_date ?? null
        ]
      );
      return updated.rows[0];
    });
    if (!res) {
      reply.code(404);
      return { error: 'campaign_not_found' };
    }
    return { campaign: res };
  });

  app.get('/admin/proofs', { preHandler: [app.adminOnly] }, async () => {
    return withTransaction(async (client) => {
      const res = await client.query(
        `SELECT p.*, c.title AS campaign_title
         FROM proofs p
         JOIN verification_sessions s ON s.id = p.session_id
         JOIN campaigns c ON c.id = s.campaign_id
         ORDER BY p.created_at DESC
         LIMIT 500`
      );
      return { proofs: res.rows };
    });
  });

  app.patch('/admin/proofs/:id', { preHandler: [app.adminOnly] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = UpdateProofSchema.parse(request.body);
    if (!body.status && !body.decision) {
      reply.code(400);
      return { error: 'missing_fields' };
    }
    const res = await withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE proofs
         SET status=COALESCE($2, status),
             decision=COALESCE($3, decision)
         WHERE id=$1
         RETURNING *`,
        [params.id, body.status ?? null, body.decision ?? null]
      );
      return updated.rows[0];
    });
    if (!res) {
      reply.code(404);
      return { error: 'proof_not_found' };
    }
    return { proof: res };
  });

  app.get('/admin/wallets', { preHandler: [app.adminOnly] }, async () => {
    return withTransaction(async (client) => {
      const res = await client.query('SELECT * FROM wallets ORDER BY created_at DESC LIMIT 500');
      return { wallets: res.rows };
    });
  });

  app.post('/admin/wallets/:id/adjust', { preHandler: [app.adminOnly] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = AdjustWalletSchema.parse(request.body);
    const result = await withTransaction(async (client) => {
      const walletRes = await client.query('SELECT * FROM wallets WHERE id=$1', [params.id]);
      const wallet = walletRes.rows[0];
      if (!wallet) return null;
      const delta = body.direction === 'CREDIT' ? body.amount : -body.amount;
      const updated = await client.query(
        'UPDATE wallets SET balance = balance + $2 WHERE id=$1 RETURNING *',
        [params.id, delta]
      );
      await client.query(
        'INSERT INTO wallet_txns (wallet_id, amount, direction, reference) VALUES ($1,$2,$3,$4)',
        [params.id, body.amount, body.direction, body.reference ?? 'ADMIN_ADJUST']
      );
      return updated.rows[0];
    });
    if (!result) {
      reply.code(404);
      return { error: 'wallet_not_found' };
    }
    return { wallet: result };
  });

  app.get('/admin/wallets/:id/txns', { preHandler: [app.adminOnly] }, async (request) => {
    const params = request.params as { id: string };
    return withTransaction(async (client) => {
      const res = await client.query(
        'SELECT * FROM wallet_txns WHERE wallet_id=$1 ORDER BY created_at DESC LIMIT 200',
        [params.id]
      );
      return { txns: res.rows };
    });
  });

  app.get('/admin/escrows', { preHandler: [app.adminOnly] }, async () => {
    return withTransaction(async (client) => {
      const res = await client.query(
        `SELECT e.*, c.title AS campaign_title
         FROM escrow_ledger e
         JOIN campaigns c ON c.id = e.campaign_id
         ORDER BY e.created_at DESC
         LIMIT 500`
      );
      return { escrows: res.rows };
    });
  });

  app.patch('/admin/escrows/:id', { preHandler: [app.adminOnly] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = UpdateEscrowSchema.parse(request.body);
    const res = await withTransaction(async (client) => {
      const updated = await client.query(
        'UPDATE escrow_ledger SET status=$2 WHERE id=$1 RETURNING *',
        [params.id, body.status]
      );
      return updated.rows[0];
    });
    if (!res) {
      reply.code(404);
      return { error: 'escrow_not_found' };
    }
    return { escrow: res };
  });

  app.get('/admin/payouts', { preHandler: [app.adminOnly] }, async () => {
    return withTransaction(async (client) => {
      const res = await client.query(
        `SELECT p.*, u.email AS user_email
         FROM payout_requests p
         JOIN users u ON u.id = p.user_id
         ORDER BY p.created_at DESC
         LIMIT 500`
      );
      return { payouts: res.rows };
    });
  });

  app.get('/admin/contracts', { preHandler: [app.adminOnly] }, async () => {
    return withTransaction(async (client) => {
      const res = await client.query(
        `SELECT ctr.*, c.title AS campaign_title, u.email AS distributor_email
         FROM contracts ctr
         JOIN campaigns c ON c.id = ctr.campaign_id
         JOIN users u ON u.id = ctr.distributor_id
         ORDER BY ctr.created_at DESC
         LIMIT 500`
      );
      return { contracts: res.rows };
    });
  });

  app.patch('/admin/contracts/:id', { preHandler: [app.adminOnly] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = UpdateContractSchema.parse(request.body);
    if (!body.status && !body.distributor_id) {
      reply.code(400);
      return { error: 'missing_fields' };
    }
    const res = await withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE contracts
         SET status=COALESCE($2, status),
             distributor_id=COALESCE($3, distributor_id)
         WHERE id=$1
         RETURNING *`,
        [params.id, body.status ?? null, body.distributor_id ?? null]
      );
      return updated.rows[0];
    });
    if (!res) {
      reply.code(404);
      return { error: 'contract_not_found' };
    }
    return { contract: res };
  });

  app.get('/admin/jobs', { preHandler: [app.adminOnly] }, async (request) => {
    const query = request.query as { status?: string };
    return withTransaction(async (client) => {
      if (query?.status) {
        const res = await client.query(
          'SELECT * FROM job_queue WHERE status=$1 ORDER BY updated_at DESC LIMIT 500',
          [query.status]
        );
        return { jobs: res.rows };
      }
      const res = await client.query(
        'SELECT * FROM job_queue ORDER BY updated_at DESC LIMIT 500'
      );
      return { jobs: res.rows };
    });
  });

  app.patch('/admin/jobs/:id', { preHandler: [app.adminOnly] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = UpdateJobSchema.parse(request.body);
    const res = await withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE job_queue
         SET status=COALESCE($2, status),
             attempts=COALESCE($3, attempts),
             last_error=COALESCE($4, last_error),
             updated_at=now()
         WHERE id=$1 RETURNING *`,
        [params.id, body.status ?? null, body.attempts ?? null, body.last_error ?? null]
      );
      return updated.rows[0];
    });
    if (!res) {
      reply.code(404);
      return { error: 'job_not_found' };
    }
    return { job: res };
  });

  app.post('/admin/jobs/:id/retry', { preHandler: [app.adminOnly] }, async (request, reply) => {
    const params = request.params as { id: string };
    const res = await withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE job_queue
         SET status='QUEUED', attempts=0, last_error=NULL, run_at=now(), updated_at=now()
         WHERE id=$1 RETURNING *`,
        [params.id]
      );
      return updated.rows[0];
    });
    if (!res) {
      reply.code(404);
      return { error: 'job_not_found' };
    }
    return { job: res };
  });

  app.patch('/admin/payouts/:id', { preHandler: [app.adminOnly] }, async (request, reply) => {
    const params = request.params as { id: string };
    const body = UpdatePayoutSchema.parse(request.body);
    const res = await withTransaction(async (client) => {
      const updated = await client.query(
        'UPDATE payout_requests SET status=$2 WHERE id=$1 RETURNING *',
        [params.id, body.status]
      );
      return updated.rows[0];
    });
    if (!res) {
      reply.code(404);
      return { error: 'payout_not_found' };
    }
    return { payout: res };
  });

  app.get('/admin/pesapal/transactions', { preHandler: [app.adminOnly] }, async () => {
    return withTransaction(async (client) => {
      const res = await client.query(
        'SELECT * FROM pesapal_transactions ORDER BY created_at DESC LIMIT 500'
      );
      return { transactions: res.rows };
    });
  });

  app.get('/admin/pesapal/webhooks', { preHandler: [app.adminOnly] }, async () => {
    return withTransaction(async (client) => {
      const res = await client.query(
        'SELECT * FROM pesapal_webhook_events ORDER BY received_at DESC LIMIT 500'
      );
      return { webhooks: res.rows };
    });
  });
}
