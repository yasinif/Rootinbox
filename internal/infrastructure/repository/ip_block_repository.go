package repository

import (
	"context"
	"fmt"

	"github.com/jmoiron/sqlx"
	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"
)

type SQLiteIPBlockRepository struct {
	writer *sqlx.DB
	reader *sqlx.DB
}

func NewIPBlockRepository(writer, reader *sqlx.DB) *SQLiteIPBlockRepository {
	return &SQLiteIPBlockRepository{
		writer: writer,
		reader: reader,
	}
}

func (r *SQLiteIPBlockRepository) getWriter(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.writer
}

func (r *SQLiteIPBlockRepository) Upsert(ctx context.Context, b *domain.IPBlock) error {
	query := `
		INSERT INTO ip_blocks (ip_hash, status, created_at, updated_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(ip_hash) DO UPDATE SET
			status = excluded.status,
			updated_at = excluded.updated_at
	`
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx, query,
		b.IPHash,
		string(b.Status),
		b.CreatedAt,
		b.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("upsert ip block: %w", err)
	}
	return nil
}

func (r *SQLiteIPBlockRepository) GetByIPHash(ctx context.Context, ipHash string) (*domain.IPBlock, error) {
	query := `SELECT ip_hash, status, created_at, updated_at FROM ip_blocks WHERE ip_hash = ?`
	var b domain.IPBlock
	var status string
	err := r.reader.QueryRowContext(ctx, query, ipHash).Scan(
		&b.IPHash,
		&status,
		&b.CreatedAt,
		&b.UpdatedAt,
	)
	if err != nil {
		return nil, fmt.Errorf("get ip block: %w", err)
	}
	b.Status = domain.IPBlockStatus(status)
	return &b, nil
}

func (r *SQLiteIPBlockRepository) ListBlocked(ctx context.Context) ([]*domain.IPBlock, error) {
	query := `SELECT ip_hash, status, created_at, updated_at FROM ip_blocks WHERE status = ?`
	rows, err := r.reader.QueryContext(ctx, query, string(domain.IPBlockStatusBlocked))
	if err != nil {
		return nil, fmt.Errorf("list blocked ips: %w", err)
	}
	defer rows.Close()

	var blocks []*domain.IPBlock
	for rows.Next() {
		var b domain.IPBlock
		var status string
		if err := rows.Scan(&b.IPHash, &status, &b.CreatedAt, &b.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan ip block: %w", err)
		}
		b.Status = domain.IPBlockStatus(status)
		blocks = append(blocks, &b)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("rows blocked ips: %w", err)
	}
	return blocks, nil
}
