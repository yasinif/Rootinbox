package http

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"rootinbox/internal/domain"
	"rootinbox/internal/usecase"
)

type mockZKVaultRepo struct {
	vaults map[string]*domain.ZKVault
}

func newMockZKVaultRepo() *mockZKVaultRepo {
	return &mockZKVaultRepo{
		vaults: make(map[string]*domain.ZKVault),
	}
}

func (m *mockZKVaultRepo) GetByUserID(ctx context.Context, userID string) (*domain.ZKVault, error) {
	if v, ok := m.vaults[userID]; ok {
		cp := *v
		return &cp, nil
	}
	return nil, domain.NewDomainError(domain.ErrVault003, "zk vault not found", nil)
}

func (m *mockZKVaultRepo) Save(ctx context.Context, vault *domain.ZKVault, expectedVersion int) error {
	existing, ok := m.vaults[vault.UserID]
	if expectedVersion == 0 {
		if ok {
			return domain.NewDomainError(domain.ErrVault001, "vault already exists, conflict on initial write", nil)
		}
		vault.Version = 1
		m.vaults[vault.UserID] = vault
		return nil
	}

	if !ok || existing.Version != expectedVersion {
		return domain.NewDomainError(domain.ErrVault001, "vault version conflict. Expected version did not match current version.", nil)
	}

	vault.Version = expectedVersion + 1
	m.vaults[vault.UserID] = vault
	return nil
}

type testUUIDGen struct{}

func (g *testUUIDGen) New() string {
	return "test-uuid-1234"
}

func TestZKVaultHandler(t *testing.T) {
	repo := newMockZKVaultRepo()
	clk := &testClock{}
	uuidG := &testUUIDGen{}
	vUC := usecase.NewVaultUseCase(nil, clk, uuidG, &testLogger{})
	vUC.SetZKVaultRepo(repo)
	handler := NewVaultHandler(vUC)

	testUserID := "user-alice-123"

	withAuth := func(req *http.Request) *http.Request {
		return req.WithContext(domain.WithUserID(req.Context(), testUserID))
	}

	t.Run("Unauthorized request returns 401", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/vault/current", nil)
		rec := httptest.NewRecorder()
		handler.HandleGetZKVault()(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("expected status 401, got %d", rec.Code)
		}
	})

	t.Run("GET non-existent vault returns 404", func(t *testing.T) {
		req := withAuth(httptest.NewRequest(http.MethodGet, "/api/v1/vault/current", nil))
		rec := httptest.NewRecorder()
		handler.HandleGetZKVault()(rec, req)

		if rec.Code != http.StatusNotFound {
			t.Fatalf("expected status 404, got %d: %s", rec.Code, rec.Body.String())
		}
	})

	t.Run("Initial PUT saves version 1 and returns ETag", func(t *testing.T) {
		payload := map[string]any{
			"expected_version": 0,
			"ciphertext":       hex.EncodeToString([]byte("secret-vault-blob-bytes-test")),
			"signature":        "sig11223344",
		}
		bodyBytes, _ := json.Marshal(payload)
		req := withAuth(httptest.NewRequest(http.MethodPut, "/api/v1/vault/current", bytes.NewReader(bodyBytes)))
		rec := httptest.NewRecorder()
		handler.HandlePutZKVault()(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
		}
		if etag := rec.Header().Get("ETag"); etag != "\"1\"" {
			t.Errorf("expected ETag \"1\", got %s", etag)
		}
	})

	t.Run("GET existing vault returns version 1 with ETag", func(t *testing.T) {
		req := withAuth(httptest.NewRequest(http.MethodGet, "/api/v1/vault/current", nil))
		rec := httptest.NewRecorder()
		handler.HandleGetZKVault()(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
		}
		if etag := rec.Header().Get("ETag"); etag != "\"1\"" {
			t.Errorf("expected ETag \"1\", got %s", etag)
		}

		var resp struct {
			Data struct {
				UserID     string `json:"user_id"`
				Version    int    `json:"version"`
				Ciphertext string `json:"ciphertext"`
				Signature  string `json:"signature"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}
		if resp.Data.Version != 1 {
			t.Errorf("expected version 1, got %d", resp.Data.Version)
		}
		if resp.Data.Signature != "sig11223344" {
			t.Errorf("expected signature sig11223344, got %s", resp.Data.Signature)
		}
	})

	t.Run("PUT with matching If-Match header updates to version 2", func(t *testing.T) {
		payload := map[string]any{
			"ciphertext": hex.EncodeToString([]byte("updated-vault-blob-bytes")),
			"signature":  "sig55667788",
		}
		bodyBytes, _ := json.Marshal(payload)
		req := withAuth(httptest.NewRequest(http.MethodPut, "/api/v1/vault/current", bytes.NewReader(bodyBytes)))
		req.Header.Set("If-Match", "\"1\"")
		rec := httptest.NewRecorder()
		handler.HandlePutZKVault()(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
		}
		if etag := rec.Header().Get("ETag"); etag != "\"2\"" {
			t.Errorf("expected ETag \"2\", got %s", etag)
		}
	})

	t.Run("PUT with stale If-Match returns 409 Conflict", func(t *testing.T) {
		payload := map[string]any{
			"ciphertext": hex.EncodeToString([]byte("stale-update")),
			"signature":  "sig9999",
		}
		bodyBytes, _ := json.Marshal(payload)
		req := withAuth(httptest.NewRequest(http.MethodPut, "/api/v1/vault/current", bytes.NewReader(bodyBytes)))
		req.Header.Set("If-Match", "\"1\"") // Server is now at version 2
		rec := httptest.NewRecorder()
		handler.HandlePutZKVault()(rec, req)

		if rec.Code != http.StatusConflict {
			t.Fatalf("expected status 409 Conflict, got %d: %s", rec.Code, rec.Body.String())
		}
	})
}
