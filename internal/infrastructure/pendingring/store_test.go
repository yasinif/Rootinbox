package pendingring

import (
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"rootinbox/internal/domain"
)

// T-RING-3: concurrent Take + Evict on the same call_id with sync.WaitGroup -> exactly one wins, no panic.
func TestMemoryPendingRing_ConcurrentTakeAndEvict(t *testing.T) {
	logger := slog.Default()
	store := New(10, logger)

	entry := &domain.PendingRingEntry{
		CallID:             "call-123",
		CalleeIdentityHash: "user-456",
		ExpiresAt:          time.Now().Unix() + 10,
	}

	err := store.Stage(entry)
	if err != nil {
		t.Fatalf("failed to stage: %v", err)
	}

	var wins int32
	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		_, ok := store.TakeByCalleeIdentityHash("user-456", time.Now().Unix())
		if ok {
			atomic.AddInt32(&wins, 1)
		}
	}()

	go func() {
		defer wg.Done()
		ok := store.Evict("call-123")
		if ok {
			atomic.AddInt32(&wins, 1)
		}
	}()

	wg.Wait()

	if wins != 1 {
		t.Errorf("expected exactly 1 win, got %d", wins)
	}
}
