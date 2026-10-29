package middleware

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"rootinbox/internal/domain"
)

const (
	// sessionCookieName must match the delivery/http cookie name.
	// RFC-0004 §7.1: Cookie Name "ps_session".
	sessionCookieName = "ps_session"

	// authFailCode is the uniform auth failure code.
	// RFC-0004 §8.2: All auth failures return AUTH_001.
	authFailCode = "AUTH_001"

	// authFailMsg is the uniform auth failure message.
	authFailMsg = "Authentication failed. Invalid identity, signature, or expired challenge."
)

// sessionAuthErrorResponse is the private error response type for the middleware.
// Uses its own struct to avoid circular imports with delivery/http.
type sessionAuthErrorResponse struct {
	Error sessionAuthErrorDetail `json:"error"`
}

type sessionAuthErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// SessionAuth creates middleware that enforces session authentication.
// RFC-0004 §8.3: Session Version Atomic Check (Runtime Middleware).
// Every protected HTTP request MUST pass through this middleware.
func SessionAuth(sessionRepo domain.SessionRepository, logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Step 1: Extract ps_session cookie or Authorization Bearer header.
			var tokenValue string
			if cookie, err := r.Cookie(sessionCookieName); err == nil && cookie.Value != "" {
				tokenValue = cookie.Value
			} else {
				authHeader := r.Header.Get("Authorization")
				if strings.HasPrefix(authHeader, "Bearer ") {
					tokenValue = strings.TrimPrefix(authHeader, "Bearer ")
				}
			}

			if tokenValue == "" {
				writeAuthError(w)
				return
			}

			// Step 2: Hash the incoming opaque cookie/token.
			// RFC-0004 §7.1: DB stores SHA256(cookie_token).
			tokenBytes, err := hex.DecodeString(tokenValue)
			if err != nil {
				writeAuthError(w)
				return
			}
			hash := sha256.Sum256(tokenBytes)
			tokenHash := hex.EncodeToString(hash[:])

			// Step 3: Look up the session in the database.
			session, err := sessionRepo.GetByTokenHash(r.Context(), tokenHash)
			if err != nil || session == nil {
				writeAuthError(w)
				return
			}

			now := time.Now().Unix()

			// Step 4: Validate that revoked_at IS NULL.
			if session.RevokedAt != nil {
				writeAuthError(w)
				return
			}

			// Step 5: Validate not expired.
			if now >= session.ExpiresAt {
				writeAuthError(w)
				return
			}

			// Authentication passed — set context values.
			ctx := domain.WithUserID(r.Context(), session.UserID)
			ctx = domain.WithSessionID(ctx, session.ID)

			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// OptionalSessionAuth extracts and attaches the authenticated user/session to the request context
// if a valid session exists, but does not abort the request if unauthenticated.
func OptionalSessionAuth(sessionRepo domain.SessionRepository, logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			var tokenValue string
			if cookie, err := r.Cookie(sessionCookieName); err == nil && cookie.Value != "" {
				tokenValue = cookie.Value
			} else {
				authHeader := r.Header.Get("Authorization")
				if strings.HasPrefix(authHeader, "Bearer ") {
					tokenValue = strings.TrimPrefix(authHeader, "Bearer ")
				}
			}

			if tokenValue != "" {
				if tokenBytes, err := hex.DecodeString(tokenValue); err == nil {
					hash := sha256.Sum256(tokenBytes)
					tokenHash := hex.EncodeToString(hash[:])
					if session, err := sessionRepo.GetByTokenHash(r.Context(), tokenHash); err == nil && session != nil {
						now := time.Now().Unix()
						if session.RevokedAt == nil && now < session.ExpiresAt {
							ctx := domain.WithUserID(r.Context(), session.UserID)
							ctx = domain.WithSessionID(ctx, session.ID)
							next.ServeHTTP(w, r.WithContext(ctx))
							return
						}
					}
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// writeAuthError writes the uniform 401 response.
// RFC-0004 §8.3: Connections failing check MUST be dropped with 401 Unauthorized.
func writeAuthError(w http.ResponseWriter) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	_ = json.NewEncoder(w).Encode(sessionAuthErrorResponse{
		Error: sessionAuthErrorDetail{
			Code:    authFailCode,
			Message: authFailMsg,
		},
	})
}
