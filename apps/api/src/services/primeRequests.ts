import { PoolClient } from 'pg';
import { v4 as uuid } from 'uuid';

export const PRIME_REQUEST_UNLOCK_PRICE_UGX = 2_000;

export const PRIME_REQUEST_ACCESS_PASS_PLANS = {
  daily: { pass_type: 'daily', label: 'Daily Access', amount_ugx: 10_000, duration_days: 1 },
  weekly: { pass_type: 'weekly', label: 'Weekly Supplier Pass', amount_ugx: 30_000, duration_days: 7 },
  monthly: { pass_type: 'monthly', label: 'Monthly Supplier Pass', amount_ugx: 50_000, duration_days: 30 },
} as const;

export type PrimeRequestPassType = keyof typeof PRIME_REQUEST_ACCESS_PASS_PLANS;

export const PRIME_REQUEST_PRICING = {
  single_unlock_ugx: PRIME_REQUEST_UNLOCK_PRICE_UGX,
  access_passes: Object.values(PRIME_REQUEST_ACCESS_PASS_PLANS),
};

const PUBLIC_STATUSES = ['approved', 'active'] as const;

let schemaEnsured = false;

export async function ensurePrimeRequestsSchema(client: PoolClient) {
  if (schemaEnsured) return;

  await client.query(`
    CREATE TABLE IF NOT EXISTS prime_requests (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      requester_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL,
      requester_name TEXT NOT NULL,
      requester_phone TEXT NOT NULL,
      requester_whatsapp TEXT NULL,
      preferred_contact_method TEXT NOT NULL DEFAULT 'PHONE',
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT NOT NULL,
      subcategory TEXT NULL,
      location TEXT NOT NULL,
      exact_location TEXT NULL,
      budget_min INTEGER NULL,
      budget_max INTEGER NULL,
      urgency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      moderation_notes TEXT NULL,
      attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
      consent_provider_contact BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NULL
    )
  `);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS requester_user_id UUID NULL REFERENCES users(id) ON DELETE SET NULL`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS requester_name TEXT`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS requester_phone TEXT`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS requester_whatsapp TEXT`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS preferred_contact_method TEXT NOT NULL DEFAULT 'PHONE'`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS title TEXT`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS description TEXT`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS category TEXT`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS subcategory TEXT`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS location TEXT`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS exact_location TEXT`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS budget_min INTEGER`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS budget_max INTEGER`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS urgency TEXT NOT NULL DEFAULT 'flexible'`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'pending'`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS moderation_notes TEXT`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS consent_provider_contact BOOLEAN NOT NULL DEFAULT false`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now()`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`);
  await client.query(`ALTER TABLE prime_requests ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS prime_request_unlocks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      request_id UUID NOT NULL REFERENCES prime_requests(id) ON DELETE CASCADE,
      unlocked_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      unlock_type TEXT NOT NULL,
      amount_paid INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'UGX',
      payment_reference TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NULL
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS prime_request_access_passes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      pass_type TEXT NOT NULL,
      amount_paid INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'UGX',
      starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      payment_reference TEXT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_prime_requests_status ON prime_requests(status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_prime_requests_category ON prime_requests(category)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_prime_requests_location ON prime_requests(location)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_prime_requests_created_at ON prime_requests(created_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_prime_requests_requester_user_id ON prime_requests(requester_user_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_prime_request_unlocks_lookup ON prime_request_unlocks(request_id, unlocked_by_user_id)`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ux_prime_request_single_unlock ON prime_request_unlocks(request_id, unlocked_by_user_id) WHERE unlock_type = 'single'`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_prime_request_access_passes_user_active ON prime_request_access_passes(user_id, status, expires_at DESC)`);

  schemaEnsured = true;
}

function asIntOrNull(value: unknown) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

export function normalizePrimeRequestStatus(value: unknown) {
  const status = String(value ?? '').trim().toLowerCase();
  if (['pending', 'approved', 'rejected', 'active', 'expired', 'fulfilled'].includes(status)) {
    return status;
  }
  return null;
}

export function normalizePrimeRequestPassType(value: unknown): PrimeRequestPassType | null {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized in PRIME_REQUEST_ACCESS_PASS_PLANS
    ? (normalized as PrimeRequestPassType)
    : null;
}

export function publicPrimeRequestDto(row: any) {
  const description = String(row.description ?? '');
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    subcategory: row.subcategory ?? null,
    location: row.location,
    budget_min: row.budget_min == null ? null : Number(row.budget_min),
    budget_max: row.budget_max == null ? null : Number(row.budget_max),
    urgency: row.urgency,
    status: row.status,
    short_description: description.length > 220 ? `${description.slice(0, 217)}...` : description,
    created_at: row.created_at,
    expires_at: row.expires_at ?? null,
    is_unlocked: row.is_unlocked === true,
    has_active_pass: row.has_active_pass === true,
  };
}

export function fullPrimeRequestDto(row: any) {
  return {
    ...publicPrimeRequestDto({ ...row, is_unlocked: true }),
    requester_name: row.requester_name,
    requester_phone: row.requester_phone,
    requester_whatsapp: row.requester_whatsapp ?? null,
    preferred_contact_method: row.preferred_contact_method,
    description: row.description,
    exact_location: row.exact_location ?? null,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    moderation_notes: row.moderation_notes ?? null,
    updated_at: row.updated_at,
  };
}

export function adminPrimeRequestDto(row: any) {
  return {
    ...fullPrimeRequestDto(row),
    requester_user_id: row.requester_user_id ?? null,
    unlock_count: Number(row.unlock_count ?? 0),
    unlock_revenue_ugx: Number(row.unlock_revenue_ugx ?? 0),
  };
}

export async function getActivePrimeRequestPass(client: PoolClient, userId: string) {
  await ensurePrimeRequestsSchema(client);
  const res = await client.query(
    `SELECT *
     FROM prime_request_access_passes
     WHERE user_id = $1
       AND status = 'active'
       AND expires_at > now()
     ORDER BY expires_at DESC
     LIMIT 1`,
    [userId]
  );
  return res.rows[0] ?? null;
}

export async function hasPrimeRequestAccess(
  client: PoolClient,
  requestId: string,
  userId: string
) {
  await ensurePrimeRequestsSchema(client);
  const res = await client.query(
    `SELECT EXISTS (
       SELECT 1 FROM prime_requests pr
       WHERE pr.id = $1 AND pr.requester_user_id = $2
     ) AS is_owner,
     EXISTS (
       SELECT 1 FROM prime_request_unlocks u
       WHERE u.request_id = $1
         AND u.unlocked_by_user_id = $2
         AND (u.expires_at IS NULL OR u.expires_at > now())
     ) AS has_unlock,
     EXISTS (
       SELECT 1 FROM prime_request_access_passes p
       WHERE p.user_id = $2
         AND p.status = 'active'
         AND p.expires_at > now()
     ) AS has_pass`,
    [requestId, userId]
  );
  const row = res.rows[0] ?? {};
  return row.is_owner === true || row.has_unlock === true || row.has_pass === true;
}

export async function loadPrimeRequest(client: PoolClient, requestId: string) {
  await ensurePrimeRequestsSchema(client);
  const res = await client.query(`SELECT * FROM prime_requests WHERE id=$1 LIMIT 1`, [requestId]);
  return res.rows[0] ?? null;
}

export async function insertPrimeRequestUnlock(
  client: PoolClient,
  input: {
    requestId: string;
    userId: string;
    amountPaid?: number;
    paymentReference?: string | null;
  }
) {
  await ensurePrimeRequestsSchema(client);
  const id = uuid();
  const res = await client.query(
    `INSERT INTO prime_request_unlocks
       (id, request_id, unlocked_by_user_id, unlock_type, amount_paid, currency, payment_reference)
     VALUES ($1, $2, $3, 'single', $4, 'UGX', $5)
     ON CONFLICT (request_id, unlocked_by_user_id) WHERE unlock_type = 'single'
     DO UPDATE SET payment_reference = COALESCE(prime_request_unlocks.payment_reference, EXCLUDED.payment_reference)
     RETURNING *`,
    [
      id,
      input.requestId,
      input.userId,
      Math.max(0, Math.round(input.amountPaid ?? PRIME_REQUEST_UNLOCK_PRICE_UGX)),
      input.paymentReference ?? null,
    ]
  );
  return res.rows[0] ?? null;
}

export async function insertPrimeRequestAccessPass(
  client: PoolClient,
  input: {
    userId: string;
    passType: PrimeRequestPassType;
    amountPaid?: number;
    paymentReference?: string | null;
  }
) {
  await ensurePrimeRequestsSchema(client);
  const plan = PRIME_REQUEST_ACCESS_PASS_PLANS[input.passType];
  const id = uuid();
  const res = await client.query(
    `INSERT INTO prime_request_access_passes
       (id, user_id, pass_type, amount_paid, currency, starts_at, expires_at, status, payment_reference)
     VALUES ($1, $2, $3, $4, 'UGX', now(), now() + ($5::text || ' days')::interval, 'active', $6)
     RETURNING *`,
    [
      id,
      input.userId,
      input.passType,
      Math.max(0, Math.round(input.amountPaid ?? plan.amount_ugx)),
      plan.duration_days,
      input.paymentReference ?? null,
    ]
  );
  return res.rows[0] ?? null;
}

export async function ensureWalletForPrimeRequestUser(client: PoolClient, userId: string) {
  const existing = await client.query(`SELECT * FROM wallets WHERE user_id=$1 LIMIT 1`, [userId]);
  if (existing.rows[0]) return existing.rows[0];
  const inserted = await client.query(
    `INSERT INTO wallets (user_id, currency, balance, balance_available, balance_escrow)
     VALUES ($1, 'UGX', 0, 0, 0)
     RETURNING *`,
    [userId]
  );
  return inserted.rows[0];
}

export async function debitPrimeRequestWallet(
  client: PoolClient,
  input: {
    userId: string;
    amount: number;
    reference: string;
  }
) {
  const wallet = await ensureWalletForPrimeRequestUser(client, input.userId);
  const locked = await client.query(`SELECT * FROM wallets WHERE id=$1 FOR UPDATE`, [wallet.id]);
  const lockedWallet = locked.rows[0];
  const balance = Number(lockedWallet?.balance_available ?? 0);
  if (!lockedWallet || balance < input.amount) {
    return { error: 'insufficient_wallet_balance' } as const;
  }
  await client.query(
    `UPDATE wallets
     SET balance_available = balance_available - $2,
         balance = GREATEST(balance - $2, 0)
     WHERE id = $1`,
    [wallet.id, input.amount]
  );
  await client.query(
    `INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
     VALUES ($1, $2, 'DEBIT', $3)`,
    [wallet.id, input.amount, input.reference]
  );
  return { ok: true, wallet_id: wallet.id } as const;
}

export function normalizePrimeRequestCreateInput(body: any) {
  return {
    requester_name: String(body.requester_name ?? body.name ?? '').trim(),
    requester_phone: String(body.requester_phone ?? body.phone ?? '').trim(),
    requester_whatsapp: String(body.requester_whatsapp ?? body.whatsapp ?? '').trim() || null,
    preferred_contact_method: String(body.preferred_contact_method ?? 'PHONE').trim().toUpperCase(),
    title: String(body.title ?? '').trim(),
    description: String(body.description ?? '').trim(),
    category: String(body.category ?? '').trim(),
    subcategory: String(body.subcategory ?? '').trim() || null,
    location: String(body.location ?? '').trim(),
    exact_location: String(body.exact_location ?? '').trim() || null,
    budget_min: asIntOrNull(body.budget_min),
    budget_max: asIntOrNull(body.budget_max),
    urgency: String(body.urgency ?? '').trim(),
    attachments: Array.isArray(body.attachments) ? body.attachments : [],
    consent_provider_contact: body.consent_provider_contact === true || body.consent === true,
  };
}

export function validatePrimeRequestCreateInput(input: ReturnType<typeof normalizePrimeRequestCreateInput>) {
  const issues: Array<{ path: string[]; message: string }> = [];
  if (input.title.length < 5 || input.title.length > 160) issues.push({ path: ['title'], message: 'Title must be 5-160 characters.' });
  if (input.description.length < 20 || input.description.length > 5000) issues.push({ path: ['description'], message: 'Description must be 20-5000 characters.' });
  if (input.category.length < 2 || input.category.length > 80) issues.push({ path: ['category'], message: 'Category is required.' });
  if (input.location.length < 2 || input.location.length > 160) issues.push({ path: ['location'], message: 'Location is required.' });
  if (input.urgency.length < 2 || input.urgency.length > 80) issues.push({ path: ['urgency'], message: 'Urgency is required.' });
  if (input.requester_name.length < 2 || input.requester_name.length > 120) issues.push({ path: ['requester_name'], message: 'Name is required.' });
  if (input.requester_phone.length < 7 || input.requester_phone.length > 30) issues.push({ path: ['requester_phone'], message: 'Enter a valid phone number.' });
  if (input.requester_whatsapp && input.requester_whatsapp.length > 30) issues.push({ path: ['requester_whatsapp'], message: 'Enter a valid WhatsApp number.' });
  if (!input.consent_provider_contact) issues.push({ path: ['consent_provider_contact'], message: 'Consent is required.' });
  if (input.budget_min != null && input.budget_min < 0) issues.push({ path: ['budget_min'], message: 'Budget minimum cannot be negative.' });
  if (input.budget_max != null && input.budget_max < 0) issues.push({ path: ['budget_max'], message: 'Budget maximum cannot be negative.' });
  if (input.budget_min != null && input.budget_max != null && input.budget_min > input.budget_max) {
    issues.push({ path: ['budget_max'], message: 'Budget maximum must be at least the minimum.' });
  }
  return issues;
}

export async function expireOldPrimeRequests(client: PoolClient) {
  await ensurePrimeRequestsSchema(client);
  await client.query(
    `UPDATE prime_requests
     SET status='expired', updated_at=now()
     WHERE expires_at IS NOT NULL
       AND expires_at <= now()
       AND status IN ('approved', 'active')`
  );
  await client.query(
    `UPDATE prime_request_access_passes
     SET status='expired', updated_at=now()
     WHERE status='active' AND expires_at <= now()`
  );
}

export const PRIME_REQUEST_PUBLIC_STATUS_SQL = PUBLIC_STATUSES.map((status) => `'${status}'`).join(',');
