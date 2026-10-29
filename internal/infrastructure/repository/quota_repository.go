package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jmoiron/sqlx"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"
)

type quotaModel struct {
	UserID          string `db:"user_id"`
	QuotaLimitBytes int64  `db:"quota_limit_bytes"`
	ReservedBytes   int64  `db:"reserved_bytes"`
	CommittedBytes  int64  `db:"committed_bytes"`
}

func (m *quotaModel) toDomain() *domain.UserQuota {
	return &domain.UserQuota{
		UserID:          m.UserID,
		QuotaLimitBytes: m.QuotaLimitBytes,
		ReservedBytes:   m.ReservedBytes,
		CommittedBytes:  m.CommittedBytes,
	}
}

// SQLiteQuotaRepository implements domain.QuotaRepository.
type SQLiteQuotaRepository struct {
	writer *sqlx.DB
	reader *sqlx.DB
}

func NewQuotaRepository(writer, reader *sqlx.DB) *SQLiteQuotaRepository {
	return &SQLiteQuotaRepository{writer: writer, reader: reader}
}

func (r *SQLiteQuotaRepository) getWriter(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.writer
}

// GetOrCreate retrieves a quota record, creating with defaults if missing.
func (r *SQLiteQuotaRepository) GetOrCreate(ctx context.Context, userID string, defaultLimitBytes int64) (*domain.UserQuota, error) {
	db := r.getWriter(ctx)

	// Try INSERT OR IGNORE first, then SELECT.
	_, err := db.ExecContext(ctx,
		`INSERT OR IGNORE INTO user_quotas (user_id, quota_limit_bytes, reserved_bytes, committed_bytes)
		 VALUES (?, ?, 0, 0)`,
		userID, defaultLimitBytes,
	)
	if err != nil {
		return nil, fmt.Errorf("ensuring quota record: %w", err)
	}

	var model quotaModel
	// Read from writer to ensure we see our own writes within a transaction.
	err = sqlx.GetContext(ctx, db, &model,
		`SELECT user_id, quota_limit_bytes, reserved_bytes, committed_bytes
		 FROM user_quotas WHERE user_id = ?`, userID,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("quota record not found after insert: %w", err)
		}
		return nil, fmt.Errorf("querying quota: %w", err)
	}
	return model.toDomain(), nil
}

// ReserveBytes atomically adds to reserved_bytes.
// RFC-0007 §8.2 INIT: reserved_bytes += paddedSize.
func (r *SQLiteQuotaRepository) ReserveBytes(ctx context.Context, userID string, bytes int64) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx,
		"UPDATE user_quotas SET reserved_bytes = reserved_bytes + ? WHERE user_id = ?",
		bytes, userID,
	)
	if err != nil {
		return fmt.Errorf("reserving quota bytes: %w", err)
	}
	return nil
}

// CommitBytes moves bytes from reserved to committed.
// RFC-0007 §8.2 FINALIZE: reserved -= paddedSize, committed += paddedSize.
func (r *SQLiteQuotaRepository) CommitBytes(ctx context.Context, userID string, bytes int64) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx,
		`UPDATE user_quotas
		 SET reserved_bytes = reserved_bytes - ?, committed_bytes = committed_bytes + ?
		 WHERE user_id = ?`,
		bytes, bytes, userID,
	)
	if err != nil {
		return fmt.Errorf("committing quota bytes: %w", err)
	}
	return nil
}

// ReleaseReserved subtracts from reserved_bytes.
// RFC-0007 §8.2 DELETE from PENDING: reserved -= paddedSize.
func (r *SQLiteQuotaRepository) ReleaseReserved(ctx context.Context, userID string, bytes int64) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx,
		"UPDATE user_quotas SET reserved_bytes = reserved_bytes - ? WHERE user_id = ?",
		bytes, userID,
	)
	if err != nil {
		return fmt.Errorf("releasing reserved quota: %w", err)
	}
	return nil
}

// ReleaseCommitted subtracts from committed_bytes.
// RFC-0007 §8.2 DELETE from FINALIZED: committed -= paddedSize.
func (r *SQLiteQuotaRepository) ReleaseCommitted(ctx context.Context, userID string, bytes int64) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx,
		"UPDATE user_quotas SET committed_bytes = committed_bytes - ? WHERE user_id = ?",
		bytes, userID,
	)
	if err != nil {
		return fmt.Errorf("releasing committed quota: %w", err)
	}
	return nil
}
