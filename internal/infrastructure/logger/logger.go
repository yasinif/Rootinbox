// Package logger provides slog configuration and domain Logger implementation.
// RFC-0001 Section 4: Structured Logging (slog).
// RFC-0001A Section 2.1: UseCases MUST NOT depend on slog.Logger directly.
// RFC-0001A Section 6: Logger MUST include Version, BuildHash, BuildTime, GoVersion,
// ConfigSchemaVersion at startup.
package logger

import (
	"log/slog"
	"os"
	"strings"

	"rootinbox/internal/config"
)

// New creates a configured *slog.Logger based on the application configuration.
// RFC-0001 Section 6 Step 3: Initialize logger.
func New(cfg *config.Config) *slog.Logger {
	level := parseLevel(cfg.Log.Level)
	handler := slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		Level: level,
	})
	return slog.New(handler)
}

// LogStartupMetadata logs required build metadata at startup.
// RFC-0001A Section 6: The structured logger MUST include Version, BuildHash,
// BuildTime, GoVersion, and ConfigSchemaVersion at startup.
func LogStartupMetadata(log *slog.Logger, cfg *config.Config) {
	log.Info("application starting",
		"version", cfg.App.Version,
		"build_hash", cfg.App.BuildHash,
		"build_time", cfg.App.BuildTime,
		"go_version", cfg.App.GoVersion,
		"config_schema_version", cfg.App.ConfigSchemaVersion,
	)
}

// DomainLogger implements domain.Logger using slog.
// RFC-0001A Section 2.1: Inject a domain Logger interface if logging
// is strictly required for business logic.
type DomainLogger struct {
	logger *slog.Logger
}

// NewDomainLogger creates a domain.Logger backed by the given slog.Logger.
func NewDomainLogger(l *slog.Logger) *DomainLogger {
	return &DomainLogger{logger: l}
}

// Info logs a message at info level.
func (dl *DomainLogger) Info(msg string, args ...any) {
	dl.logger.Info(msg, args...)
}

// Error logs a message at error level.
func (dl *DomainLogger) Error(msg string, args ...any) {
	dl.logger.Error(msg, args...)
}

func parseLevel(s string) slog.Level {
	switch strings.ToLower(s) {
	case "debug":
		return slog.LevelDebug
	case "warn", "warning":
		return slog.LevelWarn
	case "error":
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}
