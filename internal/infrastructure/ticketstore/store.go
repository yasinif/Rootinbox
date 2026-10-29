// Package ticketstore provides an in-memory TTL-backed WebSocket ticket store.
// RFC-0004 §7.3: Tickets are memory ONLY (No DB), TTL <= 30 seconds, Single-Use.
package ticketstore

import (
	"context"
	"fmt"
	"sync"
	"time"
)

type entry struct {
	userID    string
	expiresAt time.Time
}

// MemoryTicketStore implements domain.TicketStore using an in-memory map.
// RFC-0004 §7.3: Single-Use tickets with atomic consumption.
type MemoryTicketStore struct {
	mu      sync.Mutex
	entries map[string]entry
	done    chan struct{}
}

// New creates a MemoryTicketStore and starts a background cleanup goroutine.
func New() *MemoryTicketStore {
	s := &MemoryTicketStore{
		entries: make(map[string]entry),
		done:    make(chan struct{}),
	}
	go s.cleanup()
	return s
}

// Store saves a WS ticket mapping to a userID with TTL.
// RFC-0004 §7.3: TTL <= 30 seconds.
func (s *MemoryTicketStore) Store(_ context.Context, ticket string, userID string, ttlSeconds int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.entries[ticket] = entry{
		userID:    userID,
		expiresAt: time.Now().Add(time.Duration(ttlSeconds) * time.Second),
	}
	return nil
}

// Consume atomically retrieves and deletes a ticket.
// RFC-0004 §7.3: Server validates, immediately deletes the ticket from memory.
func (s *MemoryTicketStore) Consume(_ context.Context, ticket string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.entries[ticket]
	if !ok {
		return "", fmt.Errorf("ticket not found")
	}
	delete(s.entries, ticket)
	if time.Now().After(e.expiresAt) {
		return "", fmt.Errorf("ticket expired")
	}
	return e.userID, nil
}

// Close stops the background cleanup goroutine.
func (s *MemoryTicketStore) Close() {
	close(s.done)
}

func (s *MemoryTicketStore) cleanup() {
	ticker := time.NewTicker(10 * time.Second)
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
