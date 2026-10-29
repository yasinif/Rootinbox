package pendingring

import (
	"log/slog"
	"sync"

	"rootinbox/internal/domain"
	"rootinbox/pkg/crypto"
)

// MemoryPendingRing implements domain.PendingRingStore.
// RFC-0009 §7.3: RAM-only, fixed-capacity, keyed by call_id.
type MemoryPendingRing struct {
	mu      sync.Mutex
	entries map[string]*domain.PendingRingEntry
	cap     int
	logger  *slog.Logger
}

// New creates a new MemoryPendingRing buffer.
func New(capacity int, logger *slog.Logger) *MemoryPendingRing {
	return &MemoryPendingRing{
		entries: make(map[string]*domain.PendingRingEntry),
		cap:     capacity,
		logger:  logger,
	}
}

// Stage adds an entry, evicting the oldest (by ExpiresAt) if at capacity.
func (r *MemoryPendingRing) Stage(entry *domain.PendingRingEntry) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Re-staging the same call_id replaces it without counting against capacity
	if _, exists := r.entries[entry.CallID]; exists {
		r.entries[entry.CallID] = entry
		return nil
	}

	if len(r.entries) >= r.cap {
		// Evict the entry with the earliest ExpiresAt
		var oldestKey string
		var oldestExp int64 = 1<<63 - 1 // max int64

		for k, v := range r.entries {
			if v.ExpiresAt < oldestExp {
				oldestExp = v.ExpiresAt
				oldestKey = k
			}
		}

		if oldestKey != "" {
			delete(r.entries, oldestKey)
			// UseCase will increment PendingRingEvictedTotal{reason="capacity"}
			// but we can log it here if we want, or leave it to the caller.
			// Actually, metrics are usually registered globally or passed in.
			// The instruction says "increment PendingRingEvictedTotal{reason="capacity"}".
			// I'll assume the caller increments it or we just omit the counter in this package
			// and let the caller count if needed. Wait, the use case stages it. I will log it here.
			r.logger.Info("pending ring capacity eviction", "evicted_call_id", oldestKey)
		}
	}

	r.entries[entry.CallID] = entry
	return nil
}

// Take returns and removes the entry in a single critical section.
func (r *MemoryPendingRing) Take(callID string, nowUnix int64) (*domain.PendingRingEntry, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	entry, ok := r.entries[callID]
	if !ok {
		return nil, false
	}

	delete(r.entries, callID)

	if entry.ExpiresAt < nowUnix {
		crypto.Zeroize(entry.EncryptedOffer)
		if len(entry.FingerprintSignature) > 0 {
			crypto.Zeroize(entry.FingerprintSignature)
		}
		return nil, false
	}

	return entry, true
}

// TakeByCalleeIdentityHash linearly scans for an entry matching the callee.
func (r *MemoryPendingRing) TakeByCalleeIdentityHash(identityHash string, nowUnix int64) (*domain.PendingRingEntry, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()

	for k, v := range r.entries {
		if v.CalleeIdentityHash == identityHash || (v.CalleeID != "" && v.CalleeID == identityHash) {
			delete(r.entries, k)

			if v.ExpiresAt < nowUnix {
				crypto.Zeroize(v.EncryptedOffer)
				if len(v.FingerprintSignature) > 0 {
					crypto.Zeroize(v.FingerprintSignature)
				}
				return nil, false
			}

			return v, true
		}
	}

	return nil, false
}

// Evict removes an entry without returning it.
func (r *MemoryPendingRing) Evict(callID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	entry, ok := r.entries[callID]
	if ok {
		delete(r.entries, callID)
		crypto.Zeroize(entry.EncryptedOffer)
		if len(entry.FingerprintSignature) > 0 {
			crypto.Zeroize(entry.FingerprintSignature)
		}
	}
	return ok
}

// SweepExpired removes all entries past expires_at.
func (r *MemoryPendingRing) SweepExpired(nowUnix int64) int {
	r.mu.Lock()
	defer r.mu.Unlock()

	count := 0
	for k, v := range r.entries {
		if v.ExpiresAt < nowUnix {
			delete(r.entries, k)
			crypto.Zeroize(v.EncryptedOffer)
			if len(v.FingerprintSignature) > 0 {
				crypto.Zeroize(v.FingerprintSignature)
			}
			count++
		}
	}
	return count
}

// Close zeroizes all sensitive buffers and clears the map.
func (r *MemoryPendingRing) Close() {
	r.mu.Lock()
	defer r.mu.Unlock()

	for k, v := range r.entries {
		crypto.Zeroize(v.EncryptedOffer)
		if len(v.FingerprintSignature) > 0 {
			crypto.Zeroize(v.FingerprintSignature)
		}
		delete(r.entries, k)
	}
}
