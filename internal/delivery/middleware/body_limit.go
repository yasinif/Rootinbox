package middleware

import (
	"net/http"
	"strings"

	"rootinbox/internal/domain"
)

// BodyLimit enforces a maximum request body size depending on the context flag.
// Implements ADR-P10-17. Max size is 1MB unless bypassed (like MediaChunk).
func BodyLimit(maxHeaderBytes int64) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if domain.BodyLimitAppliedFromContext(r.Context()) || strings.HasPrefix(r.URL.Path, "/api/v1/media/upload/") {
				// A more specific body limit has already been applied (e.g. Media Chunk: 5,242,896 bytes)
				next.ServeHTTP(w, r)
				return
			}

			// Apply global ceiling (e.g., 1MB)
			if r.ContentLength > maxHeaderBytes {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusRequestEntityTooLarge)
				w.Write([]byte(`{"error":{"code":"` + string(domain.ErrSec002) + `","message":"request body too large"}}`))
				return
			}
			
			r.Body = http.MaxBytesReader(w, r.Body, maxHeaderBytes)
			next.ServeHTTP(w, r)
		})
	}
}
