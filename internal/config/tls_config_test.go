package config_test

import (
	"testing"

	"rootinbox/internal/config"
)

func setMinimalValidEnv(t *testing.T) {
	t.Helper()
	t.Setenv("PORT", "8443")
	t.Setenv("IP_HASH_SECRET", "12345678901234567890123456789012")
	t.Setenv("PUSH_ENABLED", "false")
	t.Setenv("DB_PATH", "test.db")
}

func TestConfig_TLS_Mode_Off_Default(t *testing.T) {
	setMinimalValidEnv(t)
	t.Setenv("APP_ORIGIN", "https://example.com")
	t.Setenv("TRUSTED_PROXIES_CIDR", "10.0.0.0/8")

	cfg := config.Load("1.0.0", "hash", "time")
	if cfg.TLS.Mode != "off" {
		t.Fatalf("expected default TLS.Mode to be 'off', got %s", cfg.TLS.Mode)
	}

	if err := config.Validate(cfg); err != nil {
		t.Fatalf("unexpected validation error: %v", err)
	}
}

func TestConfig_TLS_Mode_SelfSigned_RequiresPublicHost(t *testing.T) {
	setMinimalValidEnv(t)
	t.Setenv("TLS_MODE", "selfsigned")
	t.Setenv("PUBLIC_HOST", "")

	cfg := config.Load("1.0.0", "hash", "time")
	err := config.Validate(cfg)
	if err == nil {
		t.Fatal("expected error when PUBLIC_HOST is empty with TLS_MODE=selfsigned")
	}
}

func TestConfig_TLS_Mode_SelfSigned_AutoDerivesAppOrigin(t *testing.T) {
	setMinimalValidEnv(t)
	t.Setenv("TLS_MODE", "selfsigned")
	t.Setenv("PUBLIC_HOST", "192.168.1.50")
	t.Setenv("PORT", "8443")
	// Notice: APP_ORIGIN not set, TRUSTED_PROXIES_CIDR not set

	cfg := config.Load("1.0.0", "hash", "time")
	if cfg.Security.AppOrigin != "https://192.168.1.50:8443" {
		t.Fatalf("expected APP_ORIGIN to be 'https://192.168.1.50:8443', got '%s'", cfg.Security.AppOrigin)
	}

	if err := config.Validate(cfg); err != nil {
		t.Fatalf("unexpected validation error for valid selfsigned config: %v", err)
	}
}

func TestConfig_TLS_Mode_SelfSigned_AutoDerivesAppOrigin_Port443(t *testing.T) {
	setMinimalValidEnv(t)
	t.Setenv("TLS_MODE", "selfsigned")
	t.Setenv("PUBLIC_HOST", "192.168.1.50")
	t.Setenv("PORT", "443")

	cfg := config.Load("1.0.0", "hash", "time")
	if cfg.Security.AppOrigin != "https://192.168.1.50" {
		t.Fatalf("expected APP_ORIGIN to be 'https://192.168.1.50', got '%s'", cfg.Security.AppOrigin)
	}

	if err := config.Validate(cfg); err != nil {
		t.Fatalf("unexpected validation error: %v", err)
	}
}

func TestConfig_TLS_Mode_Files_RequiresCertAndKey(t *testing.T) {
	setMinimalValidEnv(t)
	t.Setenv("TLS_MODE", "files")
	t.Setenv("APP_ORIGIN", "https://example.com:8443")

	cfg := config.Load("1.0.0", "hash", "time")
	err := config.Validate(cfg)
	if err == nil {
		t.Fatal("expected error when TLS_CERT_FILE/TLS_KEY_FILE are missing in files mode")
	}

	t.Setenv("TLS_CERT_FILE", "server.crt")
	t.Setenv("TLS_KEY_FILE", "server.key")
	cfg = config.Load("1.0.0", "hash", "time")
	if err := config.Validate(cfg); err != nil {
		t.Fatalf("unexpected error with cert and key files provided: %v", err)
	}
}

func TestConfig_TLS_Mode_Invalid(t *testing.T) {
	setMinimalValidEnv(t)
	t.Setenv("TLS_MODE", "invalid_mode")
	t.Setenv("APP_ORIGIN", "https://example.com")

	cfg := config.Load("1.0.0", "hash", "time")
	err := config.Validate(cfg)
	if err == nil {
		t.Fatal("expected error for invalid TLS_MODE")
	}
}

func TestConfig_IPHashSecret_RejectChangeThis(t *testing.T) {
	setMinimalValidEnv(t)
	t.Setenv("TLS_MODE", "selfsigned")
	t.Setenv("PUBLIC_HOST", "127.0.0.1")
	t.Setenv("IP_HASH_SECRET", "CHANGE_THIS_GENERATE_WITH_OPENSSL_RAND_HEX_32")

	cfg := config.Load("1.0.0", "hash", "time")
	err := config.Validate(cfg)
	if err == nil {
		t.Fatal("expected error when IP_HASH_SECRET contains CHANGE_THIS placeholder")
	}
}

func TestConfig_TURNSecret_RejectChangeThis(t *testing.T) {
	setMinimalValidEnv(t)
	t.Setenv("TLS_MODE", "selfsigned")
	t.Setenv("PUBLIC_HOST", "127.0.0.1")
	t.Setenv("TURN_ENABLED", "true")
	t.Setenv("TURN_ACTIVE_SECRET", "CHANGE_THIS_TO_A_RANDOM_32_BYTES_SECRET_KEY_123456")

	cfg := config.Load("1.0.0", "hash", "time")
	err := config.Validate(cfg)
	if err == nil {
		t.Fatal("expected error when TURN_ACTIVE_SECRET contains CHANGE_THIS placeholder")
	}
}

func TestConfig_AdminSecret_RejectChangeThis(t *testing.T) {
	setMinimalValidEnv(t)
	t.Setenv("TLS_MODE", "selfsigned")
	t.Setenv("PUBLIC_HOST", "127.0.0.1")
	t.Setenv("ADMIN_ENABLED", "true")
	t.Setenv("ADMIN_API_KEY_HASH_ACTIVE", "CHANGE_THIS_GENERATE_WITH_OPENSSL_RAND_HEX_32")

	cfg := config.Load("1.0.0", "hash", "time")
	err := config.Validate(cfg)
	if err == nil {
		t.Fatal("expected error when ADMIN_API_KEY_HASH_ACTIVE contains CHANGE_THIS placeholder")
	}
}

func TestConfig_TLS_RegenerateCA_Parsing(t *testing.T) {
	setMinimalValidEnv(t)
	t.Setenv("TLS_MODE", "selfsigned")
	t.Setenv("PUBLIC_HOST", "127.0.0.1")

	// Default should be false
	cfg := config.Load("1.0.0", "hash", "time")
	if cfg.TLS.RegenerateCA {
		t.Fatal("expected default RegenerateCA to be false")
	}

	// "true"
	t.Setenv("TLS_REGENERATE_CA", "true")
	cfg = config.Load("1.0.0", "hash", "time")
	if !cfg.TLS.RegenerateCA {
		t.Fatal("expected RegenerateCA to be true when TLS_REGENERATE_CA=true")
	}

	// "1"
	t.Setenv("TLS_REGENERATE_CA", "1")
	cfg = config.Load("1.0.0", "hash", "time")
	if !cfg.TLS.RegenerateCA {
		t.Fatal("expected RegenerateCA to be true when TLS_REGENERATE_CA=1")
	}
}
