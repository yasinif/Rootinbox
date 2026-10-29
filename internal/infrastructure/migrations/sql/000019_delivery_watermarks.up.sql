-- Migration 000019: Delivery Watermarks for 4-State Receipt Tracking
ALTER TABLE conversation_read_watermarks ADD COLUMN last_delivered_at INTEGER NOT NULL DEFAULT 0;
