package confirmstore_test

import (
	"context"
	"testing"
	"time"

	"rootinbox/internal/infrastructure/confirmstore"
)

// T-SEC-1: ConfirmStore behavior.
func TestConfirmStore(t *testing.T) {
	store := confirmstore.NewStore(10*time.Millisecond)

	ctx := context.Background()
	token := "token-1"
	err := store.Set(ctx, token, "action-1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Get should pass
	payload, ok := store.Get(ctx, token)
	if !ok || payload != "action-1" {
		t.Fatalf("get failed")
	}

	// Delete
	store.Delete(ctx, token)

	// Get again should fail
	if _, ok := store.Get(ctx, token); ok {
		t.Fatalf("expected get to fail after delete")
	}

	// Set new token, wait for expiration
	token2 := "token-2"
	store.Set(ctx, token2, "action-2")
	time.Sleep(20 * time.Millisecond)

	// Get should fail (expired)
	if _, ok := store.Get(ctx, token2); ok {
		t.Fatalf("expected get to fail on expiration")
	}
}
