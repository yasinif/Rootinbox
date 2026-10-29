-- Rollback Amendment RFC-0007-B
DROP TABLE IF EXISTS group_messages;

-- In SQLite, dropping columns requires table recreation, or leaving them if unsupported.
-- Recreate conversations table without name, description, created_by if needed.
CREATE TABLE conversations_backup (
    id         TEXT PRIMARY KEY,
    type       TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

INSERT INTO conversations_backup (id, type, created_at)
SELECT id, type, created_at FROM conversations;

DROP TABLE conversations;
ALTER TABLE conversations_backup RENAME TO conversations;
