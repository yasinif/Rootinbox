// Package mediastorage provides local filesystem media storage.
// RFC-0007 §8.1: Media files MUST be stored on the local File System.
package mediastorage

import (
	"fmt"
	"os"
	"path/filepath"
)

// LocalStorage manages media chunk files on the local filesystem.
// RFC-0007 §8.1: Strict Local Storage (./data/media/).
type LocalStorage struct {
	basePath string
}

// New creates a new LocalStorage, ensuring the base directory exists.
func New(basePath string) (*LocalStorage, error) {
	if err := os.MkdirAll(basePath, 0o750); err != nil {
		return nil, fmt.Errorf("creating media base directory: %w", err)
	}
	return &LocalStorage{basePath: basePath}, nil
}

// fileDir returns the directory for a specific file's chunks.
func (s *LocalStorage) fileDir(fileID string) string {
	return filepath.Join(s.basePath, fileID)
}

// chunkPath returns the deterministic path for a chunk file.
func (s *LocalStorage) chunkPath(fileID string, chunkIndex int) string {
	return filepath.Join(s.fileDir(fileID), fmt.Sprintf("chunk_%04d", chunkIndex))
}

// tempPath returns the temporary file path for atomic writes.
func (s *LocalStorage) tempPath(fileID string, chunkIndex int) string {
	return filepath.Join(s.fileDir(fileID), fmt.Sprintf(".chunk_%04d.tmp", chunkIndex))
}

// EnsureFileDir creates the directory for a file's chunks.
func (s *LocalStorage) EnsureFileDir(fileID string) error {
	return os.MkdirAll(s.fileDir(fileID), 0o750)
}

// WriteChunkAtomic writes a chunk using the strict atomic I/O sequence.
// RFC-0007 §7.2: Write temp -> fsync -> rename -> dir sync.
// The caller MUST hold the Per-File I/O Lock.
func (s *LocalStorage) WriteChunkAtomic(fileID string, chunkIndex int, data []byte) error {
	dir := s.fileDir(fileID)
	finalPath := s.chunkPath(fileID, chunkIndex)
	tmpPath := s.tempPath(fileID, chunkIndex)

	// Step 1: Write to temporary file.
	f, err := os.Create(tmpPath)
	if err != nil {
		return fmt.Errorf("creating temp chunk file: %w", err)
	}

	_, err = f.Write(data)
	if err != nil {
		f.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("writing temp chunk: %w", err)
	}

	// Step 2: fsync the file.
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("syncing temp chunk: %w", err)
	}
	f.Close()

	// Step 3: Atomic rename to final path.
	if err := os.Rename(tmpPath, finalPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("renaming chunk to final path: %w", err)
	}

	// Step 4: Sync parent directory.
	dirHandle, err := os.Open(dir)
	if err == nil {
		dirHandle.Sync()
		dirHandle.Close()
	}
	// dir sync failure is non-fatal on some platforms (Windows).

	return nil
}

// ReadChunk reads a chunk file from disk.
// The caller MUST hold the Per-File I/O Lock.
func (s *LocalStorage) ReadChunk(fileID string, chunkIndex int) ([]byte, error) {
	data, err := os.ReadFile(s.chunkPath(fileID, chunkIndex))
	if err != nil {
		return nil, fmt.Errorf("reading chunk: %w", err)
	}
	return data, nil
}

// ChunkExists checks if a chunk file exists on disk.
func (s *LocalStorage) ChunkExists(fileID string, chunkIndex int) bool {
	_, err := os.Stat(s.chunkPath(fileID, chunkIndex))
	return err == nil
}

// ChunkSize returns the size of a chunk file on disk.
func (s *LocalStorage) ChunkSize(fileID string, chunkIndex int) (int64, error) {
	info, err := os.Stat(s.chunkPath(fileID, chunkIndex))
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

// DeleteChunks removes all chunk files for a file.
// RFC-0007 §8.5 Phase B: Physical deletion.
// The caller MUST hold the Per-File I/O Lock.
func (s *LocalStorage) DeleteChunks(fileID string) error {
	dir := s.fileDir(fileID)
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("deleting chunk directory: %w", err)
	}
	return nil
}

// DeleteChunk removes a single chunk file.
// Used for abort path cleanup.
func (s *LocalStorage) DeleteChunk(fileID string, chunkIndex int) {
	os.Remove(s.chunkPath(fileID, chunkIndex))
}

// ListOrphanFiles returns file directories in the media base that don't match
// any known file_id. Used by GC for orphan reconciliation.
func (s *LocalStorage) ListDirs() ([]string, error) {
	entries, err := os.ReadDir(s.basePath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("listing media directories: %w", err)
	}

	var dirs []string
	for _, entry := range entries {
		if entry.IsDir() {
			dirs = append(dirs, entry.Name())
		}
	}
	return dirs, nil
}
