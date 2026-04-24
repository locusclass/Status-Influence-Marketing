import { z } from 'zod';
import { withTransaction } from '../db.js';
import { ensureChatSchema } from '../services/chat.js';
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
function authUserId(request) {
    const authSub = request.user?.sub;
    return authSub === 'ariaka-access'
        ? '00000000-0000-0000-0000-000000000000'
        : authSub;
}
function timestampText(value) {
    if (value == null)
        return null;
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime()))
        return null;
    return date.toISOString();
}
function maxCursor(values) {
    let latest = null;
    let latestMs = -1;
    for (const value of values) {
        const iso = timestampText(value);
        if (iso == null)
            continue;
        const millis = Date.parse(iso);
        if (Number.isNaN(millis) || millis <= latestMs)
            continue;
        latest = iso;
        latestMs = millis;
    }
    return latest ?? new Date(0).toISOString();
}
function parseCursor(value) {
    const raw = String(value ?? '').trim();
    if (!raw)
        return null;
    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime()))
        return null;
    return parsed.toISOString();
}
function counterpartyName(row) {
    return String(row.counterpart_name ??
        row.display_name ??
        row.full_name ??
        row.email ??
        row.phone ??
        'Participant').trim();
}
function serializeThreadSummary(row) {
    const counterpartId = String(row.counterpart_id ?? '').trim();
    return {
        id: String(row.id ?? ''),
        kind: String(row.kind ?? 'DIRECT'),
        title: String(row.title ?? ''),
        created_at: timestampText(row.created_at),
        last_activity_at: timestampText(row.last_activity_at ?? row.last_message_at ?? row.created_at),
        unread_count: Math.max(0, Number(row.unread_count ?? 0)),
        live_draft_text: String(row.live_draft_text ?? '').trim(),
        counterpart: counterpartId.length === 0
            ? null
            : {
                id: counterpartId,
                public_id: String(row.counterpart_public_id ?? ''),
                display_name: counterpartyName(row),
                role: String(row.counterpart_role ?? 'DISTRIBUTOR'),
                active_role: String(row.counterpart_active_role ?? 'DISTRIBUTOR'),
                is_online: row.counterpart_is_online === true,
                last_seen_at: timestampText(row.counterpart_last_seen_at),
            },
        last_message: row.last_message_id == null
            ? null
            : {
                id: String(row.last_message_id),
                body: String(row.last_message_body ?? ''),
                sender_id: String(row.last_message_sender_id ?? ''),
                created_at: timestampText(row.last_message_created_at),
            },
    };
}
function serializeMessage(row) {
    return {
        id: String(row.id ?? ''),
        body: String(row.body ?? ''),
        sender_id: String(row.sender_id ?? ''),
        sender_name: String(row.sender_name ?? ''),
        created_at: timestampText(row.created_at),
    };
}
function serializeTypingState(row) {
    return {
        user_id: String(row.user_id ?? ''),
        draft_text: String(row.draft_text ?? ''),
        updated_at: timestampText(row.updated_at),
        display_name: String(row.display_name ?? ''),
        public_id: String(row.public_id ?? ''),
    };
}
async function usersCanChatDirectly(client, userId, participantId) {
    const relationRes = await client.query(`
    SELECT EXISTS (
      SELECT 1
      FROM campaigns c
      WHERE (
        c.advertiser_id = $1
        AND c.assigned_distributor_id = $2
      ) OR (
        c.advertiser_id = $2
        AND c.assigned_distributor_id = $1
      )
      UNION
      SELECT 1
      FROM contracts ctr
      JOIN campaigns c ON c.id = ctr.campaign_id
      WHERE (
        c.advertiser_id = $1
        AND ctr.distributor_id = $2
      ) OR (
        c.advertiser_id = $2
        AND ctr.distributor_id = $1
      )
    ) AS allowed
    `, [userId, participantId]);
    return relationRes.rows[0]?.allowed === true;
}
async function ensureDirectThread(client, userId, participantId) {
    const directKey = [userId, participantId].sort().join(':');
    const threadRes = await client.query(`
    INSERT INTO chat_threads (kind, direct_key, created_by)
    VALUES ('DIRECT', $1, $2)
    ON CONFLICT (direct_key) DO UPDATE
      SET direct_key = EXCLUDED.direct_key
    RETURNING *
    `, [directKey, userId]);
    const thread = threadRes.rows[0];
    await client.query(`
    INSERT INTO chat_thread_members (thread_id, user_id)
    VALUES ($1, $2), ($1, $3)
    ON CONFLICT DO NOTHING
    `, [thread.id, userId, participantId]);
    return thread;
}
async function listThreadSummaries(client, userId, options = {}) {
    const params = [userId];
    let threadFilterSql = '';
    if (options.threadId) {
        params.push(options.threadId);
        threadFilterSql = `AND t.id = $2`;
    }
    const res = await client.query(`
    SELECT
      t.id,
      t.kind,
      t.title,
      t.created_at,
      COALESCE(t.last_message_at, t.created_at) AS last_activity_at,
      other.user_id AS counterpart_id,
      other.public_id AS counterpart_public_id,
      other.display_name AS counterpart_name,
      other.role AS counterpart_role,
      other.active_role AS counterpart_active_role,
      other.last_seen_at AS counterpart_last_seen_at,
      (other.last_seen_at >= NOW() - interval '2 minutes') AS counterpart_is_online,
      lm.id AS last_message_id,
      lm.body AS last_message_body,
      lm.sender_id AS last_message_sender_id,
      lm.created_at AS last_message_created_at,
      COALESCE(unread.unread_count, 0)::int AS unread_count,
      COALESCE(typing.draft_text, '') AS live_draft_text
    FROM chat_thread_members self
    JOIN chat_threads t ON t.id = self.thread_id
    LEFT JOIN LATERAL (
      SELECT
        member.user_id,
        u.public_id,
        COALESCE(NULLIF(u.full_name, ''), NULLIF(u.email, ''), NULLIF(u.phone, ''), 'Participant') AS display_name,
        COALESCE(NULLIF(u.role, ''), 'DISTRIBUTOR') AS role,
        COALESCE(NULLIF(u.active_role, ''), COALESCE(NULLIF(u.role, ''), 'DISTRIBUTOR')) AS active_role,
        u.last_seen_at
      FROM chat_thread_members member
      JOIN users u ON u.id = member.user_id
      WHERE member.thread_id = t.id
        AND member.user_id <> self.user_id
      ORDER BY member.joined_at ASC
      LIMIT 1
    ) other ON TRUE
    LEFT JOIN LATERAL (
      SELECT msg.id, msg.body, msg.sender_id, msg.created_at
      FROM chat_messages msg
      WHERE msg.thread_id = t.id
      ORDER BY msg.created_at DESC
      LIMIT 1
    ) lm ON TRUE
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS unread_count
      FROM chat_messages msg
      WHERE msg.thread_id = t.id
        AND msg.sender_id <> self.user_id
        AND (self.last_read_at IS NULL OR msg.created_at > self.last_read_at)
    ) unread ON TRUE
    LEFT JOIN LATERAL (
      SELECT state.draft_text
      FROM chat_typing_states state
      WHERE state.thread_id = t.id
        AND state.user_id <> self.user_id
        AND state.is_typing = TRUE
        AND state.updated_at >= NOW() - interval '15 seconds'
      ORDER BY state.updated_at DESC
      LIMIT 1
    ) typing ON TRUE
    WHERE self.user_id = $1
      ${threadFilterSql}
    ORDER BY COALESCE(t.last_message_at, t.created_at) DESC, t.created_at DESC
    `, params);
    return res.rows.map(serializeThreadSummary);
}
async function listChatContacts(client, userId) {
    const res = await client.query(`
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
    `, [userId]);
    return res.rows.map((row) => ({
        id: String(row.id ?? ''),
        public_id: String(row.public_id ?? ''),
        display_name: String(row.display_name ?? ''),
        role: String(row.role ?? 'DISTRIBUTOR'),
        active_role: String(row.active_role ?? row.role ?? 'DISTRIBUTOR'),
        is_online: row.is_online === true,
        last_seen_at: timestampText(row.last_seen_at),
    }));
}
async function assertThreadMember(client, threadId, userId) {
    const res = await client.query(`
    SELECT t.*
    FROM chat_threads t
    JOIN chat_thread_members member ON member.thread_id = t.id
    WHERE t.id = $1
      AND member.user_id = $2
    LIMIT 1
    `, [threadId, userId]);
    return res.rows[0] ?? null;
}
async function listThreadMessages(client, threadId, options = {}) {
    const params = [threadId];
    let sinceSql = '';
    if (options.since) {
        params.push(options.since);
        sinceSql = `AND msg.created_at > $2::timestamptz`;
    }
    else {
        params.push(Math.min(Math.max(Number(options.limit ?? 80), 1), 200));
        sinceSql = `ORDER BY msg.created_at DESC LIMIT $2`;
    }
    const res = await client.query(options.since
        ? `
          SELECT
            msg.id,
            msg.body,
            msg.sender_id,
            msg.created_at,
            COALESCE(NULLIF(u.full_name, ''), NULLIF(u.email, ''), NULLIF(u.phone, ''), 'Participant') AS sender_name
          FROM chat_messages msg
          JOIN users u ON u.id = msg.sender_id
          WHERE msg.thread_id = $1
            ${sinceSql}
          ORDER BY msg.created_at ASC
        `
        : `
          SELECT *
          FROM (
            SELECT
              msg.id,
              msg.body,
              msg.sender_id,
              msg.created_at,
              COALESCE(NULLIF(u.full_name, ''), NULLIF(u.email, ''), NULLIF(u.phone, ''), 'Participant') AS sender_name
            FROM chat_messages msg
            JOIN users u ON u.id = msg.sender_id
            WHERE msg.thread_id = $1
            ${sinceSql}
          ) recent_messages
          ORDER BY recent_messages.created_at ASC
        `, params);
    return res.rows.map(serializeMessage);
}
async function listActiveTypingStates(client, threadId, userId) {
    const res = await client.query(`
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
    `, [threadId, userId]);
    return res.rows.map(serializeTypingState);
}
async function markThreadRead(client, threadId, userId) {
    await client.query(`
    UPDATE chat_thread_members
    SET last_read_at = NOW()
    WHERE thread_id = $1
      AND user_id = $2
    `, [threadId, userId]);
}
async function buildThreadDetail(client, threadId, userId) {
    const thread = await assertThreadMember(client, threadId, userId);
    if (!thread)
        return null;
    await markThreadRead(client, threadId, userId);
    const summary = (await listThreadSummaries(client, userId, { threadId }))[0] ?? null;
    const messages = await listThreadMessages(client, threadId, { limit: 80 });
    const typingStates = await listActiveTypingStates(client, threadId, userId);
    const cursor = maxCursor([
        summary?.last_activity_at,
        ...messages.map((message) => message.created_at),
        ...typingStates.map((state) => state.updated_at),
    ]);
    return {
        thread: summary,
        messages,
        typing_states: typingStates,
        cursor,
    };
}
export async function chatRoutes(app) {
    app.addHook('onReady', async () => {
        await withTransaction(async (client) => {
            await ensureChatSchema(client);
        });
    });
    app.get('/chat/contacts', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = authUserId(request);
        if (!userId) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        const contacts = await withTransaction(async (client) => {
            await ensureChatSchema(client);
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
            const participantRes = await client.query(`
        SELECT id
        FROM users
        WHERE id = $1
        LIMIT 1
        `, [parsed.data.participant_id]);
            if (!participantRes.rows[0]) {
                return { error: 'participant_not_found' };
            }
            const allowed = await usersCanChatDirectly(client, userId, parsed.data.participant_id);
            if (!allowed) {
                return { error: 'chat_not_allowed' };
            }
            const thread = await ensureDirectThread(client, userId, parsed.data.participant_id);
            return buildThreadDetail(client, String(thread.id), userId);
        });
        if (result?.error) {
            reply.code(result.error === 'participant_not_found'
                ? 404
                : result.error === 'chat_not_allowed'
                    ? 403
                    : 400);
            return result;
        }
        return result;
    });
    app.get('/chat/threads/:id', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = authUserId(request);
        const params = request.params;
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
        const params = request.params;
        const query = (request.query ?? {});
        if (!userId) {
            reply.code(401);
            return { error: 'unauthorized' };
        }
        const cursor = parseCursor(query.cursor);
        const live = await withTransaction(async (client) => {
            await ensureChatSchema(client);
            const thread = await assertThreadMember(client, params.id, userId);
            if (!thread)
                return null;
            const typingStates = await listActiveTypingStates(client, params.id, userId);
            const messages = await listThreadMessages(client, params.id, {
                since: cursor,
            });
            if (messages.isNotEmpty) {
                await markThreadRead(client, params.id, userId);
            }
            const latestRowRes = await client.query(`
        SELECT
          COALESCE(
            (SELECT MAX(created_at) FROM chat_messages WHERE thread_id = $1),
            (SELECT MAX(updated_at) FROM chat_typing_states WHERE thread_id = $1),
            $2::timestamptz
          ) AS latest_cursor
        `, [params.id, cursor ?? new Date(0).toISOString()]);
            const latestCursor = maxCursor([
                latestRowRes.rows[0]?.latest_cursor,
                ...messages.map((message) => message.created_at),
                ...typingStates.map((state) => state.updated_at),
            ]);
            const hasChanges = cursor == null ||
                messages.isNotEmpty ||
                typingStates.isNotEmpty ||
                latestCursor != (cursor ?? new Date(0).toISOString());
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
        const params = request.params;
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
            if (!thread)
                return { error: 'thread_not_found' };
            const insertRes = await client.query(`
        INSERT INTO chat_messages (thread_id, sender_id, body)
        VALUES ($1, $2, $3)
        RETURNING *
        `, [params.id, userId, parsed.data.body]);
            await client.query(`
        UPDATE chat_threads
        SET last_message_at = NOW()
        WHERE id = $1
        `, [params.id]);
            await client.query(`
        INSERT INTO chat_typing_states (thread_id, user_id, draft_text, is_typing, updated_at)
        VALUES ($1, $2, '', FALSE, NOW())
        ON CONFLICT (thread_id, user_id) DO UPDATE
          SET draft_text = EXCLUDED.draft_text,
              is_typing = EXCLUDED.is_typing,
              updated_at = EXCLUDED.updated_at
        `, [params.id, userId]);
            await markThreadRead(client, params.id, userId);
            const senderNameRes = await client.query(`
        SELECT COALESCE(NULLIF(full_name, ''), NULLIF(email, ''), NULLIF(phone, ''), 'Participant') AS sender_name
        FROM users
        WHERE id = $1
        LIMIT 1
        `, [userId]);
            const senderName = String(senderNameRes.rows[0]?.sender_name ?? 'New message').trim();
            const threadSummary = (await listThreadSummaries(client, userId, {
                threadId: params.id,
            }))[0];
            const message = serializeMessage({
                ...insertRes.rows[0],
                sender_name: senderName,
            });
            const memberIdsRes = await client.query(`
        SELECT user_id
        FROM chat_thread_members
        WHERE thread_id = $1
          AND user_id <> $2
        `, [params.id, userId]);
            await createUserNotifications(client, memberIdsRes.rows.map((row) => row.user_id), {
                category: 'BARGAIN_TABLE',
                title: 'New Bargain Table message',
                body: `${senderName}: ${parsed.data.body}`,
                actorId: userId,
                targetType: 'CHAT_THREAD',
                targetId: params.id,
            });
            return {
                message,
                thread: threadSummary,
            };
        });
        if (result?.error) {
            reply.code(result.error === 'thread_not_found' ? 404 : 400);
            return result;
        }
        return result;
    });
    app.post('/chat/threads/:id/typing', { preHandler: [app.authenticate] }, async (request, reply) => {
        const userId = authUserId(request);
        const params = request.params;
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
            if (!thread)
                return { error: 'thread_not_found' };
            await client.query(`
        INSERT INTO chat_typing_states (thread_id, user_id, draft_text, is_typing, updated_at)
        VALUES ($1, $2, $3, $4, NOW())
        ON CONFLICT (thread_id, user_id) DO UPDATE
          SET draft_text = EXCLUDED.draft_text,
              is_typing = EXCLUDED.is_typing,
              updated_at = EXCLUDED.updated_at
        `, [
                params.id,
                userId,
                isTyping ? draftText : '',
                isTyping,
            ]);
            return {
                ok: true,
                typing_state: {
                    draft_text: isTyping ? draftText : '',
                    is_typing: isTyping,
                    updated_at: new Date().toISOString(),
                },
            };
        });
        if (result?.error) {
            reply.code(result.error === 'thread_not_found' ? 404 : 400);
            return result;
        }
        return result;
    });
}
