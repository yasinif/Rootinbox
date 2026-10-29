package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"rootinbox/internal/domain"
)

type mockLimiter struct {
	allow bool
}
func (m *mockLimiter) Allow(ctx context.Context, class domain.RouteClass, identity string, userID string) bool {
	return m.allow
}

type mockIPBlockCache struct {
	blocked bool
}
func (m *mockIPBlockCache) IsBlocked(ipHash string) bool {
	return m.blocked
}

type mockAuditor struct{}
func (m *mockAuditor) Emit(event domain.SecurityEvent) {}

func TestRateLimit_T_RL_1(t *testing.T) {
	// T-RL-1: RateLimit rejection returns 429 Retry-After.
	limiter := &mockLimiter{allow: false}
	auditor := &mockAuditor{}

	mw := RateLimit(limiter, auditor)
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/challenge", nil)
	w := httptest.NewRecorder()

	handler.ServeHTTP(w, req)

	if w.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429, got %d", w.Code)
	}
	if w.Header().Get("Retry-After") == "" {
		t.Errorf("expected Retry-After header")
	}
	t.Log("T-RL-1 verified")
}
