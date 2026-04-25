import { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { withTransaction } from '../db.js';
import {
  ACCOUNT_ROLE_ADVERTISER,
  ACCOUNT_ROLE_DISTRIBUTOR,
  ACCOUNT_ROLE_DUAL_USER,
  canAccessAdvertiserFeatures,
  canAccessDistributorFeatures,
  normalizeAccountRole,
  normalizeActiveRole,
} from '../services/roles.js';
import {
  CHAT_THREAD_KIND_DIRECT,
  CHAT_THREAD_KIND_GROUP_DEAL,
  CHAT_THREAD_KIND_GROUP_ROOM,
  ensureChatSchema,
} from '../services/chat.js';
import { createUserNotifications } from '../services/userSignals.js';

const directThreadSchema = z.object({
  participant_id: z.string().uuid(),
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
  advertiser_id: z.string().uuid(),
  override_price_ugx: z.number().int().min(0),
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
  current_advertiser_viewers: number;
  private_contract_rate_ugx: number;
  has_existing_thread: boolean;
  direct_thread_id: string | null;
};

function isPromoterChatBizRole(role: unknown) {
  const normalizedRole = normalizeAccountRole(role);
  return (
    normalizedRole === ACCOUNT_ROLE_DISTRIBUTOR ||
    normalizedRole === ACCOUNT_ROLE_DUAL_USER
  );
}

function isAdvertiserChatBizRole(role: unknown) {
  const normalizedRole = normalizeAccountRole(role);
  return (
    normalizedRole === ACCOUNT_ROLE_ADVERTISER ||
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
  return {
    id: String(row?.id ?? ''),
    public_id: String(row?.public_id ?? ''),
    display_name: displayNameFromRow(row),
    role: String(row?.role ?? 'DISTRIBUTOR'),
    active_role: String(row?.active_role ?? row?.role ?? 'DISTRIBUTOR'),
    is_online: row?.is_online === true,
    last_seen_at: timestampText(row?.last_seen_at),
    profile_type: 'USER',
    verified_views_24h: toInt(row?.verified_views_24h),
    max_status_viewers_12h: toInt(row?.max_status_viewers_12h),
    current_advertiser_viewers: toInt(row?.current_advertiser_viewers),
    private_contract_rate_ugx: toInt(row?.private_contract_rate_ugx),
    has_existing_thread: row?.has_existing_thread === true,
    direct_thread_id:
      row?.direct_thread_id == null ? null : String(row.direct_thread_id),
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
      COALESCE(NULLIF(u.role, ''), 'DISTRIBUTOR') AS role,
      COALESCE(NULLIF(u.active_role, ''), COALESCE(NULLIF(u.role, ''), 'DISTRIBUTOR')) AS active_role,
      u.last_seen_at,
      (u.last_seen_at >= NOW() - interval '2 minutes') AS is_online
    FROM users u
    WHERE u.id = $1
    LIMIT 1
    `,
    [userId]
  );
  return res.rows[0] ? serializeUserSummary(res.rows[0]) : null;
}

function usersCanChatDirectly(
  currentActiveRole: string,
  participantAccountRole: unknown
) {
  const normalizedActiveRole = normalizeActiveRole(
    currentActiveRole,
    currentActiveRole
  );
  if (normalizedActiveRole === ACCOUNT_ROLE_ADVERTISER) {
    return isPromoterChatBizRole(participantAccountRole);
  }
  if (normalizedActiveRole === ACCOUNT_ROLE_DISTRIBUTOR) {
    return isAdvertiserChatBizRole(participantAccountRole);
  }
  return (
    isAdvertiserChatBizRole(participantAccountRole) ||
    isPromoterChatBizRole(participantAccountRole)
  );
}

async function ensureDirectThread(
  client: any,
  userId: string,
  participantId: string
) {
  const directKey = [userId, participantId].sort().join(':');
  const threadRes = await client.query(
    `
    INSERT INTO chat_threads (kind, direct_key, created_by)
    VALUES ($1, $2, $3)
    ON CONFLICT (direct_key) DO UPDATE
      SET direct_key = EXCLUDED.direct_key
    RETURNING *
    `,
    [CHAT_THREAD_KIND_DIRECT, directKey, userId]
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

async function loadUnreadCount(client: any, threadId: string, userId: string) {
  const res = await client.query(
    `
    SELECT COUNT(*)::int AS unread_count
    FROM chat_messages msg
    JOIN chat_thread_members member
      ON member.thread_id = msg.thread_id
     AND member.user_id = $2
    WHERE msg.thread_id = $1
      AND msg.sender_id <> $2
      AND (member.last_read_at IS NULL OR msg.created_at > member.last_read_at)
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
      COALESCE(NULLIF(u.role, ''), 'DISTRIBUTOR') AS role,
      COALESCE(NULLIF(u.active_role, ''), COALESCE(NULLIF(u.role, ''), 'DISTRIBUTOR')) AS active_role,
      u.last_seen_at,
      (u.last_seen_at >= NOW() - interval '2 minutes') AS is_online
    FROM chat_thread_members member
    JOIN users u ON u.id = member.user_id
    WHERE member.thread_id = $1
      AND member.user_id <> $2
    ORDER BY member.joined_at ASC
    LIMIT 1
    `,
    [threadId, userId]
  );
  return res.rows[0] ? serializeUserSummary(res.rows[0]) : null;
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
      COALESCE(NULLIF(u.role, ''), 'DISTRIBUTOR') AS role,
      COALESCE(NULLIF(u.active_role, ''), COALESCE(NULLIF(u.role, ''), 'DISTRIBUTOR')) AS active_role,
      u.last_seen_at,
      (u.last_seen_at >= NOW() - interval '2 minutes') AS is_online,
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
  advertiserId?: string | null
) {
  const normalizedAdvertiserId = String(advertiserId ?? '').trim();
  if (!normalizedAdvertiserId) {
    return null;
  }
  const res = await client.query(
    `
    SELECT override_price_ugx
    FROM chat_group_price_overrides
    WHERE group_id = $1
      AND advertiser_id = $2
    LIMIT 1
    `,
    [groupId, normalizedAdvertiserId]
  );
  return res.rows[0] ? toInt(res.rows[0].override_price_ugx) : null;
}

async function buildGroupSnapshot(
  client: any,
  groupId: string,
  options: {
    currentUserId?: string | null;
    pricingAdvertiserId?: string | null;
    includeMembers?: boolean;
  } = {}
) {
  const res = await client.query(
    `
    SELECT
      g.id,
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
      COALESCE(NULLIF(creator.role, ''), 'DISTRIBUTOR') AS creator_role,
      COALESCE(NULLIF(creator.active_role, ''), COALESCE(NULLIF(creator.role, ''), 'DISTRIBUTOR')) AS creator_active_role,
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
  const effectivePriceOverride = await loadGroupPriceOverride(
    client,
    groupId,
    options.pricingAdvertiserId
  );

  const members = memberRows.map((row: any) => {
    const viewers24h = toInt(row.viewers_24h);
    return {
      ...serializeUserSummary({
        id: row.user_id,
        public_id: row.public_id,
        display_name: row.display_name,
        role: row.role,
        active_role: row.active_role,
        last_seen_at: row.last_seen_at,
        is_online: row.is_online,
      }),
      group_role: String(row.membership_role ?? 'MEMBER'),
      viewers_24h: viewers24h,
      share_percent: capacity24h <= 0 ? 0 : roundPercent((viewers24h / capacity24h) * 100),
      joined_at: timestampText(row.joined_at),
    };
  });

  return {
    profile_type: 'GROUP',
    id: String(groupRow.id),
    thread_id: String(groupRow.thread_id ?? ''),
    name: String(groupRow.name ?? 'Group Pool').trim(),
    description: String(groupRow.description ?? '').trim(),
    logo_url: String(groupRow.logo_url ?? '').trim(),
    public_price_ugx: toInt(groupRow.public_price_ugx),
    effective_price_ugx:
      effectivePriceOverride == null
        ? toInt(groupRow.public_price_ugx)
        : effectivePriceOverride,
    override_applied: effectivePriceOverride != null,
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
      groupRow.creator_id == null
        ? null
        : serializeUserSummary({
            id: groupRow.creator_id,
            public_id: groupRow.creator_public_id,
            display_name: groupRow.creator_display_name,
            role: groupRow.creator_role,
            active_role: groupRow.creator_active_role,
            last_seen_at: groupRow.creator_last_seen_at,
            is_online: groupRow.creator_is_online,
          }),
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
      COALESCE(NULLIF(u.role, ''), 'DISTRIBUTOR') AS role,
      COALESCE(NULLIF(u.active_role, ''), COALESCE(NULLIF(u.role, ''), 'DISTRIBUTOR')) AS active_role,
      u.last_seen_at,
      (u.last_seen_at >= NOW() - interval '2 minutes') AS is_online
    FROM (
      SELECT c.advertiser_id AS counterpart_id
      FROM campaigns c
      WHERE c.assigned_distributor_id = $1
      UNION
      SELECT c.assigned_distributor_id AS counterpart_id
      FROM campaigns c
      WHERE c.advertiser_id = $1
        AND c.assigned_distributor_id IS NOT NULL
      UNION
      SELECT c.advertiser_id AS counterpart_id
      FROM contracts ctr
      JOIN campaigns c ON c.id = ctr.campaign_id
      WHERE ctr.distributor_id = $1
      UNION
      SELECT ctr.distributor_id AS counterpart_id
      FROM contracts ctr
      JOIN campaigns c ON c.id = ctr.campaign_id
      WHERE c.advertiser_id = $1
    ) counterparts
    JOIN users u ON u.id = counterparts.counterpart_id
    WHERE counterparts.counterpart_id IS NOT NULL
      AND counterparts.counterpart_id <> $1
    ORDER BY is_online DESC, display_name ASC
    `,
    [userId]
  );

  return res.rows.map(serializeUserSummary);
}

async function listDiscoverableChatContacts(
  client: any,
  userId: string,
  activeRole: string,
  searchText?: string
) {
  const normalizedActiveRole = normalizeActiveRole(activeRole, activeRole);
  const targetRoles =
    normalizedActiveRole === ACCOUNT_ROLE_ADVERTISER
      ? [ACCOUNT_ROLE_DISTRIBUTOR, ACCOUNT_ROLE_DUAL_USER]
      : normalizedActiveRole === ACCOUNT_ROLE_DISTRIBUTOR
        ? [ACCOUNT_ROLE_ADVERTISER, ACCOUNT_ROLE_DUAL_USER]
        : [
            ACCOUNT_ROLE_ADVERTISER,
            ACCOUNT_ROLE_DISTRIBUTOR,
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
    normalizedActiveRole === ACCOUNT_ROLE_DISTRIBUTOR
      ? 'current_advertiser_viewers'
      : 'verified_views_24h';

  const res = await client.query(
    `
    SELECT
      u.id,
      u.public_id,
      COALESCE(NULLIF(u.full_name, ''), NULLIF(u.email, ''), NULLIF(u.phone, ''), 'Participant') AS display_name,
      COALESCE(NULLIF(u.role, ''), 'DISTRIBUTOR') AS role,
      COALESCE(NULLIF(u.active_role, ''), COALESCE(NULLIF(u.role, ''), 'DISTRIBUTOR')) AS active_role,
      u.last_seen_at,
      (u.last_seen_at >= NOW() - interval '2 minutes') AS is_online,
      COALESCE(u.max_status_viewers_12h, 0)::int AS max_status_viewers_12h,
      COALESCE(u.current_advertiser_viewers, 0)::int AS current_advertiser_viewers,
      COALESCE(u.private_contract_rate_ugx, 0)::int AS private_contract_rate_ugx,
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
      AND COALESCE(NULLIF(u.role, ''), 'DISTRIBUTOR') = ANY($2::text[])
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

  return res.rows.map(serializeUserSummary);
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
      COALESCE(NULLIF(inviter.role, ''), 'DISTRIBUTOR') AS inviter_role,
      COALESCE(NULLIF(inviter.active_role, ''), COALESCE(NULLIF(inviter.role, ''), 'DISTRIBUTOR')) AS inviter_active_role,
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
    whereSearch = `
      AND (
        g.name ILIKE $1
        OR g.description ILIKE $1
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
      pricingAdvertiserId: userId,
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
      COALESCE(NULLIF(u.role, ''), 'DISTRIBUTOR') AS role,
      COALESCE(NULLIF(u.active_role, ''), COALESCE(NULLIF(u.role, ''), 'DISTRIBUTOR')) AS active_role,
      u.last_seen_at,
      (u.last_seen_at >= NOW() - interval '2 minutes') AS is_online
    FROM users u
    WHERE u.id <> $1
      AND COALESCE(NULLIF(u.role, ''), 'DISTRIBUTOR') IN ('DISTRIBUTOR', 'DUAL_USER')
  `;

  const search = String(options.search ?? '').trim();
  if (search) {
    params.push(`%${search}%`);
    sql += `
      AND (
        COALESCE(NULLIF(u.full_name, ''), '') ILIKE $${params.length}
        OR COALESCE(NULLIF(u.email, ''), '') ILIKE $${params.length}
        OR COALESCE(NULLIF(u.phone, ''), '') ILIKE $${params.length}
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
  return res.rows
    .filter((row: any) => isPromoterChatBizRole(row.role))
    .map(serializeUserSummary);
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
  const unreadCount = await loadUnreadCount(client, threadId, userId);
  const liveDraftText = await loadLiveDraftText(client, threadId, userId);

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
        pricingAdvertiserId: String(deal.advertiser_id),
        includeMembers: false,
      });
      if (String(deal.advertiser_id) !== userId) {
        counterpart = await loadUserSummary(client, String(deal.advertiser_id));
      }
      title =
        String(deal.advertiser_id) === userId
          ? String(group?.name ?? title ?? 'Group Pool').trim()
          : `${String(group?.name ?? 'Group Pool').trim()} · ${counterpart?.display_name ?? 'Advertiser'}`;
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
    counterpart,
    group,
    last_message: lastMessage ? serializeMessage(lastMessage) : null,
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
  if (
    summary?.group?.id &&
    (summary.kind === CHAT_THREAD_KIND_GROUP_ROOM ||
      summary.kind === CHAT_THREAD_KIND_GROUP_DEAL)
  ) {
    summary = {
      ...summary,
      group: await buildGroupSnapshot(client, String(summary.group.id), {
        currentUserId: userId,
        pricingAdvertiserId:
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
    typing_states: typingStates,
    cursor,
  };
}

async function ensureGroupDealThread(
  client: any,
  groupId: string,
  advertiserId: string,
  createdBy: string
) {
  const group = await loadGroupById(client, groupId);
  if (!group) return null;

  const existingRes = await client.query(
    `
    SELECT thread_id
    FROM chat_group_deal_threads
    WHERE group_id = $1
      AND advertiser_id = $2
    LIMIT 1
    `,
    [groupId, advertiserId]
  );

  let threadId = String(existingRes.rows[0]?.thread_id ?? '').trim();
  let created = false;

  if (!threadId) {
    const threadRes = await client.query(
      `
      INSERT INTO chat_threads (kind, title, created_by)
      VALUES ($1, $2, $3)
      RETURNING id
      `,
      [CHAT_THREAD_KIND_GROUP_DEAL, String(group.name ?? 'Group Pool').trim(), createdBy]
    );
    threadId = String(threadRes.rows[0]?.id ?? '').trim();

    const dealInsertRes = await client.query(
      `
      INSERT INTO chat_group_deal_threads (
        group_id,
        advertiser_id,
        thread_id,
        created_by,
        updated_at
      )
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (group_id, advertiser_id) DO UPDATE
        SET updated_at = NOW()
      RETURNING thread_id
      `,
      [groupId, advertiserId, threadId, createdBy]
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
      advertiserId,
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
    SET title = $2
    WHERE id = $1
    `,
    [threadId, String(group.name ?? 'Group Pool').trim()]
  );

  return { threadId, created, group };
}

async function ensureDistributorCandidates(client: any, userIds: string[]) {
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
    isPromoterChatBizRole(row.role)
  );
  const foundIds = new Set(res.rows.map((row: any) => String(row.id)));
  const missingIds = normalizedIds.filter((id) => !foundIds.has(id));
  return { validUsers, missingIds };
}

export async function chatRoutes(app: FastifyInstance) {
  app.addHook('onReady', async () => {
    await withTransaction(async (client) => {
      await ensureChatSchema(client);
    });
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
          activeRole !== ACCOUNT_ROLE_ADVERTISER &&
          activeRole !== ACCOUNT_ROLE_DISTRIBUTOR
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

    if (scope === 'directory' && authActiveRole(request) !== ACCOUNT_ROLE_ADVERTISER) {
      reply.code(403);
      return { error: 'advertiser_role_required' };
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
      authActiveRole(request) !== ACCOUNT_ROLE_DISTRIBUTOR ||
      !canAccessDistributorFeatures(authAccountRole(request))
    ) {
      reply.code(403);
      return { error: 'distributor_group_only' };
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
        SELECT id, role
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

      const thread = await ensureDirectThread(
        client,
        userId,
        parsed.data.participant_id
      );
      return buildThreadDetail(client, String(thread.id), userId);
    });

    if ((result as any)?.error) {
      reply.code(
        (result as any).error === 'participant_not_found'
          ? 404
          : (result as any).error === 'chat_not_allowed'
            ? 403
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
      authActiveRole(request) !== ACCOUNT_ROLE_DISTRIBUTOR ||
      !canAccessDistributorFeatures(authAccountRole(request))
    ) {
      reply.code(403);
      return { error: 'distributor_group_only' };
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
      const { validUsers, missingIds } = await ensureDistributorCandidates(
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
        INSERT INTO chat_threads (kind, title, created_by)
        VALUES ($1, $2, $3)
        RETURNING *
        `,
        [CHAT_THREAD_KIND_GROUP_ROOM, parsed.data.name, userId]
      );
      const thread = threadRes.rows[0];

      const groupRes = await client.query(
        `
        INSERT INTO chat_groups (
          thread_id,
          name,
          description,
          logo_url,
          public_price_ugx,
          created_by,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, NOW())
        RETURNING *
        `,
        [
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
      const { validUsers, missingIds } = await ensureDistributorCandidates(
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
          body: 'A promoter accepted your ChatBiz group invite.',
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
    const userId = authUserId(request);
    const params = request.params as { id: string };
    if (!userId) {
      reply.code(401);
      return { error: 'unauthorized' };
    }
    if (
      authActiveRole(request) !== ACCOUNT_ROLE_ADVERTISER ||
      !canAccessAdvertiserFeatures(authAccountRole(request))
    ) {
      reply.code(403);
      return { error: 'advertiser_role_required' };
    }

    const result = await withTransaction(async (client) => {
      await ensureChatSchema(client);
      const deal = await ensureGroupDealThread(client, params.id, userId, userId);
      if (!deal) {
        return { error: 'group_not_found' } as const;
      }

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
            title: 'New advertiser deal room',
            body: `An advertiser opened a ChatBiz room with ${String(deal.group?.name ?? 'your group')}.`,
            actorId: userId,
            targetType: 'CHAT_THREAD',
            targetId: deal.threadId,
          }
        );
      }

      return buildThreadDetail(client, deal.threadId, userId);
    });

    if ((result as any)?.error) {
      reply.code((result as any).error === 'group_not_found' ? 404 : 400);
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

      const advertiserRes = await client.query(
        `
        SELECT id, role
        FROM users
        WHERE id = $1
        LIMIT 1
        `,
        [parsed.data.advertiser_id]
      );
      const advertiser = advertiserRes.rows[0];
      if (!advertiser) {
        return { error: 'participant_not_found' } as const;
      }
      if (!canAccessAdvertiserFeatures(advertiser.role)) {
        return { error: 'invalid_group_pricing_target' } as const;
      }

      if (parsed.data.override_price_ugx <= 0) {
        await client.query(
          `
          DELETE FROM chat_group_price_overrides
          WHERE group_id = $1
            AND advertiser_id = $2
          `,
          [params.id, parsed.data.advertiser_id]
        );
      } else {
        await client.query(
          `
          INSERT INTO chat_group_price_overrides (
            group_id,
            advertiser_id,
            override_price_ugx,
            set_by,
            updated_at
          )
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (group_id, advertiser_id) DO UPDATE
            SET override_price_ugx = EXCLUDED.override_price_ugx,
                set_by = EXCLUDED.set_by,
                updated_at = EXCLUDED.updated_at
          `,
          [
            params.id,
            parsed.data.advertiser_id,
            parsed.data.override_price_ugx,
            userId,
          ]
        );
      }

      await createUserNotifications(client, [parsed.data.advertiser_id], {
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
        advertiser_id: parsed.data.advertiser_id,
        override_price_ugx: parsed.data.override_price_ugx,
        group: await buildGroupSnapshot(client, params.id, {
          currentUserId: userId,
          pricingAdvertiserId: parsed.data.advertiser_id,
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
      reply.code((result as any).error === 'thread_not_found' ? 404 : 400);
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
      reply.code((result as any).error === 'thread_not_found' ? 404 : 400);
      return result;
    }

    return result;
  });
}
