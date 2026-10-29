-- Rollback Amendment RFC-0002-A: Username Registry

DROP INDEX IF EXISTS idx_users_username;

-- SQLite does not support DROP COLUMN before 3.35.0.
-- For rollback, create a new table without the column and migrate data.
CREATE TABLE users_backup AS SELECT id, identity_hash, public_key, status, created_at, status_updated_at FROM users;
DROP TABLE users;
CREATE TABLE users (
    id              TEXT PRIMARY KEY,
    identity_hash   TEXT UNIQUE NOT NULL,
    public_key      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'ACTIVE',
    created_at      INTEGER NOT NULL,
    status_updated_at INTEGER
);
INSERT INTO users SELECT * FROM users_backup;
DROP TABLE users_backup;
