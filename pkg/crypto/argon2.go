// Package crypto provides the cryptographic foundation for RootInbox.
// RFC-0003: Cryptography, Key Lifecycle & Cipher Formats.
// All primitives are pure Go (CGO_ENABLED=0 compatible).
package crypto

import (
	"crypto/sha256"
	"strings"

	"golang.org/x/crypto/argon2"
	"golang.org/x/text/unicode/norm"
)

// Argon2id frozen parameters per RFC-0003 §4.1.
const (
	argon2Memory      = 65536 // 64 MB
	argon2Time        = 3
	argon2Parallelism = 4
	argon2KeyLength   = 32
)

// NormalizeUsername applies RFC-0003 §4.1 username normalization:
// NormalizedUsername = lowercase(Unicode_NFC(Username)).
func NormalizeUsername(username string) string {
	return strings.ToLower(norm.NFC.String(username))
}

// DeriveIdentityKey derives the Ed25519 seed from username and password.
// RFC-0003 §4.1: Argon2id (Version 0x13), Memory 65536, Time 3, Parallelism 4, Output 32 bytes.
// Salt: SHA256(NormalizedUsername || "IDENTITY").
func DeriveIdentityKey(username, password string) [32]byte {
	normalized := NormalizeUsername(username)
	salt := sha256.Sum256([]byte(normalized + "IDENTITY"))
	key := argon2.IDKey([]byte(password), salt[:], argon2Time, argon2Memory, argon2Parallelism, argon2KeyLength)
	var result [32]byte
	copy(result[:], key)
	return result
}

// DeriveVaultKey derives the AES-256-GCM vault key from username and password.
// RFC-0003 §4.2: Identical Argon2id parameters as Identity Key.
// Salt: SHA256(NormalizedUsername || "VAULT").
func DeriveVaultKey(username, password string) [32]byte {
	normalized := NormalizeUsername(username)
	salt := sha256.Sum256([]byte(normalized + "VAULT"))
	key := argon2.IDKey([]byte(password), salt[:], argon2Time, argon2Memory, argon2Parallelism, argon2KeyLength)
	var result [32]byte
	copy(result[:], key)
	return result
}
