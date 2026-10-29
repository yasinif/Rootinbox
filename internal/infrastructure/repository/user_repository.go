// Package repository contains SQLite implementations of Domain interfaces.
// RFC-0001A §4.2: Repositories MUST return ONLY Domain Entities.
// They MUST NOT leak DTOs, SQL Models, or Infrastructure Rows.
package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/jmoiron/sqlx"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"
)

// userModel is the internal SQL model for the users table.
// Private to the repository package (Clean Architecture).
type userModel struct {
	ID              string  `db:"id"`
	IdentityHash    string  `db:"identity_hash"`
	PublicKey       string  `db:"public_key"`
	Username        *string `db:"username"`
	DisplayName     *string `db:"display_name"`
	LastName        *string `db:"last_name"`
	Bio             *string `db:"bio"`
	AvatarMime      *string `db:"avatar_mime"`
	AvatarUpdatedAt *int64  `db:"avatar_updated_at"`
	LastSeenAt      int64   `db:"last_seen_at"`
	Status          string  `db:"status"`
	CreatedAt       int64   `db:"created_at"`
	StatusUpdatedAt *int64  `db:"status_updated_at"`
}

func (m *userModel) toDomain() *domain.User {
	return &domain.User{
		ID:              m.ID,
		IdentityHash:    m.IdentityHash,
		PublicKey:       m.PublicKey,
		Username:        m.Username,
		DisplayName:     m.DisplayName,
		LastName:        m.LastName,
		Bio:             m.Bio,
		AvatarMime:      m.AvatarMime,
		AvatarUpdatedAt: m.AvatarUpdatedAt,
		LastSeenAt:      m.LastSeenAt,
		Status:          domain.UserStatus(m.Status),
		CreatedAt:       m.CreatedAt,
	}
}

// SQLiteUserRepository implements domain.UserRepository using SQLite.
type SQLiteUserRepository struct {
	writer *sqlx.DB
	reader *sqlx.DB
}

// NewUserRepository creates a new SQLite-backed UserRepository.
func NewUserRepository(writer, reader *sqlx.DB) *SQLiteUserRepository {
	return &SQLiteUserRepository{writer: writer, reader: reader}
}

// getWriter returns the active transaction or the default writer DB.
func (r *SQLiteUserRepository) getWriter(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.writer
}

// getReader returns the active transaction or the default reader DB.
func (r *SQLiteUserRepository) getReader(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.reader
}

// Create persists a new user.
// RFC-0001A §3: Repositories MUST pass context.Context unchanged to every database operation.
func (r *SQLiteUserRepository) Create(ctx context.Context, user *domain.User) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx,
		"INSERT INTO users (id, identity_hash, public_key, username, display_name, last_name, bio, status, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		user.ID, user.IdentityHash, user.PublicKey, user.Username, user.DisplayName, user.LastName, user.Bio, string(user.Status), user.CreatedAt, user.LastSeenAt,
	)
	if err != nil {
		// RFC-0001A §4.3: infrastructure MAY wrap low-level errors.
		return fmt.Errorf("inserting user: %w", err)
	}
	return nil
}

// GetByID retrieves a user by their canonical UUIDv4.
func (r *SQLiteUserRepository) GetByID(ctx context.Context, id string) (*domain.User, error) {
	db := r.getReader(ctx)
	var m userModel
	err := sqlx.GetContext(ctx, db, &m, "SELECT id, identity_hash, public_key, username, display_name, last_name, bio, avatar_mime, avatar_updated_at, last_seen_at, status, created_at FROM users WHERE id = ?", id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
		}
		return nil, fmt.Errorf("querying user by id: %w", err)
	}
	return m.toDomain(), nil
}

// GetByIdentityHash retrieves a user by their deterministic public-key hash.
// RFC-0002 §4.2: identity_hash is UNIQUE.
func (r *SQLiteUserRepository) GetByIdentityHash(ctx context.Context, hash string) (*domain.User, error) {
	db := r.getReader(ctx)
	var m userModel
	err := sqlx.GetContext(ctx, db, &m, "SELECT id, identity_hash, public_key, username, display_name, last_name, bio, avatar_mime, avatar_updated_at, last_seen_at, status, created_at FROM users WHERE identity_hash = ?", hash)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
		}
		return nil, fmt.Errorf("querying user by identity_hash: %w", err)
	}
	return m.toDomain(), nil
}

// Delete removes a user by ID.
// RFC-0002 §4.3: FK cascade automatically removes participant records.
func (r *SQLiteUserRepository) Delete(ctx context.Context, id string) error {
	db := r.getWriter(ctx)
	result, err := db.ExecContext(ctx, "DELETE FROM users WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("deleting user: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected: %w", err)
	}
	if rows == 0 {
		return domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
	}
	return nil
}

// UpdateStatus transitions a user's status.
func (r *SQLiteUserRepository) UpdateStatus(ctx context.Context, id string, status domain.UserStatus, updatedAt int64) error {
	db := r.getWriter(ctx)
	res, err := db.ExecContext(ctx, "UPDATE users SET status = ?, status_updated_at = ? WHERE id = ?", string(status), updatedAt, id)
	if err != nil {
		return fmt.Errorf("updating user status: %w", err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected on update status: %w", err)
	}
	if rows == 0 {
		return domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
	}
	return nil
}

// UpdateUsername sets or clears a user's username.
// Amendment RFC-0002-A §7A.5.
func (r *SQLiteUserRepository) UpdateUsername(ctx context.Context, id string, username *string) error {
	db := r.getWriter(ctx)
	res, err := db.ExecContext(ctx, "UPDATE users SET username = ? WHERE id = ?", username, id)
	if err != nil {
		return fmt.Errorf("updating username: %w", err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected on update username: %w", err)
	}
	if rows == 0 {
		return domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
	}
	return nil
}

// GetByUsername retrieves a user by their unique username.
// Amendment RFC-0002-A §7A.3.
func (r *SQLiteUserRepository) GetByUsername(ctx context.Context, username string) (*domain.User, error) {
	db := r.getReader(ctx)
	var m userModel
	err := sqlx.GetContext(ctx, db, &m, "SELECT id, identity_hash, public_key, username, display_name, last_name, bio, avatar_mime, avatar_updated_at, last_seen_at, status, created_at FROM users WHERE username = ?", username)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
		}
		return nil, fmt.Errorf("querying user by username: %w", err)
	}
	return m.toDomain(), nil
}

// SearchByUsername performs a prefix search on usernames.
// Amendment RFC-0002-A §7A.4: Returns only active users, limited results.
func (r *SQLiteUserRepository) SearchByUsername(ctx context.Context, query string, limit int) ([]*domain.User, error) {
	db := r.getReader(ctx)
	var models []userModel
	err := sqlx.SelectContext(ctx, db, &models,
		"SELECT id, identity_hash, public_key, username, display_name, last_name, bio, avatar_mime, avatar_updated_at, last_seen_at, status, created_at FROM users WHERE username LIKE ? AND status = ? ORDER BY username ASC LIMIT ?",
		query+"%", string(domain.UserStatusActive), limit,
	)
	if err != nil {
		return nil, fmt.Errorf("searching users by username: %w", err)
	}
	users := make([]*domain.User, len(models))
	for i, m := range models {
		users[i] = m.toDomain()
	}
	return users, nil
}

// UpdateAvatar updates or clears a user's avatar MIME type and timestamp.
// Bundle 4: Personalization.
func (r *SQLiteUserRepository) UpdateAvatar(ctx context.Context, id string, mime *string, updatedAt *int64) error {
	db := r.getWriter(ctx)
	res, err := db.ExecContext(ctx, "UPDATE users SET avatar_mime = ?, avatar_updated_at = ? WHERE id = ?", mime, updatedAt, id)
	if err != nil {
		return fmt.Errorf("updating avatar: %w", err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected on update avatar: %w", err)
	}
	if rows == 0 {
		return domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
	}
	return nil
}

// UpdateProfile updates display_name, last_name, and bio for a user.
// Fix 1+2: Telegram-style profile.
func (r *SQLiteUserRepository) UpdateProfile(ctx context.Context, id string, displayName, lastName, bio *string) error {
	db := r.getWriter(ctx)
	res, err := db.ExecContext(ctx, "UPDATE users SET display_name = ?, last_name = ?, bio = ? WHERE id = ?", displayName, lastName, bio, id)
	if err != nil {
		return fmt.Errorf("updating profile: %w", err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected on update profile: %w", err)
	}
	if rows == 0 {
		return domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
	}
	return nil
}

// UpdateLastSeen updates the user's last_seen_at timestamp.
func (r *SQLiteUserRepository) UpdateLastSeen(ctx context.Context, id string, timestampMs int64) error {
	db := r.getWriter(ctx)
	res, err := db.ExecContext(ctx, "UPDATE users SET last_seen_at = ? WHERE id = ?", timestampMs, id)
	if err != nil {
		return fmt.Errorf("updating last seen: %w", err)
	}
	rows, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected on update last seen: %w", err)
	}
	if rows == 0 {
		return domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
	}
	return nil
}
