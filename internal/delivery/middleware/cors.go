package middleware

import (
	"bufio"
	"net"
	"net/http"

	"rootinbox/internal/domain"
)

// CORSStripper middleware removes any ambient CORS headers.
// Implements ADR-P10-13.
func CORSStripper() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			cw := &corsStrippingWriter{ResponseWriter: w}
			next.ServeHTTP(cw, r)
		})
	}
}

// corsStrippingWriter wraps http.ResponseWriter to strip CORS headers.
// It implements http.Hijacker so gorilla/websocket can upgrade the connection.
type corsStrippingWriter struct {
	http.ResponseWriter
}

func (w *corsStrippingWriter) Header() http.Header {
	h := w.ResponseWriter.Header()
	h.Del("Access-Control-Allow-Origin")
	h.Del("Access-Control-Allow-Methods")
	h.Del("Access-Control-Allow-Headers")
	h.Del("Access-Control-Allow-Credentials")
	h.Del("Access-Control-Expose-Headers")
	h.Del("Access-Control-Max-Age")
	return h
}

func (w *corsStrippingWriter) WriteHeader(statusCode int) {
	w.Header() // Ensure stripping happens
	w.ResponseWriter.WriteHeader(statusCode)
}

// Hijack delegates to the underlying ResponseWriter if it implements http.Hijacker.
func (w *corsStrippingWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := w.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, domain.NewDomainError(domain.ErrSys001, "webserver doesn't support hijacking", nil)
}
