package push

import (
	"errors"
	"time"

	"rootinbox/internal/domain"
)

// BuildAuthorizationHeader is delegated to the Web Push library, which owns
// RFC 8292 JWT construction. This file exists ONLY to assert our constraints.

// AssertJWTLifetime enforces the max 12h lifetime rule of RFC 8292.
// Used only by T-VAPID-5 test to guarantee we don't allow overly long JWTs.
func AssertJWTLifetime(expUnix, nowUnix int64) error {
	lifetime := time.Duration(expUnix-nowUnix) * time.Second
	if lifetime > domain.VAPIDJWTMaxLifetimeSeconds*time.Second {
		return errors.New("jwt lifetime exceeds 12h maximum")
	}
	if lifetime <= 0 {
		return errors.New("jwt is already expired")
	}
	return nil
}
