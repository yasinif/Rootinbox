-- Revert Migration 000013: Drop user profile columns

ALTER TABLE users DROP COLUMN display_name;
ALTER TABLE users DROP COLUMN last_name;
ALTER TABLE users DROP COLUMN bio;
