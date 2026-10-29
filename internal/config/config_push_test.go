package config

import (
	"crypto/rand"
	"encoding/base64"
	"os"
	"strings"
	"testing"
)

func TestConfig_PowerShellGeneratedKey_Accepted(t *testing.T) {
	// Generate key exactly like the PowerShell snippet:
	// $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b);
	// [Convert]::ToBase64String($b).TrimEnd('=').Replace('+','-').Replace('/','_')
	rawBytes := make([]byte, 32)
	_, _ = rand.Read(rawBytes)
	pwshKey := strings.TrimRight(base64.URLEncoding.EncodeToString(rawBytes), "=")

	t.Setenv("PUSH_ENABLED", "true")
	t.Setenv("PUSH_VAPID_ENCRYPTION_KEY", pwshKey)
	t.Setenv("PUSH_VAPID_SUBJECT", "mailto:admin@example.com")
	t.Setenv("APP_ORIGIN", "http://127.0.0.1:8080")
	t.Setenv("INSECURE_DEV_MODE", "true")
	t.Setenv("IP_HASH_SECRET", "12345678901234567890123456789012")

	cfg := Load("1.0.0", "hash", "time")
	if err := Validate(cfg); err != nil {
		t.Fatalf("expected valid config for PowerShell-generated base64url key, got: %v", err)
	}

	if cfg.Push.VAPIDEncryptionKey != [32]byte(rawBytes) {
		t.Fatalf("decoded key does not match raw bytes")
	}
}

func TestConfig_PushEnabled_MissingKeyOrSubject_ClearStartupError(t *testing.T) {
	t.Setenv("APP_ORIGIN", "http://127.0.0.1:8080")
	t.Setenv("INSECURE_DEV_MODE", "true")
	t.Setenv("IP_HASH_SECRET", "12345678901234567890123456789012")

	// 1. Missing Key
	t.Setenv("PUSH_ENABLED", "true")
	os.Unsetenv("PUSH_VAPID_ENCRYPTION_KEY")
	t.Setenv("PUSH_VAPID_SUBJECT", "mailto:admin@example.com")

	cfgKeyMissing := Load("1.0.0", "hash", "time")
	errKeyMissing := Validate(cfgKeyMissing)
	if errKeyMissing == nil || !strings.Contains(errKeyMissing.Error(), "PUSH_VAPID_ENCRYPTION_KEY is required") {
		t.Fatalf("expected clear error for missing key, got: %v", errKeyMissing)
	}

	// 2. Missing Subject
	t.Setenv("PUSH_ENABLED", "true")
	t.Setenv("PUSH_VAPID_ENCRYPTION_KEY", "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA")
	os.Unsetenv("PUSH_VAPID_SUBJECT")

	cfgSubjectMissing := Load("1.0.0", "hash", "time")
	errSubjectMissing := Validate(cfgSubjectMissing)
	if errSubjectMissing == nil || !strings.Contains(errSubjectMissing.Error(), "PUSH_VAPID_SUBJECT is required") {
		t.Fatalf("expected clear error for missing subject, got: %v", errSubjectMissing)
	}
}

func TestConfig_DatabasePath_NotHardcoded(t *testing.T) {
	// Default
	os.Unsetenv("DB_PATH")
	cfgDefault := Load("1.0.0", "hash", "time")
	if cfgDefault.Database.Path != "rootinbox.db" {
		t.Fatalf("expected default db path rootinbox.db, got %s", cfgDefault.Database.Path)
	}

	// Custom from env
	t.Setenv("DB_PATH", "/data/db/app.db")
	cfgEnv := Load("1.0.0", "hash", "time")
	if cfgEnv.Database.Path != "/data/db/app.db" {
		t.Fatalf("expected db path from env /data/db/app.db, got %s", cfgEnv.Database.Path)
	}
}

func TestConfig_PushEnabled_PaddedKey_Rejected(t *testing.T) {
	t.Setenv("APP_ORIGIN", "http://127.0.0.1:8080")
	t.Setenv("INSECURE_DEV_MODE", "true")
	t.Setenv("IP_HASH_SECRET", "12345678901234567890123456789012")
	t.Setenv("PUSH_ENABLED", "true")
	t.Setenv("PUSH_VAPID_SUBJECT", "mailto:admin@example.com")
	t.Setenv("PUSH_VAPID_ENCRYPTION_KEY", "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=")

	cfg := Load("1.0.0", "hash", "time")
	err := Validate(cfg)
	if err == nil || !strings.Contains(err.Error(), "padding '=' is rejected") {
		t.Fatalf("expected clear rejection of padded key, got: %v", err)
	}
}
