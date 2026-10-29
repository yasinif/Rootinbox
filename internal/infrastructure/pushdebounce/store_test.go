package pushdebounce

import (
	"testing"
	"time"
)

// T-DEB-1: 10 TryAcquire calls within 10 simulated seconds -> exactly 1 returns true.
func TestMemoryDebouncer_TryAcquire(t *testing.T) {
	d := New(10 * time.Second)
	userID := "user-123"

	// First call should succeed
	if !d.TryAcquire(userID, time.Now().Unix()) {
		t.Fatal("expected first TryAcquire to return true")
	}

	// Next 9 calls should fail
	for i := 0; i < 9; i++ {
		if d.TryAcquire(userID, time.Now().Unix()) {
			t.Fatalf("expected call %d to return false", i+2)
		}
	}
}
