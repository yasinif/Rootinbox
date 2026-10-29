-- Amendment RFC-0007-B: Group & Channel Non-E2EE Conversations
-- conversations metadata extension
ALTER TABLE conversations ADD COLUMN name TEXT;
ALTER TABLE conversations ADD COLUMN description TEXT;
ALTER TABLE conversations ADD COLUMN created_by TEXT;

-- Table: group_messages
CREATE TABLE group_messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    sender_id       TEXT NOT NULL,
    content         TEXT NOT NULL,
    reply_to_id     TEXT,
    edited_at       INTEGER,
    deleted_at      INTEGER,
    created_at      INTEGER NOT NULL,
    server_id       INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_group_messages_conv_server ON group_messages(conversation_id, server_id);
