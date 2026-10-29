-- Phase 16: Public & Private conversations (Groups and Channels) with invite links and handles.
ALTER TABLE conversations ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversations ADD COLUMN username TEXT;
ALTER TABLE conversations ADD COLUMN invite_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_username ON conversations(username) WHERE username IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_invite_code ON conversations(invite_code) WHERE invite_code IS NOT NULL;
