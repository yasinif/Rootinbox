package domain

// UserStatus represents the account status of a user.
// RFC-0002 §4.1: Domain Entity contract.
type UserStatus string

const (
	UserStatusActive    UserStatus = "ACTIVE"
	UserStatusSuspended UserStatus = "SUSPENDED"
	UserStatusDeleted   UserStatus = "DELETED"
)

// User represents a registered user in the system.
// RFC-0002 §4.1: No database/SQL tags allowed (Clean Architecture).
// RFC-0002 §4.2: Zero-Knowledge Rule — NO columns for email or phone.
// RFC-0002-A §7A.2: Username is an opt-in public identifier (nullable).
type User struct {
	ID              string  // Canonical UUIDv4
	IdentityHash    string  // Deterministic Public-Key Hash (SHA-256) for discovery
	PublicKey       string  // Ed25519 PK
	Username        *string // Amendment RFC-0002-A: Opt-in public identifier (nullable)
	DisplayName     *string // Fix 1+2: Telegram-style profile display name (nullable)
	LastName        *string // Fix 1+2: Telegram-style profile last name (nullable)
	Bio             *string // Fix 1+2: Telegram-style bio, max 200 chars (nullable)
	AvatarMime      *string // Bundle 4: Image MIME type (nullable)
	AvatarUpdatedAt *int64  // Bundle 4: Last avatar update epoch timestamp (nullable)
	AuthPubkey      *string // Decoupled authentication public key (Ed25519)
	KDFSalt         *string // Hex-encoded Argon2id salt
	KDFMemoryKiB    int     // Argon2id memory in KiB (default 32768)
	KDFIterations   int     // Argon2id iterations (default 4)
	KDFParallelism  int     // Argon2id parallelism (default 1)
	LastSeenAt      int64   // User presence: epoch milliseconds
	Status          UserStatus
	CreatedAt       int64 // Unix Epoch UTC
}
