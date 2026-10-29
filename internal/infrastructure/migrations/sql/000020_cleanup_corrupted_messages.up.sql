-- Schema Extension for Per-User One-Way Clear & Hide
ALTER TABLE conversation_read_watermarks ADD COLUMN cleared_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE conversation_read_watermarks ADD COLUMN hidden_at INTEGER NOT NULL DEFAULT 0;

-- Delete all legacy rows from obsolete messages and message_history tables
DELETE FROM messages;
DELETE FROM message_history;

-- Delete any corrupted rows in group_messages where unencrypted content contains replacement character or starts with 0x01
DELETE FROM group_messages 
WHERE content LIKE '%' || char(65533) || '%' 
   OR content LIKE '%' || '' || '%'
   OR substr(content, 1, 1) = char(1)
   OR hex(substr(content, 1, 1)) = '01';
