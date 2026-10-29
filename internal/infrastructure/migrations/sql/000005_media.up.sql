-- RFC-0007 Phase 7: Media Processing.

-- media_files: Tracks upload lifecycle and state machine.
-- RFC-0007 §8.1: media_files table.
CREATE TABLE media_files (
    file_id          TEXT PRIMARY KEY,
    uploader_user_id TEXT NOT NULL,
    token_hash       TEXT NOT NULL,
    total_chunks     INTEGER NOT NULL,
    generation       INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'PENDING',
    created_at       INTEGER NOT NULL,
    FOREIGN KEY (uploader_user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_media_files_uploader ON media_files(uploader_user_id);
CREATE INDEX idx_media_files_status ON media_files(status);

-- media_chunks: Tracks individual chunk uploads.
-- RFC-0007 §8.1: Composite PK (file_id, chunk_index).
CREATE TABLE media_chunks (
    file_id     TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    chunk_hash  TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    PRIMARY KEY (file_id, chunk_index),
    FOREIGN KEY (file_id) REFERENCES media_files(file_id) ON DELETE CASCADE
);

-- user_quotas: Tracks per-user media storage quota.
-- RFC-0007 §8.2: user_quotas table.
CREATE TABLE user_quotas (
    user_id          TEXT PRIMARY KEY,
    quota_limit_bytes INTEGER NOT NULL,
    reserved_bytes   INTEGER NOT NULL DEFAULT 0,
    committed_bytes  INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
