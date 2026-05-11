CREATE TABLE IF NOT EXISTS admin_handler_jaz_identities (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  handle TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
);

ALTER TABLE admin_handler_jaz_presence
  DROP CONSTRAINT IF EXISTS admin_handler_jaz_presence_call_mode_check;

ALTER TABLE admin_handler_jaz_presence
  ADD CONSTRAINT admin_handler_jaz_presence_call_mode_check
  CHECK (call_mode IN ('NONE', 'AUDIO', 'VIDEO'));

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
);

ALTER TABLE admin_handler_jaz_messages
  DROP CONSTRAINT IF EXISTS admin_handler_jaz_messages_body_or_attachment_check;

ALTER TABLE admin_handler_jaz_messages
  ADD CONSTRAINT admin_handler_jaz_messages_body_or_attachment_check
  CHECK (BTRIM(COALESCE(body, '')) <> '' OR attachment_url IS NOT NULL);

CREATE TABLE IF NOT EXISTS admin_handler_jaz_signal_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sender_handle TEXT NOT NULL,
  target_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '20 minutes'
);

CREATE INDEX IF NOT EXISTS admin_handler_jaz_presence_seen_idx
  ON admin_handler_jaz_presence (last_seen_at DESC, updated_at DESC);

CREATE INDEX IF NOT EXISTS admin_handler_jaz_messages_created_idx
  ON admin_handler_jaz_messages (created_at DESC);

CREATE INDEX IF NOT EXISTS admin_handler_jaz_messages_expires_idx
  ON admin_handler_jaz_messages (expires_at ASC);

CREATE INDEX IF NOT EXISTS admin_handler_jaz_signal_events_target_created_idx
  ON admin_handler_jaz_signal_events (target_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS admin_handler_jaz_signal_events_expires_idx
  ON admin_handler_jaz_signal_events (expires_at ASC);
