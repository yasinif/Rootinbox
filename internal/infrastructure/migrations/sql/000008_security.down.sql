DROP INDEX IF EXISTS idx_security_events_created_id;
DROP INDEX IF EXISTS idx_security_events_type_created;
DROP INDEX IF EXISTS idx_security_events_identity;
DROP INDEX IF EXISTS idx_security_events_iphash;
DROP INDEX IF EXISTS idx_ip_blocks_status;

DROP TABLE IF EXISTS ip_blocks;
DROP TABLE IF EXISTS security_events;

-- Note: users.status_updated_at is intentionally retained on rollback because
-- SQLite DROP COLUMN is unavailable on the modernc version's older grammar path.
