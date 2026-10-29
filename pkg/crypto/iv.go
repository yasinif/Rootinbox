package crypto

import (
	"crypto/rand"
	"encoding/binary"
	"fmt"
)

// GenerateIVPrefix generates a cryptographically random 4-byte IV prefix.
// RFC-0003 §8.1: ONLY crypto/rand (secure equivalent) permitted for RNG.
// RFC-0003 §8.1: After unexpected restart, a fresh prefix MUST be generated.
func GenerateIVPrefix() ([4]byte, error) {
	var prefix [4]byte
	if _, err := rand.Read(prefix[:]); err != nil {
		return prefix, fmt.Errorf("generating IV prefix: %w", err)
	}
	return prefix, nil
}

// BuildIV constructs a 12-byte IV from a 4-byte random prefix and 8-byte counter.
// RFC-0003 §8.1: [4-byte Random Session Prefix] [8-byte Monotonic Message Counter].
func BuildIV(prefix [4]byte, counter uint64) [12]byte {
	var iv [12]byte
	copy(iv[:4], prefix[:])
	binary.BigEndian.PutUint64(iv[4:], counter)
	return iv
}
