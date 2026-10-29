CREATE TABLE security_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'AUTH_SUCCESS', 'AUTH_FAILURE', 'SESSION_REVOKED', 'IDENTITY_MIGRATION',
        'RATE_LIMIT_TRIPPED', 'WS_ORIGIN_REJECTED', 'QUOTA_EXCEEDED', 'MEDIA_TOKEN_ISSUED', 'ADMIN_ACTION'
    )),
    identity_hash TEXT NULL,
    ip_hash TEXT NULL,
    trace_id TEXT NULL,
    admin_action TEXT NULL CHECK (admin_action IS NULL OR admin_action IN (
        'SUSPEND', 'RESUME', 'TOMBSTONE', 'IP_BAN', 'IP_UNBAN', 'TRIGGER_ACCEPTED', 'AUTH_COALESCED'
    )),
    created_at INTEGER NOT NULL
);

CREATE INDEX idx_security_events_created_id ON security_events(created_at DESC, id DESC);
CREATE INDEX idx_security_events_type_created ON security_events(event_type, created_at DESC);
CREATE INDEX idx_security_events_identity ON security_events(identity_hash, created_at DESC);
CREATE INDEX idx_security_events_iphash ON security_events(ip_hash, created_at DESC);

CREATE TABLE ip_blocks (
    ip_hash TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('BLOCKED', 'UNBLOCKED')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE INDEX idx_ip_blocks_status ON ip_blocks(status);

ALTER TABLE users ADD COLUMN status_updated_at INTEGER NULL;
