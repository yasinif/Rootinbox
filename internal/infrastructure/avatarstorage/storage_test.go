package avatarstorage_test

import (
	"bytes"
	"path/filepath"
	"testing"

	"rootinbox/internal/infrastructure/avatarstorage"
)

func TestAvatarLocalStorage(t *testing.T) {
	tempDir := t.TempDir()
	storage, err := avatarstorage.New(filepath.Join(tempDir, "avatars"))
	if err != nil {
		t.Fatalf("failed to create storage: %v", err)
	}

	userID := "test-user-uuid-1234"
	fakeImageData := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x01}

	// 1. Initially does not exist
	if storage.Exists(userID) {
		t.Fatalf("expected avatar to not exist initially")
	}

	// 2. Save
	if err := storage.Save(userID, fakeImageData); err != nil {
		t.Fatalf("failed to save avatar: %v", err)
	}

	if !storage.Exists(userID) {
		t.Fatalf("expected avatar to exist after save")
	}

	// 3. Read
	readData, err := storage.Read(userID)
	if err != nil {
		t.Fatalf("failed to read avatar: %v", err)
	}
	if !bytes.Equal(readData, fakeImageData) {
		t.Fatalf("read data mismatch")
	}

	// 4. Overwrite
	newImageData := []byte{0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10}
	if err := storage.Save(userID, newImageData); err != nil {
		t.Fatalf("failed to overwrite avatar: %v", err)
	}
	readData2, err := storage.Read(userID)
	if err != nil {
		t.Fatalf("failed to read overwritten avatar: %v", err)
	}
	if !bytes.Equal(readData2, newImageData) {
		t.Fatalf("overwritten data mismatch")
	}

	// 5. Delete
	if err := storage.Delete(userID); err != nil {
		t.Fatalf("failed to delete avatar: %v", err)
	}
	if storage.Exists(userID) {
		t.Fatalf("expected avatar to not exist after delete")
	}

	// 6. Delete idempotency (non-existent should not error)
	if err := storage.Delete(userID); err != nil {
		t.Fatalf("expected idempotent delete, got error: %v", err)
	}
}
