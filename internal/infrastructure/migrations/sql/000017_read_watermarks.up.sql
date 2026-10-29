CREATE TABLE IF NOT EXISTS conversation_read_watermarks (
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    last_read_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, conversation_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conv_watermarks_user ON conversation_read_watermarks(user_id);
