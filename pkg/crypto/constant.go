package crypto

import (
	"crypto/subtle"
)

// ConstantTimeCompare performs a constant-time comparison of two byte slices.
// RFC-0003 §8.1: All security-sensitive comparisons MUST utilize constant-time
// comparison functions.
func ConstantTimeCompare(a, b []byte) bool {
	return subtle.ConstantTimeCompare(a, b) == 1
}

// Zeroize overwrites a byte slice with zeros.
// RFC-0003 §8.3: Best-effort attempt to overwrite sensitive buffers with zeros
// before releasing references.
func Zeroize(b []byte) {
	for i := range b {
		b[i] = 0
	}
}
