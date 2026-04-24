export async function ensureChatSchema(client: any) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kind TEXT NOT NULL DEFAULT 'DIRECT'
        CHECK (kind IN ('DIRECT')),
      direct_key TEXT UNIQUE,
      title TEXT NOT NULL DEFAULT '',
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      last_message_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS chat_thread_members (
      thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_at TIMESTAMPTZ,
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (thread_id, user_id)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS chat_typing_states (
      thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      draft_text TEXT NOT NULL DEFAULT '',
      is_typing BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (thread_id, user_id)
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS chat_thread_members_user_idx
    ON chat_thread_members (user_id, joined_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS chat_messages_thread_created_idx
    ON chat_messages (thread_id, created_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS chat_typing_states_thread_updated_idx
    ON chat_typing_states (thread_id, updated_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS chat_threads_last_message_idx
    ON chat_threads (last_message_at DESC NULLS LAST, created_at DESC)
  `);
}
