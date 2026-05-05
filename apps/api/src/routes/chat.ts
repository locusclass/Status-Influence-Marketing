import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPublicContractUnitRate, MediaTypeSchema } from '@prime/shared';
import { v4 as uuid } from 'uuid';

import { withTransaction } from '../db.js';
import {
  ACCOUNT_ROLE_BUSINESS,
  ACCOUNT_ROLE_AMBASSADOR,
  ACCOUNT_ROLE_DUAL_USER,
  canAccessBusinessFeatures,
  canAccessAmbassadorFeatures,
  normalizeAccountRole,
  normalizeActiveRole,
} from '../services/roles.js';
import {
  CHAT_THREAD_KIND_DIRECT,
  CHAT_THREAD_KIND_GROUP_DEAL,
  CHAT_THREAD_KIND_GROUP_ROOM,
  CHAT_OFFER_RESPONSE_ACCEPT,
  CHAT_OFFER_RESPONSE_COUNTER,
  CHAT_OFFER_RESPONSE_REJECT,
  CHAT_OFFER_STATUS_ACCEPTED,
  CHAT_OFFER_STATUS_COUNTERED,
  CHAT_OFFER_STATUS_PENDING,
  CHAT_OFFER_STATUS_REJECTED,
  ensureChatSchema,
} from '../services/chat.js';
import {
  ensureAmbassadorReviewsSchema,
  listAmbassadorReviews,
  loadLatestCompletedContractForReview,
  loadAmbassadorReviewSummaryMap,
} from '../services/ambassadorReviews.js';
import {
  buildPhoneLookupVariants,
  splitSearchTerms,
} from '../services/contactLookup.js';
import { createUserNotifications } from '../services/userSignals.js';

const groupDealThreadSchema = z.object({
  media_url: z.string().url().optional(),
  media_urls: z.array(z.string().url()).min(1).max(8).optional(),
  media_type: z.enum(['IMAGE', 'VIDEO', 'TEXT']),
}).superRefine((value, ctx) => {
  if (normalizeMediaUrls(value).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['media_urls'],
      message: 'At least one media asset is required.',
    });
  }
});

const directThreadSchema = z.object({
  participant_id: z.string().uuid(),
  media_url: z.string().url().optional(),
  media_urls: z.array(z.string().url()).min(1).max(8).optional(),
  media_type: z.enum(['IMAGE', 'VIDEO', 'TEXT']),
}).superRefine((value, ctx) => {
  if (normalizeMediaUrls(value).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['media_urls'],
      message: 'At least one media asset is required.',
    });
  }
});

const sendMessageSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});

const updateTypingSchema = z.object({
  draft_text: z.string().max(4000).default(''),
  is_typing: z.boolean().optional(),
});

const createGroupSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(400).default(''),
  logo_url: z.string().trim().max(1024).default(''),
  public_price_ugx: z.number().int().min(0).default(0),
  invitee_ids: z.array(z.string().uuid()).max(50).default([]),
});

const updateGroupSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    description: z.string().trim().max(400).optional(),
    logo_url: z.string().trim().max(1024).optional(),
    public_price_ugx: z.number().int().min(0).optional(),
  })
  .refine(
    (value) =>
      typeof value.name === 'string' ||
      typeof value.description === 'string' ||
      typeof value.logo_url === 'string' ||
      typeof value.public_price_ugx === 'number',
    {
      message: 'At least one group field must be provided.',
      path: ['name'],
    }
  );

const inviteMembersSchema = z.object({
  member_ids: z.array(z.string().uuid()).min(1).max(50),
});

const respondInviteSchema = z.object({
  action: z.enum(['ACCEPT', 'DECLINE']),
});

const setGroupPriceSchema = z.object({
  business_id: z.string().uuid(),
  override_price_ugx: z.number().int().min(0),
});

const offerContextSchema = z.object({
  media_type: MediaTypeSchema.default('IMAGE'),
});

const createOfferSchema = z
  .object({
    media_type: MediaTypeSchema,
    media_url: z.string().url().optional(),
    media_urls: z.array(z.string().url()).max(8).optional(),
    media_text: z.string().trim().min(3).max(4000).optional(),
    proposed_price_ugx: z.number().int().positive(),
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    const hasMediaUrl = normalizeMediaUrls(value).length > 0;
    const hasMediaText =
      typeof value.media_text === 'string' &&
      value.media_text.trim().length > 0;
    if (!hasMediaUrl && !hasMediaText) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['media_url'],
        message: 'Either media_url or media_text is required.',
      });
    }
  });

const respondOfferSchema = z
  .object({
    action: z.enum([
      CHAT_OFFER_RESPONSE_ACCEPT,
      CHAT_OFFER_RESPONSE_COUNTER,
      CHAT_OFFER_RESPONSE_REJECT,
    ]),
    counter_price_ugx: z.number().int().positive().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.action === CHAT_OFFER_RESPONSE_COUNTER &&
      typeof value.counter_price_ugx !== 'number'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['counter_price_ugx'],
        message: 'counter_price_ugx is required when countering.',
      });
    }
  });

const voteGroupOfferSchema = z
  .object({
    action: z.enum([
      CHAT_OFFER_RESPONSE_ACCEPT,
      CHAT_OFFER_RESPONSE_COUNTER,
      CHAT_OFFER_RESPONSE_REJECT,
    ]),
    counter_price_ugx: z.number().int().positive().optional(),
    note: z.string().trim().max(500).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.action === CHAT_OFFER_RESPONSE_COUNTER &&
      typeof value.counter_price_ugx !== 'number'
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['counter_price_ugx'],
        message: 'counter_price_ugx is required when countering.',
      });
    }
  });

type ChatUserSummary = {
  id: string;
  public_id: string;
  display_name: string;
  role: string;
  active_role: string;
  is_online: boolean;
  last_seen_at: string | null;
  profile_type: 'USER';
  verified_views_24h: number;
  max_status_viewers_12h: number;
  current_business_viewers: number;
  private_contract_rate_ugx: number;
  official_price_ugx: number;
  price_privacy_mode: 'NEGOTIABLE' | 'FIXED';
  negotiation_allowed: boolean;
  has_existing_thread: boolean;
  direct_thread_id: string | null;
  average_rating: number;
  rating_count: number;
  latest_review_comment: string | null;
};

function isAmbassadorChatBizRole(role: unknown) {
  const normalizedRole = normalizeAccountRole(role);
  return (
    normalizedRole === ACCOUNT_ROLE_AMBASSADOR ||
    normalizedRole === ACCOUNT_ROLE_DUAL_USER
  );
}

function isBusinessChatBizRole(role: unknown) {
  const normalizedRole = normalizeAccountRole(role);
  return (
    normalizedRole === ACCOUNT_ROLE_BUSINESS ||
    normalizedRole === ACCOUNT_ROLE_DUAL_USER
  );
}

function authUserId(request: any) {
  const authSub = (request.user as any)?.sub as string | undefined;
  return authSub === 'ariaka-access'
    ? '00000000-0000-0000-0000-000000000000'
    : authSub;
}

function authAccountRole(request: any) {
  return String((request.user as any)?.role ?? '').trim().toUpperCase();
}

function authActiveRole(request: any) {
  return normalizeActiveRole(
    (request.user as any)?.active_role,
    (request.user as any)?.role
  );
}

function timestampText(value: unknown) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parseCursor(value: unknown) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function maxCursor(values: unknown[]) {
  let latest: string | null = null;
  let latestMs = -1;
  for (const value of values) {
    const iso = timestampText(value);
    if (!iso) continue;
    const millis = Date.parse(iso);
    if (Number.isNaN(millis) || millis <= latestMs) continue;
    latest = iso;
    latestMs = millis;
  }
  return latest ?? new Date(0).toISOString();
}

function toInt(value: unknown) {
  const numberValue = Number(value ?? 0);
  if (!Number.isFinite(numberValue)) return 0;
  return Math.max(0, Math.trunc(numberValue));
}

function normalizePricePrivacyMode(value: unknown) {
  return String(value ?? 'NEGOTIABLE').trim().toUpperCase() === 'FIXED'
    ? 'FIXED'
    : 'NEGOTIABLE';
}

function resolveDeterministicEngagements24h(
  provenEngagements24h: number,
  maxStatusViewers12h: number
) {
  if (provenEngagements24h > 0) {
    return provenEngagements24h;
  }
  const capacity24h = Math.max(0, maxStatusViewers12h) * 2;
  return Math.max(1, capacity24h);
}

function resolveOfficialPriceUgx(row: any, mediaType: 'IMAGE' | 'VIDEO' | 'TEXT' = 'IMAGE') {
  const privateRateUgx = toInt(row?.private_contract_rate_ugx);
  if (privateRateUgx > 0) {
    return privateRateUgx;
  }
  const pricingReference = resolveDeterministicEngagements24h(
    toInt(row?.verified_views_24h),
    toInt(row?.max_status_viewers_12h)
  );
  return pricingReference * getPublicContractUnitRate(mediaType);
}

function resolveGroupPricePrivacyMode(values: unknown[]) {
  let negotiableCount = 0;
  let fixedCount = 0;
  for (const value of values) {
    if (normalizePricePrivacyMode(value) === 'FIXED') {
      fixedCount += 1;
    } else {
      negotiableCount += 1;
    }
  }
  return negotiableCount > fixedCount ? 'NEGOTIABLE' : 'FIXED';
}

function quorumThreshold(memberCount: number) {
  return Math.max(1, Math.ceil(Math.max(0, memberCount) * 0.51));
}

function displayNameFromRow(row: any) {
  return String(
    row?.display_name ??
      row?.full_name ??
      row?.email ??
      row?.phone ??
      'Participant'
  ).trim();
}

function serializeUserSummary(row: any): ChatUserSummary {
  const pricePrivacyMode = normalizePricePrivacyMode(row?.price_privacy_mode);
  const officialPriceUgx =
    toInt(row?.official_price_ugx) > 0
      ? toInt(row?.official_price_ugx)
      : resolveOfficialPriceUgx(row);
  return {
    id: String(row?.id ?? ''),
    public_id: String(row?.public_id ?? ''),
    display_name: displayNameFromRow(row),
    role: String(row?.role ?? 'AMBASSADOR'),
    active_role: String(row?.active_role ?? row?.role ?? 'AMBASSADOR'),
    is_online: row?.is_online === true,
    last_seen_at: timestampText(row?.last_seen_at),
    profile_type: 'USER',
    verified_views_24h: toInt(row?.verified_views_24h),
    max_status_viewers_12h: toInt(row?.max_status_viewers_12h),
    current_business_viewers: toInt(row?.current_business_viewers),
    private_contract_rate_ugx: toInt(row?.private_contract_rate_ugx),
    official_price_ugx: officialPriceUgx,
    price_privacy_mode: pricePrivacyMode,
    negotiation_allowed: pricePrivacyMode === 'NEGOTIABLE',
    has_existing_thread: row?.has_existing_thread === true,
    direct_thread_id:
      row?.direct_thread_id == null ? null : String(row.direct_thread_id),
    average_rating: 0,
    rating_count: 0,
    latest_review_comment: null,
  };
}

function serializeMessage(row: any) {
  return {
    id: String(row?.id ?? ''),
    body: String(row?.body ?? ''),
    sender_id: String(row?.sender_id ?? ''),
    sender_name: displayNameFromRow(row),
    created_at: timestampText(row?.created_at),
  };
}

function serializeTypingState(row: any) {
  return {
    user_id: String(row?.user_id ?? ''),
    draft_text: String(row?.draft_text ?? ''),
    updated_at: timestampText(row?.updated_at),
    display_name: displayNameFromRow(row),
    public_id: String(row?.public_id ?? ''),
  };
}

function roundPercent(value: number) {
  return Math.round(value * 100) / 100;
}

async function loadUserSummary(client: any, userId: string) {
  const res = await client.query(
    `
    SELECT
      u.id,
      u.public_id,
      COALESCE(NULLIF(u.full_name, ''), NULLIF(u.email, ''), NULLIF(u.phone, ''), 'Participant') AS display_name,
      COALESCE(NULLIF(u.role, ''), 'AMBASSADOR') AS role,
      COALESCE(NULLIF(u.active_role, ''), COALESCE(NULLIF(u.role, ''), 'AMBASSADOR')) AS active_role,
      u.last_seen_at,
      (u.last_seen_at >= NOW() - interval '2 minutes') AS is_online,
      COALESCE(u.max_status_viewers_12h, 0)::int AS max_status_viewers_12h,
      COALESCE(u.current_business_viewers, 0)::int AS current_business_viewers,
      COALESCE(u.private_contract_rate_ugx, 0)::int AS private_contract_rate_ugx,
      COALESCE(NULLIF(u.price_privacy_mode, ''), 'NEGOTIABLE') AS price_privacy_mode,
      COALESCE(view_stats.views_24h, 0)::int AS verified_views_24h
    FROM users u
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(COALESCE(p.observed_views, 0)), 0)::int AS views_24h
      FROM proofs p
      JOIN verification_sessions s ON s.id = p.session_id
      WHERE p.user_id = u.id
        AND p.status = 'VERIFIED'
        AND p.decision = 'VERIFIED'
        AND p.created_at >= NOW() - interval '24 hours'
        AND s.platform = 'WHATSAPP_STATUS'
    ) view_stats ON TRUE
    WHERE u.id = $1
    LIMIT 1
    `,
    [userId]
  );
  return res.rows[0]
    ? applyAmbassadorReviewSummary(client, serializeUserSummary(res.rows[0]))
    : null;
}

async function resolveAmbassadorProfileUser(client: any, reference: string) {
  const normalizedReference = String(reference ?? '').trim();
  if (!normalizedReference) return null;
  const res = await client.query(
    `
    SELECT id, role
    FROM users
    WHERE id::text = $1
       OR public_id = $1
    LIMIT 1
    `,
    [normalizedReference]
  );
  const row = res.rows[0];
  if (!row || !isAmbassadorChatBizRole(row.role)) {
    return null;
  }
  return row;
}

function usersCanChatDirectly(
  currentActiveRole: string,
  participantAccountRole: unknown
) {
  const normalizedActiveRole = normalizeActiveRole(
    currentActiveRole,
    currentActiveRole
  );
  if (normalizedActiveRole === ACCOUNT_ROLE_BUSINESS) {
    return isAmbassadorChatBizRole(participantAccountRole);
  }
  if (normalizedActiveRole === ACCOUNT_ROLE_AMBASSADOR) {
    return isBusinessChatBizRole(participantAccountRole);
  }
  return (
    isBusinessChatBizRole(participantAccountRole) ||
    isAmbassadorChatBizRole(participantAccountRole)
  );
}

async function ensureDirectThread(
  client: any,
  userId: string,
  participantId: string,
  mediaUrl: string,
  mediaType: string
) {
  const directKey = [userId, participantId].sort().join(':');
  const threadRes = await client.query(
    `
    INSERT INTO chat_threads (kind, direct_key, created_by, media_url, media_type)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (direct_key) DO UPDATE
      SET media_url = EXCLUDED.media_url,
          media_type = EXCLUDED.media_type
    RETURNING *
    `,
    [CHAT_THREAD_KIND_DIRECT, directKey, userId, mediaUrl, mediaType]
  );
  const thread = threadRes.rows[0];
  await client.query(
    `
    INSERT INTO chat_thread_members (thread_id, user_id)
    VALUES ($1, $2), ($1, $3)
    ON CONFLICT DO NOTHING
    `,
    [thread.id, userId, participantId]
  );
  return thread;
}

async function assertThreadMember(client: any, threadId: string, userId: string) {
  const res = await client.query(
    `
    SELECT t.*
    FROM chat_threads t
    JOIN chat_thread_members member ON member.thread_id = t.id
    WHERE t.id = $1
      AND member.user_id = $2
    LIMIT 1
    `,
    [threadId, userId]
  );
  return res.rows[0] ?? null;
}

async function loadLastMessage(client: any, threadId: string) {
  const res = await client.query(
    `
    SELECT
      msg.id,
      msg.body,
      msg.sender_id,
      msg.created_at,
      COALESCE(NULLIF(u.full_name, ''), NULLIF(u.email, ''), NULLIF(u.phone, ''), 'Participant') AS display_name
    FROM chat_messages msg
    JOIN users u ON u.id = msg.sender_id
    WHERE msg.thread_id = $1
    ORDER BY msg.created_at DESC
    LIMIT 1
    `,
    [threadId]
  );
  return res.rows[0] ?? null;
}

function normalizeMediaUrls(value: {
  media_url?: unknown;
  media_urls?: unknown;
}) {
  const urls = [
    ...(Array.isArray(value.media_urls) ? value.media_urls : []),
    value.media_url,
  ]
    .map((entry) => String(entry ?? '').trim())
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(urls));
}

function primaryMediaUrl(value: { media_url?: unknown; media_urls?: unknown }) {
  return normalizeMediaUrls(value)[0] ?? null;
}

async function applyAmbassadorReviewSummary<T extends ChatUserSummary>(
  client: any,
  summary: T | null
) {
  if (!summary) return null;
  const summaryMap = await loadAmbassadorReviewSummaryMap(client, [summary.id]);
  const review = summaryMap.get(summary.id);
  return {
    ...summary,
    average_rating: Number(review?.average_rating ?? 0),
    rating_count: Math.max(0, Number(review?.rating_count ?? 0)),
    latest_review_comment: review?.latest_comment ?? null,
  };
}

async function applyAmbassadorReviewSummaries<T extends ChatUserSummary>(
  client: any,
  summaries: T[]
) {
  if (summaries.length === 0) return summaries;
  const summaryMap = await loadAmbassadorReviewSummaryMap(
    client,
    summaries.map((entry) => entry.id)
  );
  return summaries.map((entry) => {
    const review = summaryMap.get(entry.id);
    return {
      ...entry,
      average_rating: Number(review?.average_rating ?? 0),
      rating_count: Math.max(0, Number(review?.rating_count ?? 0)),
      latest_review_comment: review?.latest_comment ?? null,
    };
  });
}

const createAmbassadorReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(400).optional(),
});

function serializeOfferPreview(row: any) {
  return {
    id: String(row?.id ?? ''),
    status: String(row?.status ?? CHAT_OFFER_STATUS_PENDING),
    proposed_price_ugx: toInt(row?.proposed_price_ugx),
    resolved_price_ugx:
      row?.resolved_price_ugx == null ? null : toInt(row?.resolved_price_ugx),
    offeror_id: String(row?.offeror_id ?? ''),
    offeror_name: displayNameFromRow(row),
    note: String(row?.note ?? ''),
    created_at: timestampText(row?.created_at),
    updated_at: timestampText(row?.updated_at),
  };
}

async function loadLatestThreadOfferPreview(client: any, threadId: string) {
  const res = await client.query(
    `
    SELECT
      offer.id,
      offer.status,
      offer.proposed_price_ugx,
      offer.resolved_price_ugx,
      offer.offeror_id,
      offer.note,
      offer.created_at,
      offer.updated_at,
      COALESCE(NULLIF(u.full_name, ''), NULLIF(u.email, ''), NULLIF(u.phone, ''), 'Participant') AS display_name
    FROM chat_offer_events offer
    JOIN users u ON u.id = offer.offeror_id
    WHERE offer.thread_id = $1
    ORDER BY offer.created_at DESC
    LIMIT 1
    `,
    [threadId]
  );
  return res.rows[0] ?? null;
}

async function loadUnreadCount(client: any, threadId: string, userId: string) {
  const res = await client.query(
    `
    SELECT (
      SELECT COUNT(*)::int
      FROM chat_messages msg
      JOIN chat_thread_members member
        ON member.thread_id = msg.thread_id
       AND member.user_id = $2
      WHERE msg.thread_id = $1
        AND msg.sender_id <> $2
        AND (member.last_read_at IS NULL OR msg.created_at > member.last_read_at)
    ) + (
      SELECT COUNT(*)::int
      FROM chat_offer_events offer
      JOIN chat_thread_members member
        ON member.thread_id = offer.thread_id
       AND member.user_id = $2
      WHERE offer.thread_id = $1
        AND offer.offeror_id <> $2
        AND (
          member.last_read_at IS NULL OR
          COALESCE(offer.updated_at, offer.created_at) > member.last_read_at
        )
    ) AS unread_count
    `,
    [threadId, userId]
  );
  return toInt(res.rows[0]?.unread_count);
}

async function loadLiveDraftText(client: any, threadId: string, userId: string) {
  const res = await client.query(
    `
    SELECT state.draft_text
    FROM chat_typing_states state
    WHERE state.thread_id = $1
      AND state.user_id <> $2
      AND state.is_typing = TRUE
      AND state.updated_at >= NOW() - interval '15 seconds'
    ORDER BY state.updated_at DESC
    LIMIT 1
    `,
    [threadId, userId]
  );
  return String(res.rows[0]?.draft_text ?? '').trim();
}

async function loadDirectCounterpart(client: any, threadId: string, userId: string) {
  const res = await client.query(
    `
    SELECT
      u.id,
      u.public_id,
      COALESCE(NULLIF(u.full_name, ''), NULLIF(u.email, ''), NULLIF(u.phone, ''), 'Participant') AS display_name,
      COALESCE(NULLIF(u.role, ''), 'AMBASSADOR') AS role,
      COALESCE(NULLIF(u.active_role, ''), COALESCE(NULLIF(u.role, ''), 'AMBASSADOR')) AS active_role,
      u.last_seen_at,
      (u.last_seen_at >= NOW() - interval '2 minutes') AS is_online,
      COALESCE(u.max_status_viewers_12h, 0)::int AS max_status_viewers_12h,
      COALESCE(u.current_business_viewers, 0)::int AS current_business_viewers,
      COALESCE(u.private_contract_rate_ugx, 0)::int AS private_contract_rate_ugx,
      COALESCE(NULLIF(u.price_privacy_mode, ''), 'NEGOTIABLE') AS price_privacy_mode,
      COALESCE(view_stats.views_24h, 0)::int AS verified_views_24h
    FROM chat_thread_members member
    JOIN users u ON u.id = member.user_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(COALESCE(p.observed_views, 0)), 0)::int AS views_24h
      FROM proofs p
      JOIN verification_sessions s ON s.id = p.session_id
      WHERE p.user_id = u.id
        AND p.status = 'VERIFIED'
        AND p.decision = 'VERIFIED'
        AND p.created_at >= NOW() - interval '24 hours'
        AND s.platform = 'WHATSAPP_STATUS'
    ) view_stats ON TRUE
    WHERE member.thread_id = $1
      AND member.user_id <> $2
    ORDER BY member.joined_at ASC
    LIMIT 1
    `,
    [threadId, userId]
  );
  return res.rows[0]
    ? applyAmbassadorReviewSummary(client, serializeUserSummary(res.rows[0]))
    : null;
}

async function listThreadMessages(
  client: any,
  threadId: string,
  options: {
    since?: string | null;
    limit?: number;
  } = {}
) {
  const params: any[] = [threadId];
  let sql = `
    SELECT
      msg.id,
      msg.body,
      msg.sender_id,
      msg.created_at,
      COALESCE(NULLIF(u.full_name, ''), NULLIF(u.email, ''), NULLIF(u.phone, ''), 'Participant') AS display_name
    FROM chat_messages msg
    JOIN users u ON u.id = msg.sender_id
    WHERE msg.thread_id = $1
  `;

  if (options.since) {
    params.push(options.since);
    sql += `
      AND msg.created_at > $2::timestamptz
      ORDER BY msg.created_at ASC
    `;
  } else {
    params.push(Math.min(Math.max(Number(options.limit ?? 80), 1), 200));
    sql += `
      ORDER BY msg.created_at DESC
      LIMIT $2
    `;
  }

  const res = await client.query(sql, params);
  const rows = options.since ? res.rows : [...res.rows].reverse();
  return rows.map(serializeMessage);
}

async function listActiveTypingStates(client: any, threadId: string, userId: string) {
  const res = await client.query(
    `
    SELECT
      state.user_id,
      state.draft_text,
      state.updated_at,
      u.public_id,
      COALESCE(NULLIF(u.full_name, ''), NULLIF(u.email, ''), NULLIF(u.phone, ''), 'Participant') AS display_name
    FROM chat_typing_states state
    JOIN users u ON u.id = state.user_id
    WHERE state.thread_id = $1
      AND state.user_id <> $2
      AND state.is_typing = TRUE
      AND state.updated_at >= NOW() - interval '15 seconds'
    ORDER BY state.updated_at DESC
    `,
    [threadId, userId]
  );
  return res.rows.map(serializeTypingState);
}

async function markThreadRead(client: any, threadId: string, userId: string) {
  await client.query(
    `
    UPDATE chat_thread_members
    SET last_read_at = NOW()
    WHERE thread_id = $1
      AND user_id = $2
    `,
    [threadId, userId]
  );
}

async function loadGroupMembership(client: any, groupId: string, userId: string) {
  const res = await client.query(
    `
    SELECT
      membership.*,
      g.thread_id,
      g.name
    FROM chat_group_memberships membership
    JOIN chat_groups g ON g.id = membership.group_id
    WHERE membership.group_id = $1
      AND membership.user_id = $2
    LIMIT 1
    `,
    [groupId, userId]
  );
  return res.rows[0] ?? null;
}

async function loadGroupById(client: any, groupId: string) {
  const res = await client.query(
    `
    SELECT *
    FROM chat_groups
    WHERE id = $1
    LIMIT 1
    `,
    [groupId]
  );
  return res.rows[0] ?? null;
}

async function loadGroupByThreadId(client: any, threadId: string) {
  const res = await client.query(
    `
    SELECT *
    FROM chat_groups
    WHERE thread_id = $1
    LIMIT 1
    `,
    [threadId]
  );
  return res.rows[0] ?? null;
}

async function loadGroupDealByThreadId(client: any, threadId: string) {
  const res = await client.query(
    `
    SELECT
      deal.*,
      g.name AS group_name
    FROM chat_group_deal_threads deal
    JOIN chat_groups g ON g.id = deal.group_id
    WHERE deal.thread_id = $1
    LIMIT 1
    `,
    [threadId]
  );
  return res.rows[0] ?? null;
}

async function listGroupMemberViewerRows(client: any, groupId: string) {
  const res = await client.query(
    `
    SELECT
      membership.user_id,
      membership.role AS membership_role,
      membership.joined_at,
      u.public_id,
      COALESCE(NULLIF(u.full_name, ''), NULLIF(u.email, ''), NULLIF(u.phone, ''), 'Participant') AS display_name,
      COALESCE(NULLIF(u.role, ''), 'AMBASSADOR') AS role,
      COALESCE(NULLIF(u.active_role, ''), COALESCE(NULLIF(u.role, ''), 'AMBASSADOR')) AS active_role,
      u.last_seen_at,
      (u.last_seen_at >= NOW() - interval '2 minutes') AS is_online,
      COALESCE(u.max_status_viewers_12h, 0)::int AS max_status_viewers_12h,
      COALESCE(u.private_contract_rate_ugx, 0)::int AS private_contract_rate_ugx,
      COALESCE(NULLIF(u.price_privacy_mode, ''), 'NEGOTIABLE') AS price_privacy_mode,
      COALESCE(view_stats.views_24h, 0)::int AS viewers_24h
    FROM chat_group_memberships membership
    JOIN users u ON u.id = membership.user_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(COALESCE(p.observed_views, 0)), 0)::int AS views_24h
      FROM proofs p
      JOIN verification_sessions s ON s.id = p.session_id
      WHERE p.user_id = membership.user_id
        AND p.status = 'VERIFIED'
        AND p.decision = 'VERIFIED'
        AND p.created_at >= NOW() - interval '24 hours'
        AND s.platform = 'WHATSAPP_STATUS'
    ) view_stats ON TRUE
    WHERE membership.group_id = $1
      AND membership.status = 'ACTIVE'
    ORDER BY
      CASE WHEN membership.role = 'ADMIN' THEN 0 ELSE 1 END,
      membership.joined_at ASC
    `,
    [groupId]
  );
  return res.rows;
}

async function loadGroupPriceOverride(
  client: any,
  groupId: string,
  businessId?: string | null
) {
  const normalizedBusinessId = String(businessId ?? '').trim();
  if (!normalizedBusinessId) {
    return null;
  }
  const res = await client.query(
    `
    SELECT override_price_ugx
    FROM chat_group_price_overrides
    WHERE group_id = $1
      AND business_id = $2
    LIMIT 1
    `,
    [groupId, normalizedBusinessId]
  );
  return res.rows[0] ? toInt(res.rows[0].override_price_ugx) : null;
}

async function buildGroupSnapshot(
  client: any,
  groupId: string,
  options: {
    currentUserId?: string | null;
    pricingBusinessId?: string | null;
    includeMembers?: boolean;
  } = {}
) {
  const res = await client.query(
    `
    SELECT
      g.id,
      g.public_id,
      g.thread_id,
      g.name,
      g.description,
      g.logo_url,
      g.public_price_ugx,
      g.created_at,
      g.updated_at,
      creator.id AS creator_id,
      creator.public_id AS creator_public_id,
      COALESCE(NULLIF(creator.full_name, ''), NULLIF(creator.email, ''), NULLIF(creator.phone, ''), 'Participant') AS creator_display_name,
      COALESCE(NULLIF(creator.role, ''), 'AMBASSADOR') AS creator_role,
      COALESCE(NULLIF(creator.active_role, ''), COALESCE(NULLIF(creator.role, ''), 'AMBASSADOR')) AS creator_active_role,
      creator.last_seen_at AS creator_last_seen_at,
      (creator.last_seen_at >= NOW() - interval '2 minutes') AS creator_is_online,
      membership.role AS current_membership_role,
      membership.status AS current_membership_status
    FROM chat_groups g
    LEFT JOIN users creator ON creator.id = g.created_by
    LEFT JOIN chat_group_memberships membership
      ON membership.group_id = g.id
     AND membership.user_id = $2
    WHERE g.id = $1
    LIMIT 1
    `,
    [groupId, options.currentUserId ?? null]
  );
  const groupRow = res.rows[0];
  if (!groupRow) return null;

  const memberRows = await listGroupMemberViewerRows(client, groupId);
  const capacity24h = memberRows.reduce(
    (sum: number, row: any) => sum + toInt(row.viewers_24h),
    0
  );
  const memberCount = memberRows.length;
  const aggregatedOfficialPrice = memberRows.reduce(
    (sum: number, row: any) => sum + resolveOfficialPriceUgx(row),
    0
  );
  const effectivePriceOverride = await loadGroupPriceOverride(
    client,
    groupId,
    options.pricingBusinessId
  );
  const publicPriceUgx = toInt(groupRow.public_price_ugx);
  const officialPriceUgx =
    publicPriceUgx > 0 ? publicPriceUgx : aggregatedOfficialPrice;
  const groupPricePrivacyMode = resolveGroupPricePrivacyMode(
    memberRows.map((row: any) => row.price_privacy_mode)
  );

  const rawMembers = memberRows.map((row: any) => {
    const viewers24h = toInt(row.viewers_24h);
    const officialPriceUgx = resolveOfficialPriceUgx(row);
    return {
      ...serializeUserSummary({
        id: row.user_id,
        public_id: row.public_id,
        display_name: row.display_name,
        role: row.role,
        active_role: row.active_role,
        last_seen_at: row.last_seen_at,
        is_online: row.is_online,
        max_status_viewers_12h: row.max_status_viewers_12h,
        private_contract_rate_ugx: row.private_contract_rate_ugx,
        price_privacy_mode: row.price_privacy_mode,
        verified_views_24h: viewers24h,
        official_price_ugx: officialPriceUgx,
      }),
      group_role: String(row.membership_role ?? 'MEMBER'),
      viewers_24h: viewers24h,
      share_percent: capacity24h <= 0 ? 0 : roundPercent((viewers24h / capacity24h) * 100),
      joined_at: timestampText(row.joined_at),
    };
  });
  const members = await applyAmbassadorReviewSummaries(client, rawMembers);
  const creatorSummary =
    groupRow.creator_id == null
      ? null
      : await applyAmbassadorReviewSummary(
          client,
          serializeUserSummary({
            id: groupRow.creator_id,
            public_id: groupRow.creator_public_id,
            display_name: groupRow.creator_display_name,
            role: groupRow.creator_role,
            active_role: groupRow.creator_active_role,
            last_seen_at: groupRow.creator_last_seen_at,
            is_online: groupRow.creator_is_online,
          })
        );

  return {
    profile_type: 'GROUP',
    id: String(groupRow.id),
    public_id: String(groupRow.public_id ?? ''),
    thread_id: String(groupRow.thread_id ?? ''),
    name: String(groupRow.name ?? 'Group Pool').trim(),
    description: String(groupRow.description ?? '').trim(),
    logo_url: String(groupRow.logo_url ?? '').trim(),
    public_price_ugx: toInt(groupRow.public_price_ugx),
    effective_price_ugx:
      effectivePriceOverride == null
        ? officialPriceUgx
        : effectivePriceOverride,
    official_price_ugx: officialPriceUgx,
    override_applied: effectivePriceOverride != null,
    price_privacy_mode: groupPricePrivacyMode,
    negotiation_allowed: groupPricePrivacyMode === 'NEGOTIABLE',
    capacity_24h: capacity24h,
    total_verified_views_24h: capacity24h,
    member_count: memberCount,
    created_at: timestampText(groupRow.created_at),
    updated_at: timestampText(groupRow.updated_at),
    membership_role:
      groupRow.current_membership_role == null
        ? null
        : String(groupRow.current_membership_role),
    membership_status:
      groupRow.current_membership_status == null
        ? null
        : String(groupRow.current_membership_status),
    is_admin:
      String(groupRow.current_membership_role ?? '') === 'ADMIN' &&
      String(groupRow.current_membership_status ?? '') === 'ACTIVE',
    creator:
      creatorSummary,
    members: options.includeMembers ? members : [],
  };
}

async function listChatContacts(client: any, userId: string) {
  const res = await client.query(
    `
    SELECT DISTINCT
      u.id,
      u.public_id,
      COALESCE(NULLIF(u.full_name, ''), NULLIF(u.email, ''), NULLIF(u.phone, ''), 'Participant') AS display_name,
      COALESCE(NULLIF(u.role, ''), 'AMBASSADOR') AS role,
      COALESCE(NULLIF(u.active_role, ''), COALESCE(NULLIF(u.role, ''), 'AMBASSADOR')) AS active_role,
      u.last_seen_at,
      (u.last_seen_at >= NOW() - interval '2 minutes') AS is_online
    FROM (
      SELECT c.business_id AS counterpart_id
      FROM campaigns c
      WHERE c.assigned_ambassador_id = $1
      UNION
      SELECT c.assigned_ambassador_id AS counterpart_id
      FROM campaigns c
      WHERE c.business_id = $1
        AND c.assigned_ambassador_id IS NOT NULL
      UNION
      SELECT c.business_id AS counterpart_id
      FROM contracts ctr
      JOIN campaigns c ON c.id = ctr.campaign_id
      WHERE ctr.ambassador_id = $1
      UNION
      SELECT ctr.ambassador_id AS counterpart_id
      FROM contracts ctr
      JOIN campaigns c ON c.id = ctr.campaign_id
      WHERE c.business_id = $1
    ) counterparts
    JOIN users u ON u.id = counterparts.counterpart_id
    WHERE counterparts.counterpart_id IS NOT NULL
      AND counterparts.counterpart_id <> $1
    ORDER BY is_online DESC, display_name ASC
    `,
    [userId]
  );

  return applyAmbassadorReviewSummaries(
    client,
    res.rows.map(serializeUserSummary)
  );
}

async function listDiscoverableChatContacts(
  client: any,
  userId: string,
  activeRole: string,
  searchText?: string
) {
  const normalizedActiveRole = normalizeActiveRole(activeRole, activeRole);
  const targetRoles =
    normalizedActiveRole === ACCOUNT_ROLE_BUSINESS
      ? [ACCOUNT_ROLE_AMBASSADOR, ACCOUNT_ROLE_DUAL_USER]
      : normalizedActiveRole === ACCOUNT_ROLE_AMBASSADOR
        ? [ACCOUNT_ROLE_BUSINESS, ACCOUNT_ROLE_DUAL_USER]
        : [
            ACCOUNT_ROLE_BUSINESS,
            ACCOUNT_ROLE_AMBASSADOR,
            ACCOUNT_ROLE_DUAL_USER,
          ];
  const params: any[] = [userId, targetRoles, CHAT_THREAD_KIND_DIRECT];
  const search = String(searchText ?? '').trim();
  let searchSql = '';
  if (search) {
    params.push(`%${search}%`);
    searchSql = `
      AND (
        COALESCE(NULLIF(u.full_name, ''), '') ILIKE $${params.length}
        OR COALESCE(NULLIF(u.email, ''), '') ILIKE $${params.length}
        OR COALESCE(NULLIF(u.phone, ''), '') ILIKE $${params.length}
        OR COALESCE(NULLIF(u.public_id, ''), '') ILIKE $${params.length}
      )
    `;
  }

  const rankingMetric =
    normalizedActiveRole === ACCOUNT_ROLE_AMBASSADOR
      ? 'current_business_viewers'
      : 'verified_views_24h';

  const res = await client.query(
    `
    SELECT
      u.id,
      u.public_id,
      COALESCE(NULLIF(u.full_name, ''), NULLIF(u.email, ''), NULLIF(u.phone, ''), 'Participant') AS display_name,
      COALESCE(NULLIF(u.role, ''), 'AMBASSADOR') AS role,
      COALESCE(NULLIF(u.active_role, ''), COALESCE(NULLIF(u.role, ''), 'AMBASSADOR')) AS active_role,
      u.last_seen_at,
      (u.last_seen_at >= NOW() - interval '2 minutes') AS is_online,
      COALESCE(u.max_status_viewers_12h, 0)::int AS max_status_viewers_12h,
      COALESCE(u.current_business_viewers, 0)::int AS current_business_viewers,
      COALESCE(u.private_contract_rate_ugx, 0)::int AS private_contract_rate_ugx,
      COALESCE(NULLIF(u.price_privacy_mode, ''), 'NEGOTIABLE') AS price_privacy_mode,
      COALESCE(view_stats.views_24h, 0)::int AS verified_views_24h,
      direct_thread.thread_id AS direct_thread_id,
      (direct_thread.thread_id IS NOT NULL) AS has_existing_thread
    FROM users u
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(COALESCE(p.observed_views, 0)), 0)::int AS views_24h
      FROM proofs p
      JOIN verification_sessions s ON s.id = p.session_id
      WHERE p.user_id = u.id
        AND p.status = 'VERIFIED'
        AND p.decision = 'VERIFIED'
        AND p.created_at >= NOW() - interval '24 hours'
        AND s.platform = 'WHATSAPP_STATUS'
    ) view_stats ON TRUE
    LEFT JOIN LATERAL (
      SELECT t.id AS thread_id
      FROM chat_threads t
      JOIN chat_thread_members self_member
        ON self_member.thread_id = t.id
       AND self_member.user_id = $1
      JOIN chat_thread_members other_member
        ON other_member.thread_id = t.id
       AND other_member.user_id = u.id
      WHERE t.kind = $3
      LIMIT 1
    ) direct_thread ON TRUE
    WHERE u.id <> $1
      AND COALESCE(NULLIF(u.status, ''), 'ACTIVE') = 'ACTIVE'
      AND COALESCE(NULLIF(u.role, ''), 'AMBASSADOR') = ANY($2::text[])
      ${searchSql}
    ORDER BY
      has_existing_thread DESC,
      is_online DESC,
      ${rankingMetric} DESC,
      display_name ASC
    LIMIT 30
    `,
    params
  );

  return applyAmbassadorReviewSummaries(
    client,
    res.rows.map(serializeUserSummary)
  );
}

async function listMyGroups(client: any, userId: string) {
  const res = await client.query(
    `
    SELECT group_id
    FROM chat_group_memberships
    WHERE user_id = $1
      AND status = 'ACTIVE'
    ORDER BY updated_at DESC, created_at DESC
    `,
    [userId]
  );
  const groups = [];
  for (const row of res.rows) {
    const group = await buildGroupSnapshot(client, String(row.group_id), {
      currentUserId: userId,
    });
    if (group) groups.push(group);
  }
  return groups;
}

async function listGroupInvites(client: any, userId: string) {
  const res = await client.query(
    `
    SELECT
      membership.group_id,
      membership.created_at,
      membership.updated_at,
      inviter.id AS inviter_id,
      inviter.public_id AS inviter_public_id,
      COALESCE(NULLIF(inviter.full_name, ''), NULLIF(inviter.email, ''), NULLIF(inviter.phone, ''), 'Participant') AS inviter_display_name,
      COALESCE(NULLIF(inviter.role, ''), 'AMBASSADOR') AS inviter_role,
      COALESCE(NULLIF(inviter.active_role, ''), COALESCE(NULLIF(inviter.role, ''), 'AMBASSADOR')) AS inviter_active_role,
      inviter.last_seen_at AS inviter_last_seen_at,
      (inviter.last_seen_at >= NOW() - interval '2 minutes') AS inviter_is_online
    FROM chat_group_memberships membership
    LEFT JOIN users inviter ON inviter.id = membership.invited_by
    WHERE membership.user_id = $1
      AND membership.status = 'INVITED'
    ORDER BY membership.updated_at DESC, membership.created_at DESC
    `,
    [userId]
  );

  const invites = [];
  for (const row of res.rows) {
    const group = await buildGroupSnapshot(client, String(row.group_id), {
      currentUserId: userId,
    });
    if (!group) continue;
    invites.push({
      group,
      invited_at: timestampText(row.updated_at ?? row.created_at),
      invited_by:
        row.inviter_id == null
          ? null
          : serializeUserSummary({
              id: row.inviter_id,
              public_id: row.inviter_public_id,
              display_name: row.inviter_display_name,
              role: row.inviter_role,
              active_role: row.inviter_active_role,
              last_seen_at: row.inviter_last_seen_at,
              is_online: row.inviter_is_online,
            }),
    });
  }
  return invites;
}

async function listDiscoverableGroups(
  client: any,
  userId: string,
  searchText?: string
) {
  const search = String(searchText ?? '').trim();
  const searchPattern = search ? `%${search}%` : '';
  const params: any[] = [];
  let whereSearch = '';
  if (search) {
    params.push(searchPattern);
    const phoneVariants = buildPhoneLookupVariants(search);
    const memberTermClauses: string[] = [];
    for (const term of splitSearchTerms(search)) {
      params.push(`%${term}%`);
      memberTermClauses.push(
        `COALESCE(NULLIF(member_user.full_name, ''), NULLIF(member_user.email, ''), NULLIF(member_user.phone, ''), '') ILIKE $${params.length}`
      );
    }
    let memberPhoneSql = '';
    if (phoneVariants.length > 0) {
      params.push(phoneVariants);
      memberPhoneSql = `
        OR regexp_replace(COALESCE(member_user.phone, ''), '[^0-9]', '', 'g') = ANY($${params.length}::text[])
      `;
    }
    const memberTokenSql =
      memberTermClauses.length > 0
        ? `OR (${memberTermClauses.join(' AND ')})`
        : '';
    whereSearch = `
      AND (
        g.name ILIKE $1
        OR g.description ILIKE $1
        OR COALESCE(NULLIF(g.public_id, ''), '') ILIKE $1
        OR EXISTS (
          SELECT 1
          FROM chat_group_memberships membership
          JOIN users member_user ON member_user.id = membership.user_id
          WHERE membership.group_id = g.id
            AND membership.status = 'ACTIVE'
            AND (
              COALESCE(NULLIF(member_user.full_name, ''), NULLIF(member_user.email, ''), NULLIF(member_user.phone, ''), '') ILIKE $1
              OR COALESCE(NULLIF(member_user.phone, ''), '') ILIKE $1
              OR COALESCE(NULLIF(member_user.public_id, ''), '') ILIKE $1
              ${memberTokenSql}
              ${memberPhoneSql}
            )
        )
      )
    `;
  }

  const res = await client.query(
    `
    SELECT g.id
    FROM chat_groups g
    WHERE EXISTS (
      SELECT 1
      FROM chat_group_memberships membership
      WHERE membership.group_id = g.id
        AND membership.status = 'ACTIVE'
    )
    ${whereSearch}
    ORDER BY g.updated_at DESC, g.created_at DESC
    LIMIT 20
    `,
    params
  );

  const groups = [];
  for (const row of res.rows) {
    const group = await buildGroupSnapshot(client, String(row.id), {
      currentUserId: userId,
      pricingBusinessId: userId,
    });
    if (group) groups.push(group);
  }
  return groups;
}

async function listGroupCandidates(
  client: any,
  userId: string,
  options: {
    search?: string;
    groupId?: string;
  } = {}
) {
  const params: any[] = [userId];
  let sql = `
    SELECT
      u.id,
      u.public_id,
      COALESCE(NULLIF(u.full_name, ''), NULLIF(u.email, ''), NULLIF(u.phone, ''), 'Participant') AS display_name,
      COALESCE(NULLIF(u.role, ''), 'AMBASSADOR') AS role,
      COALESCE(NULLIF(u.active_role, ''), COALESCE(NULLIF(u.role, ''), 'AMBASSADOR')) AS active_role,
      u.last_seen_at,
      (u.last_seen_at >= NOW() - interval '2 minutes') AS is_online
    FROM users u
    WHERE u.id <> $1
      AND COALESCE(NULLIF(u.role, ''), 'AMBASSADOR') IN ('AMBASSADOR', 'DUAL_USER')
  `;

  const search = String(options.search ?? '').trim();
  if (search) {
    params.push(`%${search}%`);
    const searchParamIndex = params.length;
    const phoneVariants = buildPhoneLookupVariants(search);
    const termClauses: string[] = [];
    for (const term of splitSearchTerms(search)) {
      params.push(`%${term}%`);
      termClauses.push(
        `COALESCE(NULLIF(u.full_name, ''), NULLIF(u.email, ''), NULLIF(u.phone, ''), '') ILIKE $${params.length}`
      );
    }
    let phoneSearchSql = '';
    if (phoneVariants.length > 0) {
      params.push(phoneVariants);
      phoneSearchSql = `
        OR regexp_replace(COALESCE(u.phone, ''), '[^0-9]', '', 'g') = ANY($${params.length}::text[])
      `;
    }
    const tokenSearchSql =
      termClauses.length > 0 ? `OR (${termClauses.join(' AND ')})` : '';
    sql += `
      AND (
        COALESCE(NULLIF(u.full_name, ''), '') ILIKE $${searchParamIndex}
        OR COALESCE(NULLIF(u.email, ''), '') ILIKE $${searchParamIndex}
        OR COALESCE(NULLIF(u.phone, ''), '') ILIKE $${searchParamIndex}
        OR COALESCE(NULLIF(u.public_id, ''), '') ILIKE $${searchParamIndex}
        ${tokenSearchSql}
        ${phoneSearchSql}
      )
    `;
  }

  if (options.groupId) {
    params.push(options.groupId);
    sql += `
      AND NOT EXISTS (
        SELECT 1
        FROM chat_group_memberships membership
        WHERE membership.group_id = $${params.length}
          AND membership.user_id = u.id
          AND membership.status IN ('INVITED', 'ACTIVE')
      )
    `;
  }

  sql += `
    ORDER BY is_online DESC, display_name ASC
    LIMIT 20
  `;

  const res = await client.query(sql, params);
  return applyAmbassadorReviewSummaries(
    client,
    res.rows
      .filter((row: any) => isAmbassadorChatBizRole(row.role))
      .map(serializeUserSummary)
  );
}

async function buildThreadSummary(client: any, threadId: string, userId: string) {
  const threadRes = await client.query(
    `
    SELECT *
    FROM chat_threads
    WHERE id = $1
    LIMIT 1
    `,
    [threadId]
  );
  const thread = threadRes.rows[0];
  if (!thread) return null;

  const lastMessage = await loadLastMessage(client, threadId);
  const lastOffer = await loadLatestThreadOfferPreview(client, threadId);
  const unreadCount = await loadUnreadCount(client, threadId, userId);
  const liveDraftText =
    thread.kind === CHAT_THREAD_KIND_GROUP_ROOM
      ? await loadLiveDraftText(client, threadId, userId)
      : '';

  let counterpart: ChatUserSummary | null = null;
  let group: any = null;
  let title = String(thread.title ?? '').trim();

  if (thread.kind === CHAT_THREAD_KIND_DIRECT) {
    counterpart = await loadDirectCounterpart(client, threadId, userId);
    title = counterpart?.display_name ?? title;
    if (!title) {
      title = 'Participant';
    }
  } else if (thread.kind === CHAT_THREAD_KIND_GROUP_ROOM) {
    const groupRow = await loadGroupByThreadId(client, threadId);
    if (groupRow) {
      group = await buildGroupSnapshot(client, String(groupRow.id), {
        currentUserId: userId,
        includeMembers: false,
      });
      title = String(group?.name ?? title ?? 'Group Pool').trim();
    }
  } else if (thread.kind === CHAT_THREAD_KIND_GROUP_DEAL) {
    const deal = await loadGroupDealByThreadId(client, threadId);
    if (deal) {
      group = await buildGroupSnapshot(client, String(deal.group_id), {
        currentUserId: userId,
        pricingBusinessId: String(deal.business_id),
        includeMembers: false,
      });
      if (String(deal.business_id) !== userId) {
        counterpart = await loadUserSummary(client, String(deal.business_id));
      }
      title =
        String(deal.business_id) === userId
          ? String(group?.name ?? title ?? 'Group Pool').trim()
          : `${String(group?.name ?? 'Group Pool').trim()} · ${counterpart?.display_name ?? 'Business'}`;
    }
  }

  return {
    id: String(thread.id),
    kind: String(thread.kind ?? CHAT_THREAD_KIND_DIRECT),
    title,
    created_at: timestampText(thread.created_at),
    last_activity_at: timestampText(thread.last_message_at ?? thread.created_at),
    unread_count: unreadCount,
    live_draft_text: liveDraftText,
    media_url: thread.media_url == null ? null : String(thread.media_url),
    media_urls: normalizeMediaUrls({ media_url: thread.media_url }),
    media_type: thread.media_type == null ? null : String(thread.media_type),
    counterpart,
    group,
    last_message:
      thread.kind === CHAT_THREAD_KIND_GROUP_ROOM && lastMessage
        ? serializeMessage(lastMessage)
        : null,
    last_offer: lastOffer ? serializeOfferPreview(lastOffer) : null,
  };
}

async function listThreadSummaries(
  client: any,
  userId: string,
  options: { threadId?: string } = {}
) {
  const params: any[] = [userId];
  let filterSql = '';
  if (options.threadId) {
    params.push(options.threadId);
    filterSql = `AND t.id = $2`;
  }

  const res = await client.query(
    `
    SELECT t.id
    FROM chat_thread_members member
    JOIN chat_threads t ON t.id = member.thread_id
    WHERE member.user_id = $1
      ${filterSql}
    ORDER BY COALESCE(t.last_message_at, t.created_at) DESC, t.created_at DESC
    `,
    params
  );

  const summaries = [];
  for (const row of res.rows) {
    const summary = await buildThreadSummary(client, String(row.id), userId);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

async function buildThreadDetail(client: any, threadId: string, userId: string) {
  const thread = await assertThreadMember(client, threadId, userId);
  if (!thread) return null;

  await markThreadRead(client, threadId, userId);
  let summary = await buildThreadSummary(client, threadId, userId);
  const messages = await listThreadMessages(client, threadId, { limit: 80 });
  const typingStates = await listActiveTypingStates(client, threadId, userId);
  const offers = await listThreadOffers(client, threadId);
  if (
    summary?.group?.id &&
    (summary.kind === CHAT_THREAD_KIND_GROUP_ROOM ||
      summary.kind === CHAT_THREAD_KIND_GROUP_DEAL)
  ) {
    summary = {
      ...summary,
      group: await buildGroupSnapshot(client, String(summary.group.id), {
        currentUserId: userId,
        pricingBusinessId:
          summary.kind === CHAT_THREAD_KIND_GROUP_DEAL &&
          summary.counterpart == null
            ? userId
            : undefined,
        includeMembers: true,
      }),
    };
  }
  const cursor = maxCursor([
    summary?.last_activity_at,
    ...messages.map((message: any) => message.created_at),
    ...typingStates.map((state: any) => state.updated_at),
  ]);

  return {
    thread: summary,
    messages,
    offers,
    typing_states: typingStates,
    cursor,
  };
}

async function ensureGroupDealThread(
  client: any,
  groupId: string,
  businessId: string,
  createdBy: string,
  mediaUrl: string,
  mediaType: string
) {
  const group = await loadGroupById(client, groupId);
  if (!group) return null;

  const existingRes = await client.query(
    `
    SELECT thread_id
    FROM chat_group_deal_threads
    WHERE group_id = $1
      AND business_id = $2
    LIMIT 1
    `,
    [groupId, businessId]
  );

  let threadId = String(existingRes.rows[0]?.thread_id ?? '').trim();
  let created = false;

  if (!threadId) {
    const threadRes = await client.query(
      `
      INSERT INTO chat_threads (kind, title, created_by, media_url, media_type)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id
      `,
      [
        CHAT_THREAD_KIND_GROUP_DEAL,
        String(group.name ?? 'Group Pool').trim(),
        createdBy,
        mediaUrl,
        mediaType,
      ]
    );
    threadId = String(threadRes.rows[0]?.id ?? '').trim();

    const dealInsertRes = await client.query(
      `
      INSERT INTO chat_group_deal_threads (
        group_id,
        business_id,
        thread_id,
        created_by,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (group_id, business_id) DO UPDATE
        SET updated_at = NOW()
      RETURNING thread_id
      `,
      [groupId, businessId, threadId, createdBy]
    );
    threadId = String(dealInsertRes.rows[0]?.thread_id ?? threadId).trim();
    created = true;
  }

  const memberRes = await client.query(
    `
    SELECT user_id
    FROM chat_group_memberships
    WHERE group_id = $1
      AND status = 'ACTIVE'
    `,
    [groupId]
  );
  const participantIds = Array.from(
    new Set([
      businessId,
      ...memberRes.rows.map((row: any) => String(row.user_id)),
    ])
  );

  if (participantIds.length > 0) {
    await client.query(
      `
      INSERT INTO chat_thread_members (thread_id, user_id)
      SELECT $1, member_id
      FROM UNNEST($2::uuid[]) AS member_id
      ON CONFLICT DO NOTHING
      `,
      [threadId, participantIds]
    );
  }

  await client.query(
    `
    UPDATE chat_threads
    SET title = $2,
        media_url = COALESCE(NULLIF($3, ''), media_url),
        media_type = COALESCE(NULLIF($4, ''), media_type)
    WHERE id = $1
    `,
    [threadId, String(group.name ?? 'Group Pool').trim(), mediaUrl, mediaType]
  );

  return { threadId, created, group };
}

async function ensureAmbassadorCandidates(client: any, userIds: string[]) {
  const normalizedIds = Array.from(
    new Set(userIds.map((value) => String(value ?? '').trim()).filter(Boolean))
  );
  if (normalizedIds.length === 0) {
    return { validUsers: [], missingIds: [] };
  }

  const res = await client.query(
    `
    SELECT id, role
    FROM users
    WHERE id = ANY($1::uuid[])
    `,
    [normalizedIds]
  );
  const validUsers = res.rows.filter((row: any) =>
    isAmbassadorChatBizRole(row.role)
  );
  const foundIds = new Set(res.rows.map((row: any) => String(row.id)));
  const missingIds = normalizedIds.filter((id) => !foundIds.has(id));
  return { validUsers, missingIds };
}

async function buildThreadOfferContext(
  client: any,
  threadId: string,
  userId: string,
  mediaType: 'IMAGE' | 'VIDEO' | 'TEXT'
) {
  const thread = await assertThreadMember(client, threadId, userId);
  if (!thread) {
    return { error: 'thread_not_found' } as const;
  }

  if (thread.kind === CHAT_THREAD_KIND_DIRECT) {
    const counterpart = await loadDirectCounterpart(client, threadId, userId);
    if (!counterpart) {
      return { error: 'participant_not_found' } as const;
    }
    const officialPriceUgx = resolveOfficialPriceUgx(counterpart, mediaType);
    return {
      thread,
      target_kind: 'USER' as const,
      target_user_id: counterpart.id,
      target_group_id: null,
      counterpart,
      group: null,
      official_price_ugx: officialPriceUgx,
      price_privacy_mode: counterpart.price_privacy_mode,
      negotiation_allowed: counterpart.negotiation_allowed,
    };
  }

  if (thread.kind === CHAT_THREAD_KIND_GROUP_DEAL) {
    const deal = await loadGroupDealByThreadId(client, threadId);
    if (!deal) {
      return { error: 'group_not_found' } as const;
    }
    const group = await buildGroupSnapshot(client, String(deal.group_id), {
      currentUserId: userId,
      pricingBusinessId: String(deal.business_id),
      includeMembers: true,
    });
    if (!group) {
      return { error: 'group_not_found' } as const;
    }
    return {
      thread,
      target_kind: 'GROUP' as const,
      target_user_id: null,
      target_group_id: String(deal.group_id),
      counterpart: null,
      group,
      official_price_ugx: toInt(
        group.effective_price_ugx ?? group.official_price_ugx
      ),
      price_privacy_mode: normalizePricePrivacyMode(group.price_privacy_mode),
      negotiation_allowed: group.negotiation_allowed === true,
    };
  }

  return { error: 'offer_not_supported' } as const;
}

function resolveInitialOfferorId(context: any, actingUserId: string) {
  if (context.target_kind === 'USER') {
    return String(context.target_user_id ?? '').trim();
  }

  const creatorId = String(context.group?.creator?.id ?? '').trim();
  if (creatorId && creatorId !== actingUserId) {
    return creatorId;
  }

  const members = Array.isArray(context.group?.members)
    ? context.group.members
    : [];
  const adminMember = members.find(
    (member: any) => String(member?.group_role ?? '').toUpperCase() === 'ADMIN'
  );
  const representativeId = String(adminMember?.id ?? members[0]?.id ?? '').trim();
  if (representativeId && representativeId !== actingUserId) {
    return representativeId;
  }

  return '';
}

async function seedInitialThreadQuoteIfMissing(
  client: any,
  threadId: string,
  actingUserId: string,
  mediaType: 'IMAGE' | 'VIDEO' | 'TEXT'
) {
  const latestOffer = await loadLatestThreadOffer(client, threadId);
  if (latestOffer) {
    return latestOffer;
  }

  const context = await buildThreadOfferContext(
    client,
    threadId,
    actingUserId,
    mediaType
  );
  if ('error' in context || !context.negotiation_allowed) {
    return null;
  }

  const offerorId = resolveInitialOfferorId(context, actingUserId);
  if (!offerorId) {
    return null;
  }

  const seedNote =
    context.target_kind === 'GROUP'
      ? 'Current group quote'
      : 'Current ambassador quote';
  const insertRes = await client.query(
    `
    INSERT INTO chat_offer_events (
      thread_id,
      offeror_id,
      target_kind,
      target_user_id,
      target_group_id,
      official_price_ugx,
      proposed_price_ugx,
      media_type,
      media_url,
      media_text,
      note,
      status,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, $10, $11, NOW()
    )
    RETURNING *
    `,
    [
      threadId,
      offerorId,
      context.target_kind,
      context.target_user_id,
      context.target_group_id,
      context.official_price_ugx,
      context.official_price_ugx,
      context.thread.media_type ?? mediaType,
      context.thread.media_url ?? null,
      seedNote,
      CHAT_OFFER_STATUS_PENDING,
    ]
  );
  await client.query(
    `
    UPDATE chat_threads
    SET last_message_at = NOW()
    WHERE id = $1
    `,
    [threadId]
  );
  return insertRes.rows[0] ?? null;
}

async function loadLatestThreadOffer(client: any, threadId: string) {
  const res = await client.query(
    `
    SELECT *
    FROM chat_offer_events
    WHERE thread_id = $1
    ORDER BY created_at DESC
    LIMIT 1
    `,
    [threadId]
  );
  return res.rows[0] ?? null;
}

async function loadOfferById(client: any, offerId: string) {
  const res = await client.query(
    `
    SELECT
      offer.*,
      thread.kind AS thread_kind
    FROM chat_offer_events offer
    JOIN chat_threads thread ON thread.id = offer.thread_id
    WHERE offer.id = $1
    LIMIT 1
    `,
    [offerId]
  );
  return res.rows[0] ?? null;
}

async function listOfferVotes(client: any, offerId: string) {
  const res = await client.query(
    `
    SELECT
      vote.offer_id,
      vote.voter_id,
      vote.vote_action,
      vote.counter_price_ugx,
      vote.created_at,
      vote.updated_at,
      voter.public_id,
      COALESCE(NULLIF(voter.full_name, ''), NULLIF(voter.email, ''), NULLIF(voter.phone, ''), 'Participant') AS voter_display_name
    FROM chat_offer_group_votes vote
    JOIN users voter ON voter.id = vote.voter_id
    WHERE vote.offer_id = $1
    ORDER BY vote.updated_at ASC, vote.created_at ASC
    `,
    [offerId]
  );
  return res.rows.map((row: any) => ({
    voter_id: String(row.voter_id),
    voter_name: String(row.voter_display_name ?? 'Participant'),
    voter_public_id: String(row.public_id ?? ''),
    action: String(row.vote_action ?? CHAT_OFFER_RESPONSE_ACCEPT),
    counter_price_ugx: row.counter_price_ugx == null ? null : toInt(row.counter_price_ugx),
    created_at: timestampText(row.created_at),
    updated_at: timestampText(row.updated_at),
  }));
}

function medianCounterPrice(values: number[]) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? null;
  }
  const left = sorted[middle - 1] ?? 0;
  const right = sorted[middle] ?? 0;
  return Math.round((left + right) / 2);
}

function buildGroupPollSummary(memberCount: number, votes: Array<{ action: string; counter_price_ugx: number | null; voter_id: string }>) {
  const requiredVotes = quorumThreshold(memberCount);
  const acceptCount = votes.filter((vote) => vote.action === CHAT_OFFER_RESPONSE_ACCEPT).length;
  const counterVotes = votes.filter((vote) => vote.action === CHAT_OFFER_RESPONSE_COUNTER);
  const counterCount = counterVotes.length;
  const rejectCount = votes.filter((vote) => vote.action === CHAT_OFFER_RESPONSE_REJECT).length;
  const participationCount = votes.length;
  const counts = [
    { action: CHAT_OFFER_RESPONSE_ACCEPT, count: acceptCount },
    { action: CHAT_OFFER_RESPONSE_COUNTER, count: counterCount },
    { action: CHAT_OFFER_RESPONSE_REJECT, count: rejectCount },
  ];
  const highestCount = Math.max(...counts.map((item) => item.count), 0);
  const leaders = counts.filter((item) => item.count === highestCount && item.count > 0);
  let resolvedAction: string | null = null;
  if (participationCount >= requiredVotes && leaders.length === 1) {
    resolvedAction = leaders[0]?.action ?? null;
  } else if (participationCount >= memberCount && leaders.length !== 1) {
    resolvedAction = CHAT_OFFER_RESPONSE_REJECT;
  }
  return {
    member_count: memberCount,
    required_votes: requiredVotes,
    participation_count: participationCount,
    accept_count: acceptCount,
    counter_count: counterCount,
    reject_count: rejectCount,
    resolved_action: resolvedAction,
    counter_price_ugx: medianCounterPrice(
      counterVotes
        .map((vote) => toInt(vote.counter_price_ugx))
        .filter((value) => value > 0)
    ),
  };
}

async function resolveGroupOfferPoll(client: any, offerId: string) {
  const offer = await loadOfferById(client, offerId);
  if (!offer) {
    return null;
  }
  if (
    offer.target_kind !== 'GROUP' ||
    offer.status !== CHAT_OFFER_STATUS_PENDING ||
    !offer.target_group_id
  ) {
    return offer;
  }

  const memberCountRes = await client.query(
    `
    SELECT COUNT(*)::int AS member_count
    FROM chat_group_memberships
    WHERE group_id = $1
      AND status = 'ACTIVE'
    `,
    [offer.target_group_id]
  );
  const memberCount = toInt(memberCountRes.rows[0]?.member_count);
  const votes = await listOfferVotes(client, offerId);
  const pollSummary = buildGroupPollSummary(memberCount, votes);
  if (!pollSummary.resolved_action) {
    return offer;
  }

  if (pollSummary.resolved_action === CHAT_OFFER_RESPONSE_ACCEPT) {
    const updated = await client.query(
      `
      UPDATE chat_offer_events
      SET status = $2,
          resolved_price_ugx = COALESCE(resolved_price_ugx, proposed_price_ugx),
          responded_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [offerId, CHAT_OFFER_STATUS_ACCEPTED]
    );
    await client.query(
      `
      UPDATE chat_threads
      SET last_message_at = NOW()
      WHERE id = $1
      `,
      [offer.thread_id]
    );
    return updated.rows[0] ?? offer;
  }

  if (pollSummary.resolved_action === CHAT_OFFER_RESPONSE_REJECT) {
    const updated = await client.query(
      `
      UPDATE chat_offer_events
      SET status = $2,
          responded_at = NOW(),
          updated_at = NOW()
      WHERE id = $1
      RETURNING *
      `,
      [offerId, CHAT_OFFER_STATUS_REJECTED]
    );
    await client.query(
      `
      UPDATE chat_threads
      SET last_message_at = NOW()
      WHERE id = $1
      `,
      [offer.thread_id]
    );
    return updated.rows[0] ?? offer;
  }

  const counterPriceUgx = toInt(pollSummary.counter_price_ugx);
  const counterVoterId =
    votes.find(
      (vote: { action: string; voter_id: string }) =>
        vote.action === CHAT_OFFER_RESPONSE_COUNTER
    )?.voter_id ??
    String(offer.offeror_id);
  const currentOfferRes = await client.query(
    `
    UPDATE chat_offer_events
    SET status = $2,
        responded_by = $3,
        responded_at = NOW(),
        updated_at = NOW()
    WHERE id = $1
    RETURNING *
    `,
    [offerId, CHAT_OFFER_STATUS_COUNTERED, counterVoterId]
  );
  const counterOfferRes = await client.query(
    `
    INSERT INTO chat_offer_events (
      thread_id,
      parent_offer_id,
      offeror_id,
      target_kind,
      target_user_id,
      target_group_id,
      official_price_ugx,
      proposed_price_ugx,
      media_type,
      media_url,
      media_text,
      note,
      status,
      updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW()
    )
    RETURNING *
    `,
    [
      offer.thread_id,
      offer.id,
      counterVoterId,
      offer.target_kind,
      offer.target_user_id,
      offer.target_group_id,
      offer.official_price_ugx,
      counterPriceUgx,
      offer.media_type,
      offer.media_url,
      offer.media_text,
      'Group counter-offer',
      CHAT_OFFER_STATUS_PENDING,
    ]
  );
  await client.query(
    `
    UPDATE chat_threads
    SET last_message_at = NOW()
    WHERE id = $1
    `,
    [offer.thread_id]
  );
  return counterOfferRes.rows[0] ?? currentOfferRes.rows[0] ?? offer;
}

async function buildCampaignPrefillFromOffer(client: any, offer: any) {
  if (!offer || offer.status !== CHAT_OFFER_STATUS_ACCEPTED) {
    return null;
  }

  let target: any = null;
  if (offer.target_kind === 'USER' && offer.target_user_id) {
    target = await loadUserSummary(client, String(offer.target_user_id));
  } else if (offer.target_kind === 'GROUP' && offer.target_group_id) {
    const deal = await loadGroupDealByThreadId(client, String(offer.thread_id));
    target = await buildGroupSnapshot(client, String(offer.target_group_id), {
      pricingBusinessId: String(deal?.business_id ?? ''),
    });
  }

  const acceptedPrice = toInt(
    offer.resolved_price_ugx ?? offer.proposed_price_ugx
  );
  return {
    accepted_offer_id: String(offer.id),
    execution_mode: 'PRIVATE_CONTRACT',
    platform: 'WHATSAPP_STATUS',
    media_type: String(offer.media_type ?? 'IMAGE'),
    media_url: offer.media_url == null ? null : String(offer.media_url),
    media_urls: normalizeMediaUrls({ media_url: offer.media_url }),
    media_text: offer.media_text == null ? null : String(offer.media_text),
    payout_amount: acceptedPrice,
    budget_total: acceptedPrice,
    negotiated_price_ugx: acceptedPrice,
    beneficiary_user_ids:
      offer.target_kind === 'USER' && offer.target_user_id
        ? [String(offer.target_user_id)]
        : [],
    beneficiary_group_id:
      offer.target_kind === 'GROUP' && offer.target_group_id
        ? String(offer.target_group_id)
        : null,
    target,
  };
}

async function serializeOffer(client: any, offer: any) {
  const offeror = await loadUserSummary(client, String(offer.offeror_id));
  const responder =
    offer.responded_by == null
      ? null
      : await loadUserSummary(client, String(offer.responded_by));
  const deal =
    offer.target_kind === 'GROUP'
      ? await loadGroupDealByThreadId(client, String(offer.thread_id))
      : null;
  const target =
    offer.target_kind === 'USER' && offer.target_user_id
      ? await loadUserSummary(client, String(offer.target_user_id))
      : offer.target_kind === 'GROUP' && offer.target_group_id
        ? await buildGroupSnapshot(client, String(offer.target_group_id), {
            pricingBusinessId: String(deal?.business_id ?? ''),
          })
        : null;
  const votes =
    offer.target_kind === 'GROUP' ? await listOfferVotes(client, String(offer.id)) : [];
  const memberCount =
    offer.target_kind === 'GROUP' && offer.target_group_id
      ? toInt((await client.query(
          `
          SELECT COUNT(*)::int AS member_count
          FROM chat_group_memberships
          WHERE group_id = $1
            AND status = 'ACTIVE'
          `,
          [offer.target_group_id]
        )).rows[0]?.member_count)
      : 0;
  const poll =
    offer.target_kind === 'GROUP'
      ? {
          ...buildGroupPollSummary(memberCount, votes),
          votes,
        }
      : null;
  return {
    id: String(offer.id),
    thread_id: String(offer.thread_id),
    parent_offer_id:
      offer.parent_offer_id == null ? null : String(offer.parent_offer_id),
    status: String(offer.status ?? CHAT_OFFER_STATUS_PENDING),
    target_kind: String(offer.target_kind ?? 'USER'),
    official_price_ugx: toInt(offer.official_price_ugx),
    proposed_price_ugx: toInt(offer.proposed_price_ugx),
    resolved_price_ugx:
      offer.resolved_price_ugx == null ? null : toInt(offer.resolved_price_ugx),
    media_type: String(offer.media_type ?? 'IMAGE'),
    media_url: offer.media_url == null ? null : String(offer.media_url),
    media_urls: normalizeMediaUrls({ media_url: offer.media_url }),
    media_text: offer.media_text == null ? null : String(offer.media_text),
    note: String(offer.note ?? ''),
    created_at: timestampText(offer.created_at),
    updated_at: timestampText(offer.updated_at),
    responded_at: timestampText(offer.responded_at),
    offeror,
    responder,
    target,
    poll,
    campaign_prefill: await buildCampaignPrefillFromOffer(client, offer),
  };
}

async function listThreadOffers(client: any, threadId: string) {
  const res = await client.query(
    `
    SELECT *
    FROM chat_offer_events
    WHERE thread_id = $1
    ORDER BY created_at ASC
    `,
    [threadId]
  );
  const offers = [];
  for (const row of res.rows) {
    const resolvedRow =
      row.target_kind === 'GROUP'
        ? await resolveGroupOfferPoll(client, String(row.id))
        : row;
    offers.push(await serializeOffer(client, resolvedRow ?? row));
  }
  return offers;
}

export async function chatRoutes(app: FastifyInstance) {
  app.addHook('onListen', async () => {
    if (process.env.SKIP_OPTIONAL_STARTUP_WARMUPS === '1') {
      return;
    }

    try {
      await withTransaction(async (client) => {
        await ensureChatSchema(client);
        await ensureAmbassadorReviewsSchema(client);
      });
    } catch (error) {
      app.log.error(
        { err: error },
        'startup warmup failed for chat and ambassador review schema'
      );
    }
  });

  app.get('/chat/contacts', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    const query = (request.query ?? {}) as {
      scope?: string;
      search?: string;
    };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const scope = String(query.scope ?? 'linked').trim().toLowerCase();
    const contacts = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      if (scope === 'directory') {
        const activeRole = authActiveRole(request);
        if (
          activeRole !== ACCOUNT_ROLE_BUSINESS &&
          activeRole !== ACCOUNT_ROLE_AMBASSADOR
        ) {
          return [] as any[];
        }
        return listDiscoverableChatContacts(
          client,
          userId,
          activeRole,
          query.search
        );
      }
      return listChatContacts(client, userId);
    });
    return { contacts };
  });

  app.get('/chat/profiles/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    const params = request.params as { id: string };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const activeRole = authActiveRole(request);
    const result = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      await ensureAmbassadorReviewsSchema(client);
      const ambassador = await resolveAmbassadorProfileUser(client, params.id);
      if (!ambassador) {
        return { error: 'profile_not_found' } as const;
      }

      const profile = await loadUserSummary(client, String(ambassador.id));
      if (!profile) {
        return { error: 'profile_not_found' } as const;
      }

      const latestCompletedContract =
        userId !== String(ambassador.id) && isBusinessChatBizRole(activeRole)
          ? await loadLatestCompletedContractForReview(
              client,
              userId,
              String(ambassador.id)
            )
          : null;

      return {
        profile,
        reviews: await listAmbassadorReviews(client, String(ambassador.id)),
        can_review: latestCompletedContract != null,
        review_contract_id:
          latestCompletedContract == null
            ? null
            : String(latestCompletedContract.id),
      };
    });

    if ((result as any)?.error) {
      reply.code((result as any).error === 'profile_not_found' ? 404 : 400);
      return result;
    }

    return result;
  });

  app.post('/chat/profiles/:id/reviews', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    const activeRole = authActiveRole(request);
    const params = request.params as { id: string };
    const parsed = createAmbassadorReviewSchema.safeParse(request.body);
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }
    if (!isBusinessChatBizRole(activeRole)) {
      reply.code(403);
      return { error: 'forbidden' };
    }

    const result = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      await ensureAmbassadorReviewsSchema(client);
      const ambassador = await resolveAmbassadorProfileUser(client, params.id);
      if (!ambassador) {
        return { error: 'profile_not_found' } as const;
      }
      if (String(ambassador.id) === userId) {
        return { error: 'cannot_review_self' } as const;
      }

      const contract = await loadLatestCompletedContractForReview(
        client,
        userId,
        String(ambassador.id)
      );
      if (!contract?.id) {
        return { error: 'review_contract_required' } as const;
      }

      const savedReview = await client.query(
        `
        INSERT INTO ambassador_profile_reviews (
          ambassador_id,
          business_id,
          contract_id,
          rating,
          comment,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, NOW())
        ON CONFLICT (contract_id) DO UPDATE
          SET rating = EXCLUDED.rating,
              comment = EXCLUDED.comment,
              updated_at = NOW()
        RETURNING id, ambassador_id, business_id, contract_id, rating, comment, created_at, updated_at
        `,
        [
          String(ambassador.id),
          userId,
          String(contract.id),
          parsed.data.rating,
          parsed.data.comment?.trim() ?? '',
        ]
      );

      return {
        review: savedReview.rows[0] ?? null,
        profile: await loadUserSummary(client, String(ambassador.id)),
        reviews: await listAmbassadorReviews(client, String(ambassador.id)),
        can_review: true,
        review_contract_id: String(contract.id),
      };
    });

    if ((result as any)?.error) {
      const error = (result as any).error;
      reply.code(
        error === 'profile_not_found'
          ? 404
          : error === 'forbidden' || error === 'review_contract_required'
            ? 403
            : 400
      );
      return result;
    }

    return result;
  });

  app.get('/chat/threads', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const threads = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      return listThreadSummaries(client, userId);
    });
    return { threads };
  });

  app.get('/chat/groups', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    const query = (request.query ?? {}) as {
      scope?: string;
      search?: string;
    };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const scope = String(query.scope ?? 'mine').trim().toLowerCase();
    const search = String(query.search ?? '').trim();

    if (scope === 'directory' && authActiveRole(request) !== ACCOUNT_ROLE_BUSINESS) {
      reply.code(403);
      return { error: 'business_role_required' };
    }

    const result = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      if (scope === 'invites') {
        return { invites: await listGroupInvites(client, userId) };
      }
      if (scope === 'directory') {
        return { groups: await listDiscoverableGroups(client, userId, search) };
      }
      return { groups: await listMyGroups(client, userId) };
    });

    return result;
  });

  app.get('/chat/group-candidates', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    const query = (request.query ?? {}) as {
      search?: string;
      group_id?: string;
    };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    if (
      authActiveRole(request) !== ACCOUNT_ROLE_AMBASSADOR ||
      !canAccessAmbassadorFeatures(authAccountRole(request))
    ) {
      reply.code(403);
      return { error: 'ambassador_group_only' };
    }

    const candidates = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      return listGroupCandidates(client, userId, {
        search: query.search,
        groupId: query.group_id,
      });
    });
    return { candidates };
  });

  app.post('/chat/direct', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const parsed = directThreadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    if (parsed.data.participant_id === userId) {
      reply.code(400);
      return { error: 'self_chat_forbidden' };
    }

    const result = await withTransaction(async (client) => {
      await ensureChatSchema(client);

      const participantRes = await client.query(
        `
        SELECT id, role, COALESCE(NULLIF(price_privacy_mode, ''), 'NEGOTIABLE') AS price_privacy_mode
        FROM users
        WHERE id = $1
        LIMIT 1
        `,
        [parsed.data.participant_id]
      );
      if (!participantRes.rows[0]) {
        return { error: 'participant_not_found' } as const;
      }

      const allowed = usersCanChatDirectly(
        authActiveRole(request),
        participantRes.rows[0].role
      );
      if (!allowed) {
        return { error: 'chat_not_allowed' } as const;
      }
      if (normalizePricePrivacyMode(participantRes.rows[0].price_privacy_mode) === 'FIXED') {
        return { error: 'pricing_fixed' } as const;
      }

      const thread = await ensureDirectThread(
        client,
        userId,
        parsed.data.participant_id,
        primaryMediaUrl(parsed.data) ?? '',
        parsed.data.media_type
      );
      await seedInitialThreadQuoteIfMissing(
        client,
        String(thread.id),
        userId,
        parsed.data.media_type
      );
      return buildThreadDetail(client, String(thread.id), userId);
    });

    if ((result as any)?.error) {
      reply.code(
        (result as any).error === 'participant_not_found'
          ? 404
          : (result as any).error === 'chat_not_allowed'
            ? 403
            : (result as any).error === 'pricing_fixed'
              ? 409
            : 400
      );
      return result;
    }

    return result;
  });

  app.post('/chat/groups', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    if (
      authActiveRole(request) !== ACCOUNT_ROLE_AMBASSADOR ||
      !canAccessAmbassadorFeatures(authAccountRole(request))
    ) {
      reply.code(403);
      return { error: 'ambassador_group_only' };
    }

    const parsed = createGroupSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    const inviteeIds = Array.from(
      new Set(
        parsed.data.invitee_ids
          .map((value) => String(value ?? '').trim())
          .filter((value) => value && value !== userId)
      )
    );

    const result = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      const { validUsers, missingIds } = await ensureAmbassadorCandidates(
        client,
        inviteeIds
      );
      if (missingIds.length > 0) {
        return { error: 'group_candidate_not_found' } as const;
      }
      if (validUsers.length !== inviteeIds.length) {
        return { error: 'group_candidate_invalid_role' } as const;
      }

      const threadRes = await client.query(
        `
        INSERT INTO chat_threads (kind, title, created_by, media_url, media_type)
      VALUES ($1, $2, $3, $4, $5)
        RETURNING *
        `,
        [CHAT_THREAD_KIND_GROUP_ROOM, parsed.data.name, userId]
      );
      const thread = threadRes.rows[0];
      const groupPublicId = `grp-${uuid().replace(/-/g, '').slice(0, 12)}`;

      const groupRes = await client.query(
        `
        INSERT INTO chat_groups (
          public_id,
          thread_id,
          name,
          description,
          logo_url,
          public_price_ugx,
          created_by,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
        RETURNING *
        `,
        [
          groupPublicId,
          thread.id,
          parsed.data.name,
          parsed.data.description,
          parsed.data.logo_url,
          parsed.data.public_price_ugx,
          userId,
        ]
      );
      const group = groupRes.rows[0];

      await client.query(
        `
        INSERT INTO chat_group_memberships (
          group_id,
          user_id,
          role,
          status,
          invited_by,
          joined_at,
          responded_at,
          updated_at
        )
        VALUES ($1, $2, 'ADMIN', 'ACTIVE', $2, NOW(), NOW(), NOW())
        ON CONFLICT (group_id, user_id) DO UPDATE
          SET role = 'ADMIN',
              status = 'ACTIVE',
              joined_at = COALESCE(chat_group_memberships.joined_at, NOW()),
              responded_at = NOW(),
              updated_at = NOW()
        `,
        [group.id, userId]
      );
      await client.query(
        `
        INSERT INTO chat_thread_members (thread_id, user_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        `,
        [thread.id, userId]
      );

      for (const invitee of validUsers) {
        await client.query(
          `
          INSERT INTO chat_group_memberships (
            group_id,
            user_id,
            role,
            status,
            invited_by,
            updated_at
          )
          VALUES ($1, $2, 'MEMBER', 'INVITED', $3, NOW())
          ON CONFLICT (group_id, user_id) DO UPDATE
            SET role = CASE
                  WHEN chat_group_memberships.status = 'ACTIVE'
                    THEN chat_group_memberships.role
                  ELSE 'MEMBER'
                END,
                status = CASE
                  WHEN chat_group_memberships.status = 'ACTIVE'
                    THEN 'ACTIVE'
                  ELSE 'INVITED'
                END,
                invited_by = CASE
                  WHEN chat_group_memberships.status = 'ACTIVE'
                    THEN chat_group_memberships.invited_by
                  ELSE EXCLUDED.invited_by
                END,
                responded_at = CASE
                  WHEN chat_group_memberships.status = 'ACTIVE'
                    THEN chat_group_memberships.responded_at
                  ELSE NULL
                END,
                updated_at = NOW()
          `,
          [group.id, invitee.id, userId]
        );
      }

      const inviteTargetIds = validUsers.map((row: any) => String(row.id));
      await createUserNotifications(client, inviteTargetIds, {
        category: 'BARGAIN_TABLE',
        title: 'New ChatBiz group invite',
        body: `You have been invited to join ${String(group.name ?? 'a ChatBiz group')}.`,
        actorId: userId,
        targetType: 'CHAT_GROUP',
        targetId: String(group.id),
      });

      return {
        group: await buildGroupSnapshot(client, String(group.id), {
          currentUserId: userId,
          includeMembers: true,
        }),
      };
    });

    if ((result as any)?.error) {
      reply.code(
        (result as any).error === 'group_candidate_not_found' ? 404 : 400
      );
      return result;
    }

    return result;
  });

  app.patch('/chat/groups/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    const params = request.params as { id: string };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const parsed = updateGroupSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    const result = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      const membership = await loadGroupMembership(client, params.id, userId);
      if (!membership || String(membership.status) !== 'ACTIVE') {
        return { error: 'group_member_required' } as const;
      }
      if (String(membership.role) !== 'ADMIN') {
        return { error: 'group_admin_required' } as const;
      }

      const updates: string[] = [];
      const values: any[] = [params.id];
      let valueIndex = values.length + 1;

      if (typeof parsed.data.name === 'string') {
        updates.push(`name = $${valueIndex++}`);
        values.push(parsed.data.name);
      }
      if (typeof parsed.data.description === 'string') {
        updates.push(`description = $${valueIndex++}`);
        values.push(parsed.data.description);
      }
      if (typeof parsed.data.logo_url === 'string') {
        updates.push(`logo_url = $${valueIndex++}`);
        values.push(parsed.data.logo_url);
      }
      if (typeof parsed.data.public_price_ugx === 'number') {
        updates.push(`public_price_ugx = $${valueIndex++}`);
        values.push(parsed.data.public_price_ugx);
      }
      updates.push('updated_at = NOW()');

      const updateRes = await client.query(
        `
        UPDATE chat_groups
        SET ${updates.join(', ')}
        WHERE id = $1
        RETURNING *
        `,
        values
      );
      const group = updateRes.rows[0];
      if (!group) {
        return { error: 'group_not_found' } as const;
      }

      await client.query(
        `
        UPDATE chat_threads
        SET title = $2
        WHERE id = $1
        `,
        [group.thread_id, String(group.name ?? '').trim()]
      );
      await client.query(
        `
        UPDATE chat_threads thread
        SET title = $2
        FROM chat_group_deal_threads deal
        WHERE deal.group_id = $1
          AND deal.thread_id = thread.id
        `,
        [params.id, String(group.name ?? '').trim()]
      );

      return {
        group: await buildGroupSnapshot(client, params.id, {
          currentUserId: userId,
          includeMembers: true,
        }),
      };
    });

    if ((result as any)?.error) {
      reply.code(
        (result as any).error === 'group_not_found'
          ? 404
          : (result as any).error === 'group_admin_required'
            ? 403
            : 400
      );
      return result;
    }

    return result;
  });

  app.post('/chat/groups/:id/invites', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    const params = request.params as { id: string };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const parsed = inviteMembersSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    const result = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      const membership = await loadGroupMembership(client, params.id, userId);
      if (!membership || String(membership.status) !== 'ACTIVE') {
        return { error: 'group_member_required' } as const;
      }
      if (String(membership.role) !== 'ADMIN') {
        return { error: 'group_admin_required' } as const;
      }

      const targetIds = Array.from(
        new Set(
          parsed.data.member_ids
            .map((value) => String(value ?? '').trim())
            .filter((value) => value && value !== userId)
        )
      );
      const { validUsers, missingIds } = await ensureAmbassadorCandidates(
        client,
        targetIds
      );
      if (missingIds.length > 0) {
        return { error: 'group_candidate_not_found' } as const;
      }
      if (validUsers.length !== targetIds.length) {
        return { error: 'group_candidate_invalid_role' } as const;
      }

      const invitedIds: string[] = [];
      for (const target of validUsers) {
        const existing = await loadGroupMembership(client, params.id, String(target.id));
        if (existing && ['ACTIVE', 'INVITED'].includes(String(existing.status))) {
          continue;
        }
        await client.query(
          `
          INSERT INTO chat_group_memberships (
            group_id,
            user_id,
            role,
            status,
            invited_by,
            responded_at,
            updated_at
          )
          VALUES ($1, $2, 'MEMBER', 'INVITED', $3, NULL, NOW())
          ON CONFLICT (group_id, user_id) DO UPDATE
            SET role = 'MEMBER',
                status = 'INVITED',
                invited_by = EXCLUDED.invited_by,
                responded_at = NULL,
                updated_at = NOW()
          `,
          [params.id, target.id, userId]
        );
        invitedIds.push(String(target.id));
      }

      if (invitedIds.length > 0) {
        const group = await loadGroupById(client, params.id);
        await createUserNotifications(client, invitedIds, {
          category: 'BARGAIN_TABLE',
          title: 'New ChatBiz group invite',
          body: `You have been invited to join ${String(group?.name ?? 'a ChatBiz group')}.`,
          actorId: userId,
          targetType: 'CHAT_GROUP',
          targetId: params.id,
        });
      }

      return {
        invited_ids: invitedIds,
        group: await buildGroupSnapshot(client, params.id, {
          currentUserId: userId,
          includeMembers: true,
        }),
      };
    });

    if ((result as any)?.error) {
      reply.code(
        (result as any).error === 'group_candidate_not_found'
          ? 404
          : (result as any).error === 'group_admin_required'
            ? 403
            : 400
      );
      return result;
    }

    return result;
  });

  app.post('/chat/groups/:id/respond', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    const params = request.params as { id: string };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const parsed = respondInviteSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    const result = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      const membership = await loadGroupMembership(client, params.id, userId);
      if (!membership || String(membership.status) !== 'INVITED') {
        return { error: 'group_invite_not_found' } as const;
      }

      if (parsed.data.action === 'DECLINE') {
        await client.query(
          `
          UPDATE chat_group_memberships
          SET status = 'DECLINED',
              responded_at = NOW(),
              updated_at = NOW()
          WHERE group_id = $1
            AND user_id = $2
          `,
          [params.id, userId]
        );
        return {
          ok: true,
          status: 'DECLINED',
          group: await buildGroupSnapshot(client, params.id, {
            currentUserId: userId,
          }),
        };
      }

      await client.query(
        `
        UPDATE chat_group_memberships
        SET status = 'ACTIVE',
            joined_at = COALESCE(joined_at, NOW()),
            responded_at = NOW(),
            updated_at = NOW()
        WHERE group_id = $1
          AND user_id = $2
        `,
        [params.id, userId]
      );
      await client.query(
        `
        INSERT INTO chat_thread_members (thread_id, user_id)
        VALUES ($1, $2)
        ON CONFLICT DO NOTHING
        `,
        [membership.thread_id, userId]
      );
      await client.query(
        `
        INSERT INTO chat_thread_members (thread_id, user_id)
        SELECT deal.thread_id, $2
        FROM chat_group_deal_threads deal
        WHERE deal.group_id = $1
        ON CONFLICT DO NOTHING
        `,
        [params.id, userId]
      );

      const adminRes = await client.query(
        `
        SELECT user_id
        FROM chat_group_memberships
        WHERE group_id = $1
          AND status = 'ACTIVE'
          AND role = 'ADMIN'
          AND user_id <> $2
        `,
        [params.id, userId]
      );
      await createUserNotifications(
        client,
        adminRes.rows.map((row: any) => row.user_id),
        {
          category: 'BARGAIN_TABLE',
          title: 'Pool invite accepted',
          body: 'A ambassador accepted your ChatBiz group invite.',
          actorId: userId,
          targetType: 'CHAT_GROUP',
          targetId: params.id,
        }
      );

      return {
        ok: true,
        status: 'ACTIVE',
        group: await buildGroupSnapshot(client, params.id, {
          currentUserId: userId,
          includeMembers: true,
        }),
      };
    });

    if ((result as any)?.error) {
      reply.code((result as any).error === 'group_invite_not_found' ? 404 : 400);
      return result;
    }

    return result;
  });

  app.post('/chat/groups/:id/deal', { preHandler: [app.authenticate] }, async (request, reply) => {
    const parsed = groupDealThreadSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }
    const userId = authUserId(request);
    const params = request.params as { id: string };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    if (
      authActiveRole(request) !== ACCOUNT_ROLE_BUSINESS ||
      !canAccessBusinessFeatures(authAccountRole(request))
    ) {
      reply.code(403);
      return { error: 'business_role_required' };
    }

    const result = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      const groupSnapshot = await buildGroupSnapshot(client, params.id, {
        currentUserId: userId,
        pricingBusinessId: userId,
        includeMembers: true,
      });
      if (!groupSnapshot) {
        return { error: 'group_not_found' } as const;
      }
      if (groupSnapshot.negotiation_allowed !== true) {
        return { error: 'pricing_fixed' } as const;
      }
      const deal = await ensureGroupDealThread(
        client,
        params.id,
        userId,
        userId,
        primaryMediaUrl(parsed.data) ?? '',
        parsed.data.media_type
      );
      if (!deal) {
        return { error: 'group_not_found' } as const;
      }
      await seedInitialThreadQuoteIfMissing(
        client,
        deal.threadId,
        userId,
        parsed.data.media_type
      );

      if (deal.created) {
        const activeMemberIdsRes = await client.query(
          `
          SELECT user_id
          FROM chat_group_memberships
          WHERE group_id = $1
            AND status = 'ACTIVE'
          `,
          [params.id]
        );
        await createUserNotifications(
          client,
          activeMemberIdsRes.rows.map((row: any) => row.user_id),
          {
            category: 'BARGAIN_TABLE',
            title: 'New business deal room',
            body: `An business opened a ChatBiz room with ${String(deal.group?.name ?? 'your group')}.`,
            actorId: userId,
            targetType: 'CHAT_THREAD',
            targetId: deal.threadId,
          }
        );
      }

      return buildThreadDetail(client, deal.threadId, userId);
    });

    if ((result as any)?.error) {
      reply.code(
        (result as any).error === 'group_not_found'
          ? 404
          : (result as any).error === 'pricing_fixed'
            ? 409
            : 400
      );
      return result;
    }

    return result;
  });

  app.post('/chat/groups/:id/pricing', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    const params = request.params as { id: string };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const parsed = setGroupPriceSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    const result = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      const membership = await loadGroupMembership(client, params.id, userId);
      if (!membership || String(membership.status) !== 'ACTIVE') {
        return { error: 'group_member_required' } as const;
      }
      if (String(membership.role) !== 'ADMIN') {
        return { error: 'group_admin_required' } as const;
      }

      const businessRes = await client.query(
        `
        SELECT id, role
        FROM users
        WHERE id = $1
        LIMIT 1
        `,
        [parsed.data.business_id]
      );
      const business = businessRes.rows[0];
      if (!business) {
        return { error: 'participant_not_found' } as const;
      }
      if (!canAccessBusinessFeatures(business.role)) {
        return { error: 'invalid_group_pricing_target' } as const;
      }

      if (parsed.data.override_price_ugx <= 0) {
        await client.query(
          `
          DELETE FROM chat_group_price_overrides
          WHERE group_id = $1
            AND business_id = $2
          `,
          [params.id, parsed.data.business_id]
        );
      } else {
        await client.query(
          `
          INSERT INTO chat_group_price_overrides (
            group_id,
            business_id,
            override_price_ugx,
            set_by,
            updated_at
          )
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (group_id, business_id) DO UPDATE
            SET override_price_ugx = EXCLUDED.override_price_ugx,
                set_by = EXCLUDED.set_by,
                updated_at = EXCLUDED.updated_at
          `,
          [
            params.id,
            parsed.data.business_id,
            parsed.data.override_price_ugx,
            userId,
          ]
        );
      }

      await createUserNotifications(client, [parsed.data.business_id], {
        category: 'BARGAIN_TABLE',
        title: 'Your group deal price changed',
        body:
          parsed.data.override_price_ugx <= 0
            ? 'A group removed your private ChatBiz price override.'
            : `A group set your private ChatBiz price to UGX ${parsed.data.override_price_ugx}.`,
        actorId: userId,
        targetType: 'CHAT_GROUP',
        targetId: params.id,
      });

      return {
        business_id: parsed.data.business_id,
        override_price_ugx: parsed.data.override_price_ugx,
        group: await buildGroupSnapshot(client, params.id, {
          currentUserId: userId,
          pricingBusinessId: parsed.data.business_id,
          includeMembers: true,
        }),
      };
    });

    if ((result as any)?.error) {
      reply.code(
        (result as any).error === 'participant_not_found'
          ? 404
          : (result as any).error === 'group_admin_required'
            ? 403
            : 400
      );
      return result;
    }

    return result;
  });

  app.get('/chat/threads/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    const params = request.params as { id: string };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const detail = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      return buildThreadDetail(client, params.id, userId);
    });

    if (!detail) {
      reply.code(404);
      return { error: 'thread_not_found' };
    }

    return detail;
  });

  app.get('/chat/threads/:id/offer-context', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    const params = request.params as { id: string };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const parsed = offerContextSchema.safeParse(request.query);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    const result = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      return buildThreadOfferContext(
        client,
        params.id,
        userId,
        parsed.data.media_type
      );
    });

    if ((result as any)?.error) {
      reply.code(
        (result as any).error === 'thread_not_found'
          ? 404
          : (result as any).error === 'participant_not_found' ||
              (result as any).error === 'group_not_found'
            ? 404
            : 400
      );
      return result;
    }

    return result;
  });

  app.get('/chat/threads/:id/offers', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    const params = request.params as { id: string };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const result = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      const thread = await assertThreadMember(client, params.id, userId);
      if (!thread) {
        return null;
      }
      await markThreadRead(client, params.id, userId);
      return {
        offers: await listThreadOffers(client, params.id),
      };
    });

    if (!result) {
      reply.code(404);
      return { error: 'thread_not_found' };
    }

    return result;
  });

  app.post('/chat/threads/:id/offers', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    const params = request.params as { id: string };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    if (
      authActiveRole(request) !== ACCOUNT_ROLE_BUSINESS ||
      !canAccessBusinessFeatures(authAccountRole(request))
    ) {
      reply.code(403);
      return { error: 'business_role_required' };
    }

    const parsed = createOfferSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    const result = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      const context = await buildThreadOfferContext(
        client,
        params.id,
        userId,
        parsed.data.media_type
      );
      if ('error' in context) {
        return context as any;
      }
      if (!context.negotiation_allowed) {
        return { error: 'pricing_fixed' } as const;
      }

      const latestOffer = await loadLatestThreadOffer(client, params.id);
      if (
        latestOffer &&
        String(latestOffer.status) === CHAT_OFFER_STATUS_PENDING
      ) {
        return { error: 'offer_pending' } as const;
      }

      const insertRes = await client.query(
        `
        INSERT INTO chat_offer_events (
          thread_id,
          offeror_id,
          target_kind,
          target_user_id,
          target_group_id,
          official_price_ugx,
          proposed_price_ugx,
          media_type,
          media_url,
          media_text,
          note,
          status,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW()
        )
        RETURNING *
        `,
        [
          params.id,
          userId,
          context.target_kind,
          context.target_user_id,
          context.target_group_id,
          context.official_price_ugx,
          parsed.data.proposed_price_ugx,
          parsed.data.media_type,
          primaryMediaUrl(parsed.data),
          parsed.data.media_text ?? null,
          parsed.data.note ?? '',
          CHAT_OFFER_STATUS_PENDING,
        ]
      );
      await client.query(
        `
        UPDATE chat_threads
        SET last_message_at = NOW()
        WHERE id = $1
        `,
        [params.id]
      );

      if (context.target_kind === 'USER' && context.target_user_id) {
        await createUserNotifications(client, [context.target_user_id], {
          category: 'BARGAIN_TABLE',
          title: 'New ChatBiz offer',
          body: `A new offer of UGX ${parsed.data.proposed_price_ugx} is waiting for your response.`,
          actorId: userId,
          targetType: 'CHAT_THREAD',
          targetId: params.id,
        });
      } else if (context.target_kind === 'GROUP' && context.target_group_id) {
        const membersRes = await client.query(
          `
          SELECT user_id
          FROM chat_group_memberships
          WHERE group_id = $1
            AND status = 'ACTIVE'
          `,
          [context.target_group_id]
        );
        await createUserNotifications(
          client,
          membersRes.rows.map((row: any) => row.user_id),
          {
            category: 'BARGAIN_TABLE',
            title: 'New group offer',
            body: `A new offer of UGX ${parsed.data.proposed_price_ugx} is ready for your vote.`,
            actorId: userId,
            targetType: 'CHAT_THREAD',
            targetId: params.id,
          }
        );
      }

      return {
        offer: await serializeOffer(client, insertRes.rows[0]),
      };
    });

    if ((result as any)?.error) {
      reply.code(
        (result as any).error === 'thread_not_found' ||
          (result as any).error === 'participant_not_found' ||
          (result as any).error === 'group_not_found'
          ? 404
          : (result as any).error === 'pricing_fixed'
            ? 409
            : (result as any).error === 'offer_pending'
              ? 409
              : 400
      );
      return result;
    }

    return result;
  });

  app.post('/chat/offers/:id/respond', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    const params = request.params as { id: string };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const parsed = respondOfferSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    const result = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      let offer = await loadOfferById(client, params.id);
      if (!offer) {
        return { error: 'offer_not_found' } as const;
      }
      const thread = await assertThreadMember(client, String(offer.thread_id), userId);
      if (!thread) {
        return { error: 'thread_not_found' } as const;
      }
      if (String(offer.status) !== CHAT_OFFER_STATUS_PENDING) {
        return { error: 'offer_not_pending' } as const;
      }

      let responseAllowed = false;
      if (offer.target_kind === 'USER') {
        responseAllowed = String(offer.offeror_id) !== userId;
      } else if (offer.target_kind === 'GROUP') {
        const deal = await loadGroupDealByThreadId(client, String(offer.thread_id));
        responseAllowed = String(deal?.business_id ?? '') === userId;
      }
      if (!responseAllowed) {
        return { error: 'offer_response_not_allowed' } as const;
      }

      if (parsed.data.action === CHAT_OFFER_RESPONSE_ACCEPT) {
        const updated = await client.query(
          `
          UPDATE chat_offer_events
          SET status = $2,
              resolved_price_ugx = COALESCE(resolved_price_ugx, proposed_price_ugx),
              responded_by = $3,
              responded_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
          `,
          [params.id, CHAT_OFFER_STATUS_ACCEPTED, userId]
        );
        await client.query(
          `
          UPDATE chat_threads
          SET last_message_at = NOW()
          WHERE id = $1
          `,
          [offer.thread_id]
        );
        return { offer: await serializeOffer(client, updated.rows[0] ?? offer) };
      }

      if (parsed.data.action === CHAT_OFFER_RESPONSE_REJECT) {
        const updated = await client.query(
          `
          UPDATE chat_offer_events
          SET status = $2,
              responded_by = $3,
              responded_at = NOW(),
              updated_at = NOW()
          WHERE id = $1
          RETURNING *
          `,
          [params.id, CHAT_OFFER_STATUS_REJECTED, userId]
        );
        await client.query(
          `
          UPDATE chat_threads
          SET last_message_at = NOW()
          WHERE id = $1
          `,
          [offer.thread_id]
        );
        return { offer: await serializeOffer(client, updated.rows[0] ?? offer) };
      }

      await client.query(
        `
        UPDATE chat_offer_events
        SET status = $2,
            responded_by = $3,
            responded_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
        `,
        [params.id, CHAT_OFFER_STATUS_COUNTERED, userId]
      );
      const counterOfferRes = await client.query(
        `
        INSERT INTO chat_offer_events (
          thread_id,
          parent_offer_id,
          offeror_id,
          target_kind,
          target_user_id,
          target_group_id,
          official_price_ugx,
          proposed_price_ugx,
          media_type,
          media_url,
          media_text,
          note,
          status,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW()
        )
        RETURNING *
        `,
        [
          offer.thread_id,
          offer.id,
          userId,
          offer.target_kind,
          offer.target_user_id,
          offer.target_group_id,
          offer.official_price_ugx,
          parsed.data.counter_price_ugx,
          offer.media_type,
          offer.media_url,
          offer.media_text,
          parsed.data.note ?? 'Counter-offer',
          CHAT_OFFER_STATUS_PENDING,
        ]
      );
      await client.query(
        `
        UPDATE chat_threads
        SET last_message_at = NOW()
        WHERE id = $1
        `,
        [offer.thread_id]
      );
      return {
        offer: await serializeOffer(client, counterOfferRes.rows[0] ?? offer),
      };
    });

    if ((result as any)?.error) {
      reply.code(
        (result as any).error === 'offer_not_found'
          ? 404
          : (result as any).error === 'thread_not_found'
            ? 404
            : (result as any).error === 'offer_not_pending'
              ? 409
              : (result as any).error === 'offer_response_not_allowed'
                ? 403
                : 400
      );
      return result;
    }

    return result;
  });

  app.post('/chat/offers/:id/votes', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    const params = request.params as { id: string };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const parsed = voteGroupOfferSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    const result = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      const offer = await loadOfferById(client, params.id);
      if (!offer) {
        return { error: 'offer_not_found' } as const;
      }
      if (offer.target_kind !== 'GROUP' || !offer.target_group_id) {
        return { error: 'group_vote_not_allowed' } as const;
      }
      if (String(offer.status) !== CHAT_OFFER_STATUS_PENDING) {
        return { error: 'offer_not_pending' } as const;
      }
      const membership = await loadGroupMembership(
        client,
        String(offer.target_group_id),
        userId
      );
      if (!membership || String(membership.status) !== 'ACTIVE') {
        return { error: 'group_vote_not_allowed' } as const;
      }

      await client.query(
        `
        INSERT INTO chat_offer_group_votes (
          offer_id,
          voter_id,
          vote_action,
          counter_price_ugx,
          updated_at
        )
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (offer_id, voter_id) DO UPDATE
          SET vote_action = EXCLUDED.vote_action,
              counter_price_ugx = EXCLUDED.counter_price_ugx,
              updated_at = NOW()
        `,
        [
          params.id,
          userId,
          parsed.data.action,
          parsed.data.counter_price_ugx ?? null,
        ]
      );
      await client.query(
        `
        UPDATE chat_threads
        SET last_message_at = NOW()
        WHERE id = $1
        `,
        [offer.thread_id]
      );
      const resolvedOffer = await resolveGroupOfferPoll(client, params.id);
      return {
        offer: await serializeOffer(client, resolvedOffer ?? offer),
      };
    });

    if ((result as any)?.error) {
      reply.code(
        (result as any).error === 'offer_not_found'
          ? 404
          : (result as any).error === 'offer_not_pending'
            ? 409
            : (result as any).error === 'group_vote_not_allowed'
              ? 403
              : 400
      );
      return result;
    }

    return result;
  });

  app.get('/chat/threads/:id/live', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    const params = request.params as { id: string };
    const query = (request.query ?? {}) as { cursor?: string };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const cursor = parseCursor(query.cursor);

    const live = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      const thread = await assertThreadMember(client, params.id, userId);
      if (!thread) return null;

      const typingStates = await listActiveTypingStates(client, params.id, userId);
      const messages = await listThreadMessages(client, params.id, {
        since: cursor,
      });

      if (messages.length > 0) {
        await markThreadRead(client, params.id, userId);
      }

      const latestRowRes = await client.query(
        `
        SELECT
          COALESCE(
            (SELECT MAX(created_at) FROM chat_messages WHERE thread_id = $1),
            (SELECT MAX(updated_at) FROM chat_typing_states WHERE thread_id = $1),
            $2::timestamptz
          ) AS latest_cursor
        `,
        [params.id, cursor ?? new Date(0).toISOString()]
      );
      const latestCursor = maxCursor([
        latestRowRes.rows[0]?.latest_cursor,
        ...messages.map((message: any) => message.created_at),
        ...typingStates.map((state: any) => state.updated_at),
      ]);

      const hasChanges =
        cursor == null ||
        messages.length > 0 ||
        typingStates.length > 0 ||
        latestCursor !== (cursor ?? new Date(0).toISOString());

      return {
        has_changes: hasChanges,
        cursor: latestCursor,
        messages,
        typing_states: typingStates,
      };
    });

    if (!live) {
      reply.code(404);
      return { error: 'thread_not_found' };
    }

    return live;
  });

  app.post('/chat/threads/:id/messages', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    const params = request.params as { id: string };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const parsed = sendMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    const result = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      const thread = await assertThreadMember(client, params.id, userId);
      if (!thread) return { error: 'thread_not_found' } as const;
      if (thread.kind !== CHAT_THREAD_KIND_GROUP_ROOM) {
        return { error: 'message_not_supported' } as const;
      }

      const insertRes = await client.query(
        `
        INSERT INTO chat_messages (thread_id, sender_id, body)
        VALUES ($1, $2, $3)
        RETURNING *
        `,
        [params.id, userId, parsed.data.body]
      );
      await client.query(
        `
        UPDATE chat_threads
        SET last_message_at = NOW()
        WHERE id = $1
        `,
        [params.id]
      );
      await client.query(
        `
        INSERT INTO chat_typing_states (thread_id, user_id, draft_text, is_typing, updated_at)
        VALUES ($1, $2, '', FALSE, NOW())
        ON CONFLICT (thread_id, user_id) DO UPDATE
          SET draft_text = EXCLUDED.draft_text,
              is_typing = EXCLUDED.is_typing,
              updated_at = EXCLUDED.updated_at
        `,
        [params.id, userId]
      );
      await markThreadRead(client, params.id, userId);

      const sender = await loadUserSummary(client, userId);
      const threadSummary = await buildThreadSummary(client, params.id, userId);
      const message = serializeMessage({
        ...insertRes.rows[0],
        display_name: sender?.display_name ?? 'Participant',
      });
      const memberIdsRes = await client.query(
        `
        SELECT user_id
        FROM chat_thread_members
        WHERE thread_id = $1
          AND user_id <> $2
        `,
        [params.id, userId]
      );
      await createUserNotifications(
        client,
        memberIdsRes.rows.map((row: any) => row.user_id),
        {
          category: 'BARGAIN_TABLE',
          title: 'New ChatBiz message',
          body: `${sender?.display_name ?? 'Participant'}: ${parsed.data.body}`,
          actorId: userId,
          targetType: 'CHAT_THREAD',
          targetId: params.id,
        }
      );

      return {
        message,
        thread: threadSummary,
      };
    });

    if ((result as any)?.error) {
      reply.code(
        (result as any).error === 'thread_not_found'
          ? 404
          : (result as any).error === 'message_not_supported'
            ? 409
            : 400
      );
      return result;
    }

    return result;
  });

  app.post('/chat/threads/:id/typing', { preHandler: [app.authenticate] }, async (request, reply) => {
    const userId = authUserId(request);
    const params = request.params as { id: string };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }

    const parsed = updateTypingSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { error: 'validation_failed', issues: parsed.error.issues };
    }

    const draftText = parsed.data.draft_text.trim();
    const isTyping = parsed.data.is_typing ?? draftText.length > 0;

    const result = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      const thread = await assertThreadMember(client, params.id, userId);
      if (!thread) return { error: 'thread_not_found' } as const;
      if (thread.kind !== CHAT_THREAD_KIND_GROUP_ROOM) {
        return { error: 'typing_not_supported' } as const;
      }

      await client.query(
        `
        INSERT INTO chat_typing_states (thread_id, user_id, draft_text, is_typing, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (thread_id, user_id) DO UPDATE
          SET draft_text = EXCLUDED.draft_text,
              is_typing = EXCLUDED.is_typing,
              updated_at = EXCLUDED.updated_at
        `,
        [params.id, userId, isTyping ? draftText : '', isTyping]
      );

      return {
        ok: true,
        typing_state: {
          draft_text: isTyping ? draftText : '',
          is_typing: isTyping,
          updated_at: new Date().toISOString(),
        },
      };
    });

    if ((result as any)?.error) {
      reply.code(
        (result as any).error === 'thread_not_found'
          ? 404
          : (result as any).error === 'typing_not_supported'
            ? 409
            : 400
      );
      return result;
    }

    return result;
  });
}


