package repository

import (
	"context"
	"testing"
	"time"

	"rootinbox/internal/domain"
)

func TestSQLiteApplicationKeyRepository_CRUD(t *testing.T) {
	writer, reader := setupTestDB(t)
	repo := NewApplicationKeyRepository(writer, reader)
	ctx := context.Background()

	// 1. Get before create returns ErrPush001
	_, err := repo.GetByID(ctx, domain.VAPIDKeyRowID)
	if err == nil {
		t.Fatalf("expected ErrPush001 when key does not exist")
	}

	// 2. Create
	now := time.Now().Unix()
	key := &domain.ApplicationKey{
		ID:                    domain.VAPIDKeyRowID,
		PrivateKeyEncrypted:   "deadbeef1234",
		PublicKeyUncompressed: "pubkey_b64",
		CreatedAt:             now,
	}
	if err := repo.Create(ctx, key); err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	// 3. GetByID
	fetched, err := repo.GetByID(ctx, domain.VAPIDKeyRowID)
	if err != nil {
		t.Fatalf("GetByID failed: %v", err)
	}
	if fetched.PrivateKeyEncrypted != "deadbeef1234" {
		t.Fatalf("expected PrivateKeyEncrypted deadbeef1234, got %s", fetched.PrivateKeyEncrypted)
	}
	if fetched.PublicKeyUncompressed != "pubkey_b64" {
		t.Fatalf("expected PublicKeyUncompressed pubkey_b64, got %s", fetched.PublicKeyUncompressed)
	}

	// 4. UpdateCAS (migration simulation)
	key.PrivateKeyEncrypted = "cafebabe5678"
	if err := repo.UpdateCAS(ctx, key, "deadbeef1234"); err != nil {
		t.Fatalf("UpdateCAS failed: %v", err)
	}

	updated, err := repo.GetByID(ctx, domain.VAPIDKeyRowID)
	if err != nil {
		t.Fatalf("GetByID after update failed: %v", err)
	}
	if updated.PrivateKeyEncrypted != "cafebabe5678" {
		t.Fatalf("expected PrivateKeyEncrypted cafebabe5678, got %s", updated.PrivateKeyEncrypted)
	}
	if updated.PublicKeyUncompressed != "pubkey_b64" {
		t.Fatalf("expected PublicKeyUncompressed pubkey_b64, got %s", updated.PublicKeyUncompressed)
	}

	// 5. UpdateCAS with matching old ciphertext succeeds
	key.PrivateKeyEncrypted = "finalciphertext9999"
	if err := repo.UpdateCAS(ctx, key, "cafebabe5678"); err != nil {
		t.Fatalf("UpdateCAS with matching old ciphertext failed: %v", err)
	}

	// 6. UpdateCAS with mismatched old ciphertext fails with ErrPush002
	key.PrivateKeyEncrypted = "shouldnotpersist"
	if err := repo.UpdateCAS(ctx, key, "wrongoldciphertext"); err == nil {
		t.Fatalf("expected UpdateCAS with mismatched ciphertext to fail")
	}
}
