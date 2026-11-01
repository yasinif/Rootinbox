package domain

import "context"

// Vault represents an encrypted monthly message archive.
// RFC-0006 §4.3: Vault Archival Lifecycle.
// No struct tags (Clean Architecture).
type Vault struct {
	ID            string // UUIDv4
	UserID        string // FK -> users.id
	MonthYear     string // e.g., "2026-01"
	EncryptedData []byte // Strictly opaque ciphertext (AES-256-GCM)
	ContentHash   string // SHA-256(Ciphertext) hex — upload integrity
	SchemaVersion int    // Schema version bound to AAD
	Finalized     bool   // Immutability flag
	CreatedAt     int64  // UNIX Epoch UTC
}

// ZKVault represents a user's Zero-Knowledge Encrypted Vault.
// RFC Stage 1a: Decoupled Auth Keypair, KDF Parameters, and Sealed Vault Storage.
type ZKVault struct {
	UserID     string // FK -> users.id
	Version    int    // Monotonic integer version
	Ciphertext []byte // Opaque XChaCha20-Poly1305 ciphertext (nonce || ct || tag)
	Signature  string // Hex-encoded Ed25519 signature over ciphertext by auth_sk
	UpdatedAt  int64  // Unix Epoch UTC seconds
}

// ZKVaultRepository defines the data access contract for Zero-Knowledge Vault entities.
type ZKVaultRepository interface {
	GetByUserID(ctx context.Context, userID string) (*ZKVault, error)
	Save(ctx context.Context, vault *ZKVault, expectedVersion int) error
}
