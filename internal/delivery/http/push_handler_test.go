package http

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"rootinbox/internal/domain"
)

// testVAPIDKeyProvider is a test-only VAPIDKeyProvider.
type testVAPIDKeyProvider struct {
	pub  string // Base64URL unpadded
	priv string
}

func (p *testVAPIDKeyProvider) PublicKeyBase64URL() string  { return p.pub }
func (p *testVAPIDKeyProvider) PrivateKeyBase64URL() string { return p.priv }

// generate65ByteKey returns a valid 65-byte uncompressed P-256 public key (0x04 prefix + 64 bytes).
func generate65ByteKey() ([]byte, string) {
	key := make([]byte, 65)
	key[0] = 0x04
	for i := 1; i < 65; i++ {
		key[i] = byte(i)
	}
	return key, base64.RawURLEncoding.EncodeToString(key)
}

func TestHandleVapidPublicKey_200_ValidKey(t *testing.T) {
	rawKey, b64Key := generate65ByteKey()
	provider := &testVAPIDKeyProvider{pub: b64Key}
	handler := NewPushHandler(nil, provider, true)

	req := httptest.NewRequest("GET", "/api/v1/push/vapid-public-key", nil)
	// Simulate authenticated session by injecting user_id into context.
	ctx := domain.WithUserID(req.Context(), "user-123")
	req = req.WithContext(ctx)

	rr := httptest.NewRecorder()
	handler.HandleVapidPublicKey()(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp SuccessResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	data, ok := resp.Data.(map[string]interface{})
	if !ok {
		t.Fatalf("data is not a map: %T", resp.Data)
	}

	publicKey, ok := data["public_key"].(string)
	if !ok {
		t.Fatalf("public_key is not a string")
	}

	// Decode and verify round-trip.
	decoded, err := base64.RawURLEncoding.DecodeString(publicKey)
	if err != nil {
		t.Fatalf("decode public_key: %v", err)
	}
	if len(decoded) != 65 {
		t.Fatalf("expected 65 bytes, got %d", len(decoded))
	}
	if decoded[0] != 0x04 {
		t.Fatalf("expected first byte 0x04, got 0x%02x", decoded[0])
	}
	for i, b := range decoded {
		if b != rawKey[i] {
			t.Fatalf("byte %d: expected 0x%02x, got 0x%02x", i, rawKey[i], b)
		}
	}
}

func TestHandleVapidPublicKey_Sequential_ByteIdentical(t *testing.T) {
	_, b64Key := generate65ByteKey()
	provider := &testVAPIDKeyProvider{pub: b64Key}
	handler := NewPushHandler(nil, provider, true)

	bodies := make([]string, 2)
	for i := range bodies {
		req := httptest.NewRequest("GET", "/api/v1/push/vapid-public-key", nil)
		ctx := domain.WithUserID(req.Context(), "user-123")
		req = req.WithContext(ctx)
		rr := httptest.NewRecorder()
		handler.HandleVapidPublicKey()(rr, req)
		if rr.Code != http.StatusOK {
			t.Fatalf("call %d: expected 200, got %d", i, rr.Code)
		}
		bodies[i] = rr.Body.String()
	}

	if bodies[0] != bodies[1] {
		t.Fatalf("sequential calls returned different bodies:\n%s\nvs\n%s", bodies[0], bodies[1])
	}
}

func TestHandleVapidPublicKey_NoCookie_401(t *testing.T) {
	_, b64Key := generate65ByteKey()
	provider := &testVAPIDKeyProvider{pub: b64Key}
	handler := NewPushHandler(nil, provider, true)

	// No WithUserID in context → no cookie/session.
	req := httptest.NewRequest("GET", "/api/v1/push/vapid-public-key", nil)
	rr := httptest.NewRecorder()
	handler.HandleVapidPublicKey()(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp ErrorResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Error.Code != "AUTH_001" {
		t.Fatalf("expected AUTH_001, got %s", resp.Error.Code)
	}
}

func TestHandleVapidPublicKey_PushDisabled_404(t *testing.T) {
	_, b64Key := generate65ByteKey()
	provider := &testVAPIDKeyProvider{pub: b64Key}
	handler := NewPushHandler(nil, provider, false) // pushEnabled = false

	req := httptest.NewRequest("GET", "/api/v1/push/vapid-public-key", nil)
	ctx := domain.WithUserID(req.Context(), "user-123")
	req = req.WithContext(ctx)

	rr := httptest.NewRecorder()
	handler.HandleVapidPublicKey()(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rr.Code, rr.Body.String())
	}

	var resp ErrorResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.Error.Code != "PUSH_001" {
		t.Fatalf("expected PUSH_001, got %s", resp.Error.Code)
	}
}

func TestHandleVapidPublicKey_ZeroDatabaseQueries(t *testing.T) {
	// The handler takes a nil PushUseCase — it MUST NOT call any
	// method on it, proving zero DB access on this path.
	_, b64Key := generate65ByteKey()
	provider := &testVAPIDKeyProvider{pub: b64Key}
	handler := NewPushHandler(nil, provider, true)

	req := httptest.NewRequest("GET", "/api/v1/push/vapid-public-key", nil)
	ctx := domain.WithUserID(req.Context(), "user-123")
	req = req.WithContext(ctx)

	rr := httptest.NewRecorder()
	handler.HandleVapidPublicKey()(rr, req)

	// If it tried to use pushUC (nil), it would panic. Success = no DB call.
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
}

func TestHandleVapidPublicKey_Base64URLUnpadded(t *testing.T) {
	_, b64Key := generate65ByteKey()
	provider := &testVAPIDKeyProvider{pub: b64Key}
	handler := NewPushHandler(nil, provider, true)

	req := httptest.NewRequest("GET", "/api/v1/push/vapid-public-key", nil)
	ctx := domain.WithUserID(req.Context(), "user-123")
	req = req.WithContext(ctx)

	rr := httptest.NewRecorder()
	handler.HandleVapidPublicKey()(rr, req)

	var resp SuccessResponse
	if err := json.NewDecoder(rr.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}

	data := resp.Data.(map[string]interface{})
	publicKey := data["public_key"].(string)

	// Must be RawURLEncoding (no padding).
	for _, c := range publicKey {
		if c == '=' {
			t.Fatalf("public_key contains padding character '=': %s", publicKey)
		}
		if c == '+' || c == '/' {
			t.Fatalf("public_key contains standard Base64 character '%c': %s", c, publicKey)
		}
	}

	// Must decode to exactly 65 bytes.
	decoded, err := base64.RawURLEncoding.DecodeString(publicKey)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(decoded) != 65 {
		t.Fatalf("expected 65 bytes, got %d", len(decoded))
	}
	if decoded[0] != 0x04 {
		t.Fatalf("first byte: expected 0x04, got 0x%02x", decoded[0])
	}
}
