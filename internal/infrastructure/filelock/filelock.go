// Package filelock provides per-file I/O locking for media operations.
// RFC-0007 §8.4: In-memory Per-File I/O Lock (Mutex) keyed to file_id.
package filelock

import "sync"

// FileLock provides per-file mutual exclusion for filesystem operations.
// RFC-0007 §8.4: All physical filesystem operations MUST acquire this lock.
type FileLock struct {
	mu    sync.Mutex
	locks map[string]*lockEntry
}

type lockEntry struct {
	mu      sync.Mutex
	refCount int
}

// New creates a new FileLock.
func New() *FileLock {
	return &FileLock{
		locks: make(map[string]*lockEntry),
	}
}

// Lock acquires the lock for the given file_id.
func (fl *FileLock) Lock(fileID string) {
	fl.mu.Lock()
	entry, ok := fl.locks[fileID]
	if !ok {
		entry = &lockEntry{}
		fl.locks[fileID] = entry
	}
	entry.refCount++
	fl.mu.Unlock()

	entry.mu.Lock()
}

// Unlock releases the lock for the given file_id.
// Cleans up unused entries to prevent memory leaks.
func (fl *FileLock) Unlock(fileID string) {
	fl.mu.Lock()
	entry, ok := fl.locks[fileID]
	if !ok {
		fl.mu.Unlock()
		return
	}
	entry.refCount--
	if entry.refCount <= 0 {
		delete(fl.locks, fileID)
	}
	fl.mu.Unlock()

	entry.mu.Unlock()
}
