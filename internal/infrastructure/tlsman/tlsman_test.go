package tlsman_test

import (
	"crypto/x509"
	"encoding/pem"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"rootinbox/internal/config"
	"rootinbox/internal/infrastructure/tlsman"
)

func newTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestTLSManager_CA_Generation_And_Permissions(t *testing.T) {
	tempDir := t.TempDir()
	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8443},
		TLS: config.TLSConfig{
			Mode:           "selfsigned",
			PublicHost:     "192.168.1.100",
			DataDir:        tempDir,
			OnboardingPort: 8080,
		},
	}

	mgr, err := tlsman.NewManager(cfg, newTestLogger())
	if err != nil {
		t.Fatalf("failed to create TLS manager: %v", err)
	}

	caKeyPath := filepath.Join(tempDir, "ca.key")
	caCertPath := filepath.Join(tempDir, "ca.crt")

	// Verify key permissions (on Unix/Linux this must be 0600)
	if runtime.GOOS != "windows" {
		fi, err := os.Stat(caKeyPath)
		if err != nil {
			t.Fatalf("stat ca.key: %v", err)
		}
		if fi.Mode().Perm() != 0600 {
			t.Fatalf("expected ca.key permissions 0600, got %o", fi.Mode().Perm())
		}
	}

	caCert := mgr.CACert()
	if caCert == nil {
		t.Fatal("expected non-nil CA cert")
	}
	if !caCert.IsCA {
		t.Fatal("expected caCert.IsCA to be true")
	}

	// Verify name constraints for IP
	if len(caCert.PermittedIPRanges) == 0 {
		t.Fatal("expected CA PermittedIPRanges to be non-empty for IP public host")
	}
	expectedIP := net.ParseIP("192.168.1.100")
	matched := false
	for _, ipRange := range caCert.PermittedIPRanges {
		if ipRange.Contains(expectedIP) {
			matched = true
			break
		}
	}
	if !matched {
		t.Fatalf("expected PermittedIPRanges to contain %v", expectedIP)
	}

	// Verify files exist on disk
	if _, err := os.Stat(caCertPath); err != nil {
		t.Fatalf("ca.crt missing: %v", err)
	}
	if _, err := os.Stat(caKeyPath); err != nil {
		t.Fatalf("ca.key missing: %v", err)
	}
}

func TestTLSManager_ServerCert_SAN_And_Validity_IP(t *testing.T) {
	tempDir := t.TempDir()
	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8443},
		TLS: config.TLSConfig{
			Mode:           "selfsigned",
			PublicHost:     "10.0.0.5",
			DataDir:        tempDir,
			OnboardingPort: 8080,
		},
	}

	mgr, err := tlsman.NewManager(cfg, newTestLogger())
	if err != nil {
		t.Fatalf("failed to create TLS manager: %v", err)
	}

	serverCert := mgr.ServerCert()
	if serverCert == nil {
		t.Fatal("expected non-nil server certificate")
	}

	// 1. Verify SAN contains IP
	expectedIP := net.ParseIP("10.0.0.5")
	foundSAN := false
	for _, ip := range serverCert.IPAddresses {
		if ip.Equal(expectedIP) {
			foundSAN = true
			break
		}
	}
	if !foundSAN {
		t.Fatalf("expected server cert IPAddresses to contain %v, got %v", expectedIP, serverCert.IPAddresses)
	}

	// 2. Verify validity <= 825 days (Apple iOS HT210176 requirement)
	validityDuration := serverCert.NotAfter.Sub(serverCert.NotBefore)
	maxAllowed := 825 * 24 * time.Hour
	if validityDuration > maxAllowed {
		t.Fatalf("validity duration %v exceeds maximum allowed by iOS (%v)", validityDuration, maxAllowed)
	}

	// 3. Verify server cert is signed by CA
	caCert := mgr.CACert()
	if err := serverCert.CheckSignatureFrom(caCert); err != nil {
		t.Fatalf("server cert signature verification from CA failed: %v", err)
	}
}

func TestTLSManager_Domain_NameConstraints(t *testing.T) {
	tempDir := t.TempDir()
	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8443},
		TLS: config.TLSConfig{
			Mode:           "selfsigned",
			PublicHost:     "chat.internal",
			DataDir:        tempDir,
			OnboardingPort: 8080,
		},
	}

	mgr, err := tlsman.NewManager(cfg, newTestLogger())
	if err != nil {
		t.Fatalf("failed to create TLS manager: %v", err)
	}

	caCert := mgr.CACert()
	if len(caCert.PermittedDNSDomains) == 0 || caCert.PermittedDNSDomains[0] != "chat.internal" {
		t.Fatalf("expected PermittedDNSDomains to contain 'chat.internal', got %v", caCert.PermittedDNSDomains)
	}

	serverCert := mgr.ServerCert()
	foundDNS := false
	for _, name := range serverCert.DNSNames {
		if name == "chat.internal" {
			foundDNS = true
			break
		}
	}
	if !foundDNS && serverCert.Subject.CommonName != "chat.internal" {
		t.Fatalf("expected DNS SAN or CommonName 'chat.internal', got %v", serverCert.DNSNames)
	}
}

func TestTLSManager_AutoRenewal(t *testing.T) {
	tempDir := t.TempDir()
	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8443},
		TLS: config.TLSConfig{
			Mode:           "selfsigned",
			PublicHost:     "127.0.0.1",
			DataDir:        tempDir,
			OnboardingPort: 8080,
		},
	}

	mgr, err := tlsman.NewManager(cfg, newTestLogger())
	if err != nil {
		t.Fatalf("failed to create TLS manager: %v", err)
	}

	initialSerial := mgr.ServerCert().SerialNumber
	initialCASerial := mgr.CACert().SerialNumber

	// When certificate is fresh, CheckAndRenew should return false
	renewed, err := mgr.CheckAndRenew()
	if err != nil {
		t.Fatalf("CheckAndRenew error: %v", err)
	}
	if renewed {
		t.Fatal("expected renewed=false for fresh certificate")
	}

	// Now simulate certificate expiring tomorrow by rewriting server.crt with an expiring cert
	// We can delete server.crt to force renewal
	os.Remove(filepath.Join(tempDir, "server.crt"))
	os.Remove(filepath.Join(tempDir, "server.key"))

	// Create manager again; it should regenerate server cert using SAME CA
	mgr2, err := tlsman.NewManager(cfg, newTestLogger())
	if err != nil {
		t.Fatalf("failed to create second manager: %v", err)
	}

	// CA must remain the same!
	if mgr2.CACert().SerialNumber.Cmp(initialCASerial) != 0 {
		t.Fatalf("CA serial changed! Expected %v, got %v", initialCASerial, mgr2.CACert().SerialNumber)
	}
	// Server cert must be new
	if mgr2.ServerCert().SerialNumber.Cmp(initialSerial) == 0 {
		t.Fatalf("expected new server serial number, got identical %v", initialSerial)
	}
}

func TestTLSManager_OnboardingHandler(t *testing.T) {
	tempDir := t.TempDir()
	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8443},
		TLS: config.TLSConfig{
			Mode:           "selfsigned",
			PublicHost:     "192.168.1.200",
			DataDir:        tempDir,
			OnboardingPort: 8080,
		},
	}

	mgr, err := tlsman.NewManager(cfg, newTestLogger())
	if err != nil {
		t.Fatalf("failed to create TLS manager: %v", err)
	}

	handler := mgr.OnboardingHandler()

	// 1. Test GET /ca.crt
	reqCA := httptest.NewRequest(http.MethodGet, "/ca.crt", nil)
	recCA := httptest.NewRecorder()
	handler.ServeHTTP(recCA, reqCA)

	if recCA.Code != http.StatusOK {
		t.Fatalf("expected 200 for /ca.crt, got %d", recCA.Code)
	}
	contentType := recCA.Header().Get("Content-Type")
	if contentType != "application/x-x509-ca-cert" {
		t.Fatalf("expected Content-Type application/x-x509-ca-cert, got %s", contentType)
	}

	// Verify downloaded bytes parse as valid x509 cert matching CA
	block, _ := pem.Decode(recCA.Body.Bytes())
	if block == nil {
		t.Fatal("failed to decode downloaded ca.crt PEM")
	}
	downloadedCert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("parsing downloaded cert: %v", err)
	}
	if downloadedCert.SerialNumber.Cmp(mgr.CACert().SerialNumber) != 0 {
		t.Fatalf("downloaded cert does not match manager CA cert")
	}

	// 2. Test GET / (HTML guide)
	reqHTML := httptest.NewRequest(http.MethodGet, "/", nil)
	recHTML := httptest.NewRecorder()
	handler.ServeHTTP(recHTML, reqHTML)

	if recHTML.Code != http.StatusOK {
		t.Fatalf("expected 200 for /, got %d", recHTML.Code)
	}
	body := recHTML.Body.String()
	if recHTML.Header().Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("expected text/html charset=utf-8, got %s", recHTML.Header().Get("Content-Type"))
	}
	// Check for required elements in guide
	if !containsStr(body, "Certificate Trust Settings") {
		t.Fatal("HTML guide missing 'Certificate Trust Settings'")
	}
	if !containsStr(body, "192.168.1.200") {
		t.Fatal("HTML guide missing PUBLIC_HOST")
	}
	if !containsStr(body, "https://192.168.1.200:8443") {
		t.Fatal("HTML guide missing HTTPS link")
	}
}

func containsStr(s, sub string) bool {
	return filepath.Clean(s) != "" && len(s) >= len(sub) && (s == sub || len(sub) > 0 && indexOf(s, sub) >= 0)
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func TestTLSManager_Fingerprint_FormatAndOnboarding(t *testing.T) {
	tempDir := t.TempDir()
	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8443},
		TLS: config.TLSConfig{
			Mode:           "selfsigned",
			PublicHost:     "192.168.1.150",
			DataDir:        tempDir,
			OnboardingPort: 8080,
		},
	}

	mgr, err := tlsman.NewManager(cfg, newTestLogger())
	if err != nil {
		t.Fatalf("failed to create TLS manager: %v", err)
	}

	fp := mgr.CAFingerprint()
	// SHA-256 is 32 bytes -> 32 * 2 hex chars + 31 colons = 95 characters
	if len(fp) != 95 {
		t.Fatalf("expected fingerprint length 95, got %d (%s)", len(fp), fp)
	}
	// Verify uppercase hex and colon structure
	parts := strings.Split(fp, ":")
	if len(parts) != 32 {
		t.Fatalf("expected 32 colon-separated hex segments, got %d", len(parts))
	}
	for _, part := range parts {
		if len(part) != 2 {
			t.Fatalf("invalid segment length %s", part)
		}
		for _, c := range part {
			if !((c >= '0' && c <= '9') || (c >= 'A' && c <= 'F')) {
				t.Fatalf("invalid hex char %c in segment %s", c, part)
			}
		}
	}

	// Verify onboarding HTML includes fingerprint and Persian verification text
	handler := mgr.OnboardingHandler()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	handler.ServeHTTP(rec, req)

	body := rec.Body.String()
	if !strings.Contains(body, fp) {
		t.Fatalf("onboarding page does not contain CA fingerprint %s", fp)
	}
	if !strings.Contains(body, "id=\"ca-fingerprint\"") {
		t.Fatalf("onboarding page missing id=\"ca-fingerprint\"")
	}
	// Verify Persian voice-call instructions
	if !strings.Contains(body, "تماس صوتی") {
		t.Fatalf("onboarding page missing Persian voice-call comparison instruction")
	}
	// Verify Persian IP change warning
	if !strings.Contains(body, "تغییر آدرس یا انتقال سرور") {
		t.Fatalf("onboarding page missing Persian IP change warning")
	}
}

func TestTLSManager_PrintCAFingerprint(t *testing.T) {
	tempDir := t.TempDir()
	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8443},
		TLS: config.TLSConfig{
			Mode:           "selfsigned",
			PublicHost:     "192.168.1.150",
			DataDir:        tempDir,
			OnboardingPort: 8080,
		},
	}

	mgr, err := tlsman.NewManager(cfg, newTestLogger())
	if err != nil {
		t.Fatalf("failed to create TLS manager: %v", err)
	}

	// PrintCAFingerprint should succeed for the generated CA
	if err := tlsman.PrintCAFingerprint(cfg); err != nil {
		t.Fatalf("PrintCAFingerprint failed: %v", err)
	}

	// If ca.crt is missing in an empty dir, it should return error
	emptyCfg := &config.Config{
		TLS: config.TLSConfig{
			DataDir: t.TempDir(),
		},
	}
	if err := tlsman.PrintCAFingerprint(emptyCfg); err == nil {
		t.Fatal("expected error when ca.crt does not exist")
	}
	_ = mgr
}

func TestTLSManager_RefuseSilentRegeneration_CorruptCA(t *testing.T) {
	tempDir := t.TempDir()
	caCertPath := filepath.Join(tempDir, "ca.crt")
	caKeyPath := filepath.Join(tempDir, "ca.key")

	// Write corrupt/invalid files to ca.crt and ca.key
	if err := os.WriteFile(caCertPath, []byte("NOT_A_VALID_CERT_PEM"), 0644); err != nil {
		t.Fatalf("failed to write corrupt ca.crt: %v", err)
	}
	if err := os.WriteFile(caKeyPath, []byte("NOT_A_VALID_KEY_PEM"), 0600); err != nil {
		t.Fatalf("failed to write corrupt ca.key: %v", err)
	}

	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8443},
		TLS: config.TLSConfig{
			Mode:           "selfsigned",
			PublicHost:     "192.168.1.150",
			DataDir:        tempDir,
			OnboardingPort: 8080,
			RegenerateCA:   false,
		},
	}

	// Without TLS_REGENERATE_CA=true, it MUST fail to start
	_, err := tlsman.NewManager(cfg, newTestLogger())
	if err == nil {
		t.Fatal("expected NewManager to fail when CA files are corrupt and RegenerateCA=false")
	}
	if !strings.Contains(strings.ToLower(err.Error()), "refusing to silently regenerate") {
		t.Fatalf("expected error to mention 'refusing to silently regenerate', got: %v", err)
	}

	// With TLS_REGENERATE_CA=true, it MUST regenerate and succeed
	cfg.TLS.RegenerateCA = true
	mgr, err := tlsman.NewManager(cfg, newTestLogger())
	if err != nil {
		t.Fatalf("expected NewManager to succeed with RegenerateCA=true, got: %v", err)
	}
	if mgr.CACert() == nil {
		t.Fatal("expected non-nil CA cert after regeneration")
	}
}

func TestTLSManager_RefuseStartup_NameConstraintsMismatch_IP(t *testing.T) {
	tempDir := t.TempDir()
	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8443},
		TLS: config.TLSConfig{
			Mode:           "selfsigned",
			PublicHost:     "192.168.1.100",
			DataDir:        tempDir,
			OnboardingPort: 8080,
		},
	}

	// Create manager first time with 192.168.1.100
	_, err := tlsman.NewManager(cfg, newTestLogger())
	if err != nil {
		t.Fatalf("failed to create first TLS manager: %v", err)
	}

	// Now try to start manager with DIFFERENT IP (e.g. 10.0.0.1) without RegenerateCA
	cfg2 := &config.Config{
		Server: config.ServerConfig{Port: 8443},
		TLS: config.TLSConfig{
			Mode:           "selfsigned",
			PublicHost:     "10.0.0.1",
			DataDir:        tempDir,
			OnboardingPort: 8080,
			RegenerateCA:   false,
		},
	}

	_, err = tlsman.NewManager(cfg2, newTestLogger())
	if err == nil {
		t.Fatal("expected NewManager to fail due to name constraints mismatch for new IP")
	}
	if !strings.Contains(err.Error(), "existing CA name constraints do not cover PUBLIC_HOST IP (10.0.0.1)") {
		t.Fatalf("unexpected error message: %v", err)
	}
}

func TestTLSManager_RefuseStartup_NameConstraintsMismatch_DNS(t *testing.T) {
	tempDir := t.TempDir()
	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8443},
		TLS: config.TLSConfig{
			Mode:           "selfsigned",
			PublicHost:     "chat.internal",
			DataDir:        tempDir,
			OnboardingPort: 8080,
		},
	}

	// Create manager first time with chat.internal
	_, err := tlsman.NewManager(cfg, newTestLogger())
	if err != nil {
		t.Fatalf("failed to create first TLS manager: %v", err)
	}

	// Now try to start manager with DIFFERENT domain (e.g. other.domain)
	cfg2 := &config.Config{
		Server: config.ServerConfig{Port: 8443},
		TLS: config.TLSConfig{
			Mode:           "selfsigned",
			PublicHost:     "other.domain",
			DataDir:        tempDir,
			OnboardingPort: 8080,
			RegenerateCA:   false,
		},
	}

	_, err = tlsman.NewManager(cfg2, newTestLogger())
	if err == nil {
		t.Fatal("expected NewManager to fail due to name constraints mismatch for new domain")
	}
	if !strings.Contains(err.Error(), "existing CA name constraints do not cover PUBLIC_HOST domain (other.domain)") {
		t.Fatalf("unexpected error message: %v", err)
	}
}

func TestTLSManager_RegenerateServerCert_WhenCASignatureMismatches(t *testing.T) {
	tempDir := t.TempDir()
	cfg := &config.Config{
		Server: config.ServerConfig{Port: 8443},
		TLS: config.TLSConfig{
			Mode:           "selfsigned",
			PublicHost:     "192.168.1.150",
			DataDir:        tempDir,
			OnboardingPort: 8080,
		},
	}

	mgr1, err := tlsman.NewManager(cfg, newTestLogger())
	if err != nil {
		t.Fatalf("failed to create first manager: %v", err)
	}
	ca1Fingerprint := mgr1.CAFingerprint()

	// Verify server cert is signed by ca1
	serverCert1 := mgr1.ServerCert()
	if err := serverCert1.CheckSignatureFrom(mgr1.CACert()); err != nil {
		t.Fatalf("server cert 1 should be signed by CA 1: %v", err)
	}

	// Now simulate CA regeneration: delete ca.crt and ca.key, but leave server.crt and server.key in place
	caCertPath := filepath.Join(tempDir, "ca.crt")
	caKeyPath := filepath.Join(tempDir, "ca.key")
	if err := os.Remove(caCertPath); err != nil {
		t.Fatalf("failed to remove ca.crt: %v", err)
	}
	if err := os.Remove(caKeyPath); err != nil {
		t.Fatalf("failed to remove ca.key: %v", err)
	}

	// Create manager again - should generate NEW CA, and MUST detect that existing server.crt was signed by OLD CA and regenerate it
	mgr2, err := tlsman.NewManager(cfg, newTestLogger())
	if err != nil {
		t.Fatalf("failed to create second manager: %v", err)
	}
	ca2Fingerprint := mgr2.CAFingerprint()
	if ca1Fingerprint == ca2Fingerprint {
		t.Fatal("expected new CA to have a different fingerprint")
	}

	// Verify that the new server cert is signed by CA 2!
	serverCert2 := mgr2.ServerCert()
	if err := serverCert2.CheckSignatureFrom(mgr2.CACert()); err != nil {
		t.Fatalf("server cert 2 must be signed by new CA 2: %v", err)
	}
	// And verify it is NOT signed by old CA 1
	if err := serverCert2.CheckSignatureFrom(mgr1.CACert()); err == nil {
		t.Fatal("server cert 2 should NOT be signed by old CA 1")
	}
}

func TestREADME_Fa_Documentation(t *testing.T) {
	// Locate README-fa.md at repo root
	rootPath := filepath.Join("..", "..", "..", "README-fa.md")
	content, err := os.ReadFile(rootPath)
	if err != nil {
		t.Fatalf("failed to read README-fa.md from %s: %v", rootPath, err)
	}
	text := string(content)

	// H2(c) Requirements:
	// 1. Must document what changes when the server moves to a new IP
	if !strings.Contains(text, "تغییر آدرس سرور (New IP)") {
		t.Fatalf("README-fa.md missing 'تغییر آدرس سرور (New IP)' section")
	}
	// 2. New CA to install (TLS_REGENERATE_CA=true)
	if !strings.Contains(text, "TLS_REGENERATE_CA=true") {
		t.Fatalf("README-fa.md missing TLS_REGENERATE_CA=true mention in IP migration")
	}
	// 3. User data / IndexedDB origin dependence note
	if !strings.Contains(text, "IndexedDB") {
		t.Fatalf("README-fa.md missing IndexedDB origin dependence note")
	}
	// 4. Voice call fingerprint verification
	if !strings.Contains(text, "تماس صوتی") {
		t.Fatalf("README-fa.md missing voice call fingerprint verification note")
	}
}
