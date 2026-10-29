// Package infrastructure provides production implementations of domain interfaces.
package infrastructure

import (
	"time"

	"github.com/google/uuid"
)

// RealClock implements domain.Clock using the system clock.
// RFC-0001A §2.1: UseCases MUST NOT call time.Now() directly.
type RealClock struct{}

// NowUnix returns the current UTC time as UNIX epoch seconds.
func (RealClock) NowUnix() int64 {
	return time.Now().UTC().Unix()
}

// RealUUIDGenerator implements domain.UUIDGenerator using google/uuid.
// RFC-0001A §2.1: UseCases MUST NOT call uuid.New() directly.
type RealUUIDGenerator struct{}

// New generates a new RFC 4122 Version 4 UUID as a canonical lowercase string.
// RFC-0002 §4.2: All UUIDs MUST be stored as canonical lowercase strings.
func (RealUUIDGenerator) New() string {
	return uuid.New().String()
}
