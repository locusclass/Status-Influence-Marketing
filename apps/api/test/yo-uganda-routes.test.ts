import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildAuthClaims } from '../src/services/roles.js';
import { applySchema, getTestPool } from './db.js';

const yoMocks = vi.hoisted(() => ({
  getTransactionStatus: vi.fn(),
  initiateMobileMoneyCollection: vi.fn(),
  requestPayout: vi.fn(),
  verifyTransaction: vi.fn(),
}));

vi.mock('../src/services/yoUganda.js', () => ({
  getTransactionStatus: yoMocks.getTransactionStatus,
  initiateMobileMoneyCollection: yoMocks.initiateMobileMoneyCollection,
  requestPayout: yoMocks.requestPayout,
  verifyTransaction: yoMocks.verifyTransaction,
}));

const pool = getTestPool();
let app: any;

async function resetDatabase() {
  if (!pool) return;
  await pool.query(`
    TRUNCATE TABLE
      proofs,
      verification_sessions,
      payouts,
      payout_requests,
      earnings_ledger,
      pesapal_webhook_events,
      pesapal_transactions,
      wallet_withdrawals,
      escrow_ledger,
      contracts,
      campaigns,
      wallet_txns,
      wallets,
      division_admins,
      country_admins,
      divisions,
      users,
      countries
    CASCADE
  `);
  await applySchema(pool);
}

function buildYoResponse(input: {
  transactionReference: string;
  transactionStatus: string;
  amount: number;
  currency?: string;
  merchantReference?: string;
}) {
  return {
    status:
      input.transactionStatus === 'FAILED' || input.transactionStatus === 'ERROR'
        ? 'ERROR'
        : 'OK',
    statusCode: 0,
    statusMessage: null,
    errorMessage: null,
    transactionStatus: input.transactionStatus,
    transactionReference: input.transactionReference,
    raw: {},
    TransactionStatus: input.transactionStatus,
    TransactionReference: input.transactionReference,
    Amount: String(input.amount),
    CurrencyCode: input.currency ?? 'UGX',
    InternalReference: input.merchantReference ?? null,
    ExternalReference: input.merchantReference ?? null,
  };
}

async function insertAdvertiser(label: string) {
  const result = await pool!.query(
    `
    INSERT INTO users (
      full_name,
      email,
      phone,
      password_hash,
      role,
      status,
      country
    )
    VALUES ($1, $2, $3, 'x', 'ADVERTISER', 'ACTIVE', 'UG')
    RETURNING *
    `,
    [
      `${label} Advertiser`,
      `${label}-${randomUUID()}@example.com`,
      `+25670${Date.now().toString().slice(-7)}`,
    ]
  );
  return result.rows[0];
}

async function createCampaignFundingTransaction(options?: {
  advertiserId?: string;
  amount?: number;
  merchantReference?: string;
  transactionReference?: string | null;
  rawPayload?: Record<string, unknown>;
}) {
  const advertiserId = options?.advertiserId ?? (await insertAdvertiser('tx-owner')).id;
  const amount = options?.amount ?? 1000;
  const merchantReference = options?.merchantReference ?? `yo-${randomUUID()}`;
  const advertiserRes = await pool!.query('SELECT * FROM users WHERE id=$1 LIMIT 1', [advertiserId]);
  const advertiser = advertiserRes.rows[0];
  const campaign = await pool!.query(
    `
    INSERT INTO campaigns (
      advertiser_id,
      title,
      platform,
      payout_amount,
      budget_total,
      media_type,
      start_date,
      end_date,
      visibility,
      execution_mode
    )
    VALUES (
      $1,
      'YO funding test',
      'WHATSAPP_STATUS',
      100,
      $2,
      'IMAGE',
      '2026-01-01',
      '2026-12-31',
      'PRIVATE',
      'PRIVATE_CONTRACT'
    )
    RETURNING *
    `,
    [advertiserId, amount]
  );
  const escrow = await pool!.query(
    `
    INSERT INTO escrow_ledger (campaign_id, amount_total, amount_available, status)
    VALUES ($1, $2, $2, 'PENDING')
    RETURNING *
    `,
    [campaign.rows[0].id, amount]
  );
  const rawPayload = {
    kind: 'CAMPAIGN_FUNDING',
    campaign_id: campaign.rows[0].id,
    country: 'UG',
    payment_currency: 'UGX',
    supported_payment_methods: ['MOBILE_MONEY'],
    mobile_money_networks: ['MTN', 'AIRTEL'],
    customer: {
      phone_number: advertiser.phone,
    },
    ...(options?.rawPayload ?? {}),
  };
  const txn = await pool!.query(
    `
    INSERT INTO pesapal_transactions (
      escrow_id,
      type,
      amount,
      status,
      merchant_reference,
      transaction_reference,
      raw_payload
    )
    VALUES ($1, 'FUNDING', $2, 'PENDING', $3, $4, $5)
    RETURNING *
    `,
    [
      escrow.rows[0].id,
      amount,
      merchantReference,
      options?.transactionReference ?? null,
      rawPayload,
    ]
  );
  return {
    advertiser,
    campaign: campaign.rows[0],
    escrow: escrow.rows[0],
    txn: txn.rows[0],
  };
}

describe('YO Uganda payment routes', () => {
  if (!pool) {
    it('skipped: TEST_DATABASE_URL not set', () => expect(true).toBe(true));
    return;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL;
    process.env.YO_API_USERNAME = process.env.YO_API_USERNAME || 'yo-test-user';
    process.env.YO_API_PASSWORD = process.env.YO_API_PASSWORD || 'yo-test-pass';
    const serverModule = await import('../src/server.js');
    app = serverModule.buildServer();
    await applySchema(pool);
    await app.ready();
  });

  beforeEach(async () => {
    yoMocks.getTransactionStatus.mockReset();
    yoMocks.initiateMobileMoneyCollection.mockReset();
    yoMocks.requestPayout.mockReset();
    yoMocks.verifyTransaction.mockReset();
    await resetDatabase();
  });

  afterAll(async () => {
    await app.close();
    await pool.end();
  });

  it('stores the YO transaction reference during initiate', async () => {
    const { advertiser, txn } = await createCampaignFundingTransaction();
    const token = app.jwt.sign(buildAuthClaims(advertiser));
    yoMocks.initiateMobileMoneyCollection.mockResolvedValue(
      buildYoResponse({
        transactionReference: 'yo-init-123',
        transactionStatus: 'PENDING',
        amount: Number(txn.amount),
        merchantReference: txn.merchant_reference,
      })
    );

    const response = await app.inject({
      method: 'POST',
      url: '/payments/yo-uganda/initiate',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        tx_ref: txn.merchant_reference,
        payment_method: 'MOBILE_MONEY',
        network: 'MTN',
        phone_number: advertiser.phone,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      tx_ref: txn.merchant_reference,
      charge_id: 'yo-init-123',
      transaction_id: 'yo-init-123',
      provider_reference: 'yo-init-123',
      provider_status: 'PENDING',
    });

    const stored = await pool!.query(
      'SELECT status, transaction_reference, raw_payload FROM pesapal_transactions WHERE merchant_reference=$1',
      [txn.merchant_reference]
    );
    expect(stored.rows[0]).toMatchObject({
      status: 'PENDING',
      transaction_reference: 'yo-init-123',
    });
    expect(stored.rows[0].raw_payload).toMatchObject({
      yo_transaction_reference: 'yo-init-123',
      yo_last_provider_status: 'PENDING',
    });
  });

  it('prefers the stored YO reference during verify even when the client sends the merchant reference', async () => {
    const { advertiser, escrow, txn } = await createCampaignFundingTransaction({
      transactionReference: 'yo-verify-123',
    });
    const token = app.jwt.sign(buildAuthClaims(advertiser));
    yoMocks.getTransactionStatus.mockResolvedValue(
      buildYoResponse({
        transactionReference: 'yo-verify-123',
        transactionStatus: 'SUCCESSFUL',
        amount: Number(txn.amount),
        merchantReference: txn.merchant_reference,
      })
    );

    const response = await app.inject({
      method: 'POST',
      url: '/payments/yo-uganda/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        tx_ref: txn.merchant_reference,
        transaction_id: txn.merchant_reference,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(yoMocks.getTransactionStatus).toHaveBeenCalledWith(
      'yo-verify-123',
      txn.merchant_reference
    );

    const settledTxn = await pool!.query(
      'SELECT status, transaction_reference FROM pesapal_transactions WHERE merchant_reference=$1',
      [txn.merchant_reference]
    );
    expect(settledTxn.rows[0]).toMatchObject({
      status: 'COMPLETED',
      transaction_reference: 'yo-verify-123',
    });

    const settledEscrow = await pool!.query('SELECT status FROM escrow_ledger WHERE id=$1', [
      escrow.id,
    ]);
    expect(settledEscrow.rows[0].status).toBe('FUNDED');
  });

  it('accepts provider_reference aliases when the provider transaction id is not yet stored', async () => {
    const { advertiser, txn } = await createCampaignFundingTransaction({
      transactionReference: null,
      rawPayload: {
        yo_transaction_reference: null,
      },
    });
    const token = app.jwt.sign(buildAuthClaims(advertiser));
    yoMocks.getTransactionStatus.mockResolvedValue(
      buildYoResponse({
        transactionReference: 'yo-alias-123',
        transactionStatus: 'PENDING',
        amount: Number(txn.amount),
        merchantReference: txn.merchant_reference,
      })
    );

    const response = await app.inject({
      method: 'POST',
      url: '/payments/yo-uganda/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        tx_ref: txn.merchant_reference,
        provider_reference: 'yo-alias-123',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(yoMocks.getTransactionStatus).toHaveBeenCalledWith(
      'yo-alias-123',
      txn.merchant_reference
    );
    expect(response.json()).toMatchObject({
      ok: true,
      tx_ref: txn.merchant_reference,
      transaction_id: 'yo-alias-123',
      status: 'PENDING',
    });
  });

  it('blocks verification attempts from users who do not own the transaction', async () => {
    const { txn } = await createCampaignFundingTransaction({
      transactionReference: 'yo-forbidden-123',
    });
    const otherAdvertiser = await insertAdvertiser('foreign');
    const token = app.jwt.sign(buildAuthClaims(otherAdvertiser));

    const response = await app.inject({
      method: 'POST',
      url: '/payments/yo-uganda/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        tx_ref: txn.merchant_reference,
        transaction_id: 'yo-forbidden-123',
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      error: 'forbidden',
    });
    expect(yoMocks.getTransactionStatus).not.toHaveBeenCalled();
  });

  it('uses the stored YO reference on the public return route and redirects back to the browser target', async () => {
    const { escrow, txn } = await createCampaignFundingTransaction({
      transactionReference: 'yo-return-123',
      rawPayload: {
        yo_transaction_reference: 'yo-return-123',
      },
    });
    yoMocks.getTransactionStatus.mockResolvedValue(
      buildYoResponse({
        transactionReference: 'yo-return-123',
        transactionStatus: 'SUCCESSFUL',
        amount: Number(txn.amount),
        merchantReference: txn.merchant_reference,
      })
    );

    const browserTarget = 'https://example.com/payment/success';
    const response = await app.inject({
      method: 'GET',
      url: `/payments/return?tx_ref=${encodeURIComponent(
        txn.merchant_reference
      )}&target=${encodeURIComponent(browserTarget)}`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toContain(browserTarget);
    expect(response.headers.location).toContain(
      `tx_ref=${encodeURIComponent(txn.merchant_reference)}`
    );
    expect(yoMocks.getTransactionStatus).toHaveBeenCalledWith(
      'yo-return-123',
      txn.merchant_reference
    );

    const fundedEscrow = await pool!.query('SELECT status FROM escrow_ledger WHERE id=$1', [
      escrow.id,
    ]);
    expect(fundedEscrow.rows[0].status).toBe('FUNDED');
  });
});
