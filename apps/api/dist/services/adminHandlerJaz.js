import { ensureUserProfilesTable } from './userProfiles.js';
export const ADMIN_HANDLER_JAZ_ROOM_KEY = 'HANDLER_JAZ';
export const ADMIN_HANDLER_JAZ_MESSAGE_TTL_HOURS = 24;
export const ADMIN_HANDLER_JAZ_SIGNAL_TTL_MINUTES = 20;
export const ADMIN_HANDLER_JAZ_PRESENCE_WINDOW_SECONDS = 45;
export async function ensureAdminHandlerJazSchema(client) {
    await ensureUserProfilesTable(client);
    await client.query(`
    CREATE TABLE IF NOT EXISTS admin_handler_jaz_identities (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      handle TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await client.query(`
    CREATE TABLE IF NOT EXISTS admin_handler_jaz_presence (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      handle TEXT NOT NULL,
      current_pane TEXT NOT NULL DEFAULT 'OVERVIEW',
      is_room_open BOOLEAN NOT NULL DEFAULT FALSE,
      is_minimized BOOLEAN NOT NULL DEFAULT FALSE,
      in_call BOOLEAN NOT NULL DEFAULT FALSE,
      call_mode TEXT NOT NULL DEFAULT 'NONE',
      screen_share_active BOOLEAN NOT NULL DEFAULT FALSE,
      call_session_id TEXT,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
    await client.query(`
    ALTER TABLE admin_handler_jaz_presence
      DROP CONSTRAINT IF EXISTS admin_handler_jaz_presence_call_mode_check
  `);
    await client.query(`
    ALTER TABLE admin_handler_jaz_presence
      ADD CONSTRAINT admin_handler_jaz_presence_call_mode_check
      CHECK (call_mode IN ('NONE', 'AUDIO', 'VIDEO'))
  `);
    await client.query(`
    CREATE TABLE IF NOT EXISTS admin_handler_jaz_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sender_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_handle TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      attachment_url TEXT,
      attachment_name TEXT,
      attachment_mime_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
    )
  `);
    await client.query(`
    ALTER TABLE admin_handler_jaz_messages
      DROP CONSTRAINT IF EXISTS admin_handler_jaz_messages_body_or_attachment_check
  `);
    await client.query(`
    ALTER TABLE admin_handler_jaz_messages
      ADD CONSTRAINT admin_handler_jaz_messages_body_or_attachment_check
      CHECK (BTRIM(COALESCE(body, '')) <> '' OR attachment_url IS NOT NULL)
  `);
    await client.query(`
    CREATE TABLE IF NOT EXISTS admin_handler_jaz_signal_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      sender_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_handle TEXT NOT NULL,
      target_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '20 minutes'
    )
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS admin_handler_jaz_presence_seen_idx
    ON admin_handler_jaz_presence (last_seen_at DESC, updated_at DESC)
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS admin_handler_jaz_messages_created_idx
    ON admin_handler_jaz_messages (created_at DESC)
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS admin_handler_jaz_messages_expires_idx
    ON admin_handler_jaz_messages (expires_at ASC)
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS admin_handler_jaz_signal_events_target_created_idx
    ON admin_handler_jaz_signal_events (target_user_id, created_at DESC)
  `);
    await client.query(`
    CREATE INDEX IF NOT EXISTS admin_handler_jaz_signal_events_expires_idx
    ON admin_handler_jaz_signal_events (expires_at ASC)
  `);
}
export async function cleanupAdminHandlerJaz(client) {
    await ensureAdminHandlerJazSchema(client);
    await client.query(`
    DELETE FROM admin_handler_jaz_messages
    WHERE expires_at <= NOW()
    `);
    await client.query(`
    DELETE FROM admin_handler_jaz_signal_events
    WHERE expires_at <= NOW()
    `);
}
export function timestampText(value) {
    if (value == null)
        return null;
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime()))
        return null;
    return date.toISOString();
}
export function parseLiveCursor(value) {
    const raw = String(value ?? '').trim();
    if (!raw)
        return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime()))
        return null;
    return parsed.toISOString();
}
export function maxLiveCursor(values) {
    let latest = null;
    let latestMs = -1;
    for (const value of values) {
        const iso = timestampText(value);
        if (!iso)
            continue;
        const millis = Date.parse(iso);
        if (Number.isNaN(millis) || millis <= latestMs)
            continue;
        latest = iso;
        latestMs = millis;
    }
    return latest ?? new Date(0).toISOString();
}
export async function loadAdminHandlerJazIdentity(client, userId) {
    await ensureAdminHandlerJazSchema(client);
    const res = await client.query(`
    SELECT user_id, handle, created_at, updated_at
    FROM admin_handler_jaz_identities
    WHERE user_id = $1
    LIMIT 1
    `, [userId]);
    return res.rows[0] ?? null;
}
export async function upsertAdminHandlerJazIdentity(client, input) {
    await ensureAdminHandlerJazSchema(client);
    const res = await client.query(`
    INSERT INTO admin_handler_jaz_identities (user_id, handle, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET handle = EXCLUDED.handle,
          updated_at = NOW()
    RETURNING user_id, handle, created_at, updated_at
    `, [input.userId, input.handle]);
    return res.rows[0];
}
export async function upsertAdminHandlerJazPresence(client, input) {
    await ensureAdminHandlerJazSchema(client);
    const res = await client.query(`
    INSERT INTO admin_handler_jaz_presence (
      user_id,
      handle,
      current_pane,
      is_room_open,
      is_minimized,
      in_call,
      call_mode,
      screen_share_active,
      call_session_id,
      joined_at,
      last_seen_at,
      updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW(), NOW())
    ON CONFLICT (user_id) DO UPDATE
      SET handle = EXCLUDED.handle,
          current_pane = EXCLUDED.current_pane,
          is_room_open = EXCLUDED.is_room_open,
          is_minimized = EXCLUDED.is_minimized,
          in_call = EXCLUDED.in_call,
          call_mode = EXCLUDED.call_mode,
          screen_share_active = EXCLUDED.screen_share_active,
          call_session_id = EXCLUDED.call_session_id,
          last_seen_at = NOW(),
          updated_at = NOW()
    RETURNING *
    `, [
        input.userId,
        input.handle,
        String(input.currentPane ?? 'OVERVIEW').trim().toUpperCase() || 'OVERVIEW',
        input.isRoomOpen === true,
        input.isMinimized === true,
        input.inCall === true,
        normalizePresenceMode(input.callMode),
        input.screenShareActive === true,
        normalizeOptionalText(input.callSessionId),
    ]);
    return res.rows[0];
}
export async function deactivateAdminHandlerJazPresence(client, userId) {
    await ensureAdminHandlerJazSchema(client);
    await client.query(`
    UPDATE admin_handler_jaz_presence
    SET is_room_open = FALSE,
        is_minimized = FALSE,
        in_call = FALSE,
        call_mode = 'NONE',
        screen_share_active = FALSE,
        call_session_id = NULL,
        updated_at = NOW(),
        last_seen_at = NOW() - INTERVAL '10 minutes'
    WHERE user_id = $1
    `, [userId]);
}
export async function createAdminHandlerJazMessage(client, input) {
    await ensureAdminHandlerJazSchema(client);
    const res = await client.query(`
    INSERT INTO admin_handler_jaz_messages (
      sender_user_id,
      sender_handle,
      body,
      attachment_url,
      attachment_name,
      attachment_mime_type
    )
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING *
    `, [
        input.senderUserId,
        input.senderHandle,
        String(input.body ?? '').trim(),
        normalizeOptionalText(input.attachmentUrl),
        normalizeOptionalText(input.attachmentName),
        normalizeOptionalText(input.attachmentMimeType),
    ]);
    return serializeAdminHandlerJazMessage(res.rows[0]);
}
export async function createAdminHandlerJazSignalEvent(client, input) {
    await ensureAdminHandlerJazSchema(client);
    const ttlMinutes = Math.max(1, Math.min(Number(input.ttlMinutes ?? ADMIN_HANDLER_JAZ_SIGNAL_TTL_MINUTES), 60));
    const res = await client.query(`
    INSERT INTO admin_handler_jaz_signal_events (
      sender_user_id,
      sender_handle,
      target_user_id,
      event_type,
      payload,
      expires_at
    )
    VALUES ($1, $2, $3, $4, $5::jsonb, NOW() + ($6::text || ' minutes')::interval)
    RETURNING *
    `, [
        input.senderUserId,
        input.senderHandle,
        normalizeOptionalText(input.targetUserId),
        input.eventType,
        JSON.stringify(input.payload ?? {}),
        ttlMinutes.toString(),
    ]);
    return serializeAdminHandlerJazSignal(res.rows[0]);
}
export async function listAdminHandlerJazParticipants(client) {
    await ensureAdminHandlerJazSchema(client);
    const res = await client.query(`
    SELECT
      presence.user_id,
      presence.handle,
      presence.current_pane,
      presence.is_room_open,
      presence.is_minimized,
      presence.in_call,
      presence.call_mode,
      presence.screen_share_active,
      presence.call_session_id,
      presence.joined_at,
      presence.last_seen_at,
      presence.updated_at,
      COALESCE(NULLIF(u.full_name, ''), NULLIF(u.email, ''), NULLIF(u.phone, ''), 'Admin') AS display_name,
      COALESCE(profile.avatar_url, '') AS avatar_url,
      CASE
        WHEN presence.last_seen_at >= NOW() - INTERVAL '${ADMIN_HANDLER_JAZ_PRESENCE_WINDOW_SECONDS} seconds'
          THEN TRUE
        ELSE FALSE
      END AS is_available
    FROM admin_handler_jaz_presence presence
    JOIN users u ON u.id = presence.user_id
    LEFT JOIN user_profiles profile ON profile.user_id = presence.user_id
    ORDER BY
      CASE
        WHEN presence.last_seen_at >= NOW() - INTERVAL '${ADMIN_HANDLER_JAZ_PRESENCE_WINDOW_SECONDS} seconds'
          THEN 0
        ELSE 1
      END,
      presence.last_seen_at DESC,
      presence.updated_at DESC
    `);
    return res.rows.map(serializeAdminHandlerJazParticipant);
}
export async function listAdminHandlerJazMessages(client, options = {}) {
    await ensureAdminHandlerJazSchema(client);
    const limit = Math.min(Math.max(Number(options.limit ?? 80), 1), 200);
    const params = [];
    const conditions = [`expires_at > NOW()`];
    if (options.since) {
        params.push(options.since);
        conditions.push(`created_at > $${params.length}`);
    }
    params.push(limit);
    const res = await client.query(`
    SELECT *
    FROM admin_handler_jaz_messages
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at ASC
    LIMIT $${params.length}
    `, params);
    return res.rows.map(serializeAdminHandlerJazMessage);
}
export async function listAdminHandlerJazSignalEvents(client, userId, options = {}) {
    await ensureAdminHandlerJazSchema(client);
    const limit = Math.min(Math.max(Number(options.limit ?? 120), 1), 300);
    const params = [userId];
    const conditions = [
        `expires_at > NOW()`,
        `(target_user_id IS NULL OR target_user_id = $1)`,
    ];
    if (options.since) {
        params.push(options.since);
        conditions.push(`created_at > $${params.length}`);
    }
    params.push(limit);
    const res = await client.query(`
    SELECT *
    FROM admin_handler_jaz_signal_events
    WHERE ${conditions.join(' AND ')}
    ORDER BY created_at ASC
    LIMIT $${params.length}
    `, params);
    return res.rows.map(serializeAdminHandlerJazSignal);
}
export function serializeAdminHandlerJazParticipant(row) {
    return {
        user_id: String(row?.user_id ?? ''),
        handle: String(row?.handle ?? ''),
        display_name: String(row?.display_name ?? 'Admin'),
        avatar_url: String(row?.avatar_url ?? ''),
        current_pane: String(row?.current_pane ?? 'OVERVIEW'),
        is_room_open: row?.is_room_open === true,
        is_minimized: row?.is_minimized === true,
        is_available: row?.is_available === true,
        in_call: row?.in_call === true,
        call_mode: normalizePresenceMode(row?.call_mode),
        screen_share_active: row?.screen_share_active === true,
        call_session_id: normalizeOptionalText(row?.call_session_id),
        joined_at: timestampText(row?.joined_at),
        last_seen_at: timestampText(row?.last_seen_at),
        updated_at: timestampText(row?.updated_at),
    };
}
export function serializeAdminHandlerJazMessage(row) {
    return {
        id: String(row?.id ?? ''),
        sender_user_id: String(row?.sender_user_id ?? ''),
        sender_handle: String(row?.sender_handle ?? ''),
        body: String(row?.body ?? ''),
        attachment_url: normalizeOptionalText(row?.attachment_url),
        attachment_name: normalizeOptionalText(row?.attachment_name),
        attachment_mime_type: normalizeOptionalText(row?.attachment_mime_type),
        created_at: timestampText(row?.created_at),
        expires_at: timestampText(row?.expires_at),
    };
}
export function serializeAdminHandlerJazSignal(row) {
    return {
        id: String(row?.id ?? ''),
        sender_user_id: String(row?.sender_user_id ?? ''),
        sender_handle: String(row?.sender_handle ?? ''),
        target_user_id: normalizeOptionalText(row?.target_user_id),
        event_type: String(row?.event_type ?? ''),
        payload: row?.payload && typeof row.payload === 'object' ? row.payload : {},
        created_at: timestampText(row?.created_at),
        expires_at: timestampText(row?.expires_at),
    };
}
function normalizeOptionalText(value) {
    const text = String(value ?? '').trim();
    return text.length > 0 ? text : null;
}
function normalizePresenceMode(value) {
    const mode = String(value ?? 'NONE').trim().toUpperCase();
    if (mode === 'AUDIO' || mode === 'VIDEO') {
        return mode;
    }
    return 'NONE';
}
