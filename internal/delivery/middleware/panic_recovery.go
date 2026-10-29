// Package middleware provides HTTP middleware for the delivery layer.
// RFC-0001 Section 2: delivery/middleware/ — Panic Recovery, Request Logger, etc.
package middleware

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"runtime/debug"

	"rootinbox/internal/domain"
)

// PanicRecovery returns middleware that recovers from panics in HTTP handlers.
// RFC-0001 Section 4: MUST capture panics, preserve TraceID, log the stack trace
// internally, and return a sanitized SYS_500 JSON. Never leak internals.
// RFC-0001A Section 6: Panics MUST NOT cross package boundaries.
func PanicRecovery(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			defer func() {
				if rec := recover(); rec != nil {
					traceID := domain.TraceIDFromContext(r.Context())
					stack := debug.Stack()

					// Log panic with full context internally.
					// RFC-0001 Section 4: Log the stack trace internally.
					logger.Error("panic recovered",
						"trace_id", traceID,
						"panic", rec,
						"stack", string(stack),
						"method", r.Method,
						"path", r.URL.Path,
					)

					// RFC-0001 Section 4: Return sanitized SYS_500 JSON.
					// Never leak internals.
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusInternalServerError)
					_ = json.NewEncoder(w).Encode(errorResponse{
						Error: errorDetail{
							Code:    string(domain.ErrSys500),
							Message: "internal server error",
						},
					})
				}
			}()
			next.ServeHTTP(w, r)
		})
	}
}

// errorResponse is the sanitized error response format.
type errorResponse struct {
	Error errorDetail `json:"error"`
}

type errorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}
