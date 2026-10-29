package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"rootinbox/internal/delivery/middleware"
)

// T-CORS-1: WebSocket Origin stripping prevention (and CORS stripping in general).
func TestCORSStripper(t *testing.T) {
	handler := middleware.CORSStripper()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Verify that the request's Origin header is intact for the handler
		// (this is what the WS upgrader uses for CheckOrigin)
		if r.Header.Get("Origin") != "https://example.com" {
			t.Errorf("expected Origin header to be intact, got %s", r.Header.Get("Origin"))
		}

		// The handler tries to set CORS response headers
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET")
		w.Header().Set("Other-Header", "kept")
		w.WriteHeader(http.StatusOK)
	}))

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Origin", "https://example.com")
	
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	if rec.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Errorf("expected Access-Control-Allow-Origin to be stripped")
	}
	if rec.Header().Get("Access-Control-Allow-Methods") != "" {
		t.Errorf("expected Access-Control-Allow-Methods to be stripped")
	}
	if rec.Header().Get("Other-Header") != "kept" {
		t.Errorf("expected Other-Header to be kept")
	}
}
