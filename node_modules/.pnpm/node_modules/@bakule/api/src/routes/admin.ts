import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withTransaction } from '../db.js';
import { hashPassword } from '../services/auth.js';
import { config } from '../config.js';
import { PaymentRepo } from '../repositories/paymentRepo.js';
import { getTransactionStatus } from '../services/pesapal.js';

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
  last_error: z.string().optional().nullable(),
  retry_reason: z.string().optional().nullable()
});

const AdminAccessSchema = z.object({
  phrase: z.string().min(6)
});

const AuditQuerySchema = z.object({
  q: z.string().optional(),
  action: z.string().optional(),
  target_type: z.string().optional(),
  actor_id: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.string().optional(),
  offset: z.string().optional()
});

function parsePaging(query: any) {
  const limitRaw = Number(query?.limit ?? 50);
  const offsetRaw = Number(query?.offset ?? 0);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
  return { limit, offset };
}

function parseDateRange(from?: string, to?: string) {
  const start = from ? new Date(from) : null;
  const end = to ? new Date(to) : null;
  return {
    from: start && !isNaN(start.getTime()) ? start.toISOString() : null,
    to: end && !isNaN(end.getTime()) ? end.toISOString() : null
  };
}

async function logAudit(
  client: any,
  actorId: string,
  action: string,
  targetType: string,
  targetId: string | null,
  meta: any
) {
  await client.query(
    `INSERT INTO admin_audit_logs (actor_id, action, target_type, target_id, meta)
     VALUES ($1,$2,$3,$4,$5)`,
    [actorId || null, action, targetType, targetId, meta ?? null]
  );
}

export async function adminRoutes(app: FastifyInstance) {
  const paymentRepo = new PaymentRepo();

  app.post('/admin/access', async (request, reply) => {
    const body = AdminAccessSchema.parse(request.body);
    if (!config.adminAccessPhrase || body.phrase !== config.adminAccessPhrase) {
      reply.code(401);
      return { error: 'invalid_phrase' };
    }

    const token = app.jwt.sign({
      sub: 'ariaka-access',
      role: 'ADMIN'
    });

    return {
      token,
      user: {
        id: 'ariaka-access',
        email: 'ariaka-access@local',
        role: 'ADMIN'
      }
    };
  });

  app.get('/admin/audit', { preHandler: [app.adminOnly] }, async (request) => {
    const query = AuditQuerySchema.parse(request.query ?? {});
    const { limit, offset } = parsePaging(query);
    const range = parseDateRange(query.from, query.to);
    return withTransaction(async (client) => {
      const conditions: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (query.q) {
        conditions.push(`(action ILIKE $${idx} OR target_type ILIKE $${idx} OR target_id::text ILIKE $${idx})`);
        params.push(`%${query.q}%`);
        idx++;
      }
      if (query.action) {
        conditions.push(`action = $${idx}`);
        params.push(query.action);
        idx++;
      }
      if (query.target_type) {
        conditions.push(`target_type = $${idx}`);
        params.push(query.target_type);
        idx++;
      }
      if (query.actor_id) {
        conditions.push(`actor_id = $${idx}`);
        params.push(query.actor_id);
        idx++;
      }
      if (range.from) {
        conditions.push(`created_at >= $${idx}`);
        params.push(range.from);
        idx++;
      }
      if (range.to) {
        conditions.push(`created_at <= $${idx}`);
        params.push(range.to);
        idx++;
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const list = await client.query(
        `SELECT * FROM admin_audit_logs ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      );
      return { logs: list.rows };
    });
  });

  app.get('/admin/finance', { preHandler: [app.adminOnly] }, async (request) => {
    const query = request.query as any;
    const { limit, offset } = parsePaging(query);
    const range = parseDateRange(query?.from, query?.to);
    const groupByRaw = (query?.group_by ?? '').toString().toLowerCase();
    const groupBy = groupByRaw === 'day' || groupByRaw === 'month' ? groupByRaw : null;
    return withTransaction(async (client) => {
      const conditions: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (query?.q) {
        conditions.push(`(source_id::text ILIKE $${idx} OR reference ILIKE $${idx})`);
        params.push(`%${query.q}%`);
        idx++;
      }
      if (query?.type) {
        conditions.push(`source_type = $${idx}`);
        params.push(query.type);
        idx++;
      }
      if (query?.status) {
        conditions.push(`status = $${idx}`);
        params.push(query.status);
        idx++;
      }
      if (query?.min_amount) {
        conditions.push(`amount >= $${idx}`);
        params.push(Number(query.min_amount));
        idx++;
      }
      if (query?.max_amount) {
        conditions.push(`amount <= $${idx}`);
        params.push(Number(query.max_amount));
        idx++;
      }
      if (range.from) {
        conditions.push(`created_at >= $${idx}`);
        params.push(range.from);
        idx++;
      }
      if (range.to) {
        conditions.push(`created_at <= $${idx}`);
        params.push(range.to);
        idx++;
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const rows = await client.query(
        `
        WITH combined AS (
          SELECT
            p.id AS source_id,
            'PAYOUT'::text AS source_type,
            p.status::text AS status,
            p.amount::int AS amount,
            p.pesapal_reference::text AS reference,
            p.user_id::text AS user_id,
            p.created_at AS created_at
          FROM payout_requests p
          UNION ALL
          SELECT
            t.id AS source_id,
            t.type::text AS source_type,
            t.status::text AS status,
            t.amount::int AS amount,
            t.merchant_reference::text AS reference,
            NULL::text AS user_id,
            t.created_at AS created_at
          FROM pesapal_transactions t
        )
        SELECT *
        FROM combined
        ${where}
        ORDER BY created_at DESC
        LIMIT $${idx} OFFSET $${idx + 1}
        `,
        [...params, limit, offset]
      );

      const summary = await client.query(
        `
        WITH combined AS (
          SELECT
            'PAYOUT'::text AS source_type,
            p.status::text AS status,
            p.amount::int AS amount,
            p.pesapal_reference::text AS reference,
            p.id AS source_id,
            p.created_at AS created_at
          FROM payout_requests p
          UNION ALL
          SELECT
            t.type::text AS source_type,
            t.status::text AS status,
            t.amount::int AS amount,
            t.merchant_reference::text AS reference,
            t.id AS source_id,
            t.created_at AS created_at
          FROM pesapal_transactions t
        ),
        filtered AS (
          SELECT *
          FROM combined
          ${where}
        )
        SELECT
          COALESCE(SUM(amount), 0)::bigint AS total_amount,
          COALESCE(SUM(CASE WHEN source_type = 'PAYOUT' THEN amount ELSE 0 END), 0)::bigint AS payout_amount,
          COALESCE(SUM(CASE WHEN source_type <> 'PAYOUT' THEN amount ELSE 0 END), 0)::bigint AS pesapal_amount
        FROM filtered
        `,
        params
      );

      let series: any[] = [];
      if (groupBy) {
        const seriesRes = await client.query(
          `
          WITH combined AS (
            SELECT
              'PAYOUT'::text AS source_type,
              p.status::text AS status,
              p.amount::int AS amount,
              p.pesapal_reference::text AS reference,
              p.id AS source_id,
              p.created_at AS created_at
            FROM payout_requests p
            UNION ALL
            SELECT
              t.type::text AS source_type,
              t.status::text AS status,
              t.amount::int AS amount,
              t.merchant_reference::text AS reference,
              t.id AS source_id,
              t.created_at AS created_at
            FROM pesapal_transactions t
          ),
          filtered AS (
            SELECT *
            FROM combined
            ${where}
          )
          SELECT
            date_trunc('${groupBy}', created_at) AS bucket,
            COALESCE(SUM(amount), 0)::bigint AS total_amount,
            COALESCE(SUM(CASE WHEN source_type = 'PAYOUT' THEN amount ELSE 0 END), 0)::bigint AS payout_amount,
            COALESCE(SUM(CASE WHEN source_type <> 'PAYOUT' THEN amount ELSE 0 END), 0)::bigint AS pesapal_amount,
            ROUND(COALESCE(SUM(CASE WHEN source_type = 'PAYOUT' THEN amount ELSE 0 END), 0) * 0.15)::bigint AS platform_fee
          FROM filtered
          GROUP BY bucket
          ORDER BY bucket DESC
          LIMIT 366
          `,
          params
        );
        series = seriesRes.rows;
      }

      const totals = summary.rows[0] ?? {};
      const payoutAmount = Number(totals.payout_amount ?? 0);
      const platformFee = Math.round(payoutAmount * 0.15);
      return {
        summary: {
          total_amount: Number(totals.total_amount ?? 0),
          payout_amount: payoutAmount,
          pesapal_amount: Number(totals.pesapal_amount ?? 0),
          platform_fee: platformFee
        },
        rows: rows.rows,
        series
      };
    });
  });

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

  app.get('/admin/users', { preHandler: [app.adminOnly] }, async (request) => {
    const query = request.query as any;
    const { limit, offset } = parsePaging(query);
    const range = parseDateRange(query?.from, query?.to);
    return withTransaction(async (client) => {
      const conditions: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (query?.q) {
        conditions.push(`(email ILIKE $${idx} OR phone ILIKE $${idx} OR id::text ILIKE $${idx})`);
        params.push(`%${query.q}%`);
        idx++;
      }
      if (query?.role) {
        conditions.push(`role = $${idx}`);
        params.push(query.role);
        idx++;
      }
      if (query?.status) {
        conditions.push(`status = $${idx}`);
        params.push(query.status);
        idx++;
      }
      if (range.from) {
        conditions.push(`created_at >= $${idx}`);
        params.push(range.from);
        idx++;
      }
      if (range.to) {
        conditions.push(`created_at <= $${idx}`);
        params.push(range.to);
        idx++;
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const res = await client.query(
        `SELECT * FROM users ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      );
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
      if (res.rows[0]) {
        await logAudit(
          client,
          (request.user as any).sub,
          'UPDATE_USER_ROLE',
          'user',
          params.id,
          { role: body.role }
        );
      }
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
      if (res.rows[0]) {
        await logAudit(
          client,
          (request.user as any).sub,
          'UPDATE_USER_STATUS',
          'user',
          params.id,
          { status: body.status }
        );
      }
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
      if (res.rows[0]) {
        await logAudit(
          client,
          (request.user as any).sub,
          'RESET_USER_PASSWORD',
          'user',
          params.id,
          {}
        );
      }
      return res.rows[0];
    });
    if (!result) {
      reply.code(404);
      return { error: 'user_not_found' };
    }
    return { user: result };
  });

  app.get('/admin/campaigns', { preHandler: [app.adminOnly] }, async (request) => {
    const query = request.query as any;
    const { limit, offset } = parsePaging(query);
    const range = parseDateRange(query?.from, query?.to);
    return withTransaction(async (client) => {
      const conditions: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (query?.q) {
        conditions.push(`(title ILIKE $${idx} OR id::text ILIKE $${idx})`);
        params.push(`%${query.q}%`);
        idx++;
      }
      if (query?.status) {
        conditions.push(`status = $${idx}`);
        params.push(query.status);
        idx++;
      }
      if (query?.platform) {
        conditions.push(`platform = $${idx}`);
        params.push(query.platform);
        idx++;
      }
      if (query?.min_amount) {
        conditions.push(`budget_total >= $${idx}`);
        params.push(Number(query.min_amount));
        idx++;
      }
      if (query?.max_amount) {
        conditions.push(`budget_total <= $${idx}`);
        params.push(Number(query.max_amount));
        idx++;
      }
      if (range.from) {
        conditions.push(`created_at >= $${idx}`);
        params.push(range.from);
        idx++;
      }
      if (range.to) {
        conditions.push(`created_at <= $${idx}`);
        params.push(range.to);
        idx++;
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const res = await client.query(
        `SELECT * FROM campaigns ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      );
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
      if (updated.rows[0]) {
        await logAudit(
          client,
          (request.user as any).sub,
          'UPDATE_CAMPAIGN',
          'campaign',
          params.id,
          body
        );
      }
      return updated.rows[0];
    });
    if (!res) {
      reply.code(404);
      return { error: 'campaign_not_found' };
    }
    return { campaign: res };
  });

  app.get('/admin/proofs', { preHandler: [app.adminOnly] }, async (request) => {
    const query = request.query as any;
    const { limit, offset } = parsePaging(query);
    const range = parseDateRange(query?.from, query?.to);
    return withTransaction(async (client) => {
      const conditions: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (query?.q) {
        conditions.push(`(p.id::text ILIKE $${idx} OR c.title ILIKE $${idx})`);
        params.push(`%${query.q}%`);
        idx++;
      }
      if (query?.status) {
        conditions.push(`p.status = $${idx}`);
        params.push(query.status);
        idx++;
      }
      if (query?.decision) {
        conditions.push(`p.decision = $${idx}`);
        params.push(query.decision);
        idx++;
      }
      if (range.from) {
        conditions.push(`p.created_at >= $${idx}`);
        params.push(range.from);
        idx++;
      }
      if (range.to) {
        conditions.push(`p.created_at <= $${idx}`);
        params.push(range.to);
        idx++;
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const res = await client.query(
        `SELECT p.*, c.title AS campaign_title
         FROM proofs p
         JOIN verification_sessions s ON s.id = p.session_id
         JOIN campaigns c ON c.id = s.campaign_id
         ${where}
         ORDER BY p.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
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
      if (updated.rows[0]) {
        await logAudit(
          client,
          (request.user as any).sub,
          'UPDATE_PROOF',
          'proof',
          params.id,
          body
        );
      }
      return updated.rows[0];
    });
    if (!res) {
      reply.code(404);
      return { error: 'proof_not_found' };
    }
    return { proof: res };
  });

  app.get('/admin/wallets', { preHandler: [app.adminOnly] }, async (request) => {
    const query = request.query as any;
    const { limit, offset } = parsePaging(query);
    const range = parseDateRange(query?.from, query?.to);
    return withTransaction(async (client) => {
      const conditions: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (query?.q) {
        conditions.push(`(id::text ILIKE $${idx} OR user_id::text ILIKE $${idx})`);
        params.push(`%${query.q}%`);
        idx++;
      }
      if (query?.min_amount) {
        conditions.push(`balance >= $${idx}`);
        params.push(Number(query.min_amount));
        idx++;
      }
      if (query?.max_amount) {
        conditions.push(`balance <= $${idx}`);
        params.push(Number(query.max_amount));
        idx++;
      }
      if (range.from) {
        conditions.push(`created_at >= $${idx}`);
        params.push(range.from);
        idx++;
      }
      if (range.to) {
        conditions.push(`created_at <= $${idx}`);
        params.push(range.to);
        idx++;
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const res = await client.query(
        `SELECT * FROM wallets ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      );
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
      await logAudit(
        client,
        (request.user as any).sub,
        'ADJUST_WALLET',
        'wallet',
        params.id,
        { amount: body.amount, direction: body.direction, reference: body.reference }
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

  app.get('/admin/escrows', { preHandler: [app.adminOnly] }, async (request) => {
    const query = request.query as any;
    const { limit, offset } = parsePaging(query);
    const range = parseDateRange(query?.from, query?.to);
    return withTransaction(async (client) => {
      const conditions: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (query?.q) {
        conditions.push(`(c.title ILIKE $${idx} OR e.id::text ILIKE $${idx})`);
        params.push(`%${query.q}%`);
        idx++;
      }
      if (query?.status) {
        conditions.push(`e.status = $${idx}`);
        params.push(query.status);
        idx++;
      }
      if (query?.min_amount) {
        conditions.push(`e.amount_total >= $${idx}`);
        params.push(Number(query.min_amount));
        idx++;
      }
      if (query?.max_amount) {
        conditions.push(`e.amount_total <= $${idx}`);
        params.push(Number(query.max_amount));
        idx++;
      }
      if (range.from) {
        conditions.push(`e.created_at >= $${idx}`);
        params.push(range.from);
        idx++;
      }
      if (range.to) {
        conditions.push(`e.created_at <= $${idx}`);
        params.push(range.to);
        idx++;
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const res = await client.query(
        `SELECT e.*, c.title AS campaign_title
         FROM escrow_ledger e
         JOIN campaigns c ON c.id = e.campaign_id
         ${where}
         ORDER BY e.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
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
      if (updated.rows[0]) {
        await logAudit(
          client,
          (request.user as any).sub,
          'UPDATE_ESCROW',
          'escrow',
          params.id,
          { status: body.status }
        );
      }
      return updated.rows[0];
    });
    if (!res) {
      reply.code(404);
      return { error: 'escrow_not_found' };
    }
    return { escrow: res };
  });

  app.get('/admin/payouts', { preHandler: [app.adminOnly] }, async (request) => {
    const query = request.query as any;
    const { limit, offset } = parsePaging(query);
    const range = parseDateRange(query?.from, query?.to);
    return withTransaction(async (client) => {
      const conditions: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (query?.q) {
        conditions.push(`(p.id::text ILIKE $${idx} OR u.email ILIKE $${idx})`);
        params.push(`%${query.q}%`);
        idx++;
      }
      if (query?.status) {
        conditions.push(`p.status = $${idx}`);
        params.push(query.status);
        idx++;
      }
      if (query?.min_amount) {
        conditions.push(`p.amount >= $${idx}`);
        params.push(Number(query.min_amount));
        idx++;
      }
      if (query?.max_amount) {
        conditions.push(`p.amount <= $${idx}`);
        params.push(Number(query.max_amount));
        idx++;
      }
      if (range.from) {
        conditions.push(`p.created_at >= $${idx}`);
        params.push(range.from);
        idx++;
      }
      if (range.to) {
        conditions.push(`p.created_at <= $${idx}`);
        params.push(range.to);
        idx++;
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const res = await client.query(
        `SELECT p.*, u.email AS user_email
         FROM payout_requests p
         JOIN users u ON u.id = p.user_id
         ${where}
         ORDER BY p.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      );
      return { payouts: res.rows };
    });
  });

  app.get('/admin/contracts', { preHandler: [app.adminOnly] }, async (request) => {
    const query = request.query as any;
    const { limit, offset } = parsePaging(query);
    const range = parseDateRange(query?.from, query?.to);
    return withTransaction(async (client) => {
      const conditions: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (query?.q) {
        conditions.push(`(c.title ILIKE $${idx} OR u.email ILIKE $${idx} OR ctr.id::text ILIKE $${idx})`);
        params.push(`%${query.q}%`);
        idx++;
      }
      if (query?.status) {
        conditions.push(`ctr.status = $${idx}`);
        params.push(query.status);
        idx++;
      }
      if (range.from) {
        conditions.push(`ctr.created_at >= $${idx}`);
        params.push(range.from);
        idx++;
      }
      if (range.to) {
        conditions.push(`ctr.created_at <= $${idx}`);
        params.push(range.to);
        idx++;
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const res = await client.query(
        `SELECT ctr.*, c.title AS campaign_title, u.email AS distributor_email
         FROM contracts ctr
         JOIN campaigns c ON c.id = ctr.campaign_id
         JOIN users u ON u.id = ctr.distributor_id
         ${where}
         ORDER BY ctr.created_at DESC
         LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
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
      if (updated.rows[0]) {
        await logAudit(
          client,
          (request.user as any).sub,
          'UPDATE_CONTRACT',
          'contract',
          params.id,
          body
        );
      }
      return updated.rows[0];
    });
    if (!res) {
      reply.code(404);
      return { error: 'contract_not_found' };
    }
    return { contract: res };
  });

  app.get('/admin/jobs', { preHandler: [app.adminOnly] }, async (request) => {
    const query = request.query as any;
    const { limit, offset } = parsePaging(query);
    return withTransaction(async (client) => {
      const conditions: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (query?.status) {
        conditions.push(`status = $${idx}`);
        params.push(query.status);
        idx++;
      }
      if (query?.q) {
        conditions.push(`(job_type ILIKE $${idx} OR id::text ILIKE $${idx})`);
        params.push(`%${query.q}%`);
        idx++;
      }
      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const res = await client.query(
        `SELECT * FROM job_queue ${where} ORDER BY updated_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
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
             retry_reason=COALESCE($5, retry_reason),
             updated_at=now()
         WHERE id=$1 RETURNING *`,
        [params.id, body.status ?? null, body.attempts ?? null, body.last_error ?? null, body.retry_reason ?? null]
      );
      if (updated.rows[0]) {
        await logAudit(
          client,
          (request.user as any).sub,
          'UPDATE_JOB',
          'job',
          params.id,
          body
        );
      }
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
    const body = (request.body ?? {}) as { reason?: string };
    const res = await withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE job_queue
         SET status='QUEUED',
             attempts=0,
             retry_reason=COALESCE($2, retry_reason),
             run_at=now(),
             updated_at=now()
         WHERE id=$1 RETURNING *`,
        [params.id, body.reason ?? null]
      );
      if (updated.rows[0]) {
        await logAudit(
          client,
          (request.user as any).sub,
          'RETRY_JOB',
          'job',
          params.id,
          { reason: body.reason ?? null }
        );
      }
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
      if (updated.rows[0]) {
        await logAudit(
          client,
          (request.user as any).sub,
          'UPDATE_PAYOUT',
          'payout',
          params.id,
          { status: body.status }
        );
      }
      return updated.rows[0];
    });
    if (!res) {
      reply.code(404);
      return { error: 'payout_not_found' };
    }
    return { payout: res };
  });

  app.get('/admin/pesapal/transactions', { preHandler: [app.adminOnly] }, async (request) => {
    const query = request.query as any;
    const { limit, offset } = parsePaging(query);
    const range = parseDateRange(query?.from, query?.to);
    return withTransaction(async (client) => {
      const conditions: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (query?.q) {
        conditions.push(`(merchant_reference ILIKE $${idx} OR id::text ILIKE $${idx})`);
        params.push(`%${query.q}%`);
        idx++;
      }
      if (query?.status) {
        conditions.push(`status = $${idx}`);
        params.push(query.status);
        idx++;
      }
      if (query?.type) {
        conditions.push(`type = $${idx}`);
        params.push(query.type);
        idx++;
      }
      if (query?.min_amount) {
        conditions.push(`amount >= $${idx}`);
        params.push(Number(query.min_amount));
        idx++;
      }
      if (query?.max_amount) {
        conditions.push(`amount <= $${idx}`);
        params.push(Number(query.max_amount));
        idx++;
      }
      if (range.from) {
        conditions.push(`created_at >= $${idx}`);
        params.push(range.from);
        idx++;
      }
      if (range.to) {
        conditions.push(`created_at <= $${idx}`);
        params.push(range.to);
        idx++;
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const res = await client.query(
        `SELECT * FROM pesapal_transactions ${where} ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      );
      return { transactions: res.rows };
    });
  });

  app.get('/admin/pesapal/webhooks', { preHandler: [app.adminOnly] }, async (request) => {
    const query = request.query as any;
    const { limit, offset } = parsePaging(query);
    const range = parseDateRange(query?.from, query?.to);
    return withTransaction(async (client) => {
      const conditions: string[] = [];
      const params: any[] = [];
      let idx = 1;

      if (query?.q) {
        conditions.push(`(event_id ILIKE $${idx})`);
        params.push(`%${query.q}%`);
        idx++;
      }
      if (range.from) {
        conditions.push(`received_at >= $${idx}`);
        params.push(range.from);
        idx++;
      }
      if (range.to) {
        conditions.push(`received_at <= $${idx}`);
        params.push(range.to);
        idx++;
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const res = await client.query(
        `SELECT * FROM pesapal_webhook_events ${where} ORDER BY received_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset]
      );
      return { webhooks: res.rows };
    });
  });

  app.post('/admin/pesapal/webhooks/:eventId/replay', { preHandler: [app.adminOnly] }, async (request, reply) => {
    const params = request.params as { eventId: string };
    return withTransaction(async (client) => {
      const res = await client.query(
        'SELECT * FROM pesapal_webhook_events WHERE event_id=$1',
        [params.eventId]
      );
      const event = res.rows[0];
      if (!event) {
        reply.code(404);
        return { error: 'event_not_found' };
      }

      const body = event.payload ?? {};
      const reference =
        body.reference ?? body.merchant_reference ?? body.OrderMerchantReference ?? body.merchantReference;
      const trackingId =
        body.OrderTrackingId ?? body.orderTrackingId ?? body.id ?? body.event_id ?? body.tracking_id;
      const statusRaw = (body.status ?? body.payment_status_description ?? '').toString().toUpperCase();

      // Heuristic: payout webhooks usually have status + reference
      const isPayout = Boolean(body.status || body.tracking_id || body.merchant_reference);

      if (isPayout && reference) {
        const payoutRows = await client.query(
          'SELECT * FROM payout_requests WHERE pesapal_reference=$1',
          [reference]
        );
        const payout = payoutRows.rows[0];
        if (!payout) {
          reply.code(404);
          return { error: 'payout_not_found' };
        }

        if (statusRaw.includes('PAID') || statusRaw.includes('COMPLETED') || statusRaw.includes('SUCCESS')) {
          await paymentRepo.updatePayoutStatus(client, payout.id, 'PAID', reference);
        } else if (statusRaw.includes('FAILED')) {
          await paymentRepo.updatePayoutStatus(client, payout.id, 'FAILED', reference);
        }

        await logAudit(
          client,
          (request.user as any).sub,
          'REPLAY_WEBHOOK_PAYOUT',
          'payout',
          payout.id,
          { event_id: params.eventId }
        );

        return { ok: true, type: 'PAYOUT' };
      }

      if (trackingId && reference) {
        const statusInfo = (await getTransactionStatus(String(trackingId), String(reference))) as Record<string, unknown>;
        const txnRows = await client.query(
          'SELECT * FROM pesapal_transactions WHERE merchant_reference=$1',
          [reference]
        );
        const txn = txnRows.rows[0];
        if (!txn) {
          reply.code(404);
          return { error: 'txn_not_found' };
        }

        const amountRaw = (statusInfo as any).amount ?? (statusInfo as any).Amount;
        const amount = typeof amountRaw === 'string' ? parseInt(amountRaw, 10) : Number(amountRaw ?? 0);
        const escrowRows = await client.query('SELECT * FROM escrow_ledger WHERE id=$1', [txn.escrow_id]);
        const escrow = escrowRows.rows[0];
        if (!escrow || amount !== escrow.amount_total) {
          reply.code(400);
          return { error: 'amount_mismatch' };
        }

        const statusText = ((statusInfo as any).payment_status_description ?? (statusInfo as any).status ?? '')
          .toString()
          .toUpperCase();
        if (statusText.includes('COMPLETED') || statusText.includes('SUCCESS')) {
          await paymentRepo.updatePesaPalTxnStatus(client, reference, 'COMPLETED', String(trackingId));
          await paymentRepo.markEscrowFunded(client, escrow.id, txn.id);
        } else if (statusText.includes('FAILED')) {
          await paymentRepo.updatePesaPalTxnStatus(client, reference, 'FAILED', String(trackingId));
        }

        await logAudit(
          client,
          (request.user as any).sub,
          'REPLAY_WEBHOOK_IPN',
          'escrow',
          escrow.id,
          { event_id: params.eventId }
        );

        return { ok: true, type: 'IPN' };
      }

      reply.code(400);
      return { error: 'unhandled_payload' };
    });
  });
}
