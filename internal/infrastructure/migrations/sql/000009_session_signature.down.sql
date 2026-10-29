-- Rollback Phase 12 / Task 0.5: Remove session signature columns.
-- SQLite doesn't support DROP COLUMN before 3.35.0, but modernc.org/sqlite supports it.

ALTER TABLE sessions DROP COLUMN session_signature;
ALTER TABLE sessions DROP COLUMN signed_expires_at;
