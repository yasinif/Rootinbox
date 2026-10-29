package middleware

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSecurityHeaders_T_HDR_1(t *testing.T) {
	// T-HDR-1: SecurityHeaders applies strict transport and content options.
	mw := SecurityHeaders()
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	headers := map[string]string{
		"Strict-Transport-Security": "max-age=63072000; includeSubDomains",
		"X-Content-Type-Options":    "nosniff",
		"X-Frame-Options":           "DENY",
	}

	for k, v := range headers {
		if got := w.Header().Get(k); got != v {
			t.Errorf("expected header %s=%s, got %s", k, v, got)
		}
	}

	csp := w.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "style-src 'self' 'unsafe-inline'") {
		t.Errorf("expected CSP to contain style-src 'self' 'unsafe-inline', got %s", csp)
	}
	t.Log("T-HDR-1 verified")
}
