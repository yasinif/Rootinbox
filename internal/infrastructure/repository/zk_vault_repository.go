// Package repository contains SQLite implementations of Domain interfaces.
package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/jmoiron/sqlx"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"
)

type zkVaultModel struct {
	UserID     string `db:"user_id"`
	Version    int    `db:"version"`
	Ciphertext []byte `db:"ciphertext"`
	Signature  string `db:"signature"`
	UpdatedAt  int64  `db:"updated_at"`
}

func (m *zkVaultModel) toDomain() *domain.ZKVault {
	return &domain.ZKVault{
		UserID:     m.UserID,
		Version:    m.Version,
		Ciphertext: m.Ciphertext,
		Signature:  m.Signature,
		UpdatedAt:  m.UpdatedAt,
	}
}

// SQLiteZKVaultRepository implements domain.ZKVaultRepository using SQLite.
type SQLiteZKVaultRepository struct {
	writer *sqlx.DB
	reader *sqlx.DB
}

// NewZKVaultRepository creates a new SQLite-backed ZKVaultRepository.
func NewZKVaultRepository(writer, reader *sqlx.DB) *SQLiteZKVaultRepository {
	return &SQLiteZKVaultRepository{writer: writer, reader: reader}
}

func (r *SQLiteZKVaultRepository) getWriter(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.writer
}

func (r *SQLiteZKVaultRepository) getReader(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.reader
}

// GetByUserID retrieves the zero-knowledge vault for a user.
func (r *SQLiteZKVaultRepository) GetByUserID(ctx context.Context, userID string) (*domain.ZKVault, error) {
	db := r.getReader(ctx)
	var m zkVaultModel
	err := sqlx.GetContext(ctx, db, &m,
		"SELECT user_id, version, ciphertext, signature, updated_at FROM zk_vaults WHERE user_id = ?",
		userID,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, domain.NewDomainError(domain.ErrVault003, "zk vault not found", nil)
		}
		return nil, fmt.Errorf("querying zk_vault: %w", err)
	}
	return m.toDomain(), nil
}

// Save persists an initial vault or updates an existing vault with optimistic concurrency control.
func (r *SQLiteZKVaultRepository) Save(ctx context.Context, vault *domain.ZKVault, expectedVersion int) error {
	db := r.getWriter(ctx)
	if expectedVersion == 0 {
		// Initial vault upload
		_, err := db.ExecContext(ctx,
			"INSERT INTO zk_vaults (user_id, version, ciphertext, signature, updated_at) VALUES (?, ?, ?, ?, ?)",
			vault.UserID, 1, vault.Ciphertext, vault.Signature, vault.UpdatedAt,
		)
		if err != nil {
			if strings.Contains(err.Error(), "UNIQUE") || strings.Contains(err.Error(), "PRIMARY KEY") {
				return domain.NewDomainError(domain.ErrVault001, "vault already exists, conflict on initial write", err)
			}
			return fmt.Errorf("inserting initial zk_vault: %w", err)
		}
		vault.Version = 1
		return nil
	}

	// Optimistic concurrency update
	nextVersion := expectedVersion + 1
	res, err := db.ExecContext(ctx,
		"UPDATE zk_vaults SET version = ?, ciphertext = ?, signature = ?, updated_at = ? WHERE user_id = ? AND version = ?",
		nextVersion, vault.Ciphertext, vault.Signature, vault.UpdatedAt, vault.UserID, expectedVersion,
	)
	if err != nil {
		return fmt.Errorf("updating zk_vault: %w", err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected on zk_vault update: %w", err)
	}
	if rows == 0 {
		return domain.NewDomainError(domain.ErrVault001, "vault version conflict. Expected version did not match current version.", nil)
	}
	vault.Version = nextVersion
	return nil
}
