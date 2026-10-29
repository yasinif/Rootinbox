package middleware

import (
	"context"
	"net/http"
	"time"

	"github.com/google/uuid"

	"rootinbox/internal/domain"
)

type RateLimiter interface {
	Allow(ctx context.Context, routeClass domain.RouteClass, ipHash string, userID string) bool
}

// WithRouteClass attaches a RouteClass to the request context.
func WithRouteClass(class domain.RouteClass) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ctx := domain.WithRouteClass(r.Context(), class)
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

// RateLimit enforces rate limits and IP blocking.
func RateLimit(limiter RateLimiter, auditor domain.SecurityAuditor) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			ipHash, _ := domain.IPHashFromContext(r.Context())
			userID, _ := domain.UserIDFromContext(r.Context())
			routeClass, ok := domain.RouteClassFromContext(r.Context())
			if !ok {
				// Default to general if not set
				routeClass = domain.RouteClassRestGeneral
			}



			if !limiter.Allow(r.Context(), routeClass, ipHash, userID) {
				// Emit async audit event
				if auditor != nil {
					traceID := domain.TraceIDFromContext(r.Context())
					var uid *string
					if userID != "" {
						uid = &userID
					}
					var iph *string
					if ipHash != "" {
						iph = &ipHash
					}
					var tid *string
					if traceID != "" {
						tid = &traceID
					}
					auditor.Emit(domain.SecurityEvent{
						ID:           uuid.New().String(),
						EventType:    domain.EventRateLimitTripped,
						IdentityHash: uid,
						IPHash:       iph,
						TraceID:      tid,
						CreatedAt:    time.Now().Unix(),
					})
				}
				w.Header().Set("Retry-After", "60")
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				w.Write([]byte(`{"error":{"code":"` + string(domain.ErrSec001) + `","message":"rate limit exceeded"}}`))
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
