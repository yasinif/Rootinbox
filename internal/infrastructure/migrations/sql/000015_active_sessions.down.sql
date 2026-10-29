-- Down migration for 000015_active_sessions
-- SQLite cannot easily drop columns without full table recreation in older engines; no-op.
SELECT 1;
