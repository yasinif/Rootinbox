-- Migration 000013: Telegram-style User Profile columns
-- Adds display_name, last_name, and bio (up to 200 chars) to users table.

ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN last_name TEXT;
ALTER TABLE users ADD COLUMN bio TEXT;
