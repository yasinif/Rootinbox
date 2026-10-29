package domain

// VAPIDKeyRowID is the singleton primary key for the application_keys row.
const VAPIDKeyRowID = "vapid"

// ApplicationKey is the encrypted-at-rest server identity keypair (§4.1).
// Scope: ONE global keypair per deployment. NOT tied to any user identity,
// Trust Graph, or Vault (§4.1).
type ApplicationKey struct {
	ID                    string // always VAPIDKeyRowID
	PrivateKeyEncrypted   string // lowercase hex of [12-byte IV][ciphertext||tag]
	PublicKeyUncompressed string // Base64URL of the 65-byte uncompressed point
	CreatedAt             int64
}

// VAPIDKeyProvider exposes the loaded, decrypted VAPID identity.
// RFC-0001A §2: the interface belongs to the consumer (domain).
// Implementations MUST be immutable after bootstrap (§4.1).
type VAPIDKeyProvider interface {
	// PublicKeyBase64URL returns the Base64URL uncompressed public key
	// for the `k=` parameter of the Authorization header (§4.2).
	PublicKeyBase64URL() string
	// PrivateKeyBase64URL returns the encoding the Web Push library expects.
	PrivateKeyBase64URL() string
}
