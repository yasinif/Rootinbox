package domain

import "strings"

// MediaStatus represents the state of a media file in its lifecycle.
// RFC-0007 §6.1: Explicit MediaStatus Enum.
type MediaStatus string

const (
	// MediaStatusPending is the initial state upon /init.
	MediaStatusPending MediaStatus = "PENDING"
	// MediaStatusFinalized is the verified and complete state.
	MediaStatusFinalized MediaStatus = "FINALIZED"
	// MediaStatusDeleting is the intermediate state during 3-Phase deletion.
	MediaStatusDeleting MediaStatus = "DELETING"
)

// Media constants per RFC-0007.
const (
	// ChunkPlaintextSize is the plaintext chunk size before encryption.
	// RFC-0007 §4.1: Exactly 5,242,880 bytes (5MB).
	ChunkPlaintextSize = 5_242_880

	// ChunkCiphertextSize is the maximum encrypted chunk size (plaintext + AES-GCM tag).
	// RFC-0007 §4.1: Up to 5,242,896 bytes (5MB + 16 bytes). Unpadded chunks: 1 <= chunk_size <= ChunkCiphertextSize.
	ChunkCiphertextSize = 5_242_896

	// MaxTotalChunks is the maximum number of chunks per file.
	// RFC-0007 §7.1: 1 <= total_chunks <= 400 (Max 2GB).
	MaxTotalChunks = 400

	// PendingTimeoutHours is the maximum time a file can stay in PENDING.
	// Hard-delete abandoned/stale partial uploads after 1 hour to prevent orphaned storage and quota consumption.
	PendingTimeoutHours = 1

	// OrphanGraceMinutes is the minimum age for orphan chunk cleanup.
	// RFC-0007 §8.6: Orphan files older than exactly 10 minutes.
	OrphanGraceMinutes = 10
)

// MediaFile represents a media upload record.
// RFC-0007 §8.1: media_files table.
// No struct tags (Clean Architecture).
type MediaFile struct {
	FileID         string      // UUIDv4 — PRIMARY KEY
	UploaderUserID string      // FK -> users.id
	TokenHash      string      // SHA-256(Media_Token), Base64-encoded
	TotalChunks    int         // 1-400
	Generation     int64       // OCC version counter
	Status         MediaStatus // PENDING, FINALIZED, DELETING
	CreatedAt      int64       // UNIX Epoch UTC
}

// PaddedSize returns the total maximum padded storage size in bytes.
// RFC-0007 §8.2: Used for quota reservation bounds.
func (mf *MediaFile) PaddedSize() int64 {
	return int64(mf.TotalChunks) * ChunkCiphertextSize
}

// MediaChunk represents a single uploaded chunk of a media file.
// RFC-0007 §8.1: media_chunks table. Composite PK: (file_id, chunk_index).
// No struct tags (Clean Architecture).
type MediaChunk struct {
	FileID     string // FK -> media_files.file_id
	ChunkIndex int    // 0-based index
	ChunkHash  string // SHA-256 of ciphertext, hex-encoded
	CreatedAt  int64  // UNIX Epoch UTC
}

// UserQuota represents a user's media storage quota.
// RFC-0007 §8.2: user_quotas table.
// No struct tags (Clean Architecture).
type UserQuota struct {
	UserID          string // PK -> users.id
	QuotaLimitBytes int64  // Maximum capacity
	ReservedBytes   int64  // Reserved by PENDING uploads
	CommittedBytes  int64  // Used by FINALIZED files
}

// AvailableBytes returns the remaining quota capacity.
func (q *UserQuota) AvailableBytes() int64 {
	return q.QuotaLimitBytes - q.ReservedBytes - q.CommittedBytes
}

// AllowedMimeTypes defines all permitted media MIME types.
var AllowedMimeTypes = map[string]bool{
	// Images
	"image/jpeg": true, "image/jpg": true, "image/png": true, "image/webp": true,
	"image/gif": true, "image/svg+xml": true, "image/avif": true, "image/bmp": true,
	"image/tiff": true,

	// Audio
	"audio/webm": true, "audio/ogg": true, "audio/mpeg": true, "audio/mp3": true,
	"audio/mp4": true, "audio/x-m4a": true, "audio/m4a": true, "audio/wav": true,
	"audio/wave": true, "audio/x-wav": true, "audio/aac": true, "audio/flac": true,

	// Video
	"video/mp4": true, "video/webm": true, "video/ogg": true, "video/quicktime": true,
	"video/x-msvideo": true, "video/mpeg": true,

	// Documents / Archives / Fallback
	"application/pdf": true, "application/zip": true, "application/x-zip-compressed": true,
	"application/x-tar": true, "application/gzip": true, "application/x-gzip": true,
	"application/x-7z-compressed": true, "application/x-rar-compressed": true, "application/vnd.rar": true,
	"application/json": true, "text/plain": true, "text/csv": true, "text/markdown": true,
	"text/html":          true,
	"application/msword": true,
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": true,
	"application/vnd.ms-excel": true,
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":         true,
	"application/vnd.ms-powerpoint":                                             true,
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": true,
	"application/octet-stream":                                                  true,
}

// ValidateMimeType validates if a MIME type is acceptable, stripping parameters like ; codecs=...
func ValidateMimeType(mime string) bool {
	clean := strings.ToLower(strings.TrimSpace(mime))
	if idx := strings.Index(clean, ";"); idx != -1 {
		clean = strings.TrimSpace(clean[:idx])
	}
	if clean == "" {
		return false
	}
	if AllowedMimeTypes[clean] {
		return true
	}
	if strings.HasPrefix(clean, "image/") ||
		strings.HasPrefix(clean, "audio/") ||
		strings.HasPrefix(clean, "video/") ||
		strings.HasPrefix(clean, "text/") ||
		strings.HasPrefix(clean, "application/") {
		return true
	}
	return false
}
