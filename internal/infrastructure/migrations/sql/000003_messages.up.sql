-- RFC-0005 §7: Transient Queue Database Contract.
-- Zero-Knowledge Mandate: server stores ONLY minimum routing metadata.
-- RFC-0005 §6.1: PRIMARY KEY (client_uuid) provides idempotency.
-- Note: sender_id/receiver_id are TEXT to match users.id (UUID) from RFC-0002.

CREATE TABLE messages (
    client_uuid       TEXT PRIMARY KEY,
    sender_id         TEXT NOT NULL,
    receiver_id       TEXT NOT NULL,
    encrypted_payload BLOB NOT NULL,
    sequence_number   INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    FOREIGN KEY (sender_id)   REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Index for Post-Auth Flush queries (RFC-0005 §4.2).
CREATE INDEX idx_messages_receiver_id ON messages(receiver_id);
