package middleware

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"strings"

	"rootinbox/internal/config"
	"rootinbox/internal/domain"
)

// RealIP returns middleware that extracts the true client IP and computes its HMAC hash.
// Implements ADR-P10-14 (RealIP Extraction) and ADR-P10-15 (HMAC IP Hash).
func RealIP(cfg *config.Config) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ip := extractIP(r, cfg.Security.TrustedProxiesCIDR, cfg.Security.InsecureDevMode)
			ipHash := computeIPHash(ip, cfg.Security.IPHashSecret.Reveal())

			ctx := domain.WithClientIP(r.Context(), ip)
			ctx = domain.WithIPHash(ctx, ipHash)

			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func extractIP(r *http.Request, trustedProxies []*net.IPNet, insecureDevMode bool) net.IP {
	if insecureDevMode {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			if len(parts) > 0 {
				ip := net.ParseIP(strings.TrimSpace(parts[0]))
				if ip != nil {
					return ip
				}
			}
		}
	}

	remoteIP, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		remoteIP = r.RemoteAddr
	}
	ip := net.ParseIP(remoteIP)

	if len(trustedProxies) > 0 {
		isTrusted := false
		for _, cidr := range trustedProxies {
			if cidr.Contains(ip) {
				isTrusted = true
				break
			}
		}

		if isTrusted {
			if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
				parts := strings.Split(xff, ",")
				for i := len(parts) - 1; i >= 0; i-- {
					candidate := net.ParseIP(strings.TrimSpace(parts[i]))
					if candidate == nil {
						continue
					}
					isCandidateTrusted := false
					for _, cidr := range trustedProxies {
						if cidr.Contains(candidate) {
							isCandidateTrusted = true
							break
						}
					}
					if !isCandidateTrusted {
						return candidate
					}
				}
			}
		}
	}

	return ip
}

func computeIPHash(ip net.IP, secret []byte) string {
	if ip == nil {
		ip = net.IPv4(0, 0, 0, 0)
	}
	h := hmac.New(sha256.New, secret)
	h.Write(ip)
	return hex.EncodeToString(h.Sum(nil))
}
