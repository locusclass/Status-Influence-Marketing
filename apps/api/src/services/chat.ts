export const CHAT_THREAD_KIND_DIRECT = 'DIRECT';
export const CHAT_THREAD_KIND_GROUP_ROOM = 'GROUP_ROOM';
export const CHAT_THREAD_KIND_GROUP_DEAL = 'GROUP_DEAL';
export const CHAT_OFFER_STATUS_PENDING = 'PENDING';
export const CHAT_OFFER_STATUS_COUNTERED = 'COUNTERED';
export const CHAT_OFFER_STATUS_ACCEPTED = 'ACCEPTED';
export const CHAT_OFFER_STATUS_REJECTED = 'REJECTED';
export const CHAT_OFFER_RESPONSE_ACCEPT = 'ACCEPT';
export const CHAT_OFFER_RESPONSE_COUNTER = 'COUNTER';
export const CHAT_OFFER_RESPONSE_REJECT = 'REJECT';

export async function ensureChatSchema(client: any) {
  await client.query(`
    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS price_privacy_mode TEXT NOT NULL DEFAULT 'NEGOTIABLE'
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS chat_threads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      kind TEXT NOT NULL,
      title TEXT,
      direct_key TEXT UNIQUE,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      last_message_at TIMESTAMPTZ,
      media_url TEXT,
      media_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT chat_threads_kind_check CHECK (kind IN (
        '${CHAT_THREAD_KIND_DIRECT}',
        '${CHAT_THREAD_KIND_GROUP_ROOM}',
        '${CHAT_THREAD_KIND_GROUP_DEAL}'
      ))
    )
  `);

  await client.query(`
    ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS media_url TEXT;
    ALTER TABLE chat_threads ADD COLUMN IF NOT EXISTS media_type TEXT;
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
      media_url TEXT,
      media_type TEXT,
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
    CREATE TABLE IF NOT EXISTS chat_groups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id UUID NOT NULL UNIQUE REFERENCES chat_threads(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      logo_url TEXT NOT NULL DEFAULT '',
      public_price_ugx INTEGER NOT NULL DEFAULT 0,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      media_url TEXT,
      media_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    ALTER TABLE chat_groups
      ADD COLUMN IF NOT EXISTS logo_url TEXT NOT NULL DEFAULT ''
  `);
  await client.query(`
    ALTER TABLE chat_groups
      ADD COLUMN IF NOT EXISTS public_price_ugx INTEGER NOT NULL DEFAULT 0
  `);
  await client.query(`
    ALTER TABLE chat_groups
      ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT ''
  `);
  await client.query(`
    ALTER TABLE chat_groups
      ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  `);
  await client.query(`
    ALTER TABLE chat_groups
      ADD COLUMN IF NOT EXISTS public_id TEXT NOT NULL DEFAULT ''
  `);
  await client.query(`
    UPDATE chat_groups
    SET public_id = 'grp-' || SUBSTRING(REPLACE(id::text, '-', ''), 1, 12)
    WHERE public_id IS NULL OR BTRIM(public_id) = ''
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS chat_group_memberships (
      group_id UUID NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL DEFAULT 'MEMBER',
      status TEXT NOT NULL DEFAULT 'INVITED',
      invited_by UUID REFERENCES users(id) ON DELETE SET NULL,
      joined_at TIMESTAMPTZ,
      responded_at TIMESTAMPTZ,
      media_url TEXT,
      media_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (group_id, user_id)
    )
  `);
  await client.query(`
    ALTER TABLE chat_group_memberships
      DROP CONSTRAINT IF EXISTS chat_group_memberships_role_check
  `);
  await client.query(`
    ALTER TABLE chat_group_memberships
      ADD CONSTRAINT chat_group_memberships_role_check
      CHECK (role IN ('ADMIN', 'MEMBER'))
  `);
  await client.query(`
    ALTER TABLE chat_group_memberships
      DROP CONSTRAINT IF EXISTS chat_group_memberships_status_check
  `);
  await client.query(`
    ALTER TABLE chat_group_memberships
      ADD CONSTRAINT chat_group_memberships_status_check
      CHECK (status IN ('INVITED', 'ACTIVE', 'DECLINED', 'REMOVED'))
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS chat_group_deal_threads (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      group_id UUID NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      advertiser_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      thread_id UUID NOT NULL UNIQUE REFERENCES chat_threads(id) ON DELETE CASCADE,
      created_by UUID REFERENCES users(id) ON DELETE SET NULL,
      media_url TEXT,
      media_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (group_id, advertiser_id)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS chat_group_price_overrides (
      group_id UUID NOT NULL REFERENCES chat_groups(id) ON DELETE CASCADE,
      advertiser_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      override_price_ugx INTEGER NOT NULL DEFAULT 0,
      set_by UUID REFERENCES users(id) ON DELETE SET NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (group_id, advertiser_id)
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS chat_offer_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      thread_id UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
      parent_offer_id UUID REFERENCES chat_offer_events(id) ON DELETE SET NULL,
      offeror_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_kind TEXT NOT NULL DEFAULT 'USER',
      target_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      target_group_id UUID REFERENCES chat_groups(id) ON DELETE SET NULL,
      official_price_ugx INTEGER NOT NULL DEFAULT 0,
      proposed_price_ugx INTEGER NOT NULL DEFAULT 0,
      resolved_price_ugx INTEGER,
      media_type TEXT NOT NULL DEFAULT 'IMAGE',
      media_url TEXT,
      media_text TEXT,
      note TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '${CHAT_OFFER_STATUS_PENDING}',
      responded_by UUID REFERENCES users(id) ON DELETE SET NULL,
      responded_at TIMESTAMPTZ,
      media_url TEXT,
      media_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    ALTER TABLE chat_offer_events
      DROP CONSTRAINT IF EXISTS chat_offer_events_target_kind_check
  `);
  await client.query(`
    ALTER TABLE chat_offer_events
      ADD CONSTRAINT chat_offer_events_target_kind_check
      CHECK (target_kind IN ('USER', 'GROUP'))
  `);
  await client.query(`
    ALTER TABLE chat_offer_events
      DROP CONSTRAINT IF EXISTS chat_offer_events_status_check
  `);
  await client.query(`
    ALTER TABLE chat_offer_events
      ADD CONSTRAINT chat_offer_events_status_check
      CHECK (status IN (
        '${CHAT_OFFER_STATUS_PENDING}',
        '${CHAT_OFFER_STATUS_COUNTERED}',
        '${CHAT_OFFER_STATUS_ACCEPTED}',
        '${CHAT_OFFER_STATUS_REJECTED}'
      ))
  `);
  await client.query(`
    ALTER TABLE chat_offer_events
      DROP CONSTRAINT IF EXISTS chat_offer_events_media_type_check
  `);
  await client.query(`
    ALTER TABLE chat_offer_events
      ADD CONSTRAINT chat_offer_events_media_type_check
      CHECK (media_type IN ('IMAGE', 'VIDEO', 'TEXT'))
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS chat_offer_group_votes (
      offer_id UUID NOT NULL REFERENCES chat_offer_events(id) ON DELETE CASCADE,
      voter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      vote_action TEXT NOT NULL DEFAULT '${CHAT_OFFER_RESPONSE_ACCEPT}',
      counter_price_ugx INTEGER,
      media_url TEXT,
      media_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (offer_id, voter_id)
    )
  `);
  await client.query(`
    ALTER TABLE chat_offer_group_votes
      DROP CONSTRAINT IF EXISTS chat_offer_group_votes_vote_action_check
  `);
  await client.query(`
    ALTER TABLE chat_offer_group_votes
      ADD CONSTRAINT chat_offer_group_votes_vote_action_check
      CHECK (vote_action IN (
        '${CHAT_OFFER_RESPONSE_ACCEPT}',
        '${CHAT_OFFER_RESPONSE_COUNTER}',
        '${CHAT_OFFER_RESPONSE_REJECT}'
      ))
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
  await client.query(`
    CREATE INDEX IF NOT EXISTS chat_groups_name_idx
    ON chat_groups (LOWER(name))
  `);
  await client.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS chat_groups_public_id_idx
    ON chat_groups (public_id)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS chat_group_memberships_user_status_idx
    ON chat_group_memberships (user_id, status, updated_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS chat_group_memberships_group_status_idx
    ON chat_group_memberships (group_id, status, updated_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS chat_group_deal_threads_advertiser_idx
    ON chat_group_deal_threads (advertiser_id, updated_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS chat_offer_events_thread_created_idx
    ON chat_offer_events (thread_id, created_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS chat_offer_events_status_idx
    ON chat_offer_events (status, updated_at DESC)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS chat_offer_group_votes_offer_idx
    ON chat_offer_group_votes (offer_id, updated_at DESC)
  `);
}

