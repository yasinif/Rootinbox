package config

import (
	"crypto/subtle"
	"fmt"
	"log/slog"
)

// Secret wraps a byte slice to prevent accidental logging or exposure.
// Implements ADR-P10-11: Struct with unexported field, stringers return REDACTED.
type Secret struct {
	v []byte
}

func NewSecret(b []byte) Secret {
	return Secret{v: b}
}

func (s Secret) String() string {
	return "[REDACTED]"
}

func (s Secret) GoString() string {
	return "[REDACTED]"
}

func (s Secret) MarshalJSON() ([]byte, error) {
	return []byte("\"[REDACTED]\""), nil
}

func (s Secret) LogValue() slog.Value {
	return slog.StringValue("[REDACTED]")
}

func (s Secret) Format(f fmt.State, verb rune) {
	_, _ = fmt.Fprint(f, "[REDACTED]")
}

func (s Secret) IsZero() bool {
	return len(s.v) == 0
}

func (s Secret) Len() int {
	return len(s.v)
}

func (s Secret) Reveal() []byte {
	out := make([]byte, len(s.v))
	copy(out, s.v)
	return out
}

func (s Secret) ConstantTimeEqual(other []byte) bool {
	return subtle.ConstantTimeCompare(s.v, other) == 1
}
