-- Migration 000018: Delivery Acknowledgment Queue for Multi-Device & Offline Senders
CREATE TABLE IF NOT EXISTS delivery_acks (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id  TEXT NOT NULL,
    request_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE (sender_id, request_id)
);

CREATE INDEX IF NOT EXISTS idx_delivery_acks_sender ON delivery_acks(sender_id, id);
CREATE INDEX IF NOT EXISTS idx_delivery_acks_created ON delivery_acks(created_at);
