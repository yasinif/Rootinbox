-- Bundle 4: Personalization (User Avatar)
-- Add avatar columns to users table.

ALTER TABLE users ADD COLUMN avatar_mime TEXT;
ALTER TABLE users ADD COLUMN avatar_updated_at INTEGER;
