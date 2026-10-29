package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jmoiron/sqlx"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"
)

// vaultModel is the internal SQL model for the vaults table.
type vaultModel struct {
	ID            string `db:"id"`
	UserID        string `db:"user_id"`
	MonthYear     string `db:"month_year"`
	EncryptedData []byte `db:"encrypted_data"`
	ContentHash   string `db:"content_hash"`
	SchemaVersion int    `db:"schema_version"`
	Finalized     int    `db:"finalized"` // SQLite stores booleans as INTEGER
	CreatedAt     int64  `db:"created_at"`
}

func (m *vaultModel) toDomain() *domain.Vault {
	return &domain.Vault{
		ID:            m.ID,
		UserID:        m.UserID,
		MonthYear:     m.MonthYear,
		EncryptedData: m.EncryptedData,
		ContentHash:   m.ContentHash,
		SchemaVersion: m.SchemaVersion,
		Finalized:     m.Finalized == 1,
		CreatedAt:     m.CreatedAt,
	}
}

// vaultMetaModel is a lightweight model for listing vault metadata (no BLOB).
type vaultMetaModel struct {
	ID            string `db:"id"`
	UserID        string `db:"user_id"`
	MonthYear     string `db:"month_year"`
	ContentHash   string `db:"content_hash"`
	SchemaVersion int    `db:"schema_version"`
	Finalized     int    `db:"finalized"`
	CreatedAt     int64  `db:"created_at"`
}

func (m *vaultMetaModel) toDomain() *domain.Vault {
	return &domain.Vault{
		ID:            m.ID,
		UserID:        m.UserID,
		MonthYear:     m.MonthYear,
		ContentHash:   m.ContentHash,
		SchemaVersion: m.SchemaVersion,
		Finalized:     m.Finalized == 1,
		CreatedAt:     m.CreatedAt,
		// EncryptedData intentionally omitted for metadata-only listing.
	}
}

// SQLiteVaultRepository implements domain.VaultRepository using SQLite.
type SQLiteVaultRepository struct {
	writer *sqlx.DB
	reader *sqlx.DB
}

// NewVaultRepository creates a new SQLite-backed VaultRepository.
func NewVaultRepository(writer, reader *sqlx.DB) *SQLiteVaultRepository {
	return &SQLiteVaultRepository{writer: writer, reader: reader}
}

func (r *SQLiteVaultRepository) getWriter(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.writer
}

// Create persists a new vault.
// RFC-0006 §4.3: UNIQUE (user_id, month_year) enforces immutability.
func (r *SQLiteVaultRepository) Create(ctx context.Context, vault *domain.Vault) error {
	db := r.getWriter(ctx)
	finalized := 0
	if vault.Finalized {
		finalized = 1
	}

	_, err := db.ExecContext(ctx,
		`INSERT INTO vaults (id, user_id, month_year, encrypted_data, content_hash, schema_version, finalized, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		vault.ID, vault.UserID, vault.MonthYear, vault.EncryptedData,
		vault.ContentHash, vault.SchemaVersion, finalized, vault.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("inserting vault: %w", err)
	}
	return nil
}

// GetByUserAndMonth retrieves a vault by user and month.
func (r *SQLiteVaultRepository) GetByUserAndMonth(ctx context.Context, userID, monthYear string) (*domain.Vault, error) {
	var model vaultModel
	err := sqlx.GetContext(ctx, r.reader, &model,
		`SELECT id, user_id, month_year, encrypted_data, content_hash, schema_version, finalized, created_at
		 FROM vaults WHERE user_id = ? AND month_year = ?`,
		userID, monthYear,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, domain.NewDomainError(domain.ErrVault001, "vault not found", nil)
		}
		return nil, fmt.Errorf("querying vault: %w", err)
	}
	return model.toDomain(), nil
}

// ListByUserID retrieves all vault metadata for a user (excludes BLOB data).
func (r *SQLiteVaultRepository) ListByUserID(ctx context.Context, userID string) ([]*domain.Vault, error) {
	var models []vaultMetaModel
	err := sqlx.SelectContext(ctx, r.reader, &models,
		`SELECT id, user_id, month_year, content_hash, schema_version, finalized, created_at
		 FROM vaults WHERE user_id = ? ORDER BY month_year ASC`,
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("listing vaults: %w", err)
	}

	vaults := make([]*domain.Vault, len(models))
	for i, m := range models {
		vaults[i] = m.toDomain()
	}
	return vaults, nil
}

// DeleteByUserID removes all vaults for a user.
// RFC-0002 §4.3 Step 4: Hard delete all vaults for the user_id.
func (r *SQLiteVaultRepository) DeleteByUserID(ctx context.Context, userID string) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx, "DELETE FROM vaults WHERE user_id = ?", userID)
	if err != nil {
		return fmt.Errorf("deleting vaults: %w", err)
	}
	return nil
}
