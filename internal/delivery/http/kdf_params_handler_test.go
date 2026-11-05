package http

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"golang.org/x/crypto/hkdf"

	"rootinbox/internal/domain"
	"rootinbox/internal/usecase"
)

func strPtr(s string) *string {
	return &s
}

func TestHandleKDFParams(t *testing.T) {
	userRepo := newMockUserRepo()
	knownSalt := "4a7bc901e23f00001122334455667788"
	knownAuthPK := "abcdef112233445566778899aabbccddeeff00112233445566778899aabbccdd"
	knownUser := &domain.User{
		ID:             "user-1",
		IdentityHash:   "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		PublicKey:      knownAuthPK,
		Username:       strPtr("alice"),
		AuthPubkey:     &knownAuthPK,
		KDFSalt:        &knownSalt,
		KDFMemoryKiB:   32768,
		KDFIterations:  4,
		KDFParallelism: 1,
		Status:         domain.UserStatusActive,
	}
	_ = userRepo.Create(context.Background(), knownUser)

	authUC := usecase.NewAuthUseCase(userRepo, nil, nil, nil, nil, nil, nil, &testLogger{}, nil)
	authUC.SetServerSaltSecret([]byte("test-anti-enumeration-secret-1234"))
	handler := NewAuthHandler(authUC)

	t.Run("Known user returns real salt and parameters", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/kdf-params?username=alice", nil)
		rec := httptest.NewRecorder()
		handler.HandleKDFParams()(rec, req)

		if rec.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d: %s", rec.Code, rec.Body.String())
		}

		var resp struct {
			Data struct {
				Salt        string `json:"salt"`
				Iterations  int    `json:"iterations"`
				MemoryKiB   int    `json:"memory_kib"`
				Parallelism int    `json:"parallelism"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}

		if resp.Data.Salt != knownSalt {
			t.Errorf("expected salt %s, got %s", knownSalt, resp.Data.Salt)
		}
		if resp.Data.Iterations != 4 {
			t.Errorf("expected iterations 4, got %d", resp.Data.Iterations)
		}
		if resp.Data.MemoryKiB != 32768 {
			t.Errorf("expected memory_kib 32768, got %d", resp.Data.MemoryKiB)
		}
		if resp.Data.Parallelism != 1 {
			t.Errorf("expected parallelism 1, got %d", resp.Data.Parallelism)
		}
	})

	t.Run("Unknown user returns deterministic fake salt", func(t *testing.T) {
		req1 := httptest.NewRequest(http.MethodGet, "/api/v1/auth/kdf-params?username=bob_nonexistent", nil)
		rec1 := httptest.NewRecorder()
		handler.HandleKDFParams()(rec1, req1)

		if rec1.Code != http.StatusOK {
			t.Fatalf("expected status 200, got %d: %s", rec1.Code, rec1.Body.String())
		}

		var resp1 struct {
			Data struct {
				Salt        string `json:"salt"`
				Iterations  int    `json:"iterations"`
				MemoryKiB   int    `json:"memory_kib"`
				Parallelism int    `json:"parallelism"`
			} `json:"data"`
		}
		if err := json.Unmarshal(rec1.Body.Bytes(), &resp1); err != nil {
			t.Fatalf("failed to decode response: %v", err)
		}

		if len(resp1.Data.Salt) != 32 { // 16 bytes hex-encoded = 32 hex chars
			t.Errorf("expected 32 hex char fake salt, got length %d: %s", len(resp1.Data.Salt), resp1.Data.Salt)
		}

		// Verify that fake salt matches HKDF derivation with "rootinbox/kdf-fake-salt/v1:" + canonical
		expectedBuf := make([]byte, 16)
		kdfR := hkdf.Expand(sha256.New, []byte("test-anti-enumeration-secret-1234"), []byte("rootinbox/kdf-fake-salt/v1:bob_nonexistent"))
		if _, err := io.ReadFull(kdfR, expectedBuf); err != nil {
			t.Fatalf("failed to derive expected hkdf: %v", err)
		}
		expectedHex := hex.EncodeToString(expectedBuf)
		if resp1.Data.Salt != expectedHex {
			t.Errorf("expected fake salt %s, got %s", expectedHex, resp1.Data.Salt)
		}

		// Query again for bob_nonexistent to assert deterministic fake salt
		req2 := httptest.NewRequest(http.MethodGet, "/api/v1/auth/kdf-params?username=bob_nonexistent", nil)
		rec2 := httptest.NewRecorder()
		handler.HandleKDFParams()(rec2, req2)

		var resp2 struct {
			Data struct {
				Salt string `json:"salt"`
			} `json:"data"`
		}
		_ = json.Unmarshal(rec2.Body.Bytes(), &resp2)

		if resp1.Data.Salt != resp2.Data.Salt {
			t.Errorf("expected deterministic fake salt for identical unknown username, got %s vs %s", resp1.Data.Salt, resp2.Data.Salt)
		}
	})

	t.Run("Server salt secret missing returns SYS_001", func(t *testing.T) {
		unconfiguredUC := usecase.NewAuthUseCase(userRepo, nil, nil, nil, nil, nil, nil, &testLogger{}, nil)
		unconfiguredHandler := NewAuthHandler(unconfiguredUC)

		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/kdf-params?username=bob_nonexistent", nil)
		rec := httptest.NewRecorder()
		unconfiguredHandler.HandleKDFParams()(rec, req)

		var errResp struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(rec.Body.Bytes(), &errResp)

		if errResp.Error.Code != "SYS_001" {
			t.Fatalf("expected error code SYS_001, got %s (status %d): %s", errResp.Error.Code, rec.Code, rec.Body.String())
		}
	})

	t.Run("Missing username returns 400 Bad Request", func(t *testing.T) {
		req := httptest.NewRequest(http.MethodGet, "/api/v1/auth/kdf-params", nil)
		rec := httptest.NewRecorder()
		handler.HandleKDFParams()(rec, req)

		if rec.Code != http.StatusBadRequest {
			t.Fatalf("expected status 400, got %d", rec.Code)
		}
	})
}
