-- Phase 14 / Active Sessions: Add metadata columns for multi-device concurrent sessions.
ALTER TABLE sessions ADD COLUMN device_label TEXT;
ALTER TABLE sessions ADD COLUMN ip_hash TEXT;
ALTER TABLE sessions ADD COLUMN last_active_at INTEGER;
