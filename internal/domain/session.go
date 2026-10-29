package domain

// Session represents an authenticated session.
// RFC-0004 §6.2: Session Database Schema Contract.
// No database/SQL tags (Clean Architecture).
type Session struct {
	ID              string // UUIDv4
	UserID          string // FK -> users.id
	X25519PublicKey string // Hex-encoded 32-byte X25519 session public key (RFC-0003)
	SessionVersion  int
	ExpiresAt       int64  // UNIX Epoch UTC
	CreatedAt       int64  // UNIX Epoch UTC
	RevokedAt       *int64 // nil if active; UNIX Epoch UTC when revoked (Grace Period start)
	// Phase 12 / Task 0.5: Session signature for server-side MITM prevention.
	// RFC-0003 §5.1: 64-byte Ed25519 signature over the 73-byte session payload.
	// Server MUST verify this to prevent session key substitution.
	SessionSignature []byte // Raw 64-byte Ed25519 signature (nil for legacy sessions)
	SignedExpiresAt  *int64 // Client-asserted expiration bound into the signature
	// Phase 14 / Active Sessions metadata:
	DeviceLabel  string // Parsed user-agent device label (e.g. "Chrome on Windows")
	IPHash       string // Anonymized HMAC hash of IP address
	LastActiveAt int64  // UNIX Epoch UTC of last activity
}

// IsActive returns true if the session is not revoked and not expired.
func (s *Session) IsActive(nowUnix int64) bool {
	return s.RevokedAt == nil && nowUnix < s.ExpiresAt
}

// IsInGracePeriod returns true if the session is revoked but within the 24-hour grace period.
// RFC-0003 §5.4: 24-hour DECRYPT-ONLY grace period.
// RFC-0004 §6.3: revoked_at + 24h.
func (s *Session) IsInGracePeriod(nowUnix int64) bool {
	if s.RevokedAt == nil {
		return false
	}
	const gracePeriodSeconds = 24 * 60 * 60 // 24 hours
	return nowUnix < *s.RevokedAt+gracePeriodSeconds
}

// SessionTerminator defines the capability to terminate live real-time connections for a session.
type SessionTerminator interface {
	CloseSession(sessionID string, code int, reason string)
}
