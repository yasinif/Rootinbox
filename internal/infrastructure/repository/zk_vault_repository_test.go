package repository

import (
	"context"
	"testing"
	"time"

	"rootinbox/internal/domain"
)

func TestSQLiteZKVaultRepository_LifecycleAndOCC(t *testing.T) {
	writer, reader := setupTestDB(t)
	userRepo := NewUserRepository(writer, reader)
	zkRepo := NewZKVaultRepository(writer, reader)
	ctx := context.Background()

	// 1. Create test user
	userID := "zk-user-1"
	u := &domain.User{
		ID:             userID,
		IdentityHash:   "identity-hash-zk-1",
		PublicKey:      "pk-zk-1",
		Status:         domain.UserStatusActive,
		CreatedAt:      time.Now().Unix(),
		KDFMemoryKiB:   32768,
		KDFIterations:  4,
		KDFParallelism: 1,
	}
	if err := userRepo.Create(ctx, u); err != nil {
		t.Fatalf("failed to create user: %v", err)
	}

	// 2. Querying non-existent vault returns ErrVault003
	_, err := zkRepo.GetByUserID(ctx, userID)
	if err == nil {
		t.Fatalf("expected error querying non-existent vault, got nil")
	}

	// 3. Initial save (expectedVersion = 0)
	initialVault := &domain.ZKVault{
		UserID:     userID,
		Ciphertext: []byte("initial-zk-vault-blob-bytes"),
		Signature:  "sig-version-1",
		UpdatedAt:  1714500001,
	}
	if err := zkRepo.Save(ctx, initialVault, 0); err != nil {
		t.Fatalf("initial save failed: %v", err)
	}
	if initialVault.Version != 1 {
		t.Errorf("expected version 1, got %d", initialVault.Version)
	}

	// 4. Duplicate initial write returns conflict
	dupVault := &domain.ZKVault{
		UserID:     userID,
		Ciphertext: []byte("dup-write"),
		Signature:  "sig-dup",
		UpdatedAt:  1714500002,
	}
	if err := zkRepo.Save(ctx, dupVault, 0); err == nil {
		t.Fatalf("expected conflict error on duplicate initial write, got nil")
	}

	// 5. GetByUserID returns saved vault
	fetched, err := zkRepo.GetByUserID(ctx, userID)
	if err != nil {
		t.Fatalf("GetByUserID failed: %v", err)
	}
	if fetched.Version != 1 {
		t.Errorf("expected version 1, got %d", fetched.Version)
	}
	if string(fetched.Ciphertext) != "initial-zk-vault-blob-bytes" {
		t.Errorf("unexpected ciphertext: %s", string(fetched.Ciphertext))
	}
	if fetched.Signature != "sig-version-1" {
		t.Errorf("unexpected signature: %s", fetched.Signature)
	}

	// 6. Optimistic update with matching expectedVersion (1 -> 2)
	updatedVault := &domain.ZKVault{
		UserID:     userID,
		Ciphertext: []byte("updated-version-2-blob"),
		Signature:  "sig-version-2",
		UpdatedAt:  1714500005,
	}
	if err := zkRepo.Save(ctx, updatedVault, 1); err != nil {
		t.Fatalf("expected update to succeed, got %v", err)
	}
	if updatedVault.Version != 2 {
		t.Errorf("expected version 2, got %d", updatedVault.Version)
	}

	// 7. Optimistic update with stale expectedVersion (1 when DB is at 2) returns conflict
	staleVault := &domain.ZKVault{
		UserID:     userID,
		Ciphertext: []byte("stale-update"),
		Signature:  "sig-stale",
		UpdatedAt:  1714500010,
	}
	if err := zkRepo.Save(ctx, staleVault, 1); err == nil {
		t.Fatalf("expected conflict error with stale expectedVersion, got nil")
	}

	// 8. User deletion cascades to zk_vaults
	if err := userRepo.Delete(ctx, userID); err != nil {
		t.Fatalf("failed to delete user: %v", err)
	}
	_, err = zkRepo.GetByUserID(ctx, userID)
	if err == nil {
		t.Fatalf("expected vault to be deleted via cascade when user was deleted")
	}
}
