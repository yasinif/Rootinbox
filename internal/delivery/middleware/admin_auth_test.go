package middleware

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"testing"

	"rootinbox/internal/config"
)

type mockAuthFail struct{}
func (m *mockAuthFail) ShouldEmit(ctx context.Context, ip string) bool { return true }

func TestAdminAuth_T_ADM_1(t *testing.T) {
	// T-ADM-1: Admin Auth token validation.
	hashBytes := sha256.Sum256([]byte("test-admin-token"))
	cfg := &config.Config{
		Admin: config.AdminConfig{
			AdminTokenHash: hex.EncodeToString(hashBytes[:]),
		},
	}
	mw := AdminAuth(cfg, &mockAuthFail{}, &mockAuditor{})
	handler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// Missing header
	req := httptest.NewRequest(http.MethodPost, "/", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}

	// Correct header
	req = httptest.NewRequest(http.MethodPost, "/", nil)
	req.Header.Set("Authorization", "Bearer test-admin-token")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d", w.Code)
	}

	t.Log("T-ADM-1 verified")
}
