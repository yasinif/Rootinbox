// Package migrations provides the migration runner and migration registry.
// RFC-0001 Section 5: Build a dedicated Migration Runner.
// RFC-0001A Section 5.6: Versioned, monotonic, idempotent, BEGIN IMMEDIATE.
package migrations

import (
	"context"
	"embed"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"github.com/jmoiron/sqlx"
)

// sqlFiles embeds the SQL migration files.
// RFC-0001 §5: Use explicit 000001_init.up.sql and .down.sql.
//
//go:embed sql/*.sql
var sqlFiles embed.FS

// Migration represents a single schema migration step.
// RFC-0001 Section 5: Use explicit 000001_init.up.sql and .down.sql format.
type Migration struct {
	Version     int
	Description string
	Up          string
	Down        string
}

// Runner applies database migrations sequentially.
// RFC-0001A Section 5.6: Schema versions MUST be monotonic.
// Migrations MUST use BEGIN IMMEDIATE. Idempotent (safe to execute repeatedly).
type Runner struct {
	db         *sqlx.DB
	migrations []Migration
	logger     *slog.Logger
}

// NewRunner creates a migration Runner using the Writer DB.
// The Writer DB has MaxOpenConns=1, ensuring single-writer migration safety.
func NewRunner(writerDB *sqlx.DB, migrations []Migration, logger *slog.Logger) *Runner {
	return &Runner{
		db:         writerDB,
		migrations: migrations,
		logger:     logger,
	}
}

// Run applies all pending migrations in monotonic version order.
// RFC-0001A Section 5.2: Any startup failure MUST abort (Fail Fast).
// RFC-0001A Section 5.6: MUST NOT partially succeed silently.
func (r *Runner) Run(ctx context.Context) error {
	if err := r.ensureMigrationTable(ctx); err != nil {
		return fmt.Errorf("ensuring migration table: %w", err)
	}

	applied, err := r.appliedVersions(ctx)
	if err != nil {
		return fmt.Errorf("getting applied versions: %w", err)
	}

	// Sort migrations by version (monotonic order).
	sorted := make([]Migration, len(r.migrations))
	copy(sorted, r.migrations)
	sort.Slice(sorted, func(i, j int) bool {
		return sorted[i].Version < sorted[j].Version
	})

	// Validate monotonic versioning.
	for i := 1; i < len(sorted); i++ {
		if sorted[i].Version <= sorted[i-1].Version {
			return fmt.Errorf("non-monotonic migration versions: %d and %d", sorted[i-1].Version, sorted[i].Version)
		}
	}

	for _, m := range sorted {
		if applied[m.Version] {
			continue // Already applied (idempotent).
		}
		if err := r.apply(ctx, m); err != nil {
			return fmt.Errorf("applying migration %06d (%s): %w", m.Version, m.Description, err)
		}
		r.logger.Info("migration applied",
			"version", m.Version,
			"description", m.Description,
		)
	}

	return nil
}

// IsComplete checks if all registered migrations have been applied.
// Used by the health probe to verify migration readiness.
func (r *Runner) IsComplete(ctx context.Context) (bool, error) {
	if err := r.ensureMigrationTable(ctx); err != nil {
		return false, fmt.Errorf("ensuring migration table: %w", err)
	}

	applied, err := r.appliedVersions(ctx)
	if err != nil {
		return false, fmt.Errorf("getting applied versions: %w", err)
	}

	for _, m := range r.migrations {
		if !applied[m.Version] {
			return false, nil
		}
	}
	return true, nil
}

func (r *Runner) ensureMigrationTable(ctx context.Context) error {
	// RFC-0001 Section 5: Timestamps stored as INTEGER (UNIX Epoch Time).
	_, err := r.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version     INTEGER PRIMARY KEY,
			description TEXT    NOT NULL,
			applied_at  INTEGER NOT NULL
		)
	`)
	if err != nil {
		return fmt.Errorf("creating schema_migrations table: %w", err)
	}
	return nil
}

func (r *Runner) appliedVersions(ctx context.Context) (map[int]bool, error) {
	rows, err := r.db.QueryContext(ctx, "SELECT version FROM schema_migrations ORDER BY version")
	if err != nil {
		return nil, fmt.Errorf("querying applied versions: %w", err)
	}
	defer rows.Close()

	applied := make(map[int]bool)
	for rows.Next() {
		var v int
		if err := rows.Scan(&v); err != nil {
			return nil, fmt.Errorf("scanning version: %w", err)
		}
		applied[v] = true
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterating versions: %w", err)
	}
	return applied, nil
}

// apply executes a single migration within a BEGIN IMMEDIATE transaction.
// RFC-0001A Section 5.6: MUST use BEGIN IMMEDIATE to prevent concurrent race conditions.
func (r *Runner) apply(ctx context.Context, m Migration) error {
	// Use a dedicated connection to ensure BEGIN IMMEDIATE, migration SQL,
	// and COMMIT all execute on the same connection.
	// sqlx.DB embeds *sql.DB, so Conn(ctx) is available via promotion.
	conn, err := r.db.Conn(ctx)
	if err != nil {
		return fmt.Errorf("getting connection: %w", err)
	}
	defer conn.Close()

	// RFC-0001A Section 5.6: MUST use BEGIN EXCLUSIVE (or BEGIN IMMEDIATE).
	if _, err := conn.ExecContext(ctx, "BEGIN IMMEDIATE"); err != nil {
		return fmt.Errorf("BEGIN IMMEDIATE: %w", err)
	}

	committed := false
	defer func() {
		if !committed {
			_, _ = conn.ExecContext(ctx, "ROLLBACK")
		}
	}()

	if _, err := conn.ExecContext(ctx, m.Up); err != nil {
		return fmt.Errorf("executing up SQL: %w", err)
	}

	// RFC-0001 Section 5: Timestamps stored as INTEGER (UNIX Epoch Time).
	if _, err := conn.ExecContext(ctx,
		"INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)",
		m.Version, m.Description, time.Now().UTC().Unix(),
	); err != nil {
		return fmt.Errorf("recording migration version: %w", err)
	}

	if _, err := conn.ExecContext(ctx, "COMMIT"); err != nil {
		return fmt.Errorf("committing migration: %w", err)
	}
	committed = true

	return nil
}

// All returns the complete list of registered migrations.
// RFC-0002: Phase 2 adds the 000001_init migration with core domain tables.
// RFC-0004: Phase 4 adds the 000002_sessions migration.
// RFC-0005: Phase 5 adds the 000003_messages migration.
// RFC-0006: Phase 6 adds the 000004_sync migration.
func All() []Migration {
	return []Migration{
		{
			Version:     1,
			Description: "init",
			Up:          mustReadSQL("sql/000001_init.up.sql"),
			Down:        mustReadSQL("sql/000001_init.down.sql"),
		},
		{
			Version:     2,
			Description: "sessions",
			Up:          mustReadSQL("sql/000002_sessions.up.sql"),
			Down:        mustReadSQL("sql/000002_sessions.down.sql"),
		},
		{
			Version:     3,
			Description: "messages",
			Up:          mustReadSQL("sql/000003_messages.up.sql"),
			Down:        mustReadSQL("sql/000003_messages.down.sql"),
		},
		{
			Version:     4,
			Description: "sync",
			Up:          mustReadSQL("sql/000004_sync.up.sql"),
			Down:        mustReadSQL("sql/000004_sync.down.sql"),
		},
		{
			Version:     5,
			Description: "media",
			Up:          mustReadSQL("sql/000005_media.up.sql"),
			Down:        mustReadSQL("sql/000005_media.down.sql"),
		},
		{
			Version:     6,
			Description: "calls",
			Up:          mustReadSQL("sql/000006_calls.up.sql"),
			Down:        mustReadSQL("sql/000006_calls.down.sql"),
		},
		{
			Version:     7,
			Description: "push",
			Up:          mustReadSQL("sql/000007_push.up.sql"),
			Down:        mustReadSQL("sql/000007_push.down.sql"),
		},
		{
			Version:     8,
			Description: "security",
			Up:          mustReadSQL("sql/000008_security.up.sql"),
			Down:        mustReadSQL("sql/000008_security.down.sql"),
		},
		{
			Version:     9,
			Description: "session_signature",
			Up:          mustReadSQL("sql/000009_session_signature.up.sql"),
			Down:        mustReadSQL("sql/000009_session_signature.down.sql"),
		},
		{
			Version:     10,
			Description: "username",
			Up:          mustReadSQL("sql/000010_username.up.sql"),
			Down:        mustReadSQL("sql/000010_username.down.sql"),
		},
		{
			Version:     11,
			Description: "groups_and_channels",
			Up:          mustReadSQL("sql/000011_groups_and_channels.up.sql"),
			Down:        mustReadSQL("sql/000011_groups_and_channels.down.sql"),
		},
		{
			Version:     12,
			Description: "user_avatar",
			Up:          mustReadSQL("sql/000012_user_avatar.up.sql"),
			Down:        mustReadSQL("sql/000012_user_avatar.down.sql"),
		},
		{
			Version:     13,
			Description: "user_profile",
			Up:          mustReadSQL("sql/000013_user_profile.up.sql"),
			Down:        mustReadSQL("sql/000013_user_profile.down.sql"),
		},
		{
			Version:     14,
			Description: "message_history",
			Up:          mustReadSQL("sql/000014_message_history.up.sql"),
			Down:        mustReadSQL("sql/000014_message_history.down.sql"),
		},
		{
			Version:     15,
			Description: "active_sessions",
			Up:          mustReadSQL("sql/000015_active_sessions.up.sql"),
			Down:        mustReadSQL("sql/000015_active_sessions.down.sql"),
		},
		{
			Version:     16,
			Description: "conversation_privacy",
			Up:          mustReadSQL("sql/000016_conversation_privacy.up.sql"),
			Down:        mustReadSQL("sql/000016_conversation_privacy.down.sql"),
		},
		{
			Version:     17,
			Description: "read_watermarks",
			Up:          mustReadSQL("sql/000017_read_watermarks.up.sql"),
			Down:        mustReadSQL("sql/000017_read_watermarks.down.sql"),
		},
		{
			Version:     18,
			Description: "delivery_acks",
			Up:          mustReadSQL("sql/000018_delivery_acks.up.sql"),
			Down:        mustReadSQL("sql/000018_delivery_acks.down.sql"),
		},
		{
			Version:     19,
			Description: "delivery_watermarks",
			Up:          mustReadSQL("sql/000019_delivery_watermarks.up.sql"),
			Down:        mustReadSQL("sql/000019_delivery_watermarks.down.sql"),
		},
		{
			Version:     20,
			Description: "cleanup_corrupted_messages",
			Up:          mustReadSQL("sql/000020_cleanup_corrupted_messages.up.sql"),
			Down:        mustReadSQL("sql/000020_cleanup_corrupted_messages.down.sql"),
		},
		{
			Version:     21,
			Description: "user_presence_last_seen",
			Up:          mustReadSQL("sql/000021_user_presence_last_seen.up.sql"),
			Down:        mustReadSQL("sql/000021_user_presence_last_seen.down.sql"),
		},
	}
}

// mustReadSQL reads an embedded SQL file or panics.
// Called at startup; panics are acceptable for missing embedded files.
func mustReadSQL(name string) string {
	data, err := sqlFiles.ReadFile(name)
	if err != nil {
		panic(fmt.Sprintf("reading embedded SQL file %s: %v", name, err))
	}
	return string(data)
}

