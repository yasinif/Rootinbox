package domain

import "context"

// NonceStore provides ephemeral, memory-backed nonce storage with atomic consumption.
// RFC-0004 §4.2: Nonces MUST reside in an ephemeral, memory-backed store.
// RFC-0004 §4.2: Atomic Consumption (Replay Protection) via COMPARE-AND-DELETE.
// RFC-0001A §2: Interface belongs to the consumer (Domain layer).
type NonceStore interface {
	// Store saves a nonce with a TTL. Key format: "AuthNonce:{IdentityHash}:{ChallengeID}".
	// RFC-0004 §4.2: TTL MUST be 120 seconds.
	Store(ctx context.Context, key string, nonce []byte, ttlSeconds int) error

	// Consume atomically retrieves and deletes a nonce.
	// RFC-0004 §4.2: MUST be atomically deleted the exact millisecond it is accessed.
	// Returns the nonce bytes or an error if not found/expired.
	Consume(ctx context.Context, key string) ([]byte, error)
}

// TicketStore provides ephemeral, memory-backed WebSocket ticket storage.
// RFC-0004 §7.3: Tickets are memory ONLY (No DB), TTL <= 30 seconds, Single-Use.
// RFC-0001A §2: Interface belongs to the consumer (Domain layer).
type TicketStore interface {
	// Store saves a WS ticket mapping to a userID with TTL.
	// RFC-0004 §7.3: TTL <= 30 seconds, strictly Single-Use.
	Store(ctx context.Context, ticket string, userID string, ttlSeconds int) error

	// Consume atomically retrieves and deletes a ticket.
	// Returns the userID or an error if not found/expired.
	Consume(ctx context.Context, ticket string) (userID string, err error)
}
