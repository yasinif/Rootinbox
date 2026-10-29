package domain

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
