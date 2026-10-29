-- RFC-0009 §4.1: singleton Application Server VAPID identity, encrypted at rest.
-- RFC-0009 §6.2: Web Push subscription registry.
-- DECISIONS_LOG P5.1: UUIDs stored as canonical lowercase TEXT.

CREATE TABLE application_keys (
    id                      TEXT PRIMARY KEY,
    private_key_encrypted   TEXT NOT NULL,
    public_key_uncompressed TEXT NOT NULL,
    created_at              INTEGER NOT NULL,
    CHECK (id = 'vapid')
);

CREATE TABLE push_subscriptions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT    NOT NULL,
    endpoint    TEXT    NOT NULL,
    p256dh_key  TEXT    NOT NULL,
    auth_secret TEXT    NOT NULL,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE (user_id, endpoint)
);

-- Fan-out lookup (§6.4) and the trigger-path existence probe (§7.1).
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id, created_at);
