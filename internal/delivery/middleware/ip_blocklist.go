package middleware

import (
	"encoding/json"
	"net/http"

	"rootinbox/internal/domain"
)

// IPBlockCache defines the interface for the IP block cache.
type IPBlockCache interface {
	IsBlocked(ipHash string) bool
}

// IPBlocklist enforces the IP blocklist before AdminAuth.
func IPBlocklist(cache IPBlockCache, auditor domain.SecurityAuditor) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ipHash, ok := domain.IPHashFromContext(r.Context())
			if ok && cache.IsBlocked(ipHash) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				json.NewEncoder(w).Encode(map[string]interface{}{
					"error": map[string]string{
						"code":    string(domain.ErrAdm001),
						"message": "IP is blocked",
					},
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
