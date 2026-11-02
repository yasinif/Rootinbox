package mediastorage_test

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rootinbox/internal/infrastructure/mediastorage"
)

func TestValidOperations(t *testing.T) {
	tmpDir := t.TempDir()
	storage, err := mediastorage.New(tmpDir)
	if err != nil {
		t.Fatalf("mediastorage.New failed: %v", err)
	}

	validID := "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"

	// 1. EnsureFileDir
	if err := storage.EnsureFileDir(validID); err != nil {
		t.Fatalf("EnsureFileDir failed: %v", err)
	}

	// 2. WriteChunkAtomic
	testData := []byte("hello world encrypted media payload")
	if err := storage.WriteChunkAtomic(validID, 0, testData); err != nil {
		t.Fatalf("WriteChunkAtomic failed: %v", err)
	}

	// 3. ChunkExists
	if !storage.ChunkExists(validID, 0) {
		t.Errorf("expected chunk 0 to exist")
	}
	if storage.ChunkExists(validID, 1) {
		t.Errorf("did not expect chunk 1 to exist")
	}

	// 4. ChunkSize
	size, err := storage.ChunkSize(validID, 0)
	if err != nil {
		t.Fatalf("ChunkSize failed: %v", err)
	}
	if size != int64(len(testData)) {
		t.Errorf("ChunkSize = %d; want %d", size, len(testData))
	}

	// 5. ReadChunk
	data, err := storage.ReadChunk(validID, 0)
	if err != nil {
		t.Fatalf("ReadChunk failed: %v", err)
	}
	if string(data) != string(testData) {
		t.Errorf("ReadChunk data mismatch")
	}

	// 6. ListDirs
	dirs, err := storage.ListDirs()
	if err != nil {
		t.Fatalf("ListDirs failed: %v", err)
	}
	if len(dirs) != 1 || dirs[0] != validID {
		t.Errorf("ListDirs = %v; want [%s]", dirs, validID)
	}

	// 7. DeleteChunk
	storage.DeleteChunk(validID, 0)
	if storage.ChunkExists(validID, 0) {
		t.Errorf("expected chunk 0 to be deleted")
	}

	// 8. DeleteChunks
	if err := storage.DeleteChunks(validID); err != nil {
		t.Fatalf("DeleteChunks failed: %v", err)
	}
	if storage.ChunkExists(validID, 0) {
		t.Errorf("expected file directory to be removed")
	}
}

func TestCheckContainment(t *testing.T) {
	baseDir := t.TempDir()
	storage, err := mediastorage.New(baseDir)
	if err != nil {
		t.Fatalf("mediastorage.New failed: %v", err)
	}

	// Valid child path within base
	validTarget := filepath.Join(baseDir, "00000000-0000-0000-0000-000000000000")
	if err := storage.CheckContainment(baseDir, validTarget); err != nil {
		t.Errorf("expected validTarget to pass containment check, got: %v", err)
	}

	// Path traversal escapes base directory
	escapeTargets := []string{
		filepath.Join(baseDir, ".."),
		filepath.Join(baseDir, "..", "outside"),
		filepath.Join(baseDir, "..", "..", "etc"),
		"/etc/passwd",
		"C:\\Windows\\System32",
	}

	for _, target := range escapeTargets {
		err := storage.CheckContainment(baseDir, target)
		if err == nil {
			t.Errorf("CheckContainment(%q, %q) succeeded; expected containment violation error", baseDir, target)
		} else if !errors.Is(err, mediastorage.ErrPathTraversal) {
			t.Errorf("CheckContainment(%q, %q) error = %v; want ErrPathTraversal", baseDir, target, err)
		}
	}
}

func TestTraversalAttempts(t *testing.T) {
	tmpDir := t.TempDir()
	storage, err := mediastorage.New(tmpDir)
	if err != nil {
		t.Fatalf("mediastorage.New failed: %v", err)
	}

	traversalInputs := []struct {
		name string
		id   string
	}{
		{"dot-dot-slash", "../"},
		{"dot-dot-backslash", "..\\"},
		{"relative-escape-unix", "../../etc/passwd"},
		{"relative-escape-win", "..\\..\\windows\\win.ini"},
		{"absolute-unix", "/etc/passwd"},
		{"absolute-win", "C:\\Windows\\System32"},
		{"url-encoded-dots", "%2e%2e"},
		{"url-encoded-dots-slash", "%2e%2e%2f"},
		{"null-byte-injected", "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d\x00extra"},
		{"null-byte-alone", "\x00"},
		{"excessively-long-name", strings.Repeat("a", 1000)},
		{"unicode-fullwidth-dot", "\uFF0E\uFF0E/evil"},
		{"unicode-fraction-slash", "..\u2044evil"},
		{"empty-string", ""},
		{"random-string", "not-a-uuid-at-all"},
		{"uppercase-uuid", "A1B2C3D4-E5F6-4A7B-8C9D-0E1F2A3B4C5D"},
		{"uuid-with-nested-path", "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d/sub"},
		{"uuid-with-backslash", "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d\\sub"},
	}

	for _, tc := range traversalInputs {
		t.Run(tc.name, func(t *testing.T) {
			// EnsureFileDir must reject
			if err := storage.EnsureFileDir(tc.id); err == nil {
				t.Errorf("EnsureFileDir(%q) succeeded; expected error", tc.id)
			}

			// WriteChunkAtomic must reject
			if err := storage.WriteChunkAtomic(tc.id, 0, []byte("data")); err == nil {
				t.Errorf("WriteChunkAtomic(%q) succeeded; expected error", tc.id)
			}

			// ReadChunk must reject
			if _, err := storage.ReadChunk(tc.id, 0); err == nil {
				t.Errorf("ReadChunk(%q) succeeded; expected error", tc.id)
			}

			// ChunkExists must report false
			if storage.ChunkExists(tc.id, 0) {
				t.Errorf("ChunkExists(%q) returned true; expected false", tc.id)
			}

			// ChunkSize must reject
			if _, err := storage.ChunkSize(tc.id, 0); err == nil {
				t.Errorf("ChunkSize(%q) succeeded; expected error", tc.id)
			}

			// DeleteChunks must reject
			if err := storage.DeleteChunks(tc.id); err == nil {
				t.Errorf("DeleteChunks(%q) succeeded; expected error", tc.id)
			}
		})
	}
}

func TestSymlinkInsideMediaDirRefused(t *testing.T) {
	tmpDir := t.TempDir()
	storage, err := mediastorage.New(tmpDir)
	if err != nil {
		t.Fatalf("mediastorage.New failed: %v", err)
	}

	// Create an external target directory outside storage basePath
	outsideDir := filepath.Join(t.TempDir(), "external-target")
	if err := os.MkdirAll(outsideDir, 0o755); err != nil {
		t.Fatalf("creating external target: %v", err)
	}

	// Place a valid UUID symlink inside storage basePath pointing to external target
	symlinkUUID := "11111111-2222-3333-4444-555555555555"
	symlinkPath := filepath.Join(tmpDir, symlinkUUID)

	if err := os.Symlink(outsideDir, symlinkPath); err != nil {
		t.Skipf("skipping symlink test: symlink creation not permitted on this platform: %v", err)
	}

	// 1. EnsureFileDir on symlinked directory MUST fail with ErrSymlinkNotAllowed or ErrPathTraversal
	err = storage.EnsureFileDir(symlinkUUID)
	if err == nil {
		t.Errorf("EnsureFileDir on symlinked directory succeeded; expected error")
	} else if !errors.Is(err, mediastorage.ErrSymlinkNotAllowed) && !errors.Is(err, mediastorage.ErrPathTraversal) {
		t.Errorf("EnsureFileDir error = %v; want ErrSymlinkNotAllowed or ErrPathTraversal", err)
	}

	// 2. WriteChunkAtomic on symlinked directory MUST fail
	err = storage.WriteChunkAtomic(symlinkUUID, 0, []byte("injected chunk"))
	if err == nil {
		t.Errorf("WriteChunkAtomic on symlinked directory succeeded; expected error")
	} else if !errors.Is(err, mediastorage.ErrSymlinkNotAllowed) && !errors.Is(err, mediastorage.ErrPathTraversal) {
		t.Errorf("WriteChunkAtomic error = %v; want ErrSymlinkNotAllowed or ErrPathTraversal", err)
	}

	// 3. ReadChunk on symlinked directory MUST fail
	_, err = storage.ReadChunk(symlinkUUID, 0)
	if err == nil {
		t.Errorf("ReadChunk on symlinked directory succeeded; expected error")
	} else if !errors.Is(err, mediastorage.ErrSymlinkNotAllowed) && !errors.Is(err, mediastorage.ErrPathTraversal) {
		t.Errorf("ReadChunk error = %v; want ErrSymlinkNotAllowed or ErrPathTraversal", err)
	}

	// 4. ChunkExists on symlinked directory MUST return false
	if storage.ChunkExists(symlinkUUID, 0) {
		t.Errorf("ChunkExists on symlinked directory returned true; expected false")
	}

	// 5. ChunkSize on symlinked directory MUST fail
	_, err = storage.ChunkSize(symlinkUUID, 0)
	if err == nil {
		t.Errorf("ChunkSize on symlinked directory succeeded; expected error")
	} else if !errors.Is(err, mediastorage.ErrSymlinkNotAllowed) && !errors.Is(err, mediastorage.ErrPathTraversal) {
		t.Errorf("ChunkSize error = %v; want ErrSymlinkNotAllowed or ErrPathTraversal", err)
	}

	// 6. DeleteChunks on symlinked directory MUST fail
	err = storage.DeleteChunks(symlinkUUID)
	if err == nil {
		t.Errorf("DeleteChunks on symlinked directory succeeded; expected error")
	} else if !errors.Is(err, mediastorage.ErrSymlinkNotAllowed) && !errors.Is(err, mediastorage.ErrPathTraversal) {
		t.Errorf("DeleteChunks error = %v; want ErrSymlinkNotAllowed or ErrPathTraversal", err)
	}

	// 7. ListDirs MUST ignore the symlink and not include it
	dirs, err := storage.ListDirs()
	if err != nil {
		t.Fatalf("ListDirs failed: %v", err)
	}
	for _, d := range dirs {
		if d == symlinkUUID {
			t.Errorf("ListDirs returned symlinked directory %q; expected it to be omitted", symlinkUUID)
		}
	}
}
