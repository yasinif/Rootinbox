package domain

import "context"

// TransactionManager implements the Unit of Work pattern.
// RFC-0001A Section 4.1: Repositories MUST NOT manage transactions.
// ONLY atomic state transitions require a transaction.
type TransactionManager interface {
	// WithinTransaction executes fn within a database transaction.
	// The transaction is committed if fn returns nil, rolled back otherwise.
	// The ctx passed to fn carries the active transaction.
	WithinTransaction(ctx context.Context, fn func(ctx context.Context) error) error
}
