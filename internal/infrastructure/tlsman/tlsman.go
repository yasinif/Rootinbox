package tlsman

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"fmt"
	"io"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"rootinbox/internal/config"
)

// CertificateValidityDays is 820 days, strictly under the 825-day Apple iOS limit.
const CertificateValidityDays = 820

// RenewalThresholdDays triggers auto-renewal when certificate has fewer than 30 days left.
const RenewalThresholdDays = 30

// Manager manages TLS certificates, CA generation, auto-renewal, and the onboarding HTTP endpoint.
type Manager struct {
	cfg         *config.Config
	logger      *slog.Logger
	mu          sync.RWMutex
	currentCert *tls.Certificate
	serverCert  *x509.Certificate
	caCert      *x509.Certificate
	caPrivKey   *ecdsa.PrivateKey
	caCertPEM   []byte
	cancelFunc  context.CancelFunc
}

// NewManager initializes the TLS manager according to the configured TLS_MODE.
func NewManager(cfg *config.Config, logger *slog.Logger) (*Manager, error) {
	m := &Manager{
		cfg:    cfg,
		logger: logger,
	}

	switch cfg.TLS.Mode {
	case "files":
		cert, err := tls.LoadX509KeyPair(cfg.TLS.CertFile, cfg.TLS.KeyFile)
		if err != nil {
			return nil, fmt.Errorf("loading TLS cert/key files: %w", err)
		}
		m.currentCert = &cert
		logger.Info("loaded TLS certificates from files", "cert", cfg.TLS.CertFile, "key", cfg.TLS.KeyFile)

	case "selfsigned":
		if err := m.initSelfSigned(); err != nil {
			return nil, fmt.Errorf("initializing self-signed TLS: %w", err)
		}

	case "off", "":
		// TLS disabled, no-op
	default:
		return nil, fmt.Errorf("unsupported TLS_MODE: %s", cfg.TLS.Mode)
	}

	return m, nil
}

// initSelfSigned ensures the CA and server certificates exist and are valid.
func (m *Manager) initSelfSigned() error {
	dataDir := m.cfg.TLS.DataDir
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return fmt.Errorf("creating TLS data directory %s: %w", dataDir, err)
	}

	caCertPath := filepath.Join(dataDir, "ca.crt")
	caKeyPath := filepath.Join(dataDir, "ca.key")
	serverCertPath := filepath.Join(dataDir, "server.crt")
	serverKeyPath := filepath.Join(dataDir, "server.key")

	// 1. Load or generate CA
	caCertExists := fileExists(caCertPath)
	caKeyExists := fileExists(caKeyPath)

	if caCertExists || caKeyExists {
		var loadErr error
		if !caCertExists || !caKeyExists {
			loadErr = fmt.Errorf("incomplete CA files: ca.crt exists=%t, ca.key exists=%t", caCertExists, caKeyExists)
		} else {
			loadErr = m.loadCA(caCertPath, caKeyPath)
		}

		if loadErr != nil {
			if !m.cfg.TLS.RegenerateCA {
				return fmt.Errorf("existing CA could not be loaded: %w. Refusing to silently regenerate (set TLS_REGENERATE_CA=true to allow regeneration)", loadErr)
			}
			m.logger.Warn("existing CA could not be loaded; regenerating because TLS_REGENERATE_CA=true", "error", loadErr)
			if err := m.generateCA(caCertPath, caKeyPath); err != nil {
				return err
			}
		}
	} else {
		if err := m.generateCA(caCertPath, caKeyPath); err != nil {
			return err
		}
	}

	// 2. Load or generate server leaf certificate
	needsServerCert := true
	if fileExists(serverCertPath) && fileExists(serverKeyPath) {
		cert, err := tls.LoadX509KeyPair(serverCertPath, serverKeyPath)
		if err == nil && len(cert.Certificate) > 0 {
			parsed, err := x509.ParseCertificate(cert.Certificate[0])
			if err == nil {
				// Verify SAN and validity
				if m.validateServerCert(parsed) {
					m.currentCert = &cert
					m.serverCert = parsed
					needsServerCert = false
					m.logger.Info("loaded existing valid server TLS certificate",
						"subject", parsed.Subject.CommonName,
						"expires_at", parsed.NotAfter.Format(time.RFC3339))
				}
			}
		}
	}

	if needsServerCert {
		if err := m.generateServerCert(serverCertPath, serverKeyPath); err != nil {
			return err
		}
	}

	return nil
}

// loadCA loads an existing CA certificate and private key and verifies name constraints.
func (m *Manager) loadCA(certPath, keyPath string) error {
	certPEM, err := os.ReadFile(certPath)
	if err != nil {
		return err
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return err
	}

	certBlock, _ := pem.Decode(certPEM)
	if certBlock == nil {
		return fmt.Errorf("failed to decode CA cert PEM")
	}
	caCert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return fmt.Errorf("parsing CA cert: %w", err)
	}

	keyBlock, _ := pem.Decode(keyPEM)
	if keyBlock == nil {
		return fmt.Errorf("failed to decode CA key PEM")
	}
	caKey, err := x509.ParseECPrivateKey(keyBlock.Bytes)
	if err != nil {
		// Attempt PKCS8
		rawKey, errPkcs8 := x509.ParsePKCS8PrivateKey(keyBlock.Bytes)
		if errPkcs8 != nil {
			return fmt.Errorf("parsing CA private key: %w (pkcs8: %v)", err, errPkcs8)
		}
		var ok bool
		caKey, ok = rawKey.(*ecdsa.PrivateKey)
		if !ok {
			return fmt.Errorf("CA private key is not ECDSA")
		}
	}

	// Verify CA name constraints cover PUBLIC_HOST
	if err := m.verifyCANameConstraints(caCert, m.cfg.TLS.PublicHost); err != nil {
		return err
	}

	// Ensure key permissions 0600
	_ = os.Chmod(keyPath, 0600)

	m.caCert = caCert
	m.caPrivKey = caKey
	m.caCertPEM = certPEM
	m.logger.Info("loaded private CA",
		"subject", caCert.Subject.CommonName,
		"sha256_fingerprint", FormatFingerprint(caCert.Raw),
		"expires_at", caCert.NotAfter.Format(time.RFC3339))
	return nil
}

// verifyCANameConstraints verifies that the CA's name constraints cover the configured PUBLIC_HOST.
func (m *Manager) verifyCANameConstraints(caCert *x509.Certificate, publicHost string) error {
	if ip := net.ParseIP(publicHost); ip != nil {
		if len(caCert.PermittedIPRanges) > 0 {
			for _, ipNet := range caCert.PermittedIPRanges {
				if ipNet.Contains(ip) {
					return nil
				}
			}
			return fmt.Errorf("existing CA name constraints do not cover PUBLIC_HOST IP (%s); refusing to start. The CA must be regenerated (set TLS_REGENERATE_CA=true) and every phone must reinstall the new certificate", publicHost)
		}
	} else {
		if len(caCert.PermittedDNSDomains) > 0 {
			for _, domain := range caCert.PermittedDNSDomains {
				if domain == publicHost || strings.HasSuffix(publicHost, "."+domain) {
					return nil
				}
			}
			return fmt.Errorf("existing CA name constraints do not cover PUBLIC_HOST domain (%s); refusing to start. The CA must be regenerated (set TLS_REGENERATE_CA=true) and every phone must reinstall the new certificate", publicHost)
		}
	}
	return nil
}

// generateCA creates a private CA name-constrained to PUBLIC_HOST.
func (m *Manager) generateCA(certPath, keyPath string) error {
	publicHost := m.cfg.TLS.PublicHost

	caPrivKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generating CA private key: %w", err)
	}

	serialNumberLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	caSerial, err := rand.Int(rand.Reader, serialNumberLimit)
	if err != nil {
		return fmt.Errorf("generating CA serial number: %w", err)
	}

	caTemplate := x509.Certificate{
		SerialNumber: caSerial,
		Subject: pkix.Name{
			CommonName:   fmt.Sprintf("RootInbox Private CA (%s)", publicHost),
			Organization: []string{"RootInbox"},
		},
		NotBefore:             time.Now().Add(-1 * time.Hour),
		NotAfter:              time.Now().AddDate(10, 0, 0), // 10 years
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
	}

	// Name constraints to PUBLIC_HOST
	if ip := net.ParseIP(publicHost); ip != nil {
		var mask net.IPMask
		if ip.To4() != nil {
			mask = net.CIDRMask(32, 32)
		} else {
			mask = net.CIDRMask(128, 128)
		}
		caTemplate.PermittedIPRanges = []*net.IPNet{{IP: ip, Mask: mask}}
	} else {
		caTemplate.PermittedDNSDomains = []string{publicHost}
	}

	caDER, err := x509.CreateCertificate(rand.Reader, &caTemplate, &caTemplate, &caPrivKey.PublicKey, caPrivKey)
	if err != nil {
		return fmt.Errorf("creating CA certificate: %w", err)
	}

	caCertPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
	caKeyBytes, err := x509.MarshalECPrivateKey(caPrivKey)
	if err != nil {
		return fmt.Errorf("marshaling CA private key: %w", err)
	}
	caKeyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: caKeyBytes})

	// CA key permissions MUST be 0600
	if err := os.WriteFile(keyPath, caKeyPEM, 0600); err != nil {
		return fmt.Errorf("writing CA private key to %s: %w", keyPath, err)
	}
	_ = os.Chmod(keyPath, 0600)

	if err := os.WriteFile(certPath, caCertPEM, 0644); err != nil {
		return fmt.Errorf("writing CA cert to %s: %w", certPath, err)
	}

	parsedCA, err := x509.ParseCertificate(caDER)
	if err != nil {
		return fmt.Errorf("parsing generated CA cert: %w", err)
	}

	m.caCert = parsedCA
	m.caPrivKey = caPrivKey
	m.caCertPEM = caCertPEM
	m.logger.Info("generated new private CA",
		"subject", parsedCA.Subject.CommonName,
		"sha256_fingerprint", FormatFingerprint(parsedCA.Raw),
		"key_file", keyPath)
	return nil
}

// generateServerCert creates a server leaf certificate signed by the CA.
func (m *Manager) generateServerCert(certPath, keyPath string) error {
	publicHost := m.cfg.TLS.PublicHost

	serverPrivKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generating server private key: %w", err)
	}

	serialNumberLimit := new(big.Int).Lsh(big.NewInt(1), 128)
	serverSerial, err := rand.Int(rand.Reader, serialNumberLimit)
	if err != nil {
		return fmt.Errorf("generating server serial number: %w", err)
	}

	notBefore := time.Now().Add(-1 * time.Hour)
	// iOS rejects certificates valid for longer than 825 days
	notAfter := notBefore.Add(CertificateValidityDays * 24 * time.Hour)

	serverTemplate := x509.Certificate{
		SerialNumber: serverSerial,
		Subject: pkix.Name{
			CommonName:   publicHost,
			Organization: []string{"RootInbox"},
		},
		NotBefore:             notBefore,
		NotAfter:              notAfter,
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IsCA:                  false,
	}

	if ip := net.ParseIP(publicHost); ip != nil {
		serverTemplate.IPAddresses = []net.IP{ip}
	} else {
		serverTemplate.DNSNames = []string{publicHost}
	}

	serverDER, err := x509.CreateCertificate(rand.Reader, &serverTemplate, m.caCert, &serverPrivKey.PublicKey, m.caPrivKey)
	if err != nil {
		return fmt.Errorf("creating server certificate: %w", err)
	}

	serverCertPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: serverDER})
	// Append CA cert to form full chain
	fullChainPEM := append(serverCertPEM, m.caCertPEM...)

	serverKeyBytes, err := x509.MarshalECPrivateKey(serverPrivKey)
	if err != nil {
		return fmt.Errorf("marshaling server key: %w", err)
	}
	serverKeyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: serverKeyBytes})

	if err := os.WriteFile(keyPath, serverKeyPEM, 0600); err != nil {
		return fmt.Errorf("writing server private key to %s: %w", keyPath, err)
	}
	_ = os.Chmod(keyPath, 0600)

	if err := os.WriteFile(certPath, fullChainPEM, 0644); err != nil {
		return fmt.Errorf("writing server certificate chain to %s: %w", certPath, err)
	}

	tlsCert, err := tls.X509KeyPair(fullChainPEM, serverKeyPEM)
	if err != nil {
		return fmt.Errorf("loading generated server keypair: %w", err)
	}

	parsedServer, err := x509.ParseCertificate(serverDER)
	if err != nil {
		return fmt.Errorf("parsing generated server cert: %w", err)
	}

	m.mu.Lock()
	m.currentCert = &tlsCert
	m.serverCert = parsedServer
	m.mu.Unlock()

	m.logger.Info("generated server TLS certificate",
		"host", publicHost,
		"validity_days", CertificateValidityDays,
		"expires_at", notAfter.Format(time.RFC3339))
	return nil
}

// validateServerCert validates SAN, issuer signature from CA, and ensures expiry is greater than RenewalThresholdDays.
func (m *Manager) validateServerCert(cert *x509.Certificate) bool {
	// Verify server cert was signed by the current active CA
	if m.caCert != nil {
		if err := cert.CheckSignatureFrom(m.caCert); err != nil {
			m.logger.Warn("existing server certificate was not signed by active CA; regenerating", "error", err)
			return false
		}
	}

	publicHost := m.cfg.TLS.PublicHost

	// Check validity
	if time.Until(cert.NotAfter) < RenewalThresholdDays*24*time.Hour {
		return false
	}

	// Check SAN
	if ip := net.ParseIP(publicHost); ip != nil {
		found := false
		for _, certIP := range cert.IPAddresses {
			if certIP.Equal(ip) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	} else {
		found := false
		for _, name := range cert.DNSNames {
			if name == publicHost {
				found = true
				break
			}
		}
		if !found && cert.Subject.CommonName != publicHost {
			return false
		}
	}

	return true
}

// TLSConfig returns a tls.Config using GetCertificate for zero-downtime certificate rotation.
func (m *Manager) TLSConfig() *tls.Config {
	return &tls.Config{
		GetCertificate: m.GetCertificate,
		MinVersion:     tls.VersionTLS12,
	}
}

// GetCertificate implements the tls.Config.GetCertificate callback.
func (m *Manager) GetCertificate(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.currentCert == nil {
		return nil, fmt.Errorf("no TLS certificate configured")
	}
	return m.currentCert, nil
}

// CheckAndRenew checks if certificate is nearing expiration and renews it if necessary.
func (m *Manager) CheckAndRenew() (bool, error) {
	if m.cfg.TLS.Mode != "selfsigned" {
		return false, nil
	}

	m.mu.RLock()
	needRenewal := m.serverCert == nil || time.Until(m.serverCert.NotAfter) < RenewalThresholdDays*24*time.Hour
	m.mu.RUnlock()

	if !needRenewal {
		return false, nil
	}

	m.logger.Info("renewing server TLS certificate", "current_expires", m.serverCert.NotAfter)
	serverCertPath := filepath.Join(m.cfg.TLS.DataDir, "server.crt")
	serverKeyPath := filepath.Join(m.cfg.TLS.DataDir, "server.key")
	if err := m.generateServerCert(serverCertPath, serverKeyPath); err != nil {
		return false, fmt.Errorf("renewing server certificate: %w", err)
	}

	return true, nil
}

// StartRenewalWorker periodically checks and renews certificates before expiration.
func (m *Manager) StartRenewalWorker(ctx context.Context, interval time.Duration) {
	if m.cfg.TLS.Mode != "selfsigned" {
		return
	}

	childCtx, cancel := context.WithCancel(ctx)
	m.cancelFunc = cancel

	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		for {
			select {
			case <-childCtx.Done():
				return
			case <-ticker.C:
				if renewed, err := m.CheckAndRenew(); err != nil {
					m.logger.Error("certificate renewal check failed", "error", err)
				} else if renewed {
					m.logger.Info("server TLS certificate renewed successfully")
				}
			}
		}
	}()
}

// Stop stops the renewal worker.
func (m *Manager) Stop() {
	if m.cancelFunc != nil {
		m.cancelFunc()
	}
}

// CACertPEM returns the CA certificate PEM bytes.
func (m *Manager) CACertPEM() []byte {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.caCertPEM
}

// ServerCert returns the current server certificate.
func (m *Manager) ServerCert() *x509.Certificate {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.serverCert
}

// CACert returns the current CA certificate.
func (m *Manager) CACert() *x509.Certificate {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.caCert
}

// FormatFingerprint formats a DER certificate's SHA-256 digest as colon-separated uppercase hex (e.g. AA:BB:CC:...).
func FormatFingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	var sb strings.Builder
	for i, b := range sum {
		if i > 0 {
			sb.WriteByte(':')
		}
		fmt.Fprintf(&sb, "%02X", b)
	}
	return sb.String()
}

// CAFingerprint returns the colon-separated SHA-256 fingerprint of the CA certificate.
func (m *Manager) CAFingerprint() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.caCert == nil {
		return ""
	}
	return FormatFingerprint(m.caCert.Raw)
}

// PrintCAFingerprint prints the SHA-256 fingerprint of the CA certificate to stdout.
func PrintCAFingerprint(cfg *config.Config) error {
	dataDir := cfg.TLS.DataDir
	if dataDir == "" {
		dataDir = "/var/lib/rootinbox/tls"
	}
	caCertPath := filepath.Join(dataDir, "ca.crt")
	certPEM, err := os.ReadFile(caCertPath)
	if err != nil {
		return fmt.Errorf("reading CA certificate from %s: %w", caCertPath, err)
	}
	certBlock, _ := pem.Decode(certPEM)
	if certBlock == nil {
		return fmt.Errorf("failed to decode PEM block from %s", caCertPath)
	}
	caCert, err := x509.ParseCertificate(certBlock.Bytes)
	if err != nil {
		return fmt.Errorf("parsing CA certificate: %w", err)
	}
	fp := FormatFingerprint(caCert.Raw)
	fmt.Printf("SHA256 Fingerprint=%s\n", fp)
	return nil
}

// OnboardingHandler serves /ca.crt and the setup instructions page.
func (m *Manager) OnboardingHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ca.crt" {
			w.Header().Set("Content-Type", "application/x-x509-ca-cert")
			w.Header().Set("Content-Disposition", "attachment; filename=\"rootinbox-ca.crt\"")
			w.Header().Set("Cache-Control", "no-store, no-cache, must-revalidate")
			_, _ = io.WriteString(w, string(m.CACertPEM()))
			return
		}

		// HTML onboarding guide
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-cache")
		publicHost := m.cfg.TLS.PublicHost
		httpsPort := m.cfg.Server.Port
		httpsURL := fmt.Sprintf("https://%s:%d", publicHost, httpsPort)
		if httpsPort == 443 {
			httpsURL = fmt.Sprintf("https://%s", publicHost)
		}
		caFingerprint := m.CAFingerprint()

		html := fmt.Sprintf(`<!DOCTYPE html>
<html lang="fa" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>نصب گواهی امنیتی RootInbox</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; line-height: 1.6; }
    .container { max-width: 680px; margin: 0 auto; background: #1e293b; border-radius: 16px; padding: 32px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); }
    h1 { color: #38bdf8; font-size: 24px; margin-top: 0; }
    h2 { color: #94a3b8; font-size: 18px; margin-top: 24px; border-bottom: 1px solid #334155; padding-bottom: 8px; }
    p, li { font-size: 15px; color: #cbd5e1; }
    .btn { display: inline-block; background: #0284c7; color: white; padding: 12px 24px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 12px 0; transition: background 0.2s; cursor: pointer; border: none; }
    .btn:hover { background: #0369a1; }
    .btn-green { background: #10b981; }
    .btn-green:hover { background: #059669; }
    .btn-copy { background: #475569; padding: 8px 14px; font-size: 13px; }
    .btn-copy:hover { background: #64748b; }
    .badge { background: #334155; padding: 2px 8px; border-radius: 4px; font-family: monospace; color: #38bdf8; }
    .step-box { background: #0f172a; border-left: 4px solid #38bdf8; padding: 16px; border-radius: 8px; margin: 12px 0; }
    .fp-box { background: #0f172a; border-left: 4px solid #10b981; padding: 16px; border-radius: 8px; margin: 16px 0; }
    .warn-box { background: #451a03; border-left: 4px solid #f59e0b; padding: 16px; border-radius: 8px; margin: 16px 0; }
    .en-sub { font-size: 13px; color: #94a3b8; font-family: sans-serif; direction: ltr; text-align: left; margin-top: 4px; }
    .fp-val { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 13px; color: #f1f5f9; background: #1e293b; padding: 10px 14px; border-radius: 6px; border: 1px solid #334155; word-break: break-all; direction: ltr; text-align: left; display: block; margin: 8px 0; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔐 فعال‌سازی اتصال امن RootInbox</h1>
    <p>این سرور چت بر روی آدرس <span class="badge">%s</span> اجرا شده و دارای گواهی امنیتی اختصاصی (Private CA) است. برای استفاده از تمامی امکانات امن (شامل پیام صوتی، تماس، رمزنگاری و سرویس‌ورکر)، گواهی ریشه را روی گوشی خود نصب نمایید.</p>

    <!-- H1 CA Fingerprint Comparison -->
    <div class="fp-box">
      <div style="font-weight: bold; color: #38bdf8; font-size: 16px;">🔍 بررسی اثر انگشت گواهی امنیتی (SHA-256 Fingerprint)</div>
      <p style="margin: 6px 0;">
        <b>اقدام بسیار مهم قبل از نصب:</b> لطفاً اثر انگشت زیر را با مقداری که مدیر سرور از طریق یک کانال ارتباطی جداگانه (مانند تماس صوتی تلفنی) برای شما می‌خواند، <b>قبل از نصب گواهی</b> مقایسه نمایید تا از اصالت گواهی و عدم شنود یا دستکاری اطمینان حاصل فرمایید:
      </p>
      <code id="ca-fingerprint" class="fp-val">%s</code>
      <button type="button" class="btn btn-copy" onclick="navigator.clipboard.writeText(document.getElementById('ca-fingerprint').innerText); this.innerText='✓ کپی شد!';">📋 کپی اثر انگشت</button>
    </div>

    <div style="text-align: center; margin: 24px 0;">
      <a href="/ca.crt" class="btn">⬇️ دانلود فایل گواهی امنیتی (ca.crt)</a>
    </div>

    <!-- H2(c) Server IP Change Warning -->
    <div class="warn-box">
      <div style="font-weight: bold; color: #f59e0b;">⚠️ توجه مهم در مورد تغییر آدرس یا انتقال سرور (New IP):</div>
      <p style="margin: 6px 0 0 0;">
        گواهی ریشه فعلی منحصراً محدود به آدرس <span class="badge">%s</span> صادر گردیده است. در صورتی که سرور به یک آدرس IP یا دامنه جدید منتقل شود، گواهی قبلی منقضی شده و باید گواهی جدید بر روی سرور تولید و مجدداً روی تمامی گوشی‌ها نصب گردد. همچنین در نسخه فعلی، داده‌های محلی مرورگر (IndexedDB) به آدرس و منشأ سرور وابسته‌اند.
      </p>
    </div>

    <h2>📱 راهنمای نصب در اندروید (Android)</h2>
    <div class="step-box">
      <ol>
        <li>دکمه «دانلود فایل گواهی» بالا را لمس کنید تا فایل <span class="badge">rootinbox-ca.crt</span> ذخیره شود.</li>
        <li>به <b>تنظیمات گوشی (Settings)</b> بروید.</li>
        <li>بخش <b>Security</b> یا <b>Security & Privacy</b> را باز کرده و <b>More security settings</b> و سپس <b>Install a certificate</b> را انتخاب کنید (می‌توانید عبارت <span class="badge">CA certificate</span> را در تنظیمات جستجو نمایید).</li>
        <li>گزینه <b>CA certificate</b> را انتخاب کرده و پس از تأیید هشدار، فایل دانلودشده را انتخاب کنید.</li>
      </ol>
    </div>

    <h2>🍏 راهنمای نصب در آیفون (iPhone / iOS)</h2>
    <div class="step-box">
      <ol>
        <li>با مرورگر <b>Safari</b> روی دکمه «دانلود فایل گواهی» بزنید و در پیام ظاهرشده گزینه <b>Allow</b> را لمس کنید.</li>
        <li>به <b>تنظیمات گوشی (Settings)</b> بروید؛ گزینه <b>Profile Downloaded</b> در بالای صفحه ظاهر می‌شود. آن را باز کرده و <b>Install</b> را بزنید.</li>
        <li><b>مرحله بسیار مهم:</b> به آدرس زیر بروید:<br>
          <div class="en-sub">Settings &gt; General &gt; About &gt; Certificate Trust Settings</div>
        </li>
        <li>در بخش <b>Enable full trust for root certificates</b>، سوئیچ مربوط به <span class="badge">RootInbox Private CA</span> را روشن (سبز) کنید و گزینه <b>Continue</b> را تأیید فرمایید.</li>
      </ol>
    </div>

    <div style="text-align: center; margin-top: 32px;">
      <p>پس از انجام مراحل فوق، دکمه زیر را لمس کنید تا چت با پروتکل امن باز شود:</p>
      <a href="%s" class="btn btn-green">🚀 ورود به پیام‌رسان RootInbox (HTTPS)</a>
    </div>
  </div>
</body>
</html>`, publicHost, caFingerprint, publicHost, httpsURL)

		_, _ = io.WriteString(w, html)
	})
}

func fileExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && !info.IsDir()
}
