-- Phase 12 / Task 0.5: Add session signature columns for server-side verification.
-- RFC-0003 §5.1: Server MUST verify the 73-byte session signature to prevent MITM.
-- Without server-side verification of the session signature, the server could
-- substitute session keys and MITM every conversation.

ALTER TABLE sessions ADD COLUMN session_signature BLOB;
ALTER TABLE sessions ADD COLUMN signed_expires_at INTEGER;
