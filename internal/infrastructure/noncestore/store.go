// Package noncestore provides an in-memory TTL-backed nonce store.
// RFC-0004 §4.2: Nonces MUST reside in an ephemeral, memory-backed store.
// ARCHITECTURE.md: No external DB (No Postgres/Redis) — in-memory TTL map.
package noncestore

import (
	"context"
	"fmt"
	"sync"
	"time"
)

type entry struct {
	nonce     []byte
	expiresAt time.Time
}

// MemoryNonceStore implements domain.NonceStore using an in-memory map.
// RFC-0004 §4.2: Atomic Consumption via mutex-protected COMPARE-AND-DELETE.
type MemoryNonceStore struct {
	mu      sync.Mutex
	entries map[string]entry
	done    chan struct{}
}

// New creates a MemoryNonceStore and starts a background cleanup goroutine.
func New() *MemoryNonceStore {
	s := &MemoryNonceStore{
		entries: make(map[string]entry),
		done:    make(chan struct{}),
	}
	go s.cleanup()
	return s
}

// Store saves a nonce with a TTL.
// RFC-0004 §4.2: Storage Key MUST be "AuthNonce:{IdentityPublicKeyHash}:{ChallengeID}".
func (s *MemoryNonceStore) Store(_ context.Context, key string, nonce []byte, ttlSeconds int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries[key] = entry{
		nonce:     nonce,
		expiresAt: time.Now().Add(time.Duration(ttlSeconds) * time.Second),
	}
	return nil
}

// Consume atomically retrieves and deletes a nonce.
// RFC-0004 §4.2: The Nonce MUST be atomically deleted the exact millisecond it is accessed,
// regardless of success or failure. COMPARE-AND-DELETE via lock + delete.
func (s *MemoryNonceStore) Consume(_ context.Context, key string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[key]
	if !ok {
		return nil, fmt.Errorf("nonce not found")
	}
	// Atomic delete — happens before any validation.
	delete(s.entries, key)
	if time.Now().After(e.expiresAt) {
		return nil, fmt.Errorf("nonce expired")
	}
	return e.nonce, nil
}

// Close stops the background cleanup goroutine.
func (s *MemoryNonceStore) Close() {
	close(s.done)
}

// cleanup periodically removes expired entries.
func (s *MemoryNonceStore) cleanup() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			s.mu.Lock()
			now := time.Now()
			for k, e := range s.entries {
				if now.After(e.expiresAt) {
					delete(s.entries, k)
				}
			}
			s.mu.Unlock()
		}
	}
}
