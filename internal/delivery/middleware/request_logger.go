package middleware

import (
	"bufio"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/google/uuid"

	"rootinbox/internal/domain"
)

// RequestLogger returns middleware that logs every HTTP request with structured fields.
// RFC-0001 Section 4: Standardize fields: TraceID, Method, Path, Status, Latency,
// RequestSize, ResponseSize, UserID, IPHash.
func RequestLogger(logger *slog.Logger) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()

			// Generate or propagate TraceID.
			traceID := r.Header.Get("X-Trace-ID")
			if traceID == "" {
				traceID = uuid.New().String()
			}

			// RFC-0001A Section 3: Store TraceID in context.
			ctx := domain.WithTraceID(r.Context(), traceID)
			r = r.WithContext(ctx)

			// Wrap ResponseWriter to capture status code and response size.
			rw := &responseWriter{ResponseWriter: w, statusCode: http.StatusOK}

			next.ServeHTTP(rw, r)

			latency := time.Since(start)

			userID, _ := domain.UserIDFromContext(ctx)
			ipHash, _ := domain.IPHashFromContext(ctx)

			// RFC-0001 Section 4: Structured logging fields.
			logger.Info("http request",
				"trace_id", traceID,
				"method", r.Method,
				"path", r.URL.Path,
				"status", rw.statusCode,
				"latency", latency.String(),
				"request_size", r.ContentLength,
				"response_size", rw.bytesWritten,
				"user_id", userID,
				"ip_hash", ipHash,
			)
		})
	}
}

// responseWriter wraps http.ResponseWriter to capture status code and bytes written.
type responseWriter struct {
	http.ResponseWriter
	statusCode   int
	bytesWritten int64
}

// WriteHeader captures the status code.
func (rw *responseWriter) WriteHeader(code int) {
	rw.statusCode = code
	rw.ResponseWriter.WriteHeader(code)
}

func (rw *responseWriter) Write(b []byte) (int, error) {
	n, err := rw.ResponseWriter.Write(b)
	rw.bytesWritten += int64(n)
	return n, err
}

// Hijack delegates to the underlying ResponseWriter if it implements http.Hijacker.
func (rw *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := rw.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, domain.NewDomainError(domain.ErrSys001, "webserver doesn't support hijacking", nil)
}
