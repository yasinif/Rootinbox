package bootstrap_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"rootinbox/internal/bootstrap"
	"rootinbox/internal/config"
)

// TestZeroConfig_Integration_RailwayEnvOnly verifies that with ONLY Railway-provided
// environment variables (PORT, RAILWAY_ENVIRONMENT, RAILWAY_PUBLIC_DOMAIN, RAILWAY_VOLUME_MOUNT_PATH):
// 1. Server boots successfully and /health/ready returns 200 OK.
// 2. Admin key is printed/bootstrapped once and ONLY the SHA-256 hash is stored in secrets.json.
// 3. WebSocket origin accepts https://<domain> and rejects other origins.
// 4. Server restart retains the same secrets and generates NO second key.
func TestZeroConfig_Integration_RailwayEnvOnly(t *testing.T) {
	tempVolumeDir := t.TempDir()

	domainName := "test-app.up.railway.app"
	expectedOrigin := "https://" + domainName

	// Clear explicit configuration variables to verify true zero-config
	os.Unsetenv("APP_ORIGIN")
	os.Unsetenv("DB_PATH")
	os.Unsetenv("MEDIA_PATH")
	os.Unsetenv("IP_HASH_SECRET")
	os.Unsetenv("TURN_ACTIVE_SECRET")
	os.Unsetenv("ADMIN_TOKEN_HASH")
	os.Unsetenv("ADMIN_API_KEY_HASH_ACTIVE")
	os.Unsetenv("PUSH_ENABLED")
	os.Unsetenv("TRUSTED_PROXIES_CIDR")

	// Set ONLY Railway simulated variables
	t.Setenv("PORT", "8080")
	t.Setenv("RAILWAY_ENVIRONMENT", "production")
	t.Setenv("RAILWAY_PUBLIC_DOMAIN", domainName)
	t.Setenv("RAILWAY_VOLUME_MOUNT_PATH", tempVolumeDir)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 1. First Boot
	app1, err := bootstrap.Run(ctx, "1.0.0", "hash1", "2026-10-29")
	if err != nil {
		t.Fatalf("first bootstrap.Run failed: %v", err)
	}

	// Verify /health/ready returns 200 OK
	req := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
	rr := httptest.NewRecorder()
	app1.HTTPServer.Handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from /health/ready, got %d (body: %s)", rr.Code, rr.Body.String())
	}

	// Verify Admin key bootstrapped once and ONLY hash stored
	firstBootKey := app1.Config.BootstrappedAdminKey
	if firstBootKey == "" {
		t.Fatal("expected one-time admin key on first zero-config boot")
	}

	secretsPath := filepath.Join(tempVolumeDir, config.SecretsFileName)
	secBytes, err := os.ReadFile(secretsPath)
	if err != nil {
		t.Fatalf("failed reading %s: %v", secretsPath, err)
	}
	var storedSec config.PersistedSecrets
	_ = json.Unmarshal(secBytes, &storedSec)

	expectedHash := sha256.Sum256([]byte(firstBootKey))
	if storedSec.AdminTokenHash != hex.EncodeToString(expectedHash[:]) {
		t.Fatalf("stored hash does not match generated admin key")
	}

	// Verify plaintext key does NOT appear in secrets.json
	if strings.Contains(string(secBytes), firstBootKey) {
		t.Fatal("SECURITY VIOLATION: plain admin key was saved to secrets.json!")
	}

	// Verify WebSocket Origin checks: accepts https://<domain> and rejects others
	server := httptest.NewServer(app1.HTTPServer.Handler)
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/api/v1/ws"

	// Test with valid origin (must accept and attempt upgrade)
	headerValid := http.Header{}
	headerValid.Set("Origin", expectedOrigin)
	conn, resp, _ := websocket.DefaultDialer.Dial(wsURL, headerValid)
	if conn != nil {
		_ = conn.Close()
	}
	if resp != nil && resp.StatusCode == http.StatusForbidden {
		t.Fatalf("valid origin %s was unexpectedly rejected", expectedOrigin)
	}

	// Test with invalid origin (must reject with 403 Forbidden)
	headerInvalid := http.Header{}
	headerInvalid.Set("Origin", "https://attacker.evil.com")
	_, respInvalid, _ := websocket.DefaultDialer.Dial(wsURL, headerInvalid)
	if respInvalid == nil || respInvalid.StatusCode != http.StatusForbidden {
		status := 0
		if respInvalid != nil {
			status = respInvalid.StatusCode
		}
		t.Fatalf("expected 403 Forbidden for malicious origin, got: %d", status)
	}

	// Shutdown first app instance cleanly
	_ = app1.Shutdown()

	// 2. Second Boot (Restart simulation)
	app2, err2 := bootstrap.Run(ctx, "1.0.0", "hash1", "2026-10-29")
	if err2 != nil {
		t.Fatalf("second bootstrap.Run failed: %v", err2)
	}
	defer func() { _ = app2.Shutdown() }()

	// Verify secrets were retained across restart
	if hex.EncodeToString(app2.Config.Security.IPHashSecret.Reveal()) != storedSec.IPHashSecret {
		t.Fatalf("IP_HASH_SECRET changed across restart!")
	}
	if app2.Config.TURN.ActiveSecret != storedSec.TURNActiveSecret {
		t.Fatalf("TURN_ACTIVE_SECRET changed across restart!")
	}
	if app2.Config.Admin.AdminTokenHash != storedSec.AdminTokenHash {
		t.Fatalf("AdminTokenHash changed across restart!")
	}

	// Verify NO second admin key was generated on restart
	if app2.Config.BootstrappedAdminKey != "" {
		t.Fatalf("expected no bootstrapped key on restart, got: %s", app2.Config.BootstrappedAdminKey)
	}
}

// TestZeroConfig_Integration_WithoutVolume_Warning verifies that if Railway
// runs without a persistent volume mount, the server logs an ephemeral storage warning.
func TestZeroConfig_Integration_WithoutVolume_Warning(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("PORT", "8080")
	t.Setenv("RAILWAY_ENVIRONMENT", "production")
	t.Setenv("RAILWAY_PUBLIC_DOMAIN", "chat-ephemeral.up.railway.app")
	os.Unsetenv("RAILWAY_VOLUME_MOUNT_PATH")
	t.Setenv("DATA_DIR", filepath.Join(tempDir, "ephemeral"))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	app, err := bootstrap.Run(ctx, "1.0.0", "hash1", "2026-10-29")
	if err != nil {
		t.Fatalf("bootstrap.Run failed: %v", err)
	}
	defer func() { _ = app.Shutdown() }()

	hasWarning := false
	for _, w := range app.Config.Warnings {
		if strings.Contains(w, "Ephemeral storage detected") {
			hasWarning = true
			break
		}
	}
	if !hasWarning {
		t.Fatal("expected ephemeral storage warning when no volume is mounted")
	}
}

// TestZeroConfig_Integration_DBPresent_SecretsDeleted_Refuses tests the critical
// data loss prevention guard: If the database exists with data but secrets.json
// is deleted, the server refuses to boot.
func TestZeroConfig_Integration_DBPresent_SecretsDeleted_Refuses(t *testing.T) {
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "rootinbox.db")
	_ = os.WriteFile(dbPath, []byte("SQLite format 3\x00 dummy database with encrypted rows"), 0644)

	t.Setenv("RAILWAY_ENVIRONMENT", "production")
	t.Setenv("RAILWAY_VOLUME_MOUNT_PATH", tempDir)
	t.Setenv("RAILWAY_PUBLIC_DOMAIN", "chat.up.railway.app")
	os.Unsetenv("IP_HASH_SECRET")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	_, err := bootstrap.Run(ctx, "1.0.0", "hash1", "2026-10-29")
	if err == nil || !strings.Contains(err.Error(), "existing database found") {
		t.Fatalf("expected fatal startup refusal when database exists without secrets, got: %v", err)
	}
}

// TestZeroConfig_Integration_CorruptSecrets_Refuses verifies that a corrupt
// secrets.json prevents booting.
func TestZeroConfig_Integration_CorruptSecrets_Refuses(t *testing.T) {
	tempDir := t.TempDir()
	secretsPath := filepath.Join(tempDir, config.SecretsFileName)
	_ = os.WriteFile(secretsPath, []byte("### NOT JSON ###"), 0600)

	t.Setenv("RAILWAY_ENVIRONMENT", "production")
	t.Setenv("RAILWAY_VOLUME_MOUNT_PATH", tempDir)
	t.Setenv("RAILWAY_PUBLIC_DOMAIN", "chat.up.railway.app")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	_, err := bootstrap.Run(ctx, "1.0.0", "hash1", "2026-10-29")
	if err == nil || !strings.Contains(err.Error(), "corrupt or invalid JSON") {
		t.Fatalf("expected fatal startup refusal for corrupt secrets file, got: %v", err)
	}
}

// TestZeroConfig_Integration_LiveVariableSet_Unchanged verifies Fact F3:
// When explicit live Railway variables are provided (APP_ORIGIN, DB_PATH,
// IP_HASH_SECRET, MEDIA_PATH, PUSH_ENABLED, TRUSTED_PROXIES_CIDR, TURN_ENABLED),
// behavior is 100% unchanged.
func TestZeroConfig_Integration_LiveVariableSet_Unchanged(t *testing.T) {
	tempDir := t.TempDir()
	dbFile := filepath.Join(tempDir, "custom.db")
	mediaDir := filepath.Join(tempDir, "custom_media")

	liveOrigin := "https://custom-domain.com"
	liveIPHash := "abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd"

	t.Setenv("APP_ORIGIN", liveOrigin)
	t.Setenv("DB_PATH", dbFile)
	t.Setenv("MEDIA_PATH", mediaDir)
	t.Setenv("IP_HASH_SECRET", liveIPHash)
	t.Setenv("PUSH_ENABLED", "false")
	t.Setenv("TRUSTED_PROXIES_CIDR", "10.0.0.0/8,172.16.0.0/12")
	t.Setenv("TURN_ENABLED", "false")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	app, err := bootstrap.Run(ctx, "1.0.0", "hash1", "2026-10-29")
	if err != nil {
		t.Fatalf("bootstrap.Run failed with live variable set: %v", err)
	}
	defer func() { _ = app.Shutdown() }()

	if app.Config.Security.AppOrigin != liveOrigin {
		t.Fatalf("expected APP_ORIGIN %s, got %s", liveOrigin, app.Config.Security.AppOrigin)
	}
	if app.Config.Database.Path != dbFile {
		t.Fatalf("expected DB_PATH %s, got %s", dbFile, app.Config.Database.Path)
	}
	if app.Config.Media.BasePath != mediaDir {
		t.Fatalf("expected MEDIA_PATH %s, got %s", mediaDir, app.Config.Media.BasePath)
	}
	if string(app.Config.Security.IPHashSecret.Reveal()) != liveIPHash {
		t.Fatalf("expected explicit IPHashSecret, got %s", string(app.Config.Security.IPHashSecret.Reveal()))
	}
	if app.Config.Push.Enabled {
		t.Fatal("expected PUSH_ENABLED false")
	}
	if app.Config.TURN.Enabled {
		t.Fatal("expected TURN_ENABLED false")
	}
	if len(app.Config.Security.TrustedProxiesCIDR) != 2 {
		t.Fatalf("expected 2 trusted proxy CIDRs, got %d", len(app.Config.Security.TrustedProxiesCIDR))
	}
}

// TestZeroConfig_Integration_WaitingForDomainMode verifies that when on Railway
// without a public domain configured:
// 1. /health/ready returns 200 OK.
// 2. Root route returns minimal read-only page.
// 3. Host header is NOT trusted to pin origin.
func TestZeroConfig_Integration_WaitingForDomainMode(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("PORT", "8080")
	t.Setenv("RAILWAY_ENVIRONMENT", "production")
	t.Setenv("RAILWAY_VOLUME_MOUNT_PATH", tempDir)
	os.Unsetenv("RAILWAY_PUBLIC_DOMAIN")
	os.Unsetenv("APP_ORIGIN")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	app, err := bootstrap.Run(ctx, "1.0.0", "hash1", "2026-10-29")
	if err != nil {
		t.Fatalf("bootstrap.Run failed in waiting-for-domain mode: %v", err)
	}
	defer func() { _ = app.Shutdown() }()

	// 1. /health/ready returns 200 OK
	reqReady := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
	rrReady := httptest.NewRecorder()
	app.HTTPServer.Handler.ServeHTTP(rrReady, reqReady)
	if rrReady.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from /health/ready in waiting-for-domain mode, got: %d", rrReady.Code)
	}

	// 2. Root route returns minimal read-only page
	reqRoot := httptest.NewRequest(http.MethodGet, "/", nil)
	reqRoot.Host = "spoofed-attacker.com"
	reqRoot.Header.Set("Host", "spoofed-attacker.com")

	rrRoot := httptest.NewRecorder()
	app.HTTPServer.Handler.ServeHTTP(rrRoot, reqRoot)

	if rrRoot.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for root page, got %d", rrRoot.Code)
	}
	body, _ := io.ReadAll(rrRoot.Body)
	if !strings.Contains(strings.ToLower(string(body)), "waiting for domain") {
		t.Fatalf("expected waiting for domain message, got: %s", string(body))
	}

	// 3. Ensure AppOrigin was NOT altered by the Host header
	if strings.Contains(app.Config.Security.AppOrigin, "spoofed-attacker.com") {
		t.Fatal("SECURITY VIOLATION: Host header was trusted to set AppOrigin!")
	}
}

// TestZeroConfig_Integration_Z4_PublicHostSelfSigned verifies that on non-Railway,
// setting PUBLIC_HOST without TLS_MODE boots into selfsigned mode with built-in TLS.
func TestZeroConfig_Integration_Z4_PublicHostSelfSigned(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("DATA_DIR", tempDir)
	t.Setenv("DB_PATH", filepath.Join(tempDir, "test.db"))
	t.Setenv("PUBLIC_HOST", "127.0.0.1")
	os.Unsetenv("TLS_MODE")
	os.Unsetenv("PORT")
	os.Unsetenv("SERVER_PORT")
	os.Unsetenv("APP_ORIGIN")
	os.Unsetenv("RAILWAY_ENVIRONMENT")
	os.Unsetenv("RAILWAY_PROJECT_ID")
	os.Unsetenv("RAILWAY_SERVICE_ID")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	app, err := bootstrap.Run(ctx, "1.0.0", "hash1", "2026-10-30")
	if err != nil {
		t.Fatalf("bootstrap.Run failed with only PUBLIC_HOST: %v", err)
	}
	defer func() { _ = app.Shutdown() }()

	if app.Config.TLS.Mode != "selfsigned" {
		t.Fatalf("expected selfsigned TLS mode, got: %s", app.Config.TLS.Mode)
	}
	if app.TLSManager == nil {
		t.Fatal("expected TLSManager to be initialized")
	}

	// Verify health check succeeds
	req := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
	rr := httptest.NewRecorder()
	app.HTTPServer.Handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from /health/ready, got: %d", rr.Code)
	}
}

// TestZeroConfig_Integration_Z4_NothingConfigured_LocalhostOnly verifies that when nothing is configured,
// the server starts, binds to 127.0.0.1 only with InsecureDevMode=true, and serves traffic.
func TestZeroConfig_Integration_Z4_NothingConfigured_LocalhostOnly(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("DATA_DIR", tempDir)
	t.Setenv("DB_PATH", filepath.Join(tempDir, "test.db"))
	os.Unsetenv("PUBLIC_HOST")
	os.Unsetenv("TLS_MODE")
	os.Unsetenv("APP_ORIGIN")
	os.Unsetenv("SERVER_HOST")
	os.Unsetenv("RAILWAY_ENVIRONMENT")
	os.Unsetenv("RAILWAY_PROJECT_ID")
	os.Unsetenv("RAILWAY_SERVICE_ID")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	app, err := bootstrap.Run(ctx, "1.0.0", "hash1", "2026-10-30")
	if err != nil {
		t.Fatalf("bootstrap.Run failed when unconfigured: %v", err)
	}
	defer func() { _ = app.Shutdown() }()

	if app.Config.Server.Host != "127.0.0.1" {
		t.Fatalf("expected 127.0.0.1 host binding, got: %s", app.Config.Server.Host)
	}
	if !app.Config.Security.InsecureDevMode {
		t.Fatal("expected InsecureDevMode to be true")
	}

	// Verify health check
	req := httptest.NewRequest(http.MethodGet, "/health/ready", nil)
	rr := httptest.NewRecorder()
	app.HTTPServer.Handler.ServeHTTP(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from /health/ready, got: %d", rr.Code)
	}
}

// TestZeroConfig_Integration_Z6_AdminWarningsExposure verifies Z6:
// Warnings are exposed only to authenticated admins via GET /api/v1/admin/warnings without secrets.
func TestZeroConfig_Integration_Z6_AdminWarningsExposure(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("DATA_DIR", tempDir)
	t.Setenv("RAILWAY_ENVIRONMENT", "production")
	// No volume attached -> generates ephemeral warning
	os.Unsetenv("RAILWAY_VOLUME_MOUNT_PATH")
	os.Unsetenv("RAILWAY_PUBLIC_DOMAIN")
	os.Unsetenv("APP_ORIGIN")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	app, err := bootstrap.Run(ctx, "1.0.0", "hash1", "2026-10-30")
	if err != nil {
		t.Fatalf("bootstrap.Run failed: %v", err)
	}
	defer func() { _ = app.Shutdown() }()

	adminKey := app.Config.BootstrappedAdminKey
	if adminKey == "" {
		t.Fatal("expected BootstrappedAdminKey to be generated")
	}

	// 1. Unauthenticated request MUST return 401 Unauthorized
	reqUnauth := httptest.NewRequest(http.MethodGet, "/api/v1/admin/warnings", nil)
	rrUnauth := httptest.NewRecorder()
	app.HTTPServer.Handler.ServeHTTP(rrUnauth, reqUnauth)
	if rrUnauth.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 Unauthorized for missing admin key, got: %d", rrUnauth.Code)
	}

	// 2. Authenticated request MUST return 200 OK with warnings
	reqAuth := httptest.NewRequest(http.MethodGet, "/api/v1/admin/warnings", nil)
	reqAuth.Header.Set("Authorization", "Bearer "+adminKey)
	rrAuth := httptest.NewRecorder()
	app.HTTPServer.Handler.ServeHTTP(rrAuth, reqAuth)
	if rrAuth.Code != http.StatusOK {
		t.Fatalf("expected 200 OK for authenticated admin warnings request, got: %d (body: %s)", rrAuth.Code, rrAuth.Body.String())
	}

	var resp struct {
		Data struct {
			Warnings []string `json:"warnings"`
		} `json:"data"`
	}
	if err := json.NewDecoder(rrAuth.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode admin warnings response: %v", err)
	}

	if len(resp.Data.Warnings) == 0 {
		t.Fatal("expected at least one warning (ephemeral storage or domain)")
	}

	// Ensure no secrets leaked in response
	rawResp := rrAuth.Body.String()
	if strings.Contains(rawResp, string(app.Config.Security.IPHashSecret.Reveal())) {
		t.Fatal("SECURITY VIOLATION: IPHashSecret leaked in warnings endpoint!")
	}
}
