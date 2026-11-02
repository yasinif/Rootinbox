// Package mediastorage provides local filesystem media storage.
// RFC-0007 §8.1: Media files MUST be stored on the local File System.
package mediastorage

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	// ErrPathTraversal is returned when a path expression attempts to escape the storage root.
	ErrPathTraversal = errors.New("path traversal detected: path escapes storage root")
	// ErrSymlinkNotAllowed is returned when a storage directory or file is a symbolic link.
	ErrSymlinkNotAllowed = errors.New("symbolic links are not permitted in media storage")
	// ErrInvalidFileID is returned when a file ID fails strict format validation.
	ErrInvalidFileID = errors.New("invalid file_id format: must be canonical lowercase UUID")
	// ErrInvalidChunkIndex is returned when chunk index is negative or out of bounds.
	ErrInvalidChunkIndex = errors.New("invalid chunk index: must be between 0 and 400")

	// strict canonical lowercase UUID pattern
	fileIDRegex = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
)

// ValidateID strictly validates that the fileID is a canonical lowercase UUID.
// It explicitly rejects path traversal sequences, null bytes, separators, and non-canonical characters.
func ValidateID(fileID string) error {
	if fileID == "" {
		return fmt.Errorf("%w: empty file ID", ErrInvalidFileID)
	}
	if len(fileID) != 36 {
		return fmt.Errorf("%w: invalid length %d", ErrInvalidFileID, len(fileID))
	}
	if strings.ContainsAny(fileID, "/\\.\x00") {
		return fmt.Errorf("%w: contains prohibited characters", ErrInvalidFileID)
	}
	if !fileIDRegex.MatchString(fileID) {
		return fmt.Errorf("%w: must match canonical lowercase UUID pattern", ErrInvalidFileID)
	}
	return nil
}

// LocalStorage manages media chunk files on the local filesystem.
// RFC-0007 §8.1: Strict Local Storage (./data/media/).
type LocalStorage struct {
	basePath string
}

// New creates a new LocalStorage, ensuring the base directory exists.
func New(basePath string) (*LocalStorage, error) {
	cleanBase := filepath.Clean(basePath)
	if err := os.MkdirAll(cleanBase, 0o750); err != nil {
		return nil, fmt.Errorf("creating media base directory: %w", err)
	}
	return &LocalStorage{basePath: cleanBase}, nil
}

// CheckContainment verifies that target is strictly contained within base,
// using lexical analysis (filepath.Rel, filepath.IsLocal) and refusing symlinks.
func (s *LocalStorage) CheckContainment(base, target string) error {
	cleanBase := filepath.Clean(base)
	cleanTarget := filepath.Clean(target)

	// Lexical containment check via filepath.Rel
	rel, err := filepath.Rel(cleanBase, cleanTarget)
	if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || filepath.IsAbs(rel) {
		return fmt.Errorf("%w: target %q escapes base %q", ErrPathTraversal, cleanTarget, cleanBase)
	}

	// Lexical check via filepath.IsLocal
	if !filepath.IsLocal(rel) {
		return fmt.Errorf("%w: relative path %q is not local", ErrPathTraversal, rel)
	}

	// Refuse symlinks on target if it exists
	fi, err := os.Lstat(cleanTarget)
	if err == nil {
		if fi.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("%w: path is a symlink: %s", ErrSymlinkNotAllowed, cleanTarget)
		}
		// Resolve symlinks to ensure target does not escape evaluated base directory
		realBase, err := filepath.EvalSymlinks(cleanBase)
		if err == nil {
			realTarget, err := filepath.EvalSymlinks(cleanTarget)
			if err == nil {
				realRel, err := filepath.Rel(realBase, realTarget)
				if err != nil || realRel == "." || realRel == ".." || strings.HasPrefix(realRel, ".."+string(filepath.Separator)) || filepath.IsAbs(realRel) {
					return fmt.Errorf("%w: real path %q escapes real base %q", ErrPathTraversal, realTarget, realBase)
				}
			}
		}
	}

	return nil
}

// fileDir returns the directory for a specific file's chunks after strict validation and containment check.
func (s *LocalStorage) fileDir(fileID string) (string, error) {
	if err := ValidateID(fileID); err != nil {
		return "", err
	}
	targetDir := filepath.Join(s.basePath, fileID)
	if err := s.CheckContainment(s.basePath, targetDir); err != nil {
		return "", err
	}
	return targetDir, nil
}

// chunkPath returns the deterministic path for a chunk file after validation and containment check.
func (s *LocalStorage) chunkPath(fileID string, chunkIndex int) (string, error) {
	if chunkIndex < 0 || chunkIndex > 400 {
		return "", ErrInvalidChunkIndex
	}
	dir, err := s.fileDir(fileID)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, fmt.Sprintf("chunk_%04d", chunkIndex))
	if err := s.CheckContainment(dir, path); err != nil {
		return "", err
	}
	return path, nil
}

// tempPath returns the temporary file path for atomic writes after validation and containment check.
func (s *LocalStorage) tempPath(fileID string, chunkIndex int) (string, error) {
	if chunkIndex < 0 || chunkIndex > 400 {
		return "", ErrInvalidChunkIndex
	}
	dir, err := s.fileDir(fileID)
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, fmt.Sprintf(".chunk_%04d.tmp", chunkIndex))
	if err := s.CheckContainment(dir, path); err != nil {
		return "", err
	}
	return path, nil
}

// EnsureFileDir creates the directory for a file's chunks.
func (s *LocalStorage) EnsureFileDir(fileID string) error {
	dir, err := s.fileDir(fileID)
	if err != nil {
		return err
	}
	return os.MkdirAll(dir, 0o750)
}

// WriteChunkAtomic writes a chunk using the strict atomic I/O sequence.
// RFC-0007 §7.2: Write temp -> fsync -> rename -> dir sync.
// The caller MUST hold the Per-File I/O Lock.
func (s *LocalStorage) WriteChunkAtomic(fileID string, chunkIndex int, data []byte) error {
	dir, err := s.fileDir(fileID)
	if err != nil {
		return err
	}
	finalPath, err := s.chunkPath(fileID, chunkIndex)
	if err != nil {
		return err
	}
	tmpPath, err := s.tempPath(fileID, chunkIndex)
	if err != nil {
		return err
	}

	// Refuse if finalPath or tmpPath already exists as symlink
	if fi, err := os.Lstat(finalPath); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		return ErrSymlinkNotAllowed
	}
	if fi, err := os.Lstat(tmpPath); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		return ErrSymlinkNotAllowed
	}

	// Step 1: Write to temporary file.
	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
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
	p, err := s.chunkPath(fileID, chunkIndex)
	if err != nil {
		return nil, err
	}
	fi, err := os.Lstat(p)
	if err != nil {
		return nil, fmt.Errorf("reading chunk: %w", err)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return nil, ErrSymlinkNotAllowed
	}
	data, err := os.ReadFile(p)
	if err != nil {
		return nil, fmt.Errorf("reading chunk: %w", err)
	}
	return data, nil
}

// ChunkExists checks if a chunk file exists on disk.
func (s *LocalStorage) ChunkExists(fileID string, chunkIndex int) bool {
	p, err := s.chunkPath(fileID, chunkIndex)
	if err != nil {
		return false
	}
	fi, err := os.Lstat(p)
	if err != nil {
		return false
	}
	return fi.Mode()&os.ModeSymlink == 0
}

// ChunkSize returns the size of a chunk file on disk.
func (s *LocalStorage) ChunkSize(fileID string, chunkIndex int) (int64, error) {
	p, err := s.chunkPath(fileID, chunkIndex)
	if err != nil {
		return 0, err
	}
	fi, err := os.Lstat(p)
	if err != nil {
		return 0, err
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return 0, ErrSymlinkNotAllowed
	}
	return fi.Size(), nil
}

// DeleteChunks removes all chunk files for a file.
// RFC-0007 §8.5 Phase B: Physical deletion.
// The caller MUST hold the Per-File I/O Lock.
func (s *LocalStorage) DeleteChunks(fileID string) error {
	dir, err := s.fileDir(fileID)
	if err != nil {
		return err
	}
	fi, err := os.Lstat(dir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("stat chunk directory: %w", err)
	}
	if fi.Mode()&os.ModeSymlink != 0 {
		return ErrSymlinkNotAllowed
	}
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("deleting chunk directory: %w", err)
	}
	return nil
}

// DeleteChunk removes a single chunk file.
// Used for abort path cleanup.
func (s *LocalStorage) DeleteChunk(fileID string, chunkIndex int) {
	p, err := s.chunkPath(fileID, chunkIndex)
	if err != nil {
		return
	}
	fi, err := os.Lstat(p)
	if err == nil && fi.Mode()&os.ModeSymlink == 0 {
		os.Remove(p)
	}
}

// ListDirs returns file directories in the media base that don't match
// any known file_id. Used by GC for orphan reconciliation.
// Only returns genuine directories with valid UUID names, ignoring symlinks and traversal components.
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
		if entry.IsDir() && entry.Type()&os.ModeSymlink == 0 {
			if err := ValidateID(entry.Name()); err == nil {
				dirs = append(dirs, entry.Name())
			}
		}
	}
	return dirs, nil
}
