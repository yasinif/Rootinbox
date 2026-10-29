// Package avatarstorage provides local filesystem storage for user avatars.
// Bundle 4: Personalization.
package avatarstorage

import (
	"fmt"
	"os"
	"path/filepath"

	"rootinbox/internal/domain"
)

// LocalStorage manages avatar files on the local filesystem.
type LocalStorage struct {
	basePath string
}

// Compile-time assertion that LocalStorage implements domain.AvatarStorage.
var _ domain.AvatarStorage = (*LocalStorage)(nil)

// New creates a new LocalStorage, ensuring the base directory exists with secure permissions.
func New(basePath string) (*LocalStorage, error) {
	if err := os.MkdirAll(basePath, 0o750); err != nil {
		return nil, fmt.Errorf("creating avatar storage base directory: %w", err)
	}
	return &LocalStorage{basePath: basePath}, nil
}

// avatarPath returns the deterministic storage path for a user's avatar.
func (s *LocalStorage) avatarPath(userID string) string {
	return filepath.Join(s.basePath, userID)
}

// tempPath returns a temporary file path for atomic writes.
func (s *LocalStorage) tempPath(userID string) string {
	return filepath.Join(s.basePath, fmt.Sprintf(".%s.tmp", userID))
}

// Save writes avatar bytes atomically using temp -> fsync -> rename -> dir sync.
func (s *LocalStorage) Save(userID string, data []byte) error {
	finalPath := s.avatarPath(userID)
	tmpPath := s.tempPath(userID)

	// Step 1: Write to temporary file.
	f, err := os.OpenFile(tmpPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o640)
	if err != nil {
		return fmt.Errorf("creating temp avatar file: %w", err)
	}

	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("writing temp avatar: %w", err)
	}

	// Step 2: fsync file to disk.
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmpPath)
		return fmt.Errorf("syncing temp avatar: %w", err)
	}
	f.Close()

	// Step 3: Atomic rename to final path.
	if err := os.Rename(tmpPath, finalPath); err != nil {
		os.Remove(tmpPath)
		return fmt.Errorf("renaming avatar to final path: %w", err)
	}

	// Step 4: Sync parent directory.
	dirHandle, err := os.Open(s.basePath)
	if err == nil {
		dirHandle.Sync()
		dirHandle.Close()
	}

	return nil
}

// Read reads the avatar image bytes from disk.
func (s *LocalStorage) Read(userID string) ([]byte, error) {
	data, err := os.ReadFile(s.avatarPath(userID))
	if err != nil {
		return nil, fmt.Errorf("reading avatar file: %w", err)
	}
	return data, nil
}

// Delete removes the avatar file from disk.
func (s *LocalStorage) Delete(userID string) error {
	err := os.Remove(s.avatarPath(userID))
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("deleting avatar file: %w", err)
	}
	return nil
}

// Exists checks if an avatar file exists for the user.
func (s *LocalStorage) Exists(userID string) bool {
	_, err := os.Stat(s.avatarPath(userID))
	return err == nil
}
