package bootstrap

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func getFreePort(t *testing.T) int {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("failed to allocate free port: %v", err)
	}
	defer ln.Close()
	return ln.Addr().(*net.TCPAddr).Port
}

func TestBootstrap_SelfSignedTLS_E2E(t *testing.T) {
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "test.db")
	mediaPath := filepath.Join(tempDir, "media")
	tlsDir := filepath.Join(tempDir, "tls")

	httpsPort := getFreePort(t)
	onboardingPort := getFreePort(t)
	for onboardingPort == httpsPort {
		onboardingPort = getFreePort(t)
	}

	t.Setenv("DB_PATH", dbPath)
	t.Setenv("MEDIA_PATH", mediaPath)
	t.Setenv("IP_HASH_SECRET", "12345678901234567890123456789012")
	t.Setenv("PORT", strconv.Itoa(httpsPort))
	t.Setenv("TLS_MODE", "selfsigned")
	t.Setenv("PUBLIC_HOST", "127.0.0.1")
	t.Setenv("TLS_DATA_DIR", tlsDir)
	t.Setenv("TLS_ONBOARDING_PORT", strconv.Itoa(onboardingPort))
	t.Setenv("INSECURE_DEV_MODE", "true")
	t.Setenv("PUSH_ENABLED", "false")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	app, err := Run(ctx, "test", "hash", "time")
	if err != nil {
		t.Fatalf("bootstrap Run failed in selfsigned TLS mode: %v", err)
	}
	defer func() {
		_ = app.Shutdown()
	}()

	// Wait for servers to start listening
	onboardingBaseURL := fmt.Sprintf("http://127.0.0.1:%d", onboardingPort)
	httpsBaseURL := fmt.Sprintf("https://127.0.0.1:%d", httpsPort)

	var caBytes []byte
	ready := false
	for i := 0; i < 40; i++ {
		resp, err := http.Get(onboardingBaseURL + "/ca.crt")
		if err == nil && resp.StatusCode == http.StatusOK {
			caBytes, _ = io.ReadAll(resp.Body)
			resp.Body.Close()
			ready = true
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !ready {
		t.Fatalf("onboarding server did not become ready within timeout")
	}

	// 1. Verify Plain-HTTP /ca.crt
	if len(caBytes) == 0 {
		t.Fatal("empty response from /ca.crt")
	}
	block, _ := pem.Decode(caBytes)
	if block == nil {
		t.Fatal("failed to decode PEM from /ca.crt")
	}
	caCert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatalf("failed to parse CA certificate: %v", err)
	}
	if !caCert.IsCA {
		t.Fatal("downloaded certificate is not a CA")
	}

	// 2. Verify Plain-HTTP / onboarding guide
	guideResp, err := http.Get(onboardingBaseURL + "/")
	if err != nil {
		t.Fatalf("GET / from onboarding server failed: %v", err)
	}
	defer guideResp.Body.Close()
	guideBody, _ := io.ReadAll(guideResp.Body)
	if !strings.Contains(string(guideBody), "Certificate Trust Settings") {
		t.Fatal("onboarding guide missing iOS Certificate Trust Settings")
	}
	if !strings.Contains(string(guideBody), "127.0.0.1") {
		t.Fatal("onboarding guide missing PUBLIC_HOST")
	}

	// 3. Verify HTTPS /health/ready without CA fails with untrusted cert error
	insecureClient := &http.Client{Timeout: 3 * time.Second}
	_, err = insecureClient.Get(httpsBaseURL + "/health/ready")
	if err == nil {
		t.Fatal("expected untrusted client to fail TLS handshake verification")
	}

	// 4. Verify HTTPS /health/ready with trusted CA succeeds
	certPool := x509.NewCertPool()
	certPool.AddCert(caCert)

	tlsClient := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				RootCAs:    certPool,
				ServerName: "127.0.0.1",
			},
		},
		Timeout: 3 * time.Second,
	}

	httpsResp, err := tlsClient.Get(httpsBaseURL + "/health/ready")
	if err != nil {
		t.Fatalf("HTTPS GET /health/ready failed: %v", err)
	}
	defer httpsResp.Body.Close()
	if httpsResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 OK from HTTPS /health/ready, got %d", httpsResp.StatusCode)
	}

	// 5. Verify WSS handshake
	wsURL := fmt.Sprintf("wss://127.0.0.1:%d/api/v1/ws", httpsPort)
	dialer := websocket.Dialer{
		TLSClientConfig: &tls.Config{
			RootCAs:    certPool,
			ServerName: "127.0.0.1",
		},
		HandshakeTimeout: 5 * time.Second,
	}
	headers := http.Header{
		"Origin": []string{httpsBaseURL},
	}

	wsConn, wsResp, err := dialer.Dial(wsURL, headers)
	if err != nil {
		t.Fatalf("WSS dial failed: %v (resp: %v)", err, wsResp)
	}
	defer wsConn.Close()

	if wsResp.StatusCode != http.StatusSwitchingProtocols {
		t.Fatalf("expected 101 Switching Protocols, got %d", wsResp.StatusCode)
	}

	// 6. Test graceful shutdown
	if err := app.Shutdown(); err != nil {
		t.Fatalf("Shutdown failed: %v", err)
	}

	// Verify ports released
	_, err = tlsClient.Get(httpsBaseURL + "/health/ready")
	if err == nil {
		t.Fatal("expected HTTPS server to be stopped after shutdown")
	}
}

func TestBootstrap_FilesTLS_Mode(t *testing.T) {
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "test.db")
	mediaPath := filepath.Join(tempDir, "media")
	tlsDir := filepath.Join(tempDir, "tls")

	// Pre-generate CA and certs using selfsigned mode first
	genPort := getFreePort(t)
	t.Setenv("DB_PATH", dbPath)
	t.Setenv("MEDIA_PATH", mediaPath)
	t.Setenv("IP_HASH_SECRET", "12345678901234567890123456789012")
	t.Setenv("PORT", strconv.Itoa(genPort))
	t.Setenv("TLS_MODE", "selfsigned")
	t.Setenv("PUBLIC_HOST", "127.0.0.1")
	t.Setenv("TLS_DATA_DIR", tlsDir)
	t.Setenv("TLS_ONBOARDING_PORT", strconv.Itoa(getFreePort(t)))
	t.Setenv("INSECURE_DEV_MODE", "true")
	t.Setenv("PUSH_ENABLED", "false")

	app1, err := Run(context.Background(), "test", "hash", "time")
	if err != nil {
		t.Fatalf("initial run failed: %v", err)
	}
	_ = app1.Shutdown()

	certPath := filepath.Join(tlsDir, "server.crt")
	keyPath := filepath.Join(tlsDir, "server.key")
	caPath := filepath.Join(tlsDir, "ca.crt")

	// Now start in TLS_MODE=files
	filesPort := getFreePort(t)
	t.Setenv("PORT", strconv.Itoa(filesPort))
	t.Setenv("TLS_MODE", "files")
	t.Setenv("TLS_CERT_FILE", certPath)
	t.Setenv("TLS_KEY_FILE", keyPath)
	os.Unsetenv("TLS_ONBOARDING_PORT")

	app2, err := Run(context.Background(), "test", "hash", "time")
	if err != nil {
		t.Fatalf("Run failed in files TLS mode: %v", err)
	}
	defer func() {
		_ = app2.Shutdown()
	}()

	caPEM, err := os.ReadFile(caPath)
	if err != nil {
		t.Fatalf("reading CA cert: %v", err)
	}
	block, _ := pem.Decode(caPEM)
	caCert, _ := x509.ParseCertificate(block.Bytes)
	certPool := x509.NewCertPool()
	certPool.AddCert(caCert)

	tlsClient := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: &tls.Config{
				RootCAs:    certPool,
				ServerName: "127.0.0.1",
			},
		},
		Timeout: 3 * time.Second,
	}

	httpsBaseURL := fmt.Sprintf("https://127.0.0.1:%d", filesPort)
	ready := false
	for i := 0; i < 30; i++ {
		resp, err := tlsClient.Get(httpsBaseURL + "/health/ready")
		if err == nil && resp.StatusCode == http.StatusOK {
			resp.Body.Close()
			ready = true
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !ready {
		t.Fatalf("files TLS server did not respond 200 OK within timeout")
	}
}
