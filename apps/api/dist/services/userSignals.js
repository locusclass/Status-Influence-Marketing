import { pool } from '../db.js';
export async function ensureUserSignalSchema(client) {
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
}
export async function touchUserPresenceWithClient(client, userId, options = {}) {
    const normalizedUserId = String(userId ?? '').trim();
    if (!normalizedUserId)
        return;
    await ensureUserSignalSchema(client);
    await client.query(`
    UPDATE users
    SET last_seen_at = NOW(),
        last_login_at = CASE
          WHEN $2::boolean THEN NOW()
          ELSE last_login_at
        END
    WHERE id = $1
    `, [normalizedUserId, options.markLogin === true]);
}
export async function touchUserPresence(userId, options = {}) {
    const normalizedUserId = String(userId ?? '').trim();
    if (!normalizedUserId)
        return;
    const client = await pool.connect();
    try {
        await ensureUserSignalSchema(client);
        await client.query(`
      UPDATE users
      SET last_seen_at = NOW(),
          last_login_at = CASE
            WHEN $2::boolean THEN NOW()
            ELSE last_login_at
          END
      WHERE id = $1
      `, [normalizedUserId, options.markLogin === true]);
    }
    finally {
        client.release();
    }
}
export async function createUserNotifications(client, userIds, input) {
    await ensureUserSignalSchema(client);
    const uniqueUserIds = Array.from(new Set(userIds
        .map((value) => String(value ?? '').trim())
        .filter((value) => value.length > 0)));
    const actorId = typeof input.actorId === 'string' &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            .test(input.actorId.trim())
        ? input.actorId.trim()
        : null;
    for (const userId of uniqueUserIds) {
        await client.query(`
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
      `, [
            userId,
            input.category ?? 'ADMIN_ACTION',
            input.title,
            input.body,
            actorId,
            input.targetType ?? null,
            input.targetId ?? null,
            JSON.stringify(input.meta ?? {}),
        ]);
    }
}
export async function listUserNotifications(client, userId, options = {}) {
    await ensureUserSignalSchema(client);
    const normalizedUserId = String(userId ?? '').trim();
    const limit = Math.min(Math.max(Number(options.limit ?? 20), 1), 100);
    const unreadOnly = options.unreadOnly === true;
    const notificationsRes = await client.query(`
    SELECT *
    FROM user_notifications
    WHERE user_id = $1
      ${unreadOnly ? 'AND read_at IS NULL' : ''}
    ORDER BY created_at DESC
    LIMIT $2
    `, [normalizedUserId, limit]);
    const unreadCountRes = await client.query(`
    SELECT COUNT(*)::int AS unread_count
    FROM user_notifications
    WHERE user_id = $1
      AND read_at IS NULL
    `, [normalizedUserId]);
    return {
        notifications: notificationsRes.rows,
        unreadCount: Number(unreadCountRes.rows[0]?.unread_count ?? 0),
    };
}
export async function markAllUserNotificationsRead(client, userId) {
    await ensureUserSignalSchema(client);
    const normalizedUserId = String(userId ?? '').trim();
    const updated = await client.query(`
    DELETE FROM user_notifications
    WHERE user_id = $1
    RETURNING id
    `, [normalizedUserId]);
    return updated.rowCount ?? 0;
}
export async function updateUserNotificationReadState(client, userId, notificationId, read) {
    await ensureUserSignalSchema(client);
    const normalizedUserId = String(userId ?? '').trim();
    const normalizedNotificationId = String(notificationId ?? '').trim();
    if (!normalizedUserId || !normalizedNotificationId) {
        return null;
    }
    const updated = await client.query(`
    UPDATE user_notifications
    SET read_at = CASE
      WHEN $3::boolean THEN COALESCE(read_at, NOW())
      ELSE NULL
    END
    WHERE user_id = $1
      AND id = $2
    RETURNING *
    `, [normalizedUserId, normalizedNotificationId, read]);
    return updated.rows[0] ?? null;
}
export async function deleteUserNotification(client, userId, notificationId) {
    await ensureUserSignalSchema(client);
    const normalizedUserId = String(userId ?? '').trim();
    const normalizedNotificationId = String(notificationId ?? '').trim();
    if (!normalizedUserId || !normalizedNotificationId) {
        return null;
    }
    const deleted = await client.query(`
    DELETE FROM user_notifications
    WHERE user_id = $1
      AND id = $2
    RETURNING id
    `, [normalizedUserId, normalizedNotificationId]);
    return deleted.rows[0]?.id ?? null;
}
export async function collectCampaignNotificationUserIds(client, campaignId) {
    const normalizedCampaignId = String(campaignId ?? '').trim();
    if (!normalizedCampaignId) {
        return [];
    }
    const res = await client.query(`
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
    `, [normalizedCampaignId]);
    return res.rows
        .map((row) => String(row.participant_id ?? '').trim())
        .filter((value) => value.length > 0);
}
