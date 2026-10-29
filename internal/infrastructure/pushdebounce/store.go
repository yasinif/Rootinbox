package pushdebounce

import (
	"sync"
	"time"
)

// MemoryDebouncer limits Web Push triggers to at most one per rolling window.
// RFC-0009 §7.2: In-memory only.
type MemoryDebouncer struct {
	mu     sync.Mutex
	last   map[string]int64 // userID -> last Message-class send (unix)
	window int64
	stop   chan struct{}
}

// New creates a new MemoryDebouncer with the specified window.
func New(window time.Duration) *MemoryDebouncer {
	d := &MemoryDebouncer{
		last:   make(map[string]int64),
		window: int64(window.Seconds()),
		stop:   make(chan struct{}),
	}

	go d.janitor(window)
	return d
}

// TryAcquire is COMPARE-AND-SET: returns true and records nowUnix only if the
// window has elapsed. RFC-0009 §7.2.
// Single critical section to prevent races (T-DEB-4).
func (d *MemoryDebouncer) TryAcquire(userID string, nowUnix int64) bool {
	d.mu.Lock()
	defer d.mu.Unlock()

	lastSent, ok := d.last[userID]
	if ok && nowUnix-lastSent < d.window {
		return false
	}

	d.last[userID] = nowUnix
	return true
}

func (d *MemoryDebouncer) janitor(window time.Duration) {
	ticker := time.NewTicker(60 * time.Second)
	defer ticker.Stop()

	// Purge entries older than 2x window.
	maxAge := int64((window * 2).Seconds())

	for {
		select {
		case <-d.stop:
			return
		case now := <-ticker.C:
			nowUnix := now.Unix()
			d.mu.Lock()
			for k, v := range d.last {
				if nowUnix-v > maxAge {
					delete(d.last, k)
				}
			}
			d.mu.Unlock()
		}
	}
}

// Close stops the janitor.
func (d *MemoryDebouncer) Close() {
	close(d.stop)
}
