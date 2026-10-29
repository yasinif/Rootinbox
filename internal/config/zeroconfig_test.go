package config_test

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"rootinbox/internal/config"
)

// TestZeroConfig_Precedence verifies the Z1 precedence hierarchy:
// explicit env > persisted generated value > platform auto-detection > safe default.
func TestZeroConfig_Precedence(t *testing.T) {
	tempDir := t.TempDir()
	secretsPath := filepath.Join(tempDir, config.SecretsFileName)

	// 1. Create a persisted secret file
	persistedIP := "11111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222"
	persistedData := map[string]interface{}{
		"version":            1,
		"ip_hash_secret":     persistedIP,
		"turn_active_secret": "3333333333333333333333333333333344444444444444444444444444444444",
		"admin_token_hash":   "5555555555555555555555555555555566666666666666666666666666666666",
	}
	b, _ := json.Marshal(persistedData)
	_ = os.WriteFile(secretsPath, b, 0600)

	t.Setenv("DATA_DIR", tempDir)

	// Persisted value wins when no explicit env is set
	cfg := config.Load("1.0.0", "test", "now")
	if hex.EncodeToString(cfg.Security.IPHashSecret.Reveal()) != persistedIP {
		t.Fatalf("expected persisted secret to be loaded, got %s", hex.EncodeToString(cfg.Security.IPHashSecret.Reveal()))
	}

	// Explicit env overrides persisted value
	overrideIP := "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	t.Setenv("IP_HASH_SECRET", overrideIP)

	cfgOverride := config.Load("1.0.0", "test", "now")
	if string(cfgOverride.Security.IPHashSecret.Reveal()) != overrideIP {
		t.Fatalf("expected explicit env to win over persisted secret, got %s", string(cfgOverride.Security.IPHashSecret.Reveal()))
	}
}

// TestZeroConfig_PersistenceAndPermissions verifies atomic creation of secrets.json,
// JSON structure versioning, and file permissions.
// Note on Windows: OS mode bits 0600 are mapped to standard file attributes by the Go runtime,
// which is documented as part of the Windows filesystem security behavior.
func TestZeroConfig_PersistenceAndPermissions(t *testing.T) {
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "test.db")

	res, err := config.LoadOrInitializeSecrets(tempDir, dbPath)
	if err != nil {
		t.Fatalf("expected successful secrets generation, got: %v", err)
	}

	if res.BootstrappedAdminKey == "" {
		t.Fatal("expected bootstrapped admin key on first initialization")
	}

	secretsPath := filepath.Join(tempDir, config.SecretsFileName)
	info, err := os.Stat(secretsPath)
	if err != nil {
		t.Fatalf("expected secrets file to exist at %s", secretsPath)
	}

	// Verify file mode (on non-Windows, mode should be 0600)
	perm := info.Mode().Perm()
	if os.PathSeparator != '\\' && perm != 0600 {
		t.Fatalf("expected file permission 0600, got %o", perm)
	}

	// Verify JSON content
	content, err := os.ReadFile(secretsPath)
	if err != nil {
		t.Fatalf("failed to read secrets file: %v", err)
	}

	var parsed config.PersistedSecrets
	if err := json.Unmarshal(content, &parsed); err != nil {
		t.Fatalf("corrupt JSON generated: %v", err)
	}

	if parsed.Version != 1 {
		t.Fatalf("expected secrets schema version 1, got %d", parsed.Version)
	}
	if len(parsed.IPHashSecret) != 128 { // 64 bytes hex
		t.Fatalf("expected 128 hex chars for IP_HASH_SECRET, got %d", len(parsed.IPHashSecret))
	}
	if len(parsed.TURNActiveSecret) != 64 { // 32 bytes hex
		t.Fatalf("expected 64 hex chars for TURNActiveSecret, got %d", len(parsed.TURNActiveSecret))
	}
	if len(parsed.AdminTokenHash) != 64 { // 32 bytes SHA-256 hex
		t.Fatalf("expected 64 hex chars for AdminTokenHash, got %d", len(parsed.AdminTokenHash))
	}

	// Verify AdminTokenHash matches SHA-256 of the plain key printed once
	expectedHash := sha256.Sum256([]byte(res.BootstrappedAdminKey))
	if parsed.AdminTokenHash != hex.EncodeToString(expectedHash[:]) {
		t.Fatalf("stored admin hash does not match hash of generated admin key")
	}
}

// TestZeroConfig_CorruptSecretsRefusal verifies that an unreadable or corrupt
// secrets file causes startup refusal unless RESET_SECRETS is explicitly set.
func TestZeroConfig_CorruptSecretsRefusal(t *testing.T) {
	tempDir := t.TempDir()
	secretsPath := filepath.Join(tempDir, config.SecretsFileName)
	dbPath := filepath.Join(tempDir, "test.db")

	// Write corrupted JSON
	_ = os.WriteFile(secretsPath, []byte("{ corrupt json: broken !!!"), 0600)

	// Default: Must refuse to start
	_, err := config.LoadOrInitializeSecrets(tempDir, dbPath)
	if err == nil || !strings.Contains(err.Error(), "corrupt or invalid JSON") {
		t.Fatalf("expected corrupt secrets error, got: %v", err)
	}

	// When RESET_SECRETS is requested, it regenerates safely
	t.Setenv("RESET_SECRETS", "true")
	res, errReset := config.LoadOrInitializeSecrets(tempDir, dbPath)
	if errReset != nil {
		t.Fatalf("expected reset to regenerate secrets, got: %v", errReset)
	}
	if res.BootstrappedAdminKey == "" {
		t.Fatal("expected new bootstrapped admin key upon forced reset")
	}
}

// TestZeroConfig_DatabaseWithoutSecretsRefusal tests the CRITICAL safety guard:
// If database exists with data, but secrets.json and IP_HASH_SECRET are absent,
// REFUSE to start instead of generating a new secret that makes existing data unreadable.
func TestZeroConfig_DatabaseWithoutSecretsRefusal(t *testing.T) {
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "rootinbox.db")

	// Create an existing database file with simulated content
	dummyDBData := make([]byte, 1024)
	_, _ = rand.Read(dummyDBData)
	if err := os.WriteFile(dbPath, dummyDBData, 0644); err != nil {
		t.Fatalf("failed to create dummy database: %v", err)
	}

	t.Setenv("DATA_DIR", tempDir)
	os.Unsetenv("IP_HASH_SECRET")

	cfg := config.Load("1.0.0", "test", "now")
	err := config.Validate(cfg)
	if err == nil || !strings.Contains(err.Error(), "existing database found") {
		t.Fatalf("expected refusal error when database exists without secrets, got: %v", err)
	}
}

// TestZeroConfig_EnvWinsWarning verifies that when explicit env differs from
// persisted secret, env wins and a warning is recorded without leaking values.
func TestZeroConfig_EnvWinsWarning(t *testing.T) {
	tempDir := t.TempDir()
	secretsPath := filepath.Join(tempDir, config.SecretsFileName)
	dbPath := filepath.Join(tempDir, "test.db")

	persistedIP := "11111111111111111111111111111111111111111111111111111111111111112222222222222222222222222222222222222222222222222222222222222222"
	persistedData := map[string]interface{}{
		"version":            1,
		"ip_hash_secret":     persistedIP,
		"turn_active_secret": "3333333333333333333333333333333344444444444444444444444444444444",
		"admin_token_hash":   "5555555555555555555555555555555566666666666666666666666666666666",
	}
	b, _ := json.Marshal(persistedData)
	_ = os.WriteFile(secretsPath, b, 0600)

	t.Setenv("IP_HASH_SECRET", "9999999999999999999999999999999999999999999999999999999999999999")

	res, err := config.LoadOrInitializeSecrets(tempDir, dbPath)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	foundWarning := false
	for _, w := range res.Warnings {
		if strings.Contains(w, "explicit IP_HASH_SECRET environment variable overrides persisted secret") {
			foundWarning = true
			if strings.Contains(w, persistedIP) || strings.Contains(w, "999999999") {
				t.Fatal("security violation: secret value printed in warning message!")
			}
		}
	}
	if !foundWarning {
		t.Fatal("expected warning when explicit env overrides persisted secret")
	}
}

// TestZeroConfig_RailwayDetection_SimulatedEnv verifies platform auto-detection,
// defaults, and proxy CIDRs under Railway environment variables.
func TestZeroConfig_RailwayDetection_SimulatedEnv(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("DATA_DIR", tempDir)
	t.Setenv("RAILWAY_ENVIRONMENT", "production")
	t.Setenv("RAILWAY_PUBLIC_DOMAIN", "chat-prod.up.railway.app")
	t.Setenv("PORT", "3000")

	cfg := config.Load("1.0.0", "test", "now")

	if cfg.Platform != config.PlatformRailway {
		t.Fatalf("expected PlatformRailway, got %s", cfg.Platform)
	}
	if cfg.Server.Port != 3000 {
		t.Fatalf("expected port 3000 from PORT, got %d", cfg.Server.Port)
	}
	if cfg.Security.AppOrigin != "https://chat-prod.up.railway.app" {
		t.Fatalf("expected derived origin https://chat-prod.up.railway.app, got %s", cfg.Security.AppOrigin)
	}
	if cfg.Push.Enabled {
		t.Fatal("expected Push to be disabled by default on Railway in zero-config mode")
	}
	if cfg.TURN.Enabled {
		t.Fatal("expected TURN to be disabled by default on Railway due to lack of UDP ingress")
	}

	// Verify Railway proxy CIDR defaults
	if len(cfg.Security.TrustedProxiesCIDR) == 0 {
		t.Fatal("expected default trusted proxy CIDRs in Railway mode")
	}
	found10 := false
	for _, c := range cfg.Security.TrustedProxiesCIDR {
		if c.String() == "10.0.0.0/8" {
			found10 = true
		}
	}
	if !found10 {
		t.Fatal("expected 10.0.0.0/8 in Railway trusted proxy CIDRs")
	}
}

// TestZeroConfig_ProxyDefaults_OnlyRailway verifies that trusted proxy defaults
// are populated ONLY in Railway mode, never on Bare Host.
func TestZeroConfig_ProxyDefaults_OnlyRailway(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("DATA_DIR", tempDir)
	os.Unsetenv("RAILWAY_ENVIRONMENT")
	os.Unsetenv("RAILWAY_PROJECT_ID")
	os.Unsetenv("RAILWAY_SERVICE_ID")
	os.Unsetenv("TRUSTED_PROXIES_CIDR")

	cfg := config.Load("1.0.0", "test", "now")
	if cfg.Platform == config.PlatformRailway {
		t.Fatal("expected non-railway platform")
	}
	if len(cfg.Security.TrustedProxiesCIDR) > 0 {
		t.Fatalf("expected 0 default trusted proxies on bare host, got %d", len(cfg.Security.TrustedProxiesCIDR))
	}
}

// TestZeroConfig_WaitingForDomain verifies safe waiting-for-domain mode
// when running on Railway before Generate Domain is clicked.
func TestZeroConfig_WaitingForDomain(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("DATA_DIR", tempDir)
	t.Setenv("RAILWAY_ENVIRONMENT", "production")
	os.Unsetenv("RAILWAY_PUBLIC_DOMAIN")
	os.Unsetenv("APP_ORIGIN")

	cfg := config.Load("1.0.0", "test", "now")
	if !cfg.WaitingForDomain {
		t.Fatal("expected WaitingForDomain to be true when RAILWAY_PUBLIC_DOMAIN is missing")
	}

	// Validation must succeed in waiting-for-domain mode
	if err := config.Validate(cfg); err != nil {
		t.Fatalf("expected config to validate cleanly in waiting-for-domain mode, got: %v", err)
	}

	// Verify Origin parsing does not crash
	u, err := url.Parse(cfg.Security.AppOrigin)
	if err != nil || u.Scheme == "" {
		t.Fatalf("invalid AppOrigin in waiting-for-domain mode: %s", cfg.Security.AppOrigin)
	}
}

// TestZeroConfig_AdminResetKey verifies the CLI reset-key functionality.
func TestZeroConfig_AdminResetKey(t *testing.T) {
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "test.db")

	res, err := config.LoadOrInitializeSecrets(tempDir, dbPath)
	if err != nil {
		t.Fatalf("failed initial secrets load: %v", err)
	}
	initialHash := res.AdminTokenHash

	// Reset key
	newPlainKey, errReset := config.ResetAdminKey(tempDir)
	if errReset != nil {
		t.Fatalf("failed to reset admin key: %v", errReset)
	}

	// Load secrets again to verify the hash changed
	resAfter, errAfter := config.LoadOrInitializeSecrets(tempDir, dbPath)
	if errAfter != nil {
		t.Fatalf("failed re-loading secrets: %v", errAfter)
	}

	if resAfter.AdminTokenHash == initialHash {
		t.Fatal("expected admin token hash to change after reset")
	}

	// Verify new hash matches SHA-256 of new plain key
	expectedHash := sha256.Sum256([]byte(newPlainKey))
	if resAfter.AdminTokenHash != hex.EncodeToString(expectedHash[:]) {
		t.Fatal("persisted hash does not match newly generated reset key")
	}
}

// TestZeroConfig_Z4_PublicHostWithoutTLSMode verifies Z4:
// When PUBLIC_HOST is set without TLS_MODE on non-Railway, it defaults to TLS_MODE=selfsigned,
// sets default port 8443, and auto-derives the HTTPS AppOrigin.
func TestZeroConfig_Z4_PublicHostWithoutTLSMode(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("DATA_DIR", tempDir)
	t.Setenv("PUBLIC_HOST", "192.168.1.100")
	os.Unsetenv("TLS_MODE")
	os.Unsetenv("PORT")
	os.Unsetenv("SERVER_PORT")
	os.Unsetenv("APP_ORIGIN")
	os.Unsetenv("RAILWAY_ENVIRONMENT")

	cfg := config.Load("1.0.0", "hash123", "2026-10-30")

	if cfg.TLS.Mode != "selfsigned" {
		t.Fatalf("expected TLS_MODE to default to 'selfsigned' when PUBLIC_HOST is set, got: %s", cfg.TLS.Mode)
	}
	if cfg.Server.Port != 8443 {
		t.Fatalf("expected default port 8443 in selfsigned mode, got: %d", cfg.Server.Port)
	}
	if cfg.Security.AppOrigin != "https://192.168.1.100:8443" {
		t.Fatalf("expected AppOrigin https://192.168.1.100:8443, got: %s", cfg.Security.AppOrigin)
	}
	if err := config.Validate(cfg); err != nil {
		t.Fatalf("expected zero-config validation with PUBLIC_HOST to pass, got: %v", err)
	}
}

// TestZeroConfig_Z4_NothingConfigured_LocalhostOnly verifies Z4:
// When nothing is configured, the server binds to 127.0.0.1 only with a clear message and never guesses a public IP.
func TestZeroConfig_Z4_NothingConfigured_LocalhostOnly(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("DATA_DIR", tempDir)
	os.Unsetenv("PUBLIC_HOST")
	os.Unsetenv("APP_ORIGIN")
	os.Unsetenv("SERVER_HOST")
	os.Unsetenv("RAILWAY_ENVIRONMENT")
	os.Unsetenv("RAILWAY_PROJECT_ID")
	os.Unsetenv("RAILWAY_SERVICE_ID")

	cfg := config.Load("1.0.0", "hash123", "2026-10-30")

	if cfg.Server.Host != "127.0.0.1" {
		t.Fatalf("expected Server.Host to be 127.0.0.1 when unconfigured, got: %s", cfg.Server.Host)
	}
	if !cfg.Security.InsecureDevMode {
		t.Fatal("expected InsecureDevMode to be true when bound to 127.0.0.1")
	}

	foundClearMessage := false
	for _, w := range cfg.Warnings {
		if strings.Contains(w, "Listening on 127.0.0.1 only for local access (never guessing a public IP)") {
			foundClearMessage = true
		}
	}
	if !foundClearMessage {
		t.Fatalf("expected clear warning message about 127.0.0.1 local access and never guessing public IP, got: %v", cfg.Warnings)
	}

	if err := config.Validate(cfg); err != nil {
		t.Fatalf("expected zero-config validation to pass when unconfigured, got: %v", err)
	}
}

// TestZeroConfig_Z6_StartupSummaryFormatting verifies Z6:
// FormatStartupSummary includes platform, data dir and persistence status, origin, ports,
// TURN/push status with reasons, admin key state, and version/commit; secrets are strictly masked.
func TestZeroConfig_Z6_StartupSummaryFormatting(t *testing.T) {
	tempDir := t.TempDir()
	t.Setenv("DATA_DIR", tempDir)
	t.Setenv("PUBLIC_HOST", "192.168.1.100")
	t.Setenv("TURN_ENABLED", "true")
	t.Setenv("TURN_ACTIVE_SECRET", "supersecretkey12345678901234567890123456789012")

	cfg := config.Load("2.0.0", "commit-abc456", "2026-10-30")

	summary := config.FormatStartupSummary(cfg)

	requiredSubstrings := []string{
		"Platform:",
		"Data Dir:",
		"Persistent Storage",
		"App Origin:",
		"Ports:",
		"HTTPS Listen: 8443",
		"Onboarding HTTP: 8080",
		"TURN UDP:",
		"Web Push:       Disabled (Zero-config default / no VAPID keys)",
		"TURN Relay:     Enabled",
		"Admin Access:   Active",
		"Version/Commit: 2.0.0 (commit-abc456)",
	}

	for _, sub := range requiredSubstrings {
		if !strings.Contains(summary, sub) {
			t.Fatalf("missing required startup summary element '%s' in:\n%s", sub, summary)
		}
	}

	// Verify secrets are strictly masked and never appear in summary text
	if strings.Contains(summary, "supersecretkey") {
		t.Fatal("security violation: secret revealed in startup summary!")
	}
	if strings.Contains(summary, string(cfg.Security.IPHashSecret.Reveal())) {
		t.Fatal("security violation: IPHashSecret revealed in startup summary!")
	}
}
