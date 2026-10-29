-- Migration 000014: Message History (E2EE Vault Ciphertext Archive)
-- Stores client-sealed vault-ciphertext for cross-device history sync.
-- Zero-Knowledge invariant: Server stores ciphertext and IV only.

CREATE TABLE message_history (
    id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    sender_id TEXT NOT NULL,
    receiver_id TEXT,
    encrypted_payload BLOB NOT NULL,
    vault_iv BLOB NOT NULL,
    sequence_number INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER,
    deleted_at INTEGER,
    PRIMARY KEY (user_id, id)
);

CREATE INDEX idx_history_user_conv_time ON message_history(user_id, conversation_id, created_at);
CREATE INDEX idx_history_user_conv_sync ON message_history(user_id, conversation_id, updated_at);
CREATE INDEX idx_history_conv_del ON message_history(conversation_id, id);
