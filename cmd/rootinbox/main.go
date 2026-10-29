// RootInbox — Zero-Knowledge E2EE Messaging PWA
// Entry point for the single-binary Go backend.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"rootinbox/internal/bootstrap"
	"rootinbox/internal/config"
	"rootinbox/internal/infrastructure/tlsman"
)

// Build-time variables, set via -ldflags.
// Example: go build -ldflags "-X main.version=1.0.0 -X main.buildHash=abc123 -X main.buildTime=2026-01-01T00:00:00Z"
var (
	version   = "dev"
	buildHash = "unknown"
	buildTime = "unknown"
)

func main() {
	// CLI subcommand / flag to print CA fingerprint (H1 requirement)
	if len(os.Args) > 1 {
		arg := os.Args[1]
		if arg == "-ca-fingerprint" || arg == "--ca-fingerprint" || arg == "ca-fingerprint" ||
			arg == "fingerprint" || arg == "-fingerprint" || arg == "--fingerprint" {
			cfg := config.Load(version, buildHash, buildTime)
			if err := tlsman.PrintCAFingerprint(cfg); err != nil {
				fmt.Fprintf(os.Stderr, "Error: %v\n", err)
				os.Exit(1)
			}
			os.Exit(0)
		}
		if arg == "admin" && len(os.Args) >= 3 && os.Args[2] == "reset-key" {
			cfg := config.Load(version, buildHash, buildTime)
			rawKey, err := config.ResetAdminKey(cfg.DataDir)
			if err != nil {
				fmt.Fprintf(os.Stderr, "Error resetting admin key: %v\n", err)
				os.Exit(1)
			}
			fmt.Println("================================================================================")
			fmt.Println(" ROOTINBOX ADMIN API KEY RESET (PRINTED ONCE)")
			fmt.Printf(" New Admin API Key: %s\n", rawKey)
			fmt.Println(" Store this key securely. It will never be displayed in logs again.")
			fmt.Println("================================================================================")
			os.Exit(0)
		}
	}

	// Create root context for the application lifecycle.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// RFC-0001 Section 6: Execute the bootstrap sequence.
	// RFC-0001A Section 5.2: Any startup failure MUST abort (Fail Fast).
	app, err := bootstrap.Run(ctx, version, buildHash, buildTime)
	if err != nil {
		slog.Error("startup failed", "error", err)
		os.Exit(1)
	}

	// Log unified zero-config startup summary
	config.LogStartupSummary(app.Logger, app.Config)

	// Wait for shutdown signal or server error.
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-quit:
		slog.Info("shutdown signal received", "signal", sig.String())
	case err := <-app.ErrCh:
		slog.Error("server error", "error", err)
	}

	// Cancel root context to propagate shutdown.
	cancel()

	// RFC-0001A Section 5.5: Graceful Shutdown Sequence (30s Timeout).
	if err := app.Shutdown(); err != nil {
		slog.Error("shutdown error", "error", err)
		os.Exit(1)
	}

	// RFC-0001A Section 5.5: Exit(0).
	os.Exit(0)
}
