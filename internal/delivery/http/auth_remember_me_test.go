package http

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSetSessionCookie_RememberMe(t *testing.T) {
	t.Run("rememberMe true sets MaxAge", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/verify", nil)

		setSessionCookie(rec, req, "test-token-123", true)

		cookies := rec.Result().Cookies()
		if len(cookies) == 0 {
			t.Fatal("expected session cookie to be set")
		}

		c := cookies[0]
		if c.Name != cookieName {
			t.Fatalf("expected cookie name %s, got %s", cookieName, c.Name)
		}
		if c.MaxAge != cookieMaxAge {
			t.Fatalf("expected MaxAge %d, got %d", cookieMaxAge, c.MaxAge)
		}

		rawSetCookie := rec.Header().Get("Set-Cookie")
		if !strings.Contains(rawSetCookie, "Max-Age=604800") {
			t.Fatalf("expected Set-Cookie header to contain Max-Age=604800, got: %s", rawSetCookie)
		}
	})

	t.Run("rememberMe false sets session-only cookie without Max-Age", func(t *testing.T) {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/verify", nil)

		setSessionCookie(rec, req, "test-token-456", false)

		cookies := rec.Result().Cookies()
		if len(cookies) == 0 {
			t.Fatal("expected session cookie to be set")
		}

		c := cookies[0]
		if c.Name != cookieName {
			t.Fatalf("expected cookie name %s, got %s", cookieName, c.Name)
		}
		if c.MaxAge != 0 {
			t.Fatalf("expected MaxAge 0, got %d", c.MaxAge)
		}

		rawSetCookie := rec.Header().Get("Set-Cookie")
		if strings.Contains(rawSetCookie, "Max-Age=") {
			t.Fatalf("expected Set-Cookie header NOT to contain Max-Age, got: %s", rawSetCookie)
		}
		if strings.Contains(rawSetCookie, "Expires=") {
			t.Fatalf("expected Set-Cookie header NOT to contain Expires, got: %s", rawSetCookie)
		}
	})
}
