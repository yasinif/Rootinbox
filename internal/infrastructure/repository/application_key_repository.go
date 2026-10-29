package repository

import (
	"context"
	"database/sql"
	"errors"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"

	"github.com/jmoiron/sqlx"
)

type SQLiteApplicationKeyRepository struct {
	writer *sqlx.DB
	reader *sqlx.DB
}

func NewApplicationKeyRepository(writer, reader *sqlx.DB) *SQLiteApplicationKeyRepository {
	return &SQLiteApplicationKeyRepository{
		writer: writer,
		reader: reader,
	}
}

type applicationKeyModel struct {
	ID                    string `db:"id"`
	PrivateKeyEncrypted   string `db:"private_key_encrypted"`
	PublicKeyUncompressed string `db:"public_key_uncompressed"`
	CreatedAt             int64  `db:"created_at"`
}

func (m *applicationKeyModel) toDomain() *domain.ApplicationKey {
	return &domain.ApplicationKey{
		ID:                    m.ID,
		PrivateKeyEncrypted:   m.PrivateKeyEncrypted,
		PublicKeyUncompressed: m.PublicKeyUncompressed,
		CreatedAt:             m.CreatedAt,
	}
}

// getWriter returns the active transaction or the default writer DB.
func (r *SQLiteApplicationKeyRepository) getWriter(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.writer
}

// getReader returns the active transaction or the default reader DB.
func (r *SQLiteApplicationKeyRepository) getReader(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.reader
}

func (r *SQLiteApplicationKeyRepository) GetByID(ctx context.Context, id string) (*domain.ApplicationKey, error) {
	exec := r.getReader(ctx)

	query := `
		SELECT id, private_key_encrypted, public_key_uncompressed, created_at
		FROM application_keys
		WHERE id = ?`

	var model applicationKeyModel
	err := sqlx.GetContext(ctx, exec, &model, query, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, domain.NewDomainError(domain.ErrPush001, "application key not found", nil)
		}
		return nil, domain.NewDomainError(domain.ErrDB002, "getting application key", err)
	}

	return model.toDomain(), nil
}

func (r *SQLiteApplicationKeyRepository) Create(ctx context.Context, key *domain.ApplicationKey) error {
	exec := r.getWriter(ctx)

	query := `
		INSERT INTO application_keys (id, private_key_encrypted, public_key_uncompressed, created_at)
		VALUES (?, ?, ?, ?)`

	_, err := exec.ExecContext(ctx, query,
		key.ID,
		key.PrivateKeyEncrypted,
		key.PublicKeyUncompressed,
		key.CreatedAt,
	)
	if err != nil {
		return domain.NewDomainError(domain.ErrDB002, "creating application key", err)
	}

	return nil
}

func (r *SQLiteApplicationKeyRepository) UpdateCAS(ctx context.Context, key *domain.ApplicationKey, expectedOldCiphertext string) error {
	exec := r.getWriter(ctx)

	query := `
		UPDATE application_keys
		SET private_key_encrypted = ?, public_key_uncompressed = ?, created_at = ?
		WHERE id = ? AND private_key_encrypted = ?`

	res, err := exec.ExecContext(ctx, query,
		key.PrivateKeyEncrypted,
		key.PublicKeyUncompressed,
		key.CreatedAt,
		key.ID,
		expectedOldCiphertext,
	)
	if err != nil {
		return domain.NewDomainError(domain.ErrDB002, "updating application key CAS", err)
	}

	rows, err := res.RowsAffected()
	if err != nil {
		return domain.NewDomainError(domain.ErrDB002, "getting rows affected", err)
	}
	if rows == 0 {
		return domain.NewDomainError(domain.ErrPush002, "concurrent modification: expected old ciphertext did not match", nil)
	}

	return nil
}
