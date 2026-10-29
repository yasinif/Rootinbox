package domain

// PendingRingEntry stages an offline callee's invite (§7.3).
// RAM-ONLY. MUST NEVER be persisted to SQLite.
type PendingRingEntry struct {
	CallID               string
	CallerID             string
	CallerIdentityHash   string
	CalleeID             string
	CalleeIdentityHash   string
	CalleeSessionID      string // Session Binding Rule (§7.3)
	CallerSessionID      string // Session Binding Rule (§7.3)
	EncryptedOffer       []byte // verbatim call.invite ciphertext (ADR-P9-17)
	FingerprintSignature []byte // empty unless client-supplied (ADR-P9-17)
	ExpiresAt            int64
}

// PendingRingStore stages and retrieves offline call offers.
// §F5: read and eviction MUST be mutually exclusive via the same lock.
type PendingRingStore interface {
	Stage(entry *PendingRingEntry) error
	// Take atomically returns and REMOVES the entry. It MUST succeed at most
	// once per call_id, ever. Expired entries are treated as absent.
	Take(callID string, nowUnix int64) (*PendingRingEntry, bool)
	// TakeByCalleeIdentityHash scans the buffer for an entry matching the callee.
	// Used by GET /api/v1/calls/pending. Bounded by capacity (<=1024), single mutex.
	TakeByCalleeIdentityHash(identityHash string, nowUnix int64) (*PendingRingEntry, bool)
	// Evict removes an entry without returning it (Ring Timeout worker).
	Evict(callID string) bool
	// SweepExpired removes all entries past expires_at. Returns the count.
	SweepExpired(nowUnix int64) int
	Close()
}
