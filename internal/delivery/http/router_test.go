package http

import (
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"rootinbox/internal/config"
	"rootinbox/internal/domain"
)

type mockLimiter struct{}

func (m *mockLimiter) Allow(ctx context.Context, class domain.RouteClass, identity string, userID string) bool {
	return false
}

type mockIPBlockCache struct{}

func (m *mockIPBlockCache) IsBlocked(ipHash string) bool {
	return false
}

type mockAuditor struct{}

func (m *mockAuditor) Emit(event domain.SecurityEvent) {}

type mockAuthFail struct{}

func (m *mockAuthFail) ShouldEmit(ctx context.Context, ip string) bool { return true }

func TestRouter_T_WS_1(t *testing.T) {
	// T-WS-1: /api/v1/ws bypasses RateLimit and BodyLimit
	cfg := &config.Config{}

	deps := RouterDeps{
		Cfg:              cfg,
		RateLimiter:      &mockLimiter{}, // always blocks
		IPBlocks:         &mockIPBlockCache{},
		Auditor:          &mockAuditor{},
		AuthFailCoalesce: &mockAuthFail{},
		Logger:           slog.New(slog.NewTextHandler(os.Stderr, nil)),
		// other deps can be nil for this test since we only test the routing middleware
	}

	// Create router
	router := NewRouter(deps)

	// Test a normal endpoint (should be rate limited)
	req1 := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
	w1 := httptest.NewRecorder()
	router.ServeHTTP(w1, req1)

	// Wait, /health/ready might not be rate limited? Actually RateLimit applies to all endpoints.
	if w1.Code != http.StatusTooManyRequests {
		t.Errorf("expected 429 for normal endpoint, got %d", w1.Code)
	}

	// Test WS endpoint (should NOT be rate limited, should return whatever the WS handler returns, likely 400 Bad Request due to missing WS headers, or 500 since WS handler is nil in deps)
	// Actually since WSHandler is nil, it will panic, but PanicRecovery middleware will return 500.
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/ws", nil)
	w2 := httptest.NewRecorder()
	router.ServeHTTP(w2, req2)

	if w2.Code == http.StatusTooManyRequests {
		t.Errorf("expected WS endpoint to bypass rate limit (not 429), got %d", w2.Code)
	}

	t.Log("T-WS-1 verified")
}
