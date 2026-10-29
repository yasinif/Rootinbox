-- RFC-0004 §6.2: Session Database Schema Contract.
-- RFC-0004 §6.3: revoked_at is NULL if active, UNIX timestamp when revoked (Grace Period start).

CREATE TABLE sessions (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    x25519_public_key TEXT NOT NULL,
    session_version   INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    created_at        INTEGER NOT NULL,
    revoked_at        INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- RFC-0004 §7.1: Token Hashing — database MUST NEVER store the raw token.
-- Stores SHA256(cookie_token).
CREATE TABLE session_tokens (
    token_hash TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
