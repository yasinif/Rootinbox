-- Revert Bundle 4 avatar columns

ALTER TABLE users DROP COLUMN avatar_mime;
ALTER TABLE users DROP COLUMN avatar_updated_at;
