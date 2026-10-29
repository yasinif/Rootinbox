-- Amendment RFC-0002-A: Username Registry
-- Add optional username column to users table for search-based discovery.
-- Lowercase, unique, nullable. Validation (3-32 chars, [a-z0-9_]) enforced at application layer.

ALTER TABLE users ADD COLUMN username TEXT;

CREATE UNIQUE INDEX idx_users_username ON users(username) WHERE username IS NOT NULL;
