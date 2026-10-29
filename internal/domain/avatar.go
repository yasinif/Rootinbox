package domain

// Avatar constants per Bundle 4 (Personalization).
const (
	// MaxAvatarSizeBytes is the maximum allowed size for an avatar image (2MB).
	MaxAvatarSizeBytes = 2 * 1024 * 1024
)

// AvatarStorage defines the contract for physical storage of avatar image assets.
type AvatarStorage interface {
	// Save writes the avatar image bytes atomically for the specified user.
	Save(userID string, data []byte) error

	// Read retrieves the raw avatar image bytes for the specified user.
	Read(userID string) ([]byte, error)

	// Delete removes the avatar image from disk.
	Delete(userID string) error

	// Exists checks if an avatar file exists for the user.
	Exists(userID string) bool
}
