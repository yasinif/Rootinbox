package database

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jmoiron/sqlx"
)

// txKey is a private context key for the active transaction.
// RFC-0001A Section 3: Context keys MUST use dedicated private custom types.
type txKey struct{}

// TxManager implements domain.TransactionManager using the Writer DB.
// RFC-0001A Section 4.1: Repositories MUST NOT manage transactions.
// Inject a TransactionManager into UseCases.
type TxManager struct {
	db *sqlx.DB
}

// NewTxManager creates a TransactionManager backed by the Writer DB.
func NewTxManager(writerDB *sqlx.DB) *TxManager {
	return &TxManager{db: writerDB}
}

// WithinTransaction executes fn within a database transaction.
// RFC-0001A Section 4.1: The Unit of Work pattern.
// The transaction is committed if fn returns nil, rolled back otherwise.
func (tm *TxManager) WithinTransaction(ctx context.Context, fn func(ctx context.Context) error) error {
	tx, err := tm.db.BeginTxx(ctx, nil)
	if err != nil {
		return fmt.Errorf("beginning transaction: %w", err)
	}

	txCtx := context.WithValue(ctx, txKey{}, tx)

	if err := fn(txCtx); err != nil {
		if rbErr := tx.Rollback(); rbErr != nil {
			return fmt.Errorf("rollback failed: %w (original: %v)", rbErr, err)
		}
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("committing transaction: %w", err)
	}

	return nil
}

// TxFromContext retrieves the active transaction from context, if any.
// Repositories use this to participate in the active Unit of Work.
func TxFromContext(ctx context.Context) (*sqlx.Tx, bool) {
	tx, ok := ctx.Value(txKey{}).(*sqlx.Tx)
	return tx, ok
}

// WithinImmediateTransaction executes fn within a BEGIN IMMEDIATE transaction.
// RFC-0007 §8.3: All media state mutations MUST use BEGIN IMMEDIATE.
// Uses database/sql TxOptions with driver-level isolation since SQLite maps
// LevelSerializable to BEGIN IMMEDIATE for the modernc.org/sqlite driver.
func (tm *TxManager) WithinImmediateTransaction(ctx context.Context, fn func(ctx context.Context) error) error {
	tx, err := tm.db.BeginTxx(ctx, &sql.TxOptions{
		Isolation: sql.LevelSerializable,
	})
	if err != nil {
		return fmt.Errorf("beginning immediate transaction: %w", err)
	}

	txCtx := context.WithValue(ctx, txKey{}, tx)

	if err := fn(txCtx); err != nil {
		if rbErr := tx.Rollback(); rbErr != nil {
			return fmt.Errorf("rollback failed: %w (original: %v)", rbErr, err)
		}
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("committing immediate transaction: %w", err)
	}

	return nil
}
