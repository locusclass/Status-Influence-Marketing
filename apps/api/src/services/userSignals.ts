import { pool } from '../db.js';

type TouchPresenceOptions = {
  markLogin?: boolean;
};

export type NotificationInput = {
  category?: string;
  title: string;
  body: string;
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  meta?: Record<string, unknown> | null;
};

type BlockingNoticeInput = {
  title: string;
  body: string;
  audienceKind?: 'SELECTED_USERS' | 'ALL_SCOPED_USERS';
  createdByUserId?: string | null;
  expiresAt?: string | null;
  mediaUrl?: string | null;
  mediaType?: 'IMAGE' | 'VIDEO' | null;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeUuid(value: unknown) {
  const text = String(value ?? '').trim();
  return UUID_PATTERN.test(text) ? text : null;
}

export async function ensureUserSignalSchema(client: any) {
  await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ
  `);
  await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ
  `);
  await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS status_reason TEXT
  `);
  await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS status_reason_updated_at TIMESTAMPTZ
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS user_notifications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL DEFAULT 'ADMIN_ACTION',
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
      target_type TEXT,
      target_id TEXT,
      meta JSONB NOT NULL DEFAULT '{}'::jsonb,
      read_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS user_notifications_user_created_idx
    ON user_notifications (user_id, created_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS user_notifications_user_unread_idx
    ON user_notifications (user_id, read_at, created_at DESC)
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_blocking_notices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      audience_kind TEXT NOT NULL DEFAULT 'SELECTED_USERS',
      created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      removed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      removed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    ALTER TABLE admin_blocking_notices
      DROP CONSTRAINT IF EXISTS admin_blocking_notices_audience_kind_check
  `);
  await client.query(`
    ALTER TABLE admin_blocking_notices
      ADD CONSTRAINT admin_blocking_notices_audience_kind_check
      CHECK (audience_kind IN ('SELECTED_USERS', 'ALL_SCOPED_USERS'))
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS admin_blocking_notices_active_idx
    ON admin_blocking_notices (removed_at, created_at DESC)
  `);
  await client.query(`
    ALTER TABLE admin_blocking_notices
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
  `);
  await client.query(`
    ALTER TABLE admin_blocking_notices
      ADD COLUMN IF NOT EXISTS media_url TEXT
  `);
  await client.query(`
    ALTER TABLE admin_blocking_notices
      ADD COLUMN IF NOT EXISTS media_type TEXT
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS admin_blocking_notice_targets (
      notice_id UUID NOT NULL REFERENCES admin_blocking_notices(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (notice_id, user_id)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS admin_blocking_notice_targets_user_idx
    ON admin_blocking_notice_targets (user_id, created_at DESC)
  `);
}

export async function touchUserPresenceWithClient(
  client: any,
  userId: string,
  options: TouchPresenceOptions = {}
) {
  const normalizedUserId = String(userId ?? '').trim();
  if (!normalizedUserId) return;
  await ensureUserSignalSchema(client);
  await client.query(
    `
    UPDATE users
    SET last_seen_at = NOW(),
        last_login_at = CASE
          WHEN $2::boolean THEN NOW()
          ELSE last_login_at
        END
    WHERE id = $1
    `,
    [normalizedUserId, options.markLogin === true]
  );
}

export async function touchUserPresence(
  userId: string,
  options: TouchPresenceOptions = {}
) {
  const normalizedUserId = String(userId ?? '').trim();
  if (!normalizedUserId) return;
  const client = await pool.connect();

  try {
    await ensureUserSignalSchema(client);
    await client.query(
      `
      UPDATE users
      SET last_seen_at = NOW(),
          last_login_at = CASE
            WHEN $2::boolean THEN NOW()
            ELSE last_login_at
          END
      WHERE id = $1
      `,
      [normalizedUserId, options.markLogin === true]
    );
  } finally {
    client.release();
  }
}

export async function createUserNotifications(
  client: any,
  userIds: unknown[],
  input: NotificationInput
) {
  await ensureUserSignalSchema(client);
  const uniqueUserIds = Array.from(
    new Set(
      userIds
          .map((value) => String(value ?? '').trim())
          .filter((value) => value.length > 0)
    )
  );

  const actorId =
    typeof input.actorId === 'string' &&
            /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
                .test(input.actorId.trim())
        ? input.actorId.trim()
        : null;

  for (const userId of uniqueUserIds) {
    await client.query(
      `
      INSERT INTO user_notifications (
        user_id,
        category,
        title,
        body,
        actor_id,
        target_type,
        target_id,
        meta
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      `,
      [
        userId,
        input.category ?? 'ADMIN_ACTION',
        input.title,
        input.body,
        actorId,
        input.targetType ?? null,
        input.targetId ?? null,
        JSON.stringify(input.meta ?? {}),
      ]
    );
  }
}

export async function createBlockingNotice(
  client: any,
  userIds: unknown[],
  input: BlockingNoticeInput
) {
  await ensureUserSignalSchema(client);
  const uniqueUserIds = Array.from(
    new Set(
      userIds
        .map((value) => String(value ?? '').trim())
        .filter((value) => value.length > 0)
    )
  );
  if (uniqueUserIds.length === 0) {
    return null;
  }

  const createdByUserId = normalizeUuid(input.createdByUserId);
  const created = await client.query(
    `
    INSERT INTO admin_blocking_notices (
      title,
      body,
      audience_kind,
      created_by_user_id,
      expires_at,
      media_url,
      media_type
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING *
    `,
    [
      input.title.trim(),
      input.body.trim(),
      input.audienceKind ?? 'SELECTED_USERS',
      createdByUserId,
      input.expiresAt ?? null,
      input.mediaUrl ?? null,
      input.mediaType ?? null,
    ]
  );
  const notice = created.rows[0] ?? null;
  if (!notice?.id) {
    return null;
  }

  for (const userId of uniqueUserIds) {
    await client.query(
      `
      INSERT INTO admin_blocking_notice_targets (notice_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT (notice_id, user_id) DO NOTHING
      `,
      [notice.id, userId]
    );
  }

  return {
    ...notice,
    target_count: uniqueUserIds.length,
  };
}

export async function removeBlockingNotice(
  client: any,
  noticeId: string,
  removedByUserId?: string | null
) {
  await ensureUserSignalSchema(client);
  const normalizedRemovedBy = normalizeUuid(removedByUserId);
  const updated = await client.query(
    `
    UPDATE admin_blocking_notices
    SET removed_at = COALESCE(removed_at, NOW()),
        removed_by_user_id = COALESCE($2, removed_by_user_id),
        updated_at = NOW()
    WHERE id = $1
      AND removed_at IS NULL
    RETURNING *
    `,
    [noticeId, normalizedRemovedBy]
  );
  return updated.rows[0] ?? null;
}

export async function getActiveBlockingNotice(client: any, userId: string) {
  await ensureUserSignalSchema(client);
  const normalizedUserId = String(userId ?? '').trim();
  if (!normalizedUserId) {
    return null;
  }

  const res = await client.query(
    `
    SELECT
      notice.id,
      notice.title,
      notice.body,
      notice.audience_kind,
      notice.created_at,
      notice.updated_at,
      notice.created_by_user_id,
      notice.expires_at,
      notice.media_url,
      notice.media_type
    FROM admin_blocking_notice_targets target
    JOIN admin_blocking_notices notice
      ON notice.id = target.notice_id
    WHERE target.user_id = $1
      AND notice.removed_at IS NULL
      AND (notice.expires_at IS NULL OR notice.expires_at > NOW())
    ORDER BY notice.created_at DESC
    LIMIT 1
    `,
    [normalizedUserId]
  );
  return res.rows[0] ?? null;
}

export async function listUserNotifications(
  client: any,
  userId: string,
  options: {
    limit?: number;
    unreadOnly?: boolean;
  } = {}
) {
  await ensureUserSignalSchema(client);
  const normalizedUserId = String(userId ?? '').trim();
  const limit = Math.min(Math.max(Number(options.limit ?? 20), 1), 100);
  const unreadOnly = options.unreadOnly === true;

  const notificationsRes = await client.query(
    `
    SELECT *
    FROM user_notifications
    WHERE user_id = $1
      ${unreadOnly ? 'AND read_at IS NULL' : ''}
    ORDER BY created_at DESC
    LIMIT $2
    `,
    [normalizedUserId, limit]
  );
  const unreadCountRes = await client.query(
    `
    SELECT COUNT(*)::int AS unread_count
    FROM user_notifications
    WHERE user_id = $1
      AND read_at IS NULL
    `,
    [normalizedUserId]
  );

  return {
    notifications: notificationsRes.rows,
    unreadCount: Number(unreadCountRes.rows[0]?.unread_count ?? 0),
  };
}

export async function markAllUserNotificationsRead(
  client: any,
  userId: string
) {
  await ensureUserSignalSchema(client);
  const normalizedUserId = String(userId ?? '').trim();
  const updated = await client.query(
    `
    DELETE FROM user_notifications
    WHERE user_id = $1
    RETURNING id
    `,
    [normalizedUserId]
  );
  return updated.rowCount ?? 0;
}

export async function updateUserNotificationReadState(
  client: any,
  userId: string,
  notificationId: string,
  read: boolean
) {
  await ensureUserSignalSchema(client);
  const normalizedUserId = String(userId ?? '').trim();
  const normalizedNotificationId = String(notificationId ?? '').trim();
  if (!normalizedUserId || !normalizedNotificationId) {
    return null;
  }

  const updated = await client.query(
    `
    UPDATE user_notifications
    SET read_at = CASE
      WHEN $3::boolean THEN COALESCE(read_at, NOW())
      ELSE NULL
    END
    WHERE user_id = $1
      AND id = $2
    RETURNING *
    `,
    [normalizedUserId, normalizedNotificationId, read]
  );

  return updated.rows[0] ?? null;
}

export async function deleteUserNotification(
  client: any,
  userId: string,
  notificationId: string
) {
  await ensureUserSignalSchema(client);
  const normalizedUserId = String(userId ?? '').trim();
  const normalizedNotificationId = String(notificationId ?? '').trim();
  if (!normalizedUserId || !normalizedNotificationId) {
    return null;
  }

  const deleted = await client.query(
    `
    DELETE FROM user_notifications
    WHERE user_id = $1
      AND id = $2
    RETURNING id
    `,
    [normalizedUserId, normalizedNotificationId]
  );

  return (deleted.rows[0]?.id as string | undefined) ?? null;
}

export async function collectCampaignNotificationUserIds(
  client: any,
  campaignId: string
) {
  const normalizedCampaignId = String(campaignId ?? '').trim();
  if (!normalizedCampaignId) {
    return [] as string[];
  }
  const res = await client.query(
    `
    SELECT DISTINCT participant_id
    FROM (
      SELECT business_id AS participant_id
      FROM campaigns
      WHERE id = $1
      UNION ALL
      SELECT assigned_ambassador_id AS participant_id
      FROM campaigns
      WHERE id = $1
      UNION ALL
      SELECT ambassador_id AS participant_id
      FROM contracts
      WHERE campaign_id = $1
    ) participants
    WHERE participant_id IS NOT NULL
    `,
    [normalizedCampaignId]
  );
  return res.rows
      .map((row: any) => String(row.participant_id ?? '').trim())
      .filter((value: string) => value.length > 0);
}
