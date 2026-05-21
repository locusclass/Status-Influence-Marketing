import { pool, withTransaction } from './db.js';
import { platformAdapters } from './verification/adapters.js';
import { MockVerifier } from './verification/mockVerifier.js';
import { GeminiVerifier } from './verification/geminiVerifier.js';
import { DeterministicVerifier } from './verification/deterministicVerifier.js';
import { PythonBotVerifier } from './verification/pythonBotVerifier.js';
import { runTamperChecks } from './verification/tamper.js';
import { downloadToTemp, removeTemp } from './utils.js';
import { v4 as uuid } from 'uuid';
import {
  calculateAmbassadorPayoutBreakdown,
  generateMonthlyPayouts,
  deriveEngagementRate,
  doesSubmissionExist,
  extractMetricsSnapshot,
  getBurstWindowMinutes,
  getCampaignBurstMode,
  getCreatorScoreFloor,
  getPrimaryMetricTarget,
  getPublicContractUnitRate,
  getSubmissionActionType,
  getSubmissionPostId,
  getSubmissionPostUrl,
  getSubmissionPrimaryMetric,
  getSubmissionVideoUrl,
  isCreatorPlatform,
  AMBASSADOR_PLATFORM_FEE_PERCENT,
  isSubmissionPublic,
  normalizeCampaignPlatform,
  recordCampaignRevenueEntry,
} from '@prime/shared';

const verifierProvider = process.env.VERIFIER_PROVIDER ?? 'python_bot';
const verifier =
  verifierProvider === 'gemini'
    ? new GeminiVerifier()
    : verifierProvider === 'python_bot'
    ? new PythonBotVerifier()
    : verifierProvider === 'deterministic'
    ? new DeterministicVerifier()
    : new MockVerifier();
let lastContractExpirySweepAt = 0;
let lastOpenAllocatorSweepAt = 0;
let lastPublicAdvertReallocatorSweepAt = 0;
let lastMonthlyPayoutSweepAt = 0;
let lastAdvertRollupSweepAt = 0;

type Eligibleambassador = {
  id: string;
  phone: string;
  max_status_viewers_12h: number;
};

type EligibleCreator = {
  creator_id: string;
  user_id: string;
  phone: string;
  creator_score: number;
  historical_performance: number;
  delivery_reliability: number;
  engagement_consistency: number;
  creator_account_id: string | null;
  handle: string | null;
  average_views: number;
  average_engagement_rate: number;
};

if (process.env.NODE_ENV === 'production' && verifierProvider === 'mock') {
  throw new Error('VERIFIER_PROVIDER=mock is not allowed in production');
}

async function fetchNextJob() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const res = await client.query(
      `SELECT *
       FROM job_queue
       WHERE status IN ('QUEUED', 'RETRY')
         AND run_at <= now()
       ORDER BY created_at ASC
       LIMIT 1
       FOR UPDATE SKIP LOCKED`
    );

    const job = res.rows[0];

    if (!job) {
      await client.query('COMMIT');
      return null;
    }

    await client.query(
      "UPDATE job_queue SET status='PROCESSING', updated_at=now() WHERE id=$1",
      [job.id]
    );

    await client.query('COMMIT');
    return job;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

async function ensureCampaignAllocatorColumns(client: any) {
  await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS parent_campaign_id UUID REFERENCES campaigns(id)
  `);
  await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS campaign_bundle_id UUID
  `);
  await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS bundle_root_campaign_id UUID REFERENCES campaigns(id)
  `);
  await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS assigned_ambassador_id UUID REFERENCES users(id)
  `);
  await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS assigned_phone TEXT
  `);
  await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS execution_mode TEXT NOT NULL DEFAULT 'PRIVATE_CONTRACT'
  `);
  await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'PUBLIC'
  `);
  await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS impression_target INTEGER
  `);
  await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS platform_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 0
  `);
  await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS business_wallet_mode TEXT NOT NULL DEFAULT 'CAMPAIGN_ONLY'
  `);
  await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS last_allocated_at TIMESTAMPTZ
  `);
  await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS allocation_round INTEGER NOT NULL DEFAULT 0
  `);
  await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS media_text TEXT
  `);
  await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS delivery_model TEXT NOT NULL DEFAULT 'DETERMINISTIC'
  `);
  await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS execution_meta JSONB
  `);
  await client.query(`
    ALTER TABLE campaigns
      ADD COLUMN IF NOT EXISTS campaign_burst_mode BOOLEAN NOT NULL DEFAULT FALSE
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS campaigns_campaign_bundle_id_idx
    ON campaigns (campaign_bundle_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS campaigns_bundle_root_campaign_id_idx
    ON campaigns (bundle_root_campaign_id)
  `);
}

async function ensureambassadorPayoutColumns(client: any) {
  await client.query(`
    ALTER TABLE payout_requests
      ADD COLUMN IF NOT EXISTS platform_fee_percent NUMERIC(5,2) NOT NULL DEFAULT ${AMBASSADOR_PLATFORM_FEE_PERCENT}
  `);
  await client.query(`
    ALTER TABLE payout_requests
      ADD COLUMN IF NOT EXISTS platform_fee_amount INTEGER NOT NULL DEFAULT 0
  `);
  await client.query(`
    ALTER TABLE payout_requests
      ADD COLUMN IF NOT EXISTS net_amount INTEGER
  `);
  await client.query(`
    UPDATE payout_requests
    SET net_amount = COALESCE(net_amount, amount)
    WHERE net_amount IS NULL
  `);
}

async function ensureCreatorMarketingTables(client: any) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS creators (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      creator_score NUMERIC(6,2) NOT NULL DEFAULT 50,
      historical_performance NUMERIC(6,2) NOT NULL DEFAULT 50,
      delivery_reliability NUMERIC(6,2) NOT NULL DEFAULT 50,
      engagement_consistency NUMERIC(6,2) NOT NULL DEFAULT 50,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS creator_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      handle TEXT,
      profile_url TEXT,
      followers_count INTEGER NOT NULL DEFAULT 0,
      average_views INTEGER NOT NULL DEFAULT 0,
      average_engagement_rate NUMERIC(8,4) NOT NULL DEFAULT 0,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS creator_accounts_creator_platform_unique
    ON creator_accounts (creator_id, platform)
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS content_submissions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      campaign_id UUID NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      proof_id UUID UNIQUE REFERENCES proofs(id) ON DELETE SET NULL,
      creator_id UUID REFERENCES creators(id) ON DELETE SET NULL,
      creator_account_id UUID REFERENCES creator_accounts(id) ON DELETE SET NULL,
      platform TEXT NOT NULL,
      post_id TEXT,
      action_type TEXT,
      post_url TEXT,
      video_url TEXT,
      metrics_json JSONB,
      validation_status TEXT NOT NULL DEFAULT 'PENDING',
      public BOOLEAN,
      content_exists BOOLEAN,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS post_engagement_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      submission_id UUID NOT NULL REFERENCES content_submissions(id) ON DELETE CASCADE,
      platform TEXT NOT NULL,
      metrics_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function syncCreatorsFromUsers(client: any) {
  await client.query(`
    INSERT INTO creators (
      user_id,
      creator_score,
      historical_performance,
      delivery_reliability,
      engagement_consistency
    )
    SELECT
      u.id,
      COALESCE(ts.score, 50),
      COALESCE(ts.score, 50),
      COALESCE(ts.score, 50),
      50
    FROM users u
    LEFT JOIN trust_scores ts ON ts.user_id = u.id
    WHERE u.role IN ('AMBASSADOR', 'DUAL_USER', 'ADMIN')
    ON CONFLICT (user_id)
    DO UPDATE SET
      creator_score = GREATEST(creators.creator_score, COALESCE(EXCLUDED.creator_score, creators.creator_score)),
      updated_at = NOW()
  `);
}

function getDistributableCampaignBudget(campaign: any) {
  return Math.max(0, Number(campaign?.budget_total ?? 0));
}

function getEscrowCampaignId(campaign: any) {
  const executionMeta =
    campaign?.execution_meta && typeof campaign.execution_meta === 'object'
      ? (campaign.execution_meta as Record<string, unknown>)
      : null;
  const contractReissue =
    executionMeta?.contract_reissue &&
    typeof executionMeta.contract_reissue === 'object'
      ? (executionMeta.contract_reissue as Record<string, unknown>)
      : null;
  const sourceEscrowCampaignId = String(
    contractReissue?.source_escrow_campaign_id ?? ''
  ).trim();
  if (sourceEscrowCampaignId.length > 0) {
    return sourceEscrowCampaignId;
  }
  return String(
    campaign?.bundle_root_campaign_id ??
      campaign?.parent_campaign_id ??
      campaign?.id ??
      ''
  ).trim();
}

function getCreatorUnitCount(campaign: any) {
  const explicit = Math.max(
    0,
    Math.floor(Number(campaign?.execution_meta?.creator_unit_count ?? 0))
  );
  if (explicit > 0) {
    return explicit;
  }
  const payoutAmount = Math.max(1, Number(campaign?.payout_amount ?? 1));
  return Math.max(
    1,
    Math.floor(getDistributableCampaignBudget(campaign) / payoutAmount)
  );
}

function getPerAllocationTarget(campaign: any, unitCount: number) {
  const explicit = Math.max(
    0,
    Math.floor(Number(campaign?.execution_meta?.per_creator_target_metric ?? 0))
  );
  if (explicit > 0) {
    return explicit;
  }
  const totalTarget = Math.max(
    1,
    Math.floor(Number(campaign?.impression_target ?? campaign?.terms_min_views ?? 1))
  );
  return Math.max(1, Math.ceil(totalTarget / Math.max(1, unitCount)));
}

async function getEligibleambassadors(client: any): Promise<Eligibleambassador[]> {
  const res = await client.query(
    `
    SELECT
      u.id,
      u.phone,
      COALESCE(u.max_status_viewers_12h, 0)::int AS max_status_viewers_12h
    FROM users u
    WHERE u.role IN ('AMBASSADOR', 'DUAL_USER')
      AND u.status = 'ACTIVE'
      AND COALESCE(u.max_status_viewers_12h, 0) > 0
    ORDER BY u.max_status_viewers_12h DESC, u.created_at ASC
    `
  );
  return res.rows.map((row: any): Eligibleambassador => ({
    id: row.id,
    phone: String(row.phone ?? ''),
    max_status_viewers_12h: Number(row.max_status_viewers_12h ?? 0),
  }));
}

async function getEligibleCreators(
  client: any,
  platform: string,
  creatorScoreFloor: number
): Promise<EligibleCreator[]> {
  const res = await client.query(
    `
    SELECT
      c.id AS creator_id,
      c.user_id,
      COALESCE(u.phone, '') AS phone,
      COALESCE(c.creator_score, 50)::numeric AS creator_score,
      COALESCE(c.historical_performance, 50)::numeric AS historical_performance,
      COALESCE(c.delivery_reliability, 50)::numeric AS delivery_reliability,
      COALESCE(c.engagement_consistency, 50)::numeric AS engagement_consistency,
      ca.id AS creator_account_id,
      ca.handle,
      COALESCE(ca.average_views, 0)::int AS average_views,
      COALESCE(ca.average_engagement_rate, 0)::numeric AS average_engagement_rate
    FROM creators c
    JOIN users u ON u.id = c.user_id
    JOIN creator_accounts ca
      ON ca.creator_id = c.id
     AND ca.platform = $1
     AND ca.active = TRUE
    WHERE u.role IN ('AMBASSADOR', 'DUAL_USER', 'ADMIN')
      AND u.status = 'ACTIVE'
      AND COALESCE(c.creator_score, 50) >= $2
      AND NULLIF(BTRIM(COALESCE(ca.profile_url, ca.handle, '')), '') IS NOT NULL
    ORDER BY
      COALESCE(c.creator_score, 50) DESC,
      COALESCE(c.delivery_reliability, 50) DESC,
      COALESCE(c.engagement_consistency, 50) DESC,
      COALESCE(c.historical_performance, 50) DESC,
      u.created_at ASC
    `,
    [platform, creatorScoreFloor]
  );
  return res.rows.map((row: any): EligibleCreator => ({
    creator_id: String(row.creator_id),
    user_id: String(row.user_id),
    phone: String(row.phone ?? ''),
    creator_score: Number(row.creator_score ?? 50),
    historical_performance: Number(row.historical_performance ?? 50),
    delivery_reliability: Number(row.delivery_reliability ?? 50),
    engagement_consistency: Number(row.engagement_consistency ?? 50),
    creator_account_id: row.creator_account_id ? String(row.creator_account_id) : null,
    handle: row.handle ? String(row.handle) : null,
    average_views: Number(row.average_views ?? 0),
    average_engagement_rate: Number(row.average_engagement_rate ?? 0),
  }));
}

async function getOpenRootCampaignsReadyForAllocation(client: any) {
  const res = await client.query(
    `
    SELECT
      c.*,
      COALESCE(c.bundle_root_campaign_id, c.id) AS escrow_campaign_id,
      e.amount_available,
      e.amount_total,
      e.status AS escrow_status
    FROM campaigns c
    JOIN escrow_ledger e
      ON e.campaign_id = COALESCE(c.bundle_root_campaign_id, c.id)
    WHERE c.parent_campaign_id IS NULL
      AND c.execution_mode = 'OPEN_BUDGET'
      AND c.status = 'ACTIVE'
      AND e.status IN ('FUNDED', 'PARTIALLY_DISBURSED')
    ORDER BY c.created_at ASC
    `
  );
  return res.rows;
}

async function allocateCreatorCampaignShares(client: any, rootCampaign: any) {
  const eligible: EligibleCreator[] = shuffle(
    await getEligibleCreators(
      client,
      String(rootCampaign.platform ?? ''),
      getCreatorScoreFloor(rootCampaign)
    )
  );
  if (!eligible.length) {
    return 0;
  }

  const existingRes = await client.query(
    `
    SELECT COUNT(*)::int AS allocated_units
    FROM campaigns
    WHERE parent_campaign_id=$1
      AND status IN ('ACTIVE', 'COMPLETED')
    `,
    [rootCampaign.id]
  );
  const totalUnits = getCreatorUnitCount(rootCampaign);
  let remainingUnits =
    totalUnits - Number(existingRes.rows[0]?.allocated_units ?? 0);
  if (remainingUnits <= 0) {
    return 0;
  }

  const unitTarget = getPerAllocationTarget(rootCampaign, totalUnits);
  const burstMode = getCampaignBurstMode(rootCampaign);
  const burstWindowMinutes = getBurstWindowMinutes(rootCampaign);
  const burstBatchId = burstMode ? `burst_${uuid().slice(0, 8)}` : null;

  let created = 0;
  let round = Number(rootCampaign.allocation_round ?? 0) + 1;
  const recentlyAssigned = new Set<string>();
  while (remainingUnits > 0 && eligible.length > 0) {
    let allocatedThisPass = false;
    for (const creator of eligible) {
      if (remainingUnits <= 0) break;
      if (recentlyAssigned.has(creator.user_id) && recentlyAssigned.size < eligible.length) {
        continue;
      }
      const activeRes = await client.query(
        `
        SELECT 1
        FROM campaigns
        WHERE parent_campaign_id=$1
          AND assigned_ambassador_id=$2
          AND status='ACTIVE'
        LIMIT 1
        `,
        [rootCampaign.id, creator.user_id]
      );
      if (activeRes.rows[0]) {
        continue;
      }

      const childExecutionMeta = {
        ...(rootCampaign.execution_meta ?? {}),
        allocation_strategy: 'REPUTATION_BASED',
        assigned_creator_id: creator.creator_id,
        assigned_creator_account_id: creator.creator_account_id,
        assigned_creator_score: creator.creator_score,
        assigned_creator_handle: creator.handle,
        assigned_creator_average_views: creator.average_views,
        assigned_creator_average_engagement_rate:
          creator.average_engagement_rate,
        burst_batch_id: burstBatchId,
        burst_window_minutes: burstWindowMinutes,
      };
      const childExecutionMetaJson = JSON.stringify(childExecutionMeta);

      await client.query(
        `
        INSERT INTO campaigns (
          business_id,
          campaign_bundle_id,
          bundle_root_campaign_id,
          parent_campaign_id,
          assigned_ambassador_id,
          assigned_phone,
          title,
          platform,
          delivery_model,
          execution_mode,
          visibility,
          payout_amount,
          budget_total,
          impression_target,
          platform_fee_percent,
          business_wallet_mode,
          last_allocated_at,
          allocation_round,
          media_type,
          media_text,
          media_url,
          execution_meta,
          campaign_burst_mode,
          terms_keep_hours,
          terms_min_views,
          terms_requirement,
          status,
          start_date,
          end_date
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,'OPEN_BUDGET','PRIVATE',$10,$11,$12,$13,$14,now(),$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23,'ACTIVE',$24,$25
        )
        `,
        [
          rootCampaign.business_id,
          rootCampaign.campaign_bundle_id ?? null,
          rootCampaign.bundle_root_campaign_id ?? rootCampaign.id,
          rootCampaign.id,
          creator.user_id,
          creator.phone || null,
          `${rootCampaign.title} - Creator ${uuid().slice(0, 8)}`,
          rootCampaign.platform,
          rootCampaign.delivery_model ?? 'DETERMINISTIC',
          unitTarget * getPublicContractUnitRate(rootCampaign.media_type),
          unitTarget * getPublicContractUnitRate(rootCampaign.media_type),
          unitTarget,
          rootCampaign.platform_fee_percent ?? 0,
          rootCampaign.business_wallet_mode ?? 'CAMPAIGN_ONLY',
          round,
          rootCampaign.media_type,
          rootCampaign.media_text,
          rootCampaign.media_url,
          childExecutionMetaJson,
          burstMode,
          rootCampaign.terms_keep_hours,
          rootCampaign.terms_min_views ?? unitTarget,
          rootCampaign.terms_requirement,
          rootCampaign.start_date,
          rootCampaign.end_date,
        ]
      );

      remainingUnits -= 1;
      created += 1;
      allocatedThisPass = true;
      recentlyAssigned.add(creator.user_id);
    }
    if (!allocatedThisPass) {
      break;
    }
    if (recentlyAssigned.size >= eligible.length) {
      recentlyAssigned.clear();
      round += 1;
    }
  }

  if (created > 0) {
    await client.query(
      `
      UPDATE campaigns
      SET last_allocated_at = now(),
          allocation_round = $2
      WHERE id=$1
      `,
      [rootCampaign.id, round]
    );
  }
  return created;
}

async function allocateOpenCampaignShares(client: any, rootCampaign: any) {
  if (isCreatorPlatform(rootCampaign.platform)) {
    return allocateCreatorCampaignShares(client, rootCampaign);
  }
  const eligible: Eligibleambassador[] = shuffle(await getEligibleambassadors(client));
  if (!eligible.length) {
    return 0;
  }

  const existingRes = await client.query(
    `
    SELECT COALESCE(SUM(impression_target), 0)::int AS allocated_views
    FROM campaigns
    WHERE parent_campaign_id=$1
      AND status IN ('ACTIVE', 'COMPLETED')
    `,
    [rootCampaign.id]
  );
  let remainingViews =
    Number(rootCampaign.impression_target ?? 0) -
    Number(existingRes.rows[0]?.allocated_views ?? 0);
  if (remainingViews <= 0) {
    return 0;
  }

  let created = 0;
  let round = Number(rootCampaign.allocation_round ?? 0) + 1;
  const recentlyAssigned = new Set<string>();
  while (remainingViews > 0 && eligible.length > 0) {
    let allocatedThisPass = false;
    for (const ambassador of eligible) {
      if (remainingViews <= 0) break;
      if (recentlyAssigned.has(ambassador.id) && recentlyAssigned.size < eligible.length) {
        continue;
      }
      const activeRes = await client.query(
        `
        SELECT 1
        FROM campaigns
        WHERE parent_campaign_id=$1
          AND assigned_ambassador_id=$2
          AND status='ACTIVE'
        LIMIT 1
        `,
        [rootCampaign.id, ambassador.id]
      );
      if (activeRes.rows[0]) {
        continue;
      }

      const views = Math.max(1, Math.min(ambassador.max_status_viewers_12h, remainingViews));
      const budgetTotal =
        views * getPublicContractUnitRate(rootCampaign.media_type);
      const executionMetaJson =
        rootCampaign.execution_meta == null
          ? null
          : JSON.stringify(rootCampaign.execution_meta);
      await client.query(
        `
        INSERT INTO campaigns (
          business_id,
          campaign_bundle_id,
          bundle_root_campaign_id,
          parent_campaign_id,
          assigned_ambassador_id,
          assigned_phone,
          title,
          platform,
          delivery_model,
          execution_mode,
          visibility,
          payout_amount,
          budget_total,
          impression_target,
          platform_fee_percent,
          business_wallet_mode,
          last_allocated_at,
          allocation_round,
          media_type,
          media_text,
          media_url,
          execution_meta,
          campaign_burst_mode,
          terms_keep_hours,
          terms_min_views,
          terms_requirement,
          status,
          start_date,
          end_date
        )
        VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,'OPEN_BUDGET','PRIVATE',$10,$11,$12,$13,$14,now(),$15,$16,$17,$18,$19::jsonb,$20,$21,$22,$23,'ACTIVE',$24,$25
        )
        `,
        [
          rootCampaign.business_id,
          rootCampaign.campaign_bundle_id ?? null,
          rootCampaign.bundle_root_campaign_id ?? rootCampaign.id,
          rootCampaign.id,
          ambassador.id,
          ambassador.phone,
          `${rootCampaign.title} - Allocation ${uuid().slice(0, 8)}`,
          rootCampaign.platform,
          rootCampaign.delivery_model ?? 'DETERMINISTIC',
          budgetTotal,
          budgetTotal,
          views,
          rootCampaign.platform_fee_percent ?? 0,
          rootCampaign.business_wallet_mode ?? 'CAMPAIGN_ONLY',
          round,
          rootCampaign.media_type,
          rootCampaign.media_text,
          rootCampaign.media_url,
          executionMetaJson,
          rootCampaign.campaign_burst_mode ?? false,
          rootCampaign.terms_keep_hours,
          rootCampaign.terms_min_views,
          rootCampaign.terms_requirement,
          rootCampaign.start_date,
          rootCampaign.end_date,
        ]
      );
      remainingViews -= views;
      created += 1;
      allocatedThisPass = true;
      recentlyAssigned.add(ambassador.id);
    }
    if (!allocatedThisPass) {
      break;
    }
    if (recentlyAssigned.size >= eligible.length) {
      recentlyAssigned.clear();
      round += 1;
    }
  }

  if (created > 0) {
    await client.query(
      `
      UPDATE campaigns
      SET last_allocated_at = now(),
          allocation_round = $2
      WHERE id=$1
      `,
      [rootCampaign.id, round]
    );
  }
  return created;
}

async function reallocateExpiredOpenAllocations(client: any) {
  const res = await client.query(
    `
    SELECT c.*
    FROM campaigns c
    WHERE c.parent_campaign_id IS NOT NULL
      AND c.execution_mode='OPEN_BUDGET'
      AND c.status='ACTIVE'
      AND c.last_allocated_at IS NOT NULL
      AND c.last_allocated_at < now() - interval '1 hour'
      AND NOT EXISTS (
        SELECT 1 FROM contracts ctr
        WHERE ctr.campaign_id = c.id
          AND ctr.status IN ('ACTIVE', 'COMPLETED')
      )
    ORDER BY c.last_allocated_at ASC
    `
  );

  const Eligibleambassadors: Eligibleambassador[] = shuffle(
    await getEligibleambassadors(client)
  );
  for (const allocation of res.rows as any[]) {
    const unresolvedProofRes = await client.query(
      `
      SELECT 1
      FROM proofs p
      JOIN verification_sessions s ON s.id = p.session_id
      WHERE s.campaign_id=$1
        AND (
          p.status IN ('PENDING', 'MANUAL_REVIEW', 'VERIFIED')
          OR (p.status = 'REJECTED' AND COALESCE(p.decision, '') <> 'REJECTED')
        )
      LIMIT 1
      `,
      [allocation.id]
    );
    if (unresolvedProofRes.rows[0]) {
      continue;
    }

    if (isCreatorPlatform(allocation.platform)) {
      const eligibleCreators = shuffle(
        await getEligibleCreators(
          client,
          String(allocation.platform ?? ''),
          getCreatorScoreFloor(allocation)
        )
      );
      const nextCreator = eligibleCreators.find(
        (row: EligibleCreator) =>
          row.user_id !== allocation.assigned_ambassador_id
      );
      if (!nextCreator) {
        continue;
      }
      const nextExecutionMeta = JSON.stringify({
        ...(allocation.execution_meta ?? {}),
        allocation_strategy: 'REPUTATION_BASED',
        assigned_creator_id: nextCreator.creator_id,
        assigned_creator_account_id: nextCreator.creator_account_id,
        assigned_creator_score: nextCreator.creator_score,
        assigned_creator_handle: nextCreator.handle,
        reallocated_at: new Date().toISOString(),
      });
      await client.query(
        `
        UPDATE campaigns
        SET assigned_ambassador_id=$2,
            assigned_phone=$3,
            execution_meta=$4::jsonb,
            last_allocated_at=now(),
            allocation_round=allocation_round + 1
        WHERE id=$1
        `,
        [allocation.id, nextCreator.user_id, nextCreator.phone || null, nextExecutionMeta]
      );
      continue;
    }

    const nextambassador = Eligibleambassadors.find(
      (row: Eligibleambassador) =>
        row.id !== allocation.assigned_ambassador_id
        && row.max_status_viewers_12h >= Number(allocation.impression_target ?? 0)
    );
    if (!nextambassador) {
      continue;
    }

    await client.query(
      `
      UPDATE campaigns
      SET assigned_ambassador_id=$2,
          assigned_phone=$3,
          last_allocated_at=now(),
          allocation_round=allocation_round + 1
      WHERE id=$1
      `,
      [allocation.id, nextambassador.id, nextambassador.phone]
    );
  }
}

type ReviewReason = { code: string; message: string };

type TraceEvaluation = {
  valid: boolean;
  required_steps: number;
  completed_steps: number;
  unique_completed_steps: number;
  duration_seconds: number;
  timeline_order_valid: boolean;
  scheduled_timing_valid: boolean;
};

type PlatformValidationSummary = {
  platform: string;
  primary_metric: number;
  primary_metric_target: number;
  primary_metric_ratio: number;
  engagement_rate: number;
  engagement_threshold: number;
  live_hours: number;
  live_hours_target: number;
  post_exists: boolean;
  post_public: boolean;
  post_id: string | null;
  post_url: string | null;
  video_url: string | null;
  action_type: string | null;
  metrics_snapshot: Record<string, unknown>;
  passed: boolean;
  should_retry_allocation: boolean;
  partial_payout_ratio: number;
};

function clampUnitInterval(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function evaluateClientTrace(script: any, clientMeta: any, tamperDuration: number): TraceEvaluation {
  const steps = Array.isArray(script) ? script : [];
  const requiredStepIds = steps.filter((s: any) => s?.required !== false).map((s: any) => String(s.id ?? ''));
  const uniqueRequired = new Set(requiredStepIds.filter(Boolean));
  const events = Array.isArray(clientMeta?.steps) ? clientMeta.steps : [];
  const completedIds: string[] = [];
  const completedAt: number[] = [];
  let scheduledTimingValid = true;
  for (const event of events) {
    const id = String(event?.id ?? '').trim();
    if (!id) continue;
    completedIds.push(id);
    const ts = Date.parse(String(event?.completed_at ?? ''));
    if (!Number.isNaN(ts)) completedAt.push(ts);

    const matchingStep = steps.find((step: any) => String(step?.id ?? '') === id);
    const scheduledSecond = Number(matchingStep?.at_second ?? 0);
    const completedSecond = Number(event?.completed_second ?? NaN);
    if (
      matchingStep &&
      Number.isFinite(completedSecond) &&
      (completedSecond < Math.max(0, scheduledSecond - 12) ||
        completedSecond > scheduledSecond + 12)
    ) {
      scheduledTimingValid = false;
    }
  }

  const startedAt = Date.parse(String(clientMeta?.recording_started_at ?? ''));
  const stoppedAt = Date.parse(String(clientMeta?.recording_stopped_at ?? ''));
  const declaredDuration =
    Number.isFinite(startedAt) && Number.isFinite(stoppedAt) && stoppedAt > startedAt
      ? Math.round((stoppedAt - startedAt) / 1000)
      : 0;
  const duration = tamperDuration > 0 ? Math.round(tamperDuration) : declaredDuration;

  let timelineOrderValid = true;
  for (let i = 1; i < completedAt.length; i += 1) {
    const current = completedAt[i] ?? 0;
    const previous = completedAt[i - 1] ?? 0;
    if (current < previous) {
      timelineOrderValid = false;
      break;
    }
  }

  const uniqueCompleted = new Set(completedIds);
  const requiredCompletedCount = [...uniqueRequired].filter((id) => uniqueCompleted.has(id)).length;
  const strictDuration = duration >= 58 && duration <= 75;
  const valid =
    uniqueRequired.size > 0 &&
    requiredCompletedCount >= uniqueRequired.size &&
    timelineOrderValid &&
    scheduledTimingValid &&
    strictDuration;

  return {
    valid,
    required_steps: uniqueRequired.size,
    completed_steps: completedIds.length,
    unique_completed_steps: requiredCompletedCount,
    duration_seconds: duration,
    timeline_order_valid: timelineOrderValid,
    scheduled_timing_valid: scheduledTimingValid,
  };
}

function buildReviewReasons(input: {
  campaign?: any;
  tamper: any;
  result: any;
  script?: any;
  clientMeta?: any;
}): ReviewReason[] {
  const trace = evaluateClientTrace(input.script, input.clientMeta, Number(input.tamper?.details?.duration ?? 0));
  const platform = normalizeCampaignPlatform(input.campaign?.platform);
  const reasons: ReviewReason[] = [];
  if (input.tamper.cut_spike) {
    reasons.push({ code: 'TAMPER_CUT_SPIKE', message: 'Abrupt scene changes detected.' });
  }
  if (input.tamper.frozen_frames) {
    reasons.push({ code: 'TAMPER_FROZEN_FRAMES', message: 'Frozen frames detected in the recording.' });
  }
  if (input.tamper.timestamp_inconsistent) {
    reasons.push({ code: 'TAMPER_TIMESTAMP', message: 'Recording timestamp metadata inconsistent.' });
  }
  if (input.tamper.overlay_suspected) {
    reasons.push({ code: 'TAMPER_OVERLAY', message: 'Overlay anomalies detected near target UI.' });
  }
  if (input.result.challenge_seen === false) {
    reasons.push({ code: 'CHALLENGE_NOT_SEEN', message: 'Challenge code/phrase not visible or not detected.' });
  }
  if (typeof input.result.confidence === 'number' && input.result.confidence < 0.7) {
    reasons.push({ code: 'LOW_CONFIDENCE', message: 'Verification confidence is below threshold.' });
  }
  if (
    platform === 'WHATSAPP_STATUS' &&
    (!input.result.observed_views || input.result.observed_views <= 0)
  ) {
    reasons.push({ code: 'VIEWS_MISSING', message: 'View count could not be verified.' });
  }
  const hasBotReport = Boolean(input.result?.verifier_report);
  const botVerdict = String(input.result?.verifier_report?.verdict ?? '');
  if (hasBotReport && botVerdict === 'REJECTED') {
    reasons.push({
      code: 'PYTHON_BOT_REJECTED',
      message: 'Python verification bot rejected the recording as non-authentic.',
    });
  }
  const botSignals = Array.isArray(input.result?.verifier_report?.tamper_signals)
    ? input.result.verifier_report.tamper_signals
    : [];
  if (hasBotReport && botSignals.length > 0) {
    reasons.push({
      code: 'PYTHON_BOT_TAMPER_SIGNALS',
      message: `Python verification detected tamper signals: ${botSignals.join(', ')}`,
    });
  }
  const scrollDetected = Boolean(input.result?.verifier_report?.scroll_detected);
  if (platform === 'WHATSAPP_STATUS' && hasBotReport && !scrollDetected) {
    reasons.push({
      code: 'LIVENESS_SCROLL_MISSING',
      message: 'No reliable list scroll/liveness signal detected by the Python verifier.',
    });
  }
  if (trace.required_steps > 0 && trace.unique_completed_steps < trace.required_steps) {
    reasons.push({
      code: 'STEPS_INCOMPLETE',
      message: 'Required verification gestures were not completed.',
    });
  }
  if (!trace.timeline_order_valid) {
    reasons.push({
      code: 'STEP_TIMELINE_INVALID',
      message: 'Verification step timeline is inconsistent.',
    });
  }
  if (!trace.scheduled_timing_valid) {
    reasons.push({
      code: 'STEP_TIMING_INVALID',
      message: 'Verification steps were completed outside the expected timing windows.',
    });
  }
  if (trace.duration_seconds < 58 || trace.duration_seconds > 75) {
    reasons.push({
      code: 'RECORDING_DURATION_INVALID',
      message: 'Recording duration is outside the required 60-second window.',
    });
  }
  return reasons;
}

function buildPlatformValidationSummary(
  campaign: any,
  proof: any,
  result: any
): PlatformValidationSummary {
  const platform = normalizeCampaignPlatform(campaign?.platform);
  const metricsSnapshot = extractMetricsSnapshot(proof?.meta) as Record<string, unknown>;
  const primaryMetric = getSubmissionPrimaryMetric(campaign, proof?.meta, result?.observed_views);
  const primaryMetricTarget = Math.max(0, getPrimaryMetricTarget(campaign));
  const engagementRate = deriveEngagementRate(metricsSnapshot);
  const engagementThreshold = 0;
  const liveHours = 0;
  const liveHoursTarget = 0;
  const postExists = doesSubmissionExist(proof?.meta);
  const postPublic = true;
  const primaryMetricRatio =
    primaryMetricTarget > 0 ? primaryMetric / primaryMetricTarget : 1;
  const engagementRatio =
    engagementThreshold > 0 ? engagementRate / engagementThreshold : 1;
  const liveRatio = liveHoursTarget > 0 ? liveHours / liveHoursTarget : 1;
  const partialPayoutRatio = clampUnitInterval(
    Math.min(
      primaryMetricRatio,
      engagementRatio,
      liveRatio,
      postExists ? 1 : 0,
      postPublic ? 1 : 0
    )
  );
  const passed =
    postExists &&
    postPublic &&
    (primaryMetricTarget <= 0 || primaryMetric >= primaryMetricTarget) &&
    (engagementThreshold <= 0 || engagementRate >= engagementThreshold) &&
    (liveHoursTarget <= 0 || liveHours >= liveHoursTarget);

  return {
    platform,
    primary_metric: primaryMetric,
    primary_metric_target: primaryMetricTarget,
    primary_metric_ratio: clampUnitInterval(primaryMetricRatio),
    engagement_rate: engagementRate,
    engagement_threshold: engagementThreshold,
    live_hours: liveHours,
    live_hours_target: liveHoursTarget,
    post_exists: postExists,
    post_public: postPublic,
    post_id: getSubmissionPostId(proof?.meta),
    post_url: getSubmissionPostUrl(proof?.meta),
    video_url: getSubmissionVideoUrl(proof?.meta),
    action_type: getSubmissionActionType(proof?.meta),
    metrics_snapshot: metricsSnapshot,
    passed,
    should_retry_allocation:
      isCreatorPlatform(platform) &&
      String(campaign?.execution_mode ?? '') === 'OPEN_BUDGET' &&
      !passed,
    partial_payout_ratio: partialPayoutRatio,
  };
}

function buildPlatformReviewReasons(
  campaign: any,
  validation: PlatformValidationSummary
): ReviewReason[] {
  const reasons: ReviewReason[] = [];
  if (!validation.post_exists) {
    reasons.push({
      code: 'CONTENT_NOT_FOUND',
      message: 'Submitted content is no longer available.',
    });
  }
  if (!validation.post_public) {
    reasons.push({
      code: 'CONTENT_NOT_PUBLIC',
      message: 'Submitted content must remain public for escrow release.',
    });
  }
  if (
    validation.primary_metric_target > 0 &&
    validation.primary_metric < validation.primary_metric_target
  ) {
    reasons.push({
      code: 'PRIMARY_METRIC_BELOW_TARGET',
      message: `Content views are below target (${validation.primary_metric}/${validation.primary_metric_target}).`,
    });
  }
  return reasons;
}

function deriveFinalProofDecision(input: {
  campaign: any;
  reasons: ReviewReason[];
  result: any;
  trace: TraceEvaluation;
  platformValidation: PlatformValidationSummary;
}) {
  const confidence = Number(input.result?.confidence ?? 0);
  const challengeSeen = Boolean(input.result?.challenge_seen);
  const verifierDecision = String(input.result?.decision ?? '').toUpperCase();

  const blockingReasonCodes = new Set(
    input.reasons.map((reason) => reason.code)
  );
  const hasBlockingReason =
    blockingReasonCodes.size > 0 ||
    !input.trace.valid ||
    !challengeSeen ||
    confidence < 0.7 ||
    verifierDecision === 'REJECTED' ||
    !input.platformValidation.passed;

  return hasBlockingReason ? 'REJECTED' : 'VERIFIED';
}

async function markContractCompletedForVerifiedProof(client: any, proofId: string) {
  const proofContextRes = await client.query(
    `
    SELECT
      p.id,
      p.user_id,
      p.status,
      p.decision,
      s.campaign_id
    FROM proofs p
    JOIN verification_sessions s ON s.id = p.session_id
    WHERE p.id=$1
    LIMIT 1
    `,
    [proofId]
  );
  const proofContext = proofContextRes.rows[0];
  if (!proofContext) return;
  if (proofContext.status !== 'VERIFIED' || proofContext.decision !== 'VERIFIED') return;

  await client.query(
    `
    UPDATE contracts
    SET status='COMPLETED',
        completed_at=COALESCE(completed_at, now())
    WHERE campaign_id=$1
      AND ambassador_id=$2
      AND status='ACTIVE'
    `,
    [proofContext.campaign_id, proofContext.user_id]
  );
  await client.query(
    `
    UPDATE campaigns
    SET status='COMPLETED'
    WHERE id=$1
    `,
    [proofContext.campaign_id]
  );
  await recordCampaignRevenueEntry(client, proofContext.campaign_id);
}

async function preparePayoutRequest(client: any, proof: any, campaign: any) {
  await ensureambassadorPayoutColumns(client);
  const escrowCampaignId = getEscrowCampaignId(campaign);
  const payoutBreakdown = calculateAmbassadorPayoutBreakdown(
    Number(campaign?.payout_amount ?? campaign?.budget_total ?? 0)
  );
  const escrowDebitAmount = Math.max(
    0,
    Math.round(Number(campaign?.budget_total ?? payoutBreakdown.gross_amount))
  );
  const contractRes = await client.query(
    `SELECT id
     FROM contracts
     WHERE campaign_id=$1
       AND ambassador_id=$2
       AND status IN ('ACTIVE', 'COMPLETED')
     LIMIT 1`,
    [campaign.id, proof.user_id]
  );
  if (!contractRes.rows[0]) {
    throw new Error('active_contract_required');
  }

  const escrowRes = await client.query(
    'SELECT * FROM escrow_ledger WHERE campaign_id=$1',
    [escrowCampaignId]
  );
  const escrow = escrowRes.rows[0];

  if (!escrow || escrow.status === 'PENDING') {
    throw new Error('escrow_not_funded');
  }

  const existingPayoutRes = await client.query(
    'SELECT * FROM payout_requests WHERE proof_id=$1',
    [proof.id]
  );
  let payoutRow = existingPayoutRes.rows[0];
  if (!payoutRow) {
    const payoutInsert = await client.query(
      `INSERT INTO payout_requests (
         proof_id,
         user_id,
         amount,
         platform_fee_percent,
         platform_fee_amount,
         net_amount,
         status
       )
       VALUES ($1,$2,$3,$4,$5,$6,'REQUESTED')
       RETURNING *`,
      [
        proof.id,
        proof.user_id,
        payoutBreakdown.gross_amount,
        payoutBreakdown.platform_fee_percent,
        payoutBreakdown.platform_fee_amount,
        payoutBreakdown.net_amount,
      ]
    );
    payoutRow = payoutInsert.rows[0];
  } else {
    const payoutUpdate = await client.query(
      `
      UPDATE payout_requests
      SET amount = $2,
          platform_fee_percent = $3,
          platform_fee_amount = $4,
          net_amount = $5
      WHERE id = $1
      RETURNING *
      `,
      [
        payoutRow.id,
        payoutBreakdown.gross_amount,
        payoutBreakdown.platform_fee_percent,
        payoutBreakdown.platform_fee_amount,
        payoutBreakdown.net_amount,
      ]
    );
    payoutRow = payoutUpdate.rows[0] ?? payoutRow;
  }

  if (!payoutRow) return null;
  if (payoutRow.status === 'PAID') return null;

  if (payoutRow.status === 'PROCESSING' && payoutRow.pesapal_reference) {
    return null;
  }

  if (payoutRow.status === 'FAILED') {
    const resetRes = await client.query(
      "UPDATE payout_requests SET status='REQUESTED' WHERE id=$1 RETURNING *",
      [payoutRow.id]
    );
    payoutRow = resetRes.rows[0] ?? payoutRow;
  }

  const updatedEscrow = await client.query(
    `UPDATE escrow_ledger
     SET amount_available = amount_available - $2,
         status = CASE
           WHEN amount_available - $2 <= 0
           THEN 'COMPLETED'
           ELSE 'PARTIALLY_DISBURSED'
         END
     WHERE id=$1 AND amount_available >= $2
     RETURNING *`,
    [escrow.id, escrowDebitAmount]
  );

  if (!updatedEscrow.rows[0]) {
    throw new Error('insufficient_escrow');
  }

  const userRes = await client.query(
    'SELECT email, preferred_currency FROM users WHERE id=$1',
    [proof.user_id]
  );
  const user = userRes.rows[0];
  const walletRes = await client.query(
    'SELECT * FROM wallets WHERE user_id=$1 FOR UPDATE',
    [proof.user_id]
  );
  let wallet = walletRes.rows[0];
  if (!wallet) {
    const createdWallet = await client.query(
      `
      INSERT INTO wallets (user_id, currency, balance_available, balance_escrow, balance)
      VALUES ($1,$2,0,0,0)
      RETURNING *
      `,
      [
        proof.user_id,
        (user?.preferred_currency ?? 'UGX').toString().toUpperCase(),
      ]
    );
    wallet = createdWallet.rows[0];
  }

  await client.query(
    `
    UPDATE wallets
    SET balance_available = balance_available + $2,
        balance = balance + $2
    WHERE id=$1
    `,
    [wallet.id, payoutBreakdown.gross_amount]
  );
  await client.query(
    `
    INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
    VALUES ($1,$2,'CREDIT',$3)
    `,
    [wallet.id, payoutBreakdown.gross_amount, `PROOF_PAYOUT_GROSS:${proof.id}`]
  );
  if (payoutBreakdown.platform_fee_amount > 0) {
    await client.query(
      `
      UPDATE wallets
      SET balance_available = balance_available - $2,
          balance = balance - $2
      WHERE id=$1
      `,
      [wallet.id, payoutBreakdown.platform_fee_amount]
    );
    await client.query(
      `
      INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
      VALUES ($1,$2,'DEBIT',$3)
      `,
      [
        wallet.id,
        payoutBreakdown.platform_fee_amount,
        `AMBASSADOR_PLATFORM_FEE:${proof.id}`,
      ]
    );
  }
  await client.query(
    `
    UPDATE payout_requests
    SET status='PAID',
        pesapal_reference=$2,
        platform_fee_percent=$3,
        platform_fee_amount=$4,
        net_amount=$5
    WHERE id=$1
    `,
    [
      payoutRow.id,
      `WALLET_CREDIT:${proof.id}`,
      payoutBreakdown.platform_fee_percent,
      payoutBreakdown.platform_fee_amount,
      payoutBreakdown.net_amount,
    ]
  );
  return null;
}

async function upsertContentSubmission(
  client: any,
  campaign: any,
  proof: any,
  validation: PlatformValidationSummary,
  finalDecision: string
) {
  const creatorRes = await client.query(
    'SELECT id FROM creators WHERE user_id=$1 LIMIT 1',
    [proof.user_id]
  );
  const creatorId = creatorRes.rows[0]?.id ?? null;
  const creatorAccountId =
    campaign?.execution_meta?.assigned_creator_account_id ?? null;
  const metricsJson = JSON.stringify({
    ...validation.metrics_snapshot,
    primary_metric: validation.primary_metric,
    primary_metric_target: validation.primary_metric_target,
    primary_metric_ratio: validation.primary_metric_ratio,
    engagement_rate: validation.engagement_rate,
    engagement_threshold: validation.engagement_threshold,
    live_hours: validation.live_hours,
    live_hours_target: validation.live_hours_target,
    partial_payout_ratio: validation.partial_payout_ratio,
  });
  const existingRes = await client.query(
    'SELECT id FROM content_submissions WHERE proof_id=$1 LIMIT 1',
    [proof.id]
  );

  let submissionId: string;
  if (existingRes.rows[0]?.id) {
    submissionId = String(existingRes.rows[0].id);
    await client.query(
      `
      UPDATE content_submissions
      SET creator_id=$2,
          creator_account_id=$3,
          platform=$4,
          post_id=$5,
          action_type=$6,
          post_url=$7,
          video_url=$8,
          metrics_json=$9::jsonb,
          validation_status=$10,
          public=$11,
          content_exists=$12,
          updated_at=NOW()
      WHERE id=$1
      `,
      [
        submissionId,
        creatorId,
        creatorAccountId,
        validation.platform,
        validation.post_id,
        validation.action_type,
        validation.post_url,
        validation.video_url,
        metricsJson,
        finalDecision,
        validation.post_public,
        validation.post_exists,
      ]
    );
  } else {
    const inserted = await client.query(
      `
      INSERT INTO content_submissions (
        campaign_id,
        proof_id,
        creator_id,
        creator_account_id,
        platform,
        post_id,
        action_type,
        post_url,
        video_url,
        metrics_json,
        validation_status,
        public,
        content_exists
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13)
      RETURNING id
      `,
      [
        campaign.id,
        proof.id,
        creatorId,
        creatorAccountId,
        validation.platform,
        validation.post_id,
        validation.action_type,
        validation.post_url,
        validation.video_url,
        metricsJson,
        finalDecision,
        validation.post_public,
        validation.post_exists,
      ]
    );
    submissionId = String(inserted.rows[0].id);
  }

  await client.query(
    `
    INSERT INTO post_engagement_logs (submission_id, platform, metrics_json)
    VALUES ($1,$2,$3::jsonb)
    `,
    [submissionId, validation.platform, metricsJson]
  );

  if (creatorId && isCreatorPlatform(validation.platform)) {
    const creatorHandle =
      typeof campaign?.execution_meta?.assigned_creator_handle === 'string'
        ? campaign.execution_meta.assigned_creator_handle
        : null;
    await client.query(
      `
      INSERT INTO creator_accounts (
        creator_id,
        platform,
        handle,
        profile_url,
        average_views,
        average_engagement_rate,
        active,
        metadata,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,TRUE,$7::jsonb,NOW())
      ON CONFLICT (creator_id, platform)
      DO UPDATE SET
        handle = COALESCE(EXCLUDED.handle, creator_accounts.handle),
        profile_url = COALESCE(EXCLUDED.profile_url, creator_accounts.profile_url),
        average_views = CASE
          WHEN creator_accounts.average_views <= 0 THEN EXCLUDED.average_views
          ELSE ROUND(((creator_accounts.average_views * 0.6) + (EXCLUDED.average_views * 0.4))::numeric)
        END,
        average_engagement_rate = CASE
          WHEN creator_accounts.average_engagement_rate <= 0 THEN EXCLUDED.average_engagement_rate
          ELSE ROUND(((creator_accounts.average_engagement_rate * 0.6) + (EXCLUDED.average_engagement_rate * 0.4))::numeric, 4)
        END,
        active = TRUE,
        metadata = COALESCE(creator_accounts.metadata, '{}'::jsonb) || EXCLUDED.metadata,
        updated_at = NOW()
      `,
      [
        creatorId,
        validation.platform,
        creatorHandle,
        validation.post_url,
        validation.primary_metric,
        validation.engagement_rate,
        JSON.stringify({
          last_post_id: validation.post_id,
          last_submission_url: validation.post_url ?? validation.video_url,
          last_action_type: validation.action_type,
        }),
      ]
    );
  }
}

async function updateCreatorPerformance(
  client: any,
  campaign: any,
  proof: any,
  finalDecision: string,
  validation: PlatformValidationSummary
) {
  if (!isCreatorPlatform(campaign?.platform)) {
    return;
  }

  await client.query(
    `
    INSERT INTO creators (
      user_id,
      creator_score,
      historical_performance,
      delivery_reliability,
      engagement_consistency
    )
    VALUES ($1,50,50,50,50)
    ON CONFLICT (user_id) DO NOTHING
    `,
    [proof.user_id]
  );

  const performanceScore = clampUnitInterval(validation.primary_metric_ratio) * 100;
  const reliabilityScore =
    finalDecision === 'VERIFIED'
      ? 100
      : Math.max(10, Math.round(validation.partial_payout_ratio * 100));
  const engagementBaseline =
    validation.engagement_rate > 0
      ? Math.min(100, validation.engagement_rate)
      : 50;
  const nextCreatorScore = Math.round(
    (performanceScore * 0.45) +
      (reliabilityScore * 0.35) +
      (engagementBaseline * 0.20)
  );

  await client.query(
    `
    UPDATE creators
    SET creator_score = ROUND(((creator_score * 0.6) + ($2 * 0.4))::numeric, 2),
        historical_performance = ROUND(((historical_performance * 0.6) + ($3 * 0.4))::numeric, 2),
        delivery_reliability = ROUND(((delivery_reliability * 0.6) + ($4 * 0.4))::numeric, 2),
        engagement_consistency = ROUND(((engagement_consistency * 0.6) + ($5 * 0.4))::numeric, 2),
        updated_at = NOW()
    WHERE user_id=$1
    `,
    [
      proof.user_id,
      Math.max(0, Math.min(100, nextCreatorScore)),
      Math.max(0, Math.min(100, performanceScore)),
      Math.max(0, Math.min(100, reliabilityScore)),
      Math.max(0, Math.min(100, engagementBaseline)),
    ]
  );
}

async function queueRejectedOpenAllocationRetry(
  client: any,
  campaign: any,
  proof: any,
  validation: PlatformValidationSummary
) {
  if (!validation.should_retry_allocation) {
    return;
  }

  await client.query(
    `
    UPDATE contracts
    SET status='CANCELLED',
        cancelled_at=COALESCE(cancelled_at, NOW())
    WHERE campaign_id=$1
      AND ambassador_id=$2
      AND status='ACTIVE'
    `,
    [campaign.id, proof.user_id]
  );

  await client.query(
    `
    UPDATE campaigns
    SET execution_meta = COALESCE(execution_meta, '{}'::jsonb) || $2::jsonb,
        last_allocated_at = NOW() - interval '2 hours',
        status='ACTIVE'
    WHERE id=$1
    `,
    [
      campaign.id,
      JSON.stringify({
        settlement_recommendation: 'RETRY_ALLOCATION',
        retry_allocation_requested_at: new Date().toISOString(),
        recommended_partial_payout_ratio: validation.partial_payout_ratio,
        last_validation: {
          platform: validation.platform,
          primary_metric: validation.primary_metric,
          primary_metric_target: validation.primary_metric_target,
          engagement_rate: validation.engagement_rate,
          engagement_threshold: validation.engagement_threshold,
          live_hours: validation.live_hours,
          live_hours_target: validation.live_hours_target,
          post_public: validation.post_public,
          post_exists: validation.post_exists,
        },
      }),
    ]
  );
}

async function ensureWalletForUser(client: any, userId: string) {
  const existing = await client.query(
    'SELECT * FROM wallets WHERE user_id=$1 LIMIT 1',
    [userId]
  );
  if (existing.rows[0]) {
    return existing.rows[0];
  }

  const userRes = await client.query(
    'SELECT preferred_currency FROM users WHERE id=$1 LIMIT 1',
    [userId]
  );
  const currency = (
    userRes.rows[0]?.preferred_currency ?? 'UGX'
  ).toString().trim().toUpperCase();

  const created = await client.query(
    `
    INSERT INTO wallets (user_id, currency, balance_available, balance_escrow, balance)
    VALUES ($1,$2,0,0,0)
    RETURNING *
    `,
    [userId, currency]
  );
  return created.rows[0];
}

async function refundExpiredPrivateContractToWallet(client: any, expiredContract: any) {
  const refundAmount = Number(expiredContract.budget_total ?? 0);
  if (refundAmount <= 0) {
    return;
  }

  const escrowRes = await client.query(
    `
    UPDATE escrow_ledger
    SET amount_available = amount_available - $2,
        status = CASE
          WHEN amount_available - $2 <= 0 THEN 'COMPLETED'
          ELSE 'PARTIALLY_DISBURSED'
        END
    WHERE campaign_id=$1 AND amount_available >= $2
    RETURNING *
    `,
    [expiredContract.escrow_campaign_id, refundAmount]
  );
  if (!escrowRes.rows[0]) {
    return;
  }

  const wallet = await ensureWalletForUser(client, expiredContract.business_id);
  await client.query(
    `
    UPDATE wallets
    SET balance_available = balance_available + $2,
        balance = balance + $2
    WHERE id=$1
    `,
    [wallet.id, refundAmount]
  );
  await client.query(
    `
    INSERT INTO wallet_txns (wallet_id, amount, direction, reference)
    VALUES ($1,$2,'CREDIT',$3)
    `,
    [
      wallet.id,
      refundAmount,
      `ESCROW_RETURN:CONTRACT_EXPIRE:${expiredContract.id}`,
    ]
  );
}

async function compensatePayoutFailure(proofId: string, campaignId: string) {
  await withTransaction(async (client) => {
    const payoutRes = await client.query(
      'SELECT * FROM payout_requests WHERE proof_id=$1',
      [proofId]
    );
    const payout = payoutRes.rows[0];
    if (!payout || payout.status !== 'PROCESSING') {
      return;
    }
    await client.query(
      "UPDATE payout_requests SET status='FAILED' WHERE id=$1",
      [payout.id]
    );
    const campaignRes = await client.query(
      `
      SELECT budget_total, parent_campaign_id, bundle_root_campaign_id
      FROM campaigns
      WHERE id=$1
      LIMIT 1
      `,
      [campaignId]
    );
    const escrowRefundAmount = Number(campaignRes.rows[0]?.budget_total ?? payout.amount ?? 0);
    const escrowCampaignId = getEscrowCampaignId(campaignRes.rows[0] ?? { id: campaignId });
    await client.query(
      `UPDATE escrow_ledger
       SET amount_available = amount_available + $2,
            status = CASE
              WHEN amount_available + $2 >= amount_total THEN 'FUNDED'
              ELSE 'PARTIALLY_DISBURSED'
            END
        WHERE campaign_id=$1`,
      [escrowCampaignId, escrowRefundAmount]
    );
  });
}

async function processVerificationJob(job: any) {
  await pool.query(
    `UPDATE job_queue
     SET status='DONE',
         retry_reason='manual_admin_review_required',
         updated_at=now()
     WHERE id=$1`,
    [job.id]
  );
}

async function processPayoutJob(job: any) {
  const proofId = job.payload.proof_id;

  try {
    const proofRes = await pool.query('SELECT * FROM proofs WHERE id=$1', [proofId]);
    const proof = proofRes.rows[0];
    if (!proof) throw new Error('proof_not_found');
    if (proof.status !== 'VERIFIED') throw new Error('proof_not_verified');

    const sessionRes = await pool.query('SELECT * FROM verification_sessions WHERE id=$1', [proof.session_id]);
    const session = sessionRes.rows[0];
    if (!session) throw new Error('session_not_found');

    const campaignRes = await pool.query('SELECT * FROM campaigns WHERE id=$1', [session.campaign_id]);
    const campaign = campaignRes.rows[0];
    if (!campaign) throw new Error('campaign_not_found');

    const payoutRequest = await withTransaction(async (client) => {
      const isBusinessProof = proof.user_id === campaign.business_id;
      if (!isBusinessProof) {
        return preparePayoutRequest(client, proof, campaign);
      }
      return null;
    });

    if (payoutRequest) {
      // Wallet crediting is completed inside the transaction.
    }

    await pool.query(
      "UPDATE job_queue SET status='DONE', updated_at=now() WHERE id=$1",
      [job.id]
    );
  } catch (err: any) {
    try {
      const proofRes = await pool.query('SELECT * FROM proofs WHERE id=$1', [proofId]);
      const proof = proofRes.rows[0];
      if (proof) {
        const sessionRes = await pool.query('SELECT * FROM verification_sessions WHERE id=$1', [proof.session_id]);
        const session = sessionRes.rows[0];
        if (session) {
          await compensatePayoutFailure(proofId, session.campaign_id);
        }
      }
    } catch {
      // best-effort compensation only
    }
    const attempts = job.attempts + 1;
    const nextStatus = attempts >= job.max_attempts ? 'FAILED' : 'RETRY';
    const delay = Math.min(60 * attempts, 300);

    await pool.query(
      `UPDATE job_queue
       SET status=$2,
           attempts=$3,
           last_error=$4,
           run_at=now() + ($5 || ' seconds')::interval,
           updated_at=now()
       WHERE id=$1`,
      [job.id, nextStatus, attempts, err?.message ?? 'error', delay]
    );
  }
}

async function expireOverdueContractsIfDue() {
  const now = Date.now();
  if (now - lastContractExpirySweepAt < 30_000) return;
  lastContractExpirySweepAt = now;

  await withTransaction(async (client) => {
    const expired = await client.query(
      `UPDATE contracts ctr
       SET status='CANCELLED',
           cancelled_at=COALESCE(cancelled_at, now())
       FROM campaigns c
       WHERE ctr.campaign_id = c.id
         AND ctr.status='ACTIVE'
         AND ctr.contract_deadline_at IS NOT NULL
         AND ctr.contract_deadline_at < now()
        RETURNING
          ctr.id,
          ctr.campaign_id,
          c.execution_mode,
          c.business_id,
          c.budget_total,
          COALESCE(c.bundle_root_campaign_id, c.parent_campaign_id, c.id) AS escrow_campaign_id`
    );

    const openCampaignIds = expired.rows
      .filter((row: any) => row.execution_mode === 'OPEN_BUDGET')
      .map((row: any) => row.campaign_id);

    for (const row of expired.rows.filter((entry: any) => entry.execution_mode !== 'OPEN_BUDGET')) {
      await refundExpiredPrivateContractToWallet(client, row);
    }

    if (openCampaignIds.length > 0) {
      await client.query(
        `
        UPDATE campaigns
        SET last_allocated_at = now() - interval '2 hours'
        WHERE id = ANY($1::uuid[])
        `,
        [openCampaignIds]
      );
    }
  });
}

async function reallocateExpiredPublicAdvertContracts(client: any) {
  const PUBLIC_AD_ELIGIBLE_ROLES = ['ADMIN', 'AMBASSADOR', 'DUAL_USER'];
  const PUBLIC_AD_RATE = 50;

  // Find expired pending PUBLIC_ADVERT contracts
  const expiredRes = await client.query(
    `SELECT c.*
     FROM campaigns c
     WHERE c.parent_campaign_id IS NOT NULL
       AND c.execution_mode = 'PUBLIC_ADVERT'
       AND c.status = 'ACTIVE'
       AND c.public_allocation_expires_at IS NOT NULL
       AND c.public_allocation_expires_at < NOW()
       AND NOT EXISTS (
         SELECT 1 FROM verification_sessions vs
         WHERE vs.campaign_id = c.id AND vs.status IN ('ACTIVE', 'COMPLETED')
       )
     ORDER BY c.public_allocation_expires_at ASC
     LIMIT 50`
  );

  if (expiredRes.rows.length === 0) return;

  for (const expired of expiredRes.rows as any[]) {
    const rootId = expired.parent_campaign_id;

    // Get root campaign budget info
    const rootRes = await client.query(
      `SELECT *, public_ad_viewer_target, public_ad_rate_per_view FROM campaigns WHERE id=$1 LIMIT 1`,
      [rootId]
    );
    const root = rootRes.rows[0];
    if (!root) continue;

    // Count allocations per ambassador for this root (non-expired, non-cancelled)
    const allocCountRes = await client.query(
      `SELECT assigned_ambassador_id, COUNT(*)::int AS contract_count,
              MAX(last_allocated_at) AS last_allocated
       FROM campaigns
       WHERE parent_campaign_id = $1
         AND execution_mode = 'PUBLIC_ADVERT'
         AND id != $2
       GROUP BY assigned_ambassador_id`,
      [rootId, expired.id]
    );
    const countByAmbassador = new Map<string, { count: number; last: Date }>();
    for (const row of allocCountRes.rows as any[]) {
      countByAmbassador.set(row.assigned_ambassador_id, {
        count: Number(row.contract_count),
        last: new Date(row.last_allocated),
      });
    }

    // Get all ambassadors
    const ambRes = await client.query(
      `SELECT id, phone, COALESCE(NULLIF(max_status_viewers_12h, 0), 50)::int AS effective_viewers
       FROM users
       WHERE status = 'ACTIVE' AND role = ANY($1::text[])`,
      [PUBLIC_AD_ELIGIBLE_ROLES]
    );
    const ambassadors = ambRes.rows as any[];
    if (ambassadors.length === 0) continue;

    // Determine the minimum contract count in the pool (excluding the expired one's ambassador)
    const allCounts = ambassadors.map((a: any) => countByAmbassador.get(a.id)?.count ?? 0);
    const minCount = Math.min(...allCounts);

    // Priority: ambassadors with minCount contracts, sorted by least-recently allocated
    const candidates = ambassadors
      .filter((a: any) => a.id !== expired.assigned_ambassador_id)
      .map((a: any) => ({
        ...a,
        count: countByAmbassador.get(a.id)?.count ?? 0,
        last: countByAmbassador.get(a.id)?.last ?? new Date(0),
      }))
      .filter((a: any) => a.count === minCount)
      .sort((x: any, y: any) => x.last.getTime() - y.last.getTime());

    // If no minCount candidates, widen to all not already at max
    const finalCandidates =
      candidates.length > 0
        ? candidates
        : ambassadors
            .filter((a: any) => a.id !== expired.assigned_ambassador_id)
            .map((a: any) => ({
              ...a,
              count: countByAmbassador.get(a.id)?.count ?? 0,
              last: countByAmbassador.get(a.id)?.last ?? new Date(0),
            }))
            .sort((x: any, y: any) => x.last.getTime() - y.last.getTime());

    if (finalCandidates.length === 0) continue;

    const next = finalCandidates[0];
    const ambPayout = Number(next.effective_viewers) * PUBLIC_AD_RATE;
    const newExpiresAt = new Date(Date.now() + 60 * 60 * 1000); // +1 hour

    // Mark old contract as cancelled
    await client.query(
      `UPDATE campaigns SET status='CANCELLED' WHERE id=$1`,
      [expired.id]
    );

    // Create new contract for next ambassador
    const metaJson = root.execution_meta == null ? null : JSON.stringify(root.execution_meta);
    await client.query(
      `INSERT INTO campaigns (
         business_id, campaign_bundle_id, bundle_root_campaign_id, parent_campaign_id,
         assigned_ambassador_id, assigned_phone, title, platform, delivery_model,
         execution_mode, visibility, payout_amount, budget_total, impression_target,
         platform_fee_percent, business_wallet_mode, last_allocated_at, allocation_round,
         media_type, media_text, media_url, execution_meta, campaign_burst_mode,
         terms_keep_hours, terms_min_views, terms_requirement, status, start_date, end_date,
         public_distribution_round, public_allocation_expires_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,'PUBLIC_ADVERT','PRIVATE',$10,$11,$12,$13,$14,NOW(),$15,
         $16,$17,$18,$19::jsonb,$20,$21,$22,$23,'ACTIVE',$24,$25,$26,$27
       )`,
      [
        root.business_id,
        root.campaign_bundle_id ?? null,
        root.bundle_root_campaign_id ?? rootId,
        rootId,
        next.id,
        next.phone,
        root.title,
        root.platform,
        root.delivery_model ?? 'DETERMINISTIC',
        ambPayout,
        ambPayout,
        Number(next.effective_viewers),
        root.platform_fee_percent ?? 0,
        root.business_wallet_mode ?? 'CAMPAIGN_ONLY',
        expired.public_distribution_round ?? 1,
        root.media_type,
        root.media_text ?? null,
        root.media_url ?? null,
        metaJson,
        root.campaign_burst_mode ?? false,
        root.terms_keep_hours ?? 12,
        root.terms_min_views ?? null,
        root.terms_requirement ?? 'DURATION',
        root.start_date,
        root.end_date,
        (expired.public_distribution_round ?? 1),
        newExpiresAt,
      ]
    );

    console.info(
      `[PUBLIC_ADVERT] Reallocated expired contract ${expired.id} (was: ${expired.assigned_ambassador_id}) → new: ${next.id}`
    );
  }
}

async function runPublicAdvertReallocatorIfDue() {
  const now = Date.now();
  if (now - lastPublicAdvertReallocatorSweepAt < 60_000) return; // every 60 seconds
  lastPublicAdvertReallocatorSweepAt = now;

  await withTransaction(async (client) => {
    await reallocateExpiredPublicAdvertContracts(client);
  });
}

async function runOpenContractAllocatorIfDue() {
  const now = Date.now();
  if (now - lastOpenAllocatorSweepAt < 30_000) return;
  lastOpenAllocatorSweepAt = now;

  await withTransaction(async (client) => {
    await ensureCampaignAllocatorColumns(client);
    await ensureCreatorMarketingTables(client);
    await syncCreatorsFromUsers(client);
    await reallocateExpiredOpenAllocations(client);
    const roots = await getOpenRootCampaignsReadyForAllocation(client);
    for (const root of roots) {
      await allocateOpenCampaignShares(client, root);
    }
  });
}

async function runMonthlyManagerPayoutsIfDue() {
  const now = Date.now();
  if (now - lastMonthlyPayoutSweepAt < 60 * 60 * 1000) return;
  lastMonthlyPayoutSweepAt = now;

  const current = new Date();
  if (current.getUTCDate() !== 1) {
    return;
  }

  await withTransaction(async (client) => {
    await generateMonthlyPayouts(client, current);
  });
}

async function expireEndedAdvertListingsIfDue() {
  const TWO_MINUTES_MS = 2 * 60 * 1000;
  // We use the advert rollup timestamp as a co-timer (runs every 2 min independently)
  // Use a separate static tracker
  if (!((expireEndedAdvertListingsIfDue as any).__lastAt)) {
    (expireEndedAdvertListingsIfDue as any).__lastAt = 0;
  }
  if (Date.now() - (expireEndedAdvertListingsIfDue as any).__lastAt < TWO_MINUTES_MS) return;
  (expireEndedAdvertListingsIfDue as any).__lastAt = Date.now();

  const { rowCount } = await pool.query(`
    UPDATE advert_listings
    SET status = 'EXPIRED', updated_at = now()
    WHERE status = 'ACTIVE'
      AND admin_keep_alive = FALSE
      AND campaign_end_at IS NOT NULL
      AND campaign_end_at < now()
  `);

  if ((rowCount ?? 0) > 0) {
    console.info(`advert_listings_expired count=${rowCount}`);
  }
}

async function runAdvertAnalyticsRollupIfDue() {
  const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
  if (Date.now() - lastAdvertRollupSweepAt < SIX_HOURS_MS) return;
  lastAdvertRollupSweepAt = Date.now();

  await withTransaction(async (client) => {
    // Upsert daily rollup for yesterday and today across all active listings
    await client.query(`
      INSERT INTO advert_analytics_rollups
        (id, listing_id, rollup_date, visits, unique_visitors, cta_taps,
         whatsapp_taps, phone_taps, gallery_opens, offer_starts, avg_session_secs)
      SELECT
        gen_random_uuid(),
        s.listing_id,
        DATE(s.session_start) AS rollup_date,
        COUNT(*) AS visits,
        COUNT(*) FILTER (WHERE NOT s.is_return_visitor) AS unique_visitors,
        COALESCE(e.cta_taps, 0),
        COALESCE(e.whatsapp_taps, 0),
        COALESCE(e.phone_taps, 0),
        COALESCE(e.gallery_opens, 0),
        COALESCE(e.offer_starts, 0),
        COALESCE(AVG(s.session_duration_secs), 0) AS avg_session_secs
      FROM advert_page_sessions s
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE ev.event_type = 'CTA_TAP')       AS cta_taps,
          COUNT(*) FILTER (WHERE ev.event_type = 'WHATSAPP_TAP')  AS whatsapp_taps,
          COUNT(*) FILTER (WHERE ev.event_type = 'PHONE_TAP')     AS phone_taps,
          COUNT(*) FILTER (WHERE ev.event_type = 'GALLERY_OPEN')  AS gallery_opens,
          COUNT(*) FILTER (WHERE ev.event_type = 'OFFER_START')   AS offer_starts
        FROM advert_engagement_events ev
        WHERE ev.listing_id = s.listing_id
          AND DATE(ev.occurred_at) = DATE(s.session_start)
      ) e ON TRUE
      WHERE DATE(s.session_start) >= CURRENT_DATE - INTERVAL '2 days'
      GROUP BY s.listing_id, DATE(s.session_start), e.cta_taps, e.whatsapp_taps,
               e.phone_taps, e.gallery_opens, e.offer_starts
      ON CONFLICT (listing_id, rollup_date) DO UPDATE SET
        visits          = EXCLUDED.visits,
        unique_visitors = EXCLUDED.unique_visitors,
        cta_taps        = EXCLUDED.cta_taps,
        whatsapp_taps   = EXCLUDED.whatsapp_taps,
        phone_taps      = EXCLUDED.phone_taps,
        gallery_opens   = EXCLUDED.gallery_opens,
        offer_starts    = EXCLUDED.offer_starts,
        avg_session_secs = EXCLUDED.avg_session_secs
    `);
  });

  console.info('advert_analytics_rollup_complete');
}

async function loop() {
  while (true) {
    try {
      await expireOverdueContractsIfDue();
    } catch (err) {
      console.error('contract_expiry_sweep_failed', err);
    }

    try {
      await runOpenContractAllocatorIfDue();
    } catch (err) {
      console.error('open_contract_allocator_failed', err);
    }

    try {
      await runPublicAdvertReallocatorIfDue();
    } catch (err) {
      console.error('public_advert_reallocator_failed', err);
    }

    try {
      await runMonthlyManagerPayoutsIfDue();
    } catch (err) {
      console.error('monthly_manager_payouts_failed', err);
    }

    try {
      await expireEndedAdvertListingsIfDue();
    } catch (err) {
      console.error('advert_listing_expiry_sweep_failed', err);
    }

    try {
      await runAdvertAnalyticsRollupIfDue();
    } catch (err) {
      console.error('advert_analytics_rollup_failed', err);
    }

    const job = await fetchNextJob();

    if (!job) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }

    if (job.job_type === 'VERIFY_PROOF') {
      await processVerificationJob(job);
    } else if (job.job_type === 'PAYOUT_PROOF') {
      await processPayoutJob(job);
    } else if (job.job_type === 'PROCESS_MEDIA') {
      await processMediaJob(job);
    } else if (job.job_type === 'CLEANUP_MEDIA') {
      await cleanupMediaJob(job);
    } else {
      await pool.query(
        "UPDATE job_queue SET status='FAILED', last_error='unknown_job_type' WHERE id=$1",
        [job.id]
      );
    }
  }
}

// ─── PROCESS_MEDIA ────────────────────────────────────────────────────────────
// Fetches file metadata from Firebase, computes a sha256 hash, and marks the
// asset ready.  Heavy work (thumbnails, transcoding) can be added here later.

async function processMediaJob(job: any) {
  const { asset_id, object_name, mime_type, purpose } = job.payload as {
    asset_id: string;
    object_name: string;
    mime_type?: string;
    purpose?: string;
  };

  if (!asset_id || !object_name) {
    await pool.query(
      "UPDATE job_queue SET status='FAILED', last_error='missing_payload_fields', updated_at=now() WHERE id=$1",
      [job.id]
    );
    return;
  }

  try {
    await pool.query(
      "UPDATE media_assets SET processing_status='processing', updated_at=now() WHERE id=$1",
      [asset_id]
    );

    // Fetch GCS object metadata (size, content-type).
    const { getFirebaseObjectMetadata } = await import('./firebaseStorageWorker.js');
    const meta = await getFirebaseObjectMetadata(object_name);

    const fileSizeBytes = meta?.size ?? null;
    const assetType = (mime_type ?? '').startsWith('video/') ? 'video'
      : (mime_type ?? '').startsWith('image/') ? 'image'
      : 'document';

    // Proof assets need admin review before payout release.
    const proofPurposes = new Set([
      'ambassador_proof_screenshot',
      'ambassador_proof_screen_recording',
    ]);
    const verificationStatus = proofPurposes.has(purpose ?? '') ? 'needs_admin_review' : 'not_required';

    await pool.query(
      `UPDATE media_assets
       SET processing_status = 'ready',
           asset_type        = $2,
           file_size_bytes   = COALESCE($3, file_size_bytes),
           verification_status = CASE
             WHEN upload_purpose IN ('ambassador_proof_screenshot','ambassador_proof_screen_recording')
               AND verification_status = 'pending' THEN $4
             ELSE verification_status
           END,
           updated_at        = now()
       WHERE id = $1`,
      [asset_id, assetType, fileSizeBytes, verificationStatus]
    );

    await pool.query(
      "UPDATE job_queue SET status='DONE', updated_at=now() WHERE id=$1",
      [job.id]
    );
  } catch (err: any) {
    const attempts = job.attempts + 1;
    const nextStatus = attempts >= job.max_attempts ? 'FAILED' : 'RETRY';
    const delay = Math.min(30 * attempts, 180);

    if (nextStatus === 'FAILED') {
      await pool.query(
        "UPDATE media_assets SET processing_status='failed', updated_at=now() WHERE id=$1",
        [asset_id]
      );
    }

    await pool.query(
      `UPDATE job_queue
       SET status=$2, attempts=$3, last_error=$4,
           run_at=now() + ($5 || ' seconds')::interval, updated_at=now()
       WHERE id=$1`,
      [job.id, nextStatus, attempts, err?.message ?? 'error', delay]
    );
  }
}

// ─── CLEANUP_MEDIA ────────────────────────────────────────────────────────────
// Deletes orphaned or soft-deleted assets from Firebase Storage.
// Also sweeps abandoned pending_upload records older than 30 minutes.

async function cleanupMediaJob(job: any) {
  const { asset_id, object_name } = job.payload as { asset_id?: string; object_name?: string };

  try {
    if (object_name) {
      const { deleteFromFirebaseStorage } = await import('./firebaseStorageWorker.js');
      await deleteFromFirebaseStorage(object_name).catch(() => {/* 404 is fine */});
    }

    // Sweep abandoned pending_upload records older than 30 minutes.
    const abandoned = await pool.query(
      `SELECT id, original_storage_path
       FROM media_assets
       WHERE processing_status = 'pending_upload'
         AND created_at < now() - interval '30 minutes'
         AND deleted_at IS NULL
       LIMIT 50`
    );
    for (const row of abandoned.rows) {
      if (row.original_storage_path) {
        const { deleteFromFirebaseStorage } = await import('./firebaseStorageWorker.js');
        await deleteFromFirebaseStorage(row.original_storage_path).catch(() => {});
      }
      await pool.query(
        "UPDATE media_assets SET processing_status='deleted', deleted_at=now(), updated_at=now() WHERE id=$1",
        [row.id]
      );
    }

    await pool.query(
      "UPDATE job_queue SET status='DONE', updated_at=now() WHERE id=$1",
      [job.id]
    );
  } catch (err: any) {
    const attempts = job.attempts + 1;
    const nextStatus = attempts >= (job.max_attempts ?? 3) ? 'FAILED' : 'RETRY';
    await pool.query(
      `UPDATE job_queue SET status=$2, attempts=$3, last_error=$4, updated_at=now() WHERE id=$1`,
      [job.id, nextStatus, attempts, err?.message ?? 'error']
    );
  }
}

loop().catch((err) => {
  console.error(err);
  process.exit(1);
});
