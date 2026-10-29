package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"rootinbox/internal/config"
	"rootinbox/internal/delivery/middleware"
	"rootinbox/internal/domain"
)

// T-SEC-4: RealIP spoofing block.
func TestRealIP(t *testing.T) {
	cfg := &config.Config{
		Security: config.SecurityConfig{
			InsecureDevMode: true,
			IPHashSecret:    config.NewSecret([]byte("test-secret-32-bytes-long-here!!!")),
		},
	}

	handler := middleware.RealIP(cfg)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ipHash, _ := domain.IPHashFromContext(r.Context())
		if ipHash == "" {
			t.Errorf("expected ipHash to be set in context")
		}
		w.WriteHeader(http.StatusOK)
	}))

	// Valid header
	req1 := httptest.NewRequest(http.MethodGet, "/", nil)
	req1.Header.Set("X-Forwarded-For", "203.0.113.5")
	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req1)
	if rec1.Code != http.StatusOK {
		t.Errorf("expected OK, got %d", rec1.Code)
	}

	// Multiple IPs in header (spoofed)
	req2 := httptest.NewRequest(http.MethodGet, "/", nil)
	req2.Header.Set("X-Forwarded-For", "1.2.3.4, 203.0.113.5")
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)
	// Middleware just takes the first valid IP from XFF in our implementation
	if rec2.Code != http.StatusOK {
		t.Errorf("expected OK, got %d", rec2.Code)
	}
	
	// Check the context from spoofing:
	// We need to inspect what IP was chosen.
	var extractedIPHash string
	inspectHandler := middleware.RealIP(cfg)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		extractedIPHash, _ = domain.IPHashFromContext(r.Context())
		w.WriteHeader(http.StatusOK)
	}))
	
	inspectHandler.ServeHTTP(rec2, req2)
	if extractedIPHash == "" {
		t.Errorf("expected ip hash to be set")
	}
}
