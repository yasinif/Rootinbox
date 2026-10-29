-- RFC-0008 Phase 8: Voice & Video Calls.

-- calls: Tracks call lifecycle and state machine.
-- RFC-0008 §9: SQLite Schema (calls).
CREATE TABLE calls (
    id                  TEXT PRIMARY KEY,
    conversation_id     TEXT NOT NULL,
    caller_id           TEXT NOT NULL,
    callee_id           TEXT NOT NULL,
    type                TEXT NOT NULL DEFAULT 'AUDIO',
    request_fingerprint TEXT NOT NULL,
    status              TEXT NOT NULL DEFAULT 'RINGING',
    started_at          INTEGER,
    ended_at            INTEGER,
    created_at          INTEGER NOT NULL,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id),
    FOREIGN KEY (caller_id) REFERENCES users(id),
    FOREIGN KEY (callee_id) REFERENCES users(id)
);

CREATE INDEX idx_calls_caller_id ON calls(caller_id);
CREATE INDEX idx_calls_callee_id ON calls(callee_id);
CREATE INDEX idx_calls_status ON calls(status);
CREATE INDEX idx_calls_conversation_id ON calls(conversation_id);
