-- Reverse of 000004_sync.up.sql

-- Drop vaults table.
DROP TABLE IF EXISTS vaults;

-- Revert messages table to original schema (no server_id).
CREATE TABLE messages_old (
    client_uuid       TEXT PRIMARY KEY,
    sender_id         TEXT NOT NULL,
    receiver_id       TEXT NOT NULL,
    encrypted_payload BLOB NOT NULL,
    sequence_number   INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    FOREIGN KEY (sender_id)   REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO messages_old (client_uuid, sender_id, receiver_id, encrypted_payload, sequence_number, created_at)
SELECT client_uuid, sender_id, receiver_id, encrypted_payload, sequence_number, created_at
FROM messages;

DROP TABLE messages;
ALTER TABLE messages_old RENAME TO messages;

CREATE INDEX idx_messages_receiver_id ON messages(receiver_id);
