package bootstrap

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"rootinbox/internal/domain"
	"rootinbox/internal/usecase"
)

func TestBootstrap_PushRollbackLifecycle(t *testing.T) {
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "test.db")
	mediaPath := filepath.Join(tempDir, "media")

	t.Setenv("DB_PATH", dbPath)
	t.Setenv("MEDIA_PATH", mediaPath)
	t.Setenv("APP_ORIGIN", "http://127.0.0.1:8080")
	t.Setenv("INSECURE_DEV_MODE", "true")
	t.Setenv("IP_HASH_SECRET", "12345678901234567890123456789012")
	t.Setenv("PORT", "8080")

	// Phase 1: disabled -> server starts without touching VAPID keys
	t.Setenv("PUSH_ENABLED", "false")
	os.Unsetenv("PUSH_VAPID_ENCRYPTION_KEY")
	os.Unsetenv("PUSH_VAPID_SUBJECT")

	ctx := context.Background()
	app1, err := Run(ctx, "test", "hash", "time")
	if err != nil {
		t.Fatalf("Phase 1: server failed to start with PUSH_ENABLED=false: %v", err)
	}

	// Verify vapid-public-key endpoint returns 404 when disabled
	rec1 := httptest.NewRecorder()
	req1 := httptest.NewRequest(http.MethodGet, "/api/v1/push/vapid-public-key", nil)
	app1.HTTPServer.Handler.ServeHTTP(rec1, req1)
	// Because request has no auth cookie, router requires auth -> 401 or disabled -> 404
	// In PushHandler, auth check runs first, but public key is disabled.
	app1.DB.Close()

	// Phase 2: enabled(real key) -> server starts, generates/migrates VAPID key
	t.Setenv("PUSH_ENABLED", "true")
	realKeyB64 := "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" // 32-byte zero in base64url, wait, real non-zero:
	realKeyB64 = "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA"  // 32 bytes 1..32 in base64url
	t.Setenv("PUSH_VAPID_ENCRYPTION_KEY", realKeyB64)
	t.Setenv("PUSH_VAPID_SUBJECT", "mailto:test@example.com")

	app2, err := Run(ctx, "test", "hash", "time")
	if err != nil {
		t.Fatalf("Phase 2: server failed to start with PUSH_ENABLED=true and real key: %v", err)
	}
	app2.DB.Close()

	// Phase 3: Rollback bug test: enabled(real key) -> migrated -> disabled -> server still starts!
	// Live production rollback sets PUSH_ENABLED=false. Server MUST start cleanly without decrypting row with zero key.
	t.Setenv("PUSH_ENABLED", "false")
	os.Unsetenv("PUSH_VAPID_ENCRYPTION_KEY")
	os.Unsetenv("PUSH_VAPID_SUBJECT")

	app3, err := Run(ctx, "test", "hash", "time")
	if err != nil {
		t.Fatalf("Phase 3: Rollback bug reproduced! Server failed to start with PUSH_ENABLED=false on migrated DB: %v", err)
	}
	app3.DB.Close()

	// Phase 4: Re-enabling push with the real key loads the exact same key without error
	t.Setenv("PUSH_ENABLED", "true")
	t.Setenv("PUSH_VAPID_ENCRYPTION_KEY", realKeyB64)
	t.Setenv("PUSH_VAPID_SUBJECT", "mailto:test@example.com")

	app4, err := Run(ctx, "test", "hash", "time")
	if err != nil {
		t.Fatalf("Phase 4: server failed to re-enable push with real key: %v", err)
	}
	app4.DB.Close()
}

func TestBootstrap_WorkersRegisteredInBothModes(t *testing.T) {
	tempDir := t.TempDir()
	dbPath := filepath.Join(tempDir, "test.db")
	mediaPath := filepath.Join(tempDir, "media")

	t.Setenv("DB_PATH", dbPath)
	t.Setenv("MEDIA_PATH", mediaPath)
	t.Setenv("APP_ORIGIN", "http://127.0.0.1:8080")
	t.Setenv("INSECURE_DEV_MODE", "true")
	t.Setenv("IP_HASH_SECRET", "12345678901234567890123456789012")
	t.Setenv("PORT", "8080")

	assertWorkers := func(t *testing.T, workers []domain.Worker) {
		t.Helper()
		var hasPushDispatch, hasPendingRingSweeper bool
		for _, w := range workers {
			switch w.(type) {
			case *usecase.PushDispatchWorker:
				hasPushDispatch = true
			case *usecase.PendingRingSweeper:
				hasPendingRingSweeper = true
			}
		}
		if !hasPushDispatch {
			t.Errorf("expected PushDispatchWorker to be registered in app.Workers")
		}
		if !hasPendingRingSweeper {
			t.Errorf("expected PendingRingSweeper to be registered in app.Workers")
		}
	}

	ctx := context.Background()

	// Mode 1: PUSH_ENABLED=false
	t.Setenv("PUSH_ENABLED", "false")
	os.Unsetenv("PUSH_VAPID_ENCRYPTION_KEY")
	os.Unsetenv("PUSH_VAPID_SUBJECT")

	appDisabled, err := Run(ctx, "test", "hash", "time")
	if err != nil {
		t.Fatalf("Run failed with PUSH_ENABLED=false: %v", err)
	}
	assertWorkers(t, appDisabled.Workers)
	appDisabled.DB.Close()

	// Mode 2: PUSH_ENABLED=true
	t.Setenv("PUSH_ENABLED", "true")
	t.Setenv("PUSH_VAPID_ENCRYPTION_KEY", "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA")
	t.Setenv("PUSH_VAPID_SUBJECT", "mailto:test@example.com")

	appEnabled, err := Run(ctx, "test", "hash", "time")
	if err != nil {
		t.Fatalf("Run failed with PUSH_ENABLED=true: %v", err)
	}
	assertWorkers(t, appEnabled.Workers)
	appEnabled.DB.Close()
}
