package middleware

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"

	"rootinbox/internal/config"
	"rootinbox/internal/domain"
)

// AdminAuth is a middleware that enforces admin authentication.
// It reads the Bearer token from the Authorization header and verifies it
// against the configured AdminTokenHash using a constant-time comparison.
func AdminAuth(cfg *config.Config, authFailCoalesce interface{ ShouldEmit(context.Context, string) bool }, auditor domain.SecurityAuditor) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" || !strings.HasPrefix(authHeader, "Bearer ") {
				failAuth(w, r, authFailCoalesce, auditor)
				return
			}

			token := strings.TrimPrefix(authHeader, "Bearer ")
			tokenHash := sha256.Sum256([]byte(token))

			// Decode expected hash
			expectedHash, err := hex.DecodeString(cfg.Admin.AdminTokenHash)
			if err != nil {
				failAuth(w, r, authFailCoalesce, auditor)
				return
			}

			// Constant-time comparison
			if subtle.ConstantTimeCompare(tokenHash[:], expectedHash) != 1 {
				// To prevent timing attacks, we still do the hashing above regardless.
				failAuth(w, r, authFailCoalesce, auditor)
				return
			}

			// Success
			next.ServeHTTP(w, r)
		})
	}
}

func failAuth(w http.ResponseWriter, r *http.Request, authFailCoalesce interface{ ShouldEmit(context.Context, string) bool }, auditor domain.SecurityAuditor) {
	// Emit audit event conditionally via coalesce
	ipHash, _ := domain.IPHashFromContext(r.Context())
	
	if auditor != nil && (authFailCoalesce == nil || authFailCoalesce.ShouldEmit(r.Context(), ipHash)) {
		traceID := domain.TraceIDFromContext(r.Context())
		var iph, tid *string
		if ipHash != "" {
			iph = &ipHash
		}
		if traceID != "" {
			tid = &traceID
		}
		
		auditor.Emit(domain.SecurityEvent{
			ID:        uuid.New().String(),
			EventType: domain.EventAuthFailure,
			IPHash:    iph,
			TraceID:   tid,
			CreatedAt: time.Now().Unix(),
		})
	}
	
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnauthorized)
	w.Write([]byte(`{"error":{"code":"` + string(domain.ErrAdm001) + `","message":"admin authentication failed"}}`))
}
