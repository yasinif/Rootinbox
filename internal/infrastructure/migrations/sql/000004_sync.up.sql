-- RFC-0006 Phase 6: Sync & Vaults.

-- Part 1: Recreate messages table with server_id AUTOINCREMENT for cursor pagination.
-- RFC-0006 §4.2: "Server routes transient messages via auto-incrementing integer IDs."
-- SQLite does not support ALTER TABLE ADD COLUMN with AUTOINCREMENT, so we recreate.

CREATE TABLE messages_new (
    server_id         INTEGER PRIMARY KEY AUTOINCREMENT,
    client_uuid       TEXT UNIQUE NOT NULL,
    sender_id         TEXT NOT NULL,
    receiver_id       TEXT NOT NULL,
    encrypted_payload BLOB NOT NULL,
    sequence_number   INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    FOREIGN KEY (sender_id)   REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (receiver_id) REFERENCES users(id) ON DELETE CASCADE
);

-- Copy existing data (server_id will auto-assign).
INSERT INTO messages_new (client_uuid, sender_id, receiver_id, encrypted_payload, sequence_number, created_at)
SELECT client_uuid, sender_id, receiver_id, encrypted_payload, sequence_number, created_at
FROM messages;

-- Drop old table and rename.
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;

-- Recreate index for receiver queries.
CREATE INDEX idx_messages_receiver_id ON messages(receiver_id);

-- Part 2: Create vaults table.
-- RFC-0006 §4.3: Vault Archival Lifecycle.
-- UNIQUE (user_id, month_year) enforces immutability.

CREATE TABLE vaults (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL,
    month_year     TEXT NOT NULL,
    encrypted_data BLOB NOT NULL,
    content_hash   TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    finalized      INTEGER NOT NULL DEFAULT 1,
    created_at     INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE (user_id, month_year)
);
