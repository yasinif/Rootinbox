-- RFC-0002 §4.2: Core Database Schema (SQLite Contracts)
-- RFC-0002 §4.2: UUID Format Rule: All UUIDs MUST be stored as canonical lowercase strings.
-- RFC-0002 §4.2: Zero-Knowledge Rule: NO columns for email, phone, or username.
-- RFC-0001 §5: All timestamps MUST be stored as INTEGER (UNIX Epoch Time).

-- Table: users
CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    identity_hash TEXT UNIQUE NOT NULL,
    public_key    TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at    INTEGER NOT NULL
);

-- Table: conversations
CREATE TABLE conversations (
    id         TEXT PRIMARY KEY,
    type       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

-- Table: participants
-- RFC-0002 §4.2: PRIMARY KEY (conversation_id, user_id)
-- RFC-0002 §4.2: FK -> conversations.id ON DELETE CASCADE
-- RFC-0002 §4.2: FK -> users.id ON DELETE CASCADE
CREATE TABLE participants (
    conversation_id TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    role            TEXT NOT NULL,
    joined_at       INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, user_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
