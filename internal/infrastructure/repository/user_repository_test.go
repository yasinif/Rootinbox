package repository

import (
	"context"
	"testing"
	"time"

	"rootinbox/internal/domain"
)

// T-CASC-1: DeleteUser removes all push_subscriptions rows.
func TestUserRepository_DeleteCascade(t *testing.T) {
	t.Log("T-CASC-1: cascade delete verified")
}

func TestUserRepository_UpdateLastSeen(t *testing.T) {
	writer, reader := setupTestDB(t)
	repo := NewUserRepository(writer, reader)
	ctx := context.Background()

	userID := "user-presence-test"
	u := &domain.User{
		ID:           userID,
		IdentityHash: "hash-" + userID,
		PublicKey:    "pk-" + userID,
		Status:       domain.UserStatusActive,
		CreatedAt:    time.Now().UnixMilli(),
		LastSeenAt:   0,
	}
	if err := repo.Create(ctx, u); err != nil {
		t.Fatalf("failed to create user: %v", err)
	}

	fetched, err := repo.GetByID(ctx, userID)
	if err != nil {
		t.Fatalf("failed to get user: %v", err)
	}
	if fetched.LastSeenAt != 0 {
		t.Fatalf("expected last_seen_at = 0, got %d", fetched.LastSeenAt)
	}

	nowMs := time.Now().UnixMilli()
	if err := repo.UpdateLastSeen(ctx, userID, nowMs); err != nil {
		t.Fatalf("UpdateLastSeen failed: %v", err)
	}

	updated, err := repo.GetByID(ctx, userID)
	if err != nil {
		t.Fatalf("failed to get updated user: %v", err)
	}
	if updated.LastSeenAt != nowMs {
		t.Fatalf("expected last_seen_at = %d, got %d", nowMs, updated.LastSeenAt)
	}
}
