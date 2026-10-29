package middleware

import (
	"net/http"

	"github.com/google/uuid"

	"rootinbox/internal/domain"
)

// TraceID injects a unique trace ID into every request context.
// Implements ADR-P10-3: Unified Trace ID injection.
func TraceID() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			traceID := uuid.New().String()
			ctx := domain.WithTraceID(r.Context(), traceID)
			w.Header().Set("X-Trace-ID", traceID)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
