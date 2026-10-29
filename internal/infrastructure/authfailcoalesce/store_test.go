package authfailcoalesce_test

import (
	"context"
	"testing"

	"rootinbox/internal/infrastructure/authfailcoalesce"
)

// T-SEC-2: AuthFailCoalesce debouncing.
func TestAuthFailCoalesce(t *testing.T) {
	store := authfailcoalesce.NewStore()

	ctx := context.Background()
	ipHash := "ip1"

	// 1st failure: ShouldEmit == true
	if !store.ShouldEmit(ctx, ipHash) {
		t.Fatalf("expected true for 1st failure")
	}

	// 2nd and 3rd failures: ShouldEmit == false
	if store.ShouldEmit(ctx, ipHash) {
		t.Fatalf("expected false for 2nd failure")
	}
	if store.ShouldEmit(ctx, ipHash) {
		t.Fatalf("expected false for 3rd failure")
	}
}
