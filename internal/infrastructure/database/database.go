// Package database provides SQLite connection pooling and setup.
// RFC-0001 Section 5: Connection Pools (sqlx), Writer MaxOpenConns=1, Reader MaxOpenConns=4-8.
// PRAGMAs: WAL, synchronous=NORMAL, foreign_keys=ON, temp_store=MEMORY, busy_timeout=5000.
package database

import (
	"context"
	"fmt"

	"github.com/jmoiron/sqlx"
	_ "modernc.org/sqlite" // Pure-Go SQLite driver (CGO_ENABLED=0).
)

// DB holds the Writer and Reader connection pools.
// RFC-0001 Section 5: Writer DB MaxOpenConns=1 (strict single-writer),
// Reader DB MaxOpenConns=4 to 8.
type DB struct {
	Writer *sqlx.DB
	Reader *sqlx.DB
}

// Open creates Writer and Reader SQLite connection pools.
// RFC-0001 Section 6 Step 5: Open SQLite reader/writer pools.
func Open(ctx context.Context, dbPath string, readerMaxConns int) (*DB, error) {
	writerDSN := buildDSN(dbPath)
	writer, err := sqlx.Open("sqlite", writerDSN)
	if err != nil {
		return nil, fmt.Errorf("opening writer DB: %w", err)
	}
	// RFC-0001 Section 5: Writer MaxOpenConns=1 (Strict single-writer).
	writer.SetMaxOpenConns(1)
	writer.SetMaxIdleConns(1)

	if err := writer.PingContext(ctx); err != nil {
		writer.Close()
		return nil, fmt.Errorf("pinging writer DB: %w", err)
	}

	readerDSN := buildDSN(dbPath)
	reader, err := sqlx.Open("sqlite", readerDSN)
	if err != nil {
		writer.Close()
		return nil, fmt.Errorf("opening reader DB: %w", err)
	}
	// RFC-0001 Section 5: Reader MaxOpenConns=4 to 8.
	reader.SetMaxOpenConns(readerMaxConns)
	reader.SetMaxIdleConns(readerMaxConns)

	if err := reader.PingContext(ctx); err != nil {
		writer.Close()
		reader.Close()
		return nil, fmt.Errorf("pinging reader DB: %w", err)
	}

	return &DB{Writer: writer, Reader: reader}, nil
}

// buildDSN constructs the SQLite DSN with per-connection PRAGMAs.
// RFC-0001 Section 5 / Section 6 Step 6: Apply PRAGMAs.
// PRAGMAs are embedded in the DSN to ensure they apply to every connection
// created by the pool, as required by SQLite semantics.
func buildDSN(dbPath string) string {
	return fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)&_pragma=foreign_keys(1)&_pragma=temp_store(MEMORY)&_pragma=busy_timeout(5000)", dbPath)
}

// Close closes both Writer and Reader pools in the correct order.
// RFC-0001A Section 5.5: Close Writer DB -> Close Reader DB.
func (db *DB) Close() error {
	var firstErr error

	if err := db.Writer.Close(); err != nil {
		firstErr = fmt.Errorf("closing writer DB: %w", err)
	}

	if err := db.Reader.Close(); err != nil {
		if firstErr == nil {
			firstErr = fmt.Errorf("closing reader DB: %w", err)
		}
	}

	return firstErr
}
