package middleware

import (
	"net/http"
	"strings"
)

// SecurityHeaders adds standard security headers to every response.
// Implements ADR-P10-16 + RFC-0010 §8.1 (CSP).
func SecurityHeaders() func(http.Handler) http.Handler {
	// RFC-0010 §8.1: Content Security Policy directive table.
	// 'wasm-unsafe-eval' is required for the libsodium-wrappers WASM fallback (RFC-0003).
	// worker-src 'self' is required for the Crypto Worker.
	// connect-src 'self' enforces single-binary deployment (no external API calls).
	csp := strings.Join([]string{
		"default-src 'self'",
		"script-src 'self' 'wasm-unsafe-eval'",
		"style-src 'self' 'unsafe-inline'",
		"connect-src 'self'",
		"worker-src 'self'",
		"media-src 'self' blob:",
		"img-src 'self' blob: data:",
		"font-src 'self'",
		"object-src 'none'",
		"base-uri 'none'",
		"frame-ancestors 'none'",
		"form-action 'self'",
	}, "; ")

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("X-Frame-Options", "DENY")
			w.Header().Set("Strict-Transport-Security", "max-age=63072000; includeSubDomains")
			w.Header().Set("Content-Security-Policy", csp)
			// COEP require-corp (Phase 10 security hardening).
			w.Header().Set("Cross-Origin-Embedder-Policy", "require-corp")
			w.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
			next.ServeHTTP(w, r)
		})
	}
}

