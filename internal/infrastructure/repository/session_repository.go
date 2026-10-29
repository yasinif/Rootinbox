package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/jmoiron/sqlx"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"
)

// sessionModel is the internal SQL model for the sessions table.
type sessionModel struct {
	ID               string  `db:"id"`
	UserID           string  `db:"user_id"`
	X25519PublicKey  string  `db:"x25519_public_key"`
	SessionVersion   int     `db:"session_version"`
	ExpiresAt        int64   `db:"expires_at"`
	CreatedAt        int64   `db:"created_at"`
	RevokedAt        *int64  `db:"revoked_at"`
	SessionSignature []byte  `db:"session_signature"`
	SignedExpiresAt  *int64  `db:"signed_expires_at"`
	DeviceLabel      *string `db:"device_label"`
	IPHash           *string `db:"ip_hash"`
	LastActiveAt     *int64  `db:"last_active_at"`
}

func (m *sessionModel) toDomain() *domain.Session {
	var devLabel, ipHash string
	var lastActive int64
	if m.DeviceLabel != nil {
		devLabel = *m.DeviceLabel
	}
	if m.IPHash != nil {
		ipHash = *m.IPHash
	}
	if m.LastActiveAt != nil {
		lastActive = *m.LastActiveAt
	}
	return &domain.Session{
		ID:               m.ID,
		UserID:           m.UserID,
		X25519PublicKey:  m.X25519PublicKey,
		SessionVersion:   m.SessionVersion,
		ExpiresAt:        m.ExpiresAt,
		CreatedAt:        m.CreatedAt,
		RevokedAt:        m.RevokedAt,
		SessionSignature: m.SessionSignature,
		SignedExpiresAt:  m.SignedExpiresAt,
		DeviceLabel:      devLabel,
		IPHash:           ipHash,
		LastActiveAt:     lastActive,
	}
}

// SQLiteSessionRepository implements domain.SessionRepository using SQLite.
type SQLiteSessionRepository struct {
	writer *sqlx.DB
	reader *sqlx.DB
}

// NewSessionRepository creates a new SQLite-backed SessionRepository.
func NewSessionRepository(writer, reader *sqlx.DB) *SQLiteSessionRepository {
	return &SQLiteSessionRepository{writer: writer, reader: reader}
}

func (r *SQLiteSessionRepository) getWriter(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.writer
}

func (r *SQLiteSessionRepository) getReader(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.reader
}

// Create persists a new session.
func (r *SQLiteSessionRepository) Create(ctx context.Context, session *domain.Session) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx,
		`INSERT INTO sessions (id, user_id, x25519_public_key, session_version, expires_at, created_at, revoked_at, session_signature, signed_expires_at, device_label, ip_hash, last_active_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		session.ID, session.UserID, session.X25519PublicKey, session.SessionVersion,
		session.ExpiresAt, session.CreatedAt, session.RevokedAt,
		session.SessionSignature, session.SignedExpiresAt,
		session.DeviceLabel, session.IPHash, session.LastActiveAt,
	)
	if err != nil {
		return fmt.Errorf("inserting session: %w", err)
	}
	return nil
}

// CreateToken stores a hashed session token.
// RFC-0004 §7.1: Store SHA256(cookie_token), never raw.
func (r *SQLiteSessionRepository) CreateToken(ctx context.Context, tokenHash string, sessionID string, createdAt int64) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx,
		"INSERT INTO session_tokens (token_hash, session_id, created_at) VALUES (?, ?, ?)",
		tokenHash, sessionID, createdAt,
	)
	if err != nil {
		return fmt.Errorf("inserting session token: %w", err)
	}
	return nil
}

// GetByTokenHash retrieves a session by its token hash.
// JOINs session_tokens with sessions.
func (r *SQLiteSessionRepository) GetByTokenHash(ctx context.Context, tokenHash string) (*domain.Session, error) {
	db := r.getReader(ctx)
	var m sessionModel
	err := sqlx.GetContext(ctx, db, &m,
		`SELECT s.id, s.user_id, s.x25519_public_key, s.session_version, s.expires_at, s.created_at, s.revoked_at, s.session_signature, s.signed_expires_at, s.device_label, s.ip_hash, s.last_active_at
		 FROM sessions s
		 INNER JOIN session_tokens st ON st.session_id = s.id
		 WHERE st.token_hash = ?`,
		tokenHash,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, domain.NewDomainError(domain.ErrAuth001, "invalid session", nil)
		}
		return nil, fmt.Errorf("querying session by token hash: %w", err)
	}
	return m.toDomain(), nil
}

// GetActiveByUserID retrieves the currently active (non-revoked) session.
func (r *SQLiteSessionRepository) GetActiveByUserID(ctx context.Context, userID string) (*domain.Session, error) {
	db := r.getReader(ctx)
	var m sessionModel
	err := sqlx.GetContext(ctx, db, &m,
		`SELECT id, user_id, x25519_public_key, session_version, expires_at, created_at, revoked_at, session_signature, signed_expires_at, device_label, ip_hash, last_active_at
		 FROM sessions WHERE user_id = ? AND revoked_at IS NULL
		 ORDER BY session_version DESC LIMIT 1`,
		userID,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil // No active session is not an error.
		}
		return nil, fmt.Errorf("querying active session: %w", err)
	}
	return m.toDomain(), nil
}

// GetByID retrieves a session by its ID.
func (r *SQLiteSessionRepository) GetByID(ctx context.Context, sessionID string) (*domain.Session, error) {
	db := r.getReader(ctx)
	var m sessionModel
	err := sqlx.GetContext(ctx, db, &m,
		`SELECT id, user_id, x25519_public_key, session_version, expires_at, created_at, revoked_at, session_signature, signed_expires_at, device_label, ip_hash, last_active_at
		 FROM sessions WHERE id = ?`,
		sessionID,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("querying session by id: %w", err)
	}
	return m.toDomain(), nil
}

// GetActiveSessionsByUserID retrieves all active (non-revoked, non-expired) sessions for a user.
func (r *SQLiteSessionRepository) GetActiveSessionsByUserID(ctx context.Context, userID string) ([]*domain.Session, error) {
	db := r.getReader(ctx)
	var models []sessionModel
	now := time.Now().Unix()
	err := sqlx.SelectContext(ctx, db, &models,
		`SELECT id, user_id, x25519_public_key, session_version, expires_at, created_at, revoked_at, session_signature, signed_expires_at, device_label, ip_hash, last_active_at
		 FROM sessions
		 WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
		 ORDER BY created_at DESC`,
		userID, now,
	)
	if err != nil {
		return nil, fmt.Errorf("querying active sessions: %w", err)
	}
	result := make([]*domain.Session, len(models))
	for i, m := range models {
		result[i] = m.toDomain()
	}
	return result, nil
}

// RevokeByUserID sets revoked_at on all active sessions for a user.
// RFC-0004 §6.3: Transition active session to GRACE_PERIOD state.
func (r *SQLiteSessionRepository) RevokeByUserID(ctx context.Context, userID string, revokedAt int64) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx,
		"UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
		revokedAt, userID,
	)
	if err != nil {
		return fmt.Errorf("revoking sessions: %w", err)
	}
	return nil
}

// RevokeSession sets revoked_at on a specific session.
func (r *SQLiteSessionRepository) RevokeSession(ctx context.Context, sessionID string, revokedAt int64) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx,
		"UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
		revokedAt, sessionID,
	)
	if err != nil {
		return fmt.Errorf("revoking session: %w", err)
	}
	return nil
}

// RevokeOtherSessions sets revoked_at on all active sessions for a user except the given session ID.
func (r *SQLiteSessionRepository) RevokeOtherSessions(ctx context.Context, userID string, exceptSessionID string, revokedAt int64) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx,
		"UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id != ? AND revoked_at IS NULL",
		revokedAt, userID, exceptSessionID,
	)
	if err != nil {
		return fmt.Errorf("revoking other sessions: %w", err)
	}
	return nil
}

// UpdateLastActive updates the last_active_at timestamp for a session.
func (r *SQLiteSessionRepository) UpdateLastActive(ctx context.Context, sessionID string, lastActiveAt int64) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx,
		"UPDATE sessions SET last_active_at = ? WHERE id = ?",
		lastActiveAt, sessionID,
	)
	if err != nil {
		return fmt.Errorf("updating session last_active_at: %w", err)
	}
	return nil
}

// GetLatestVersionByUserID returns the highest session_version for a user.
func (r *SQLiteSessionRepository) GetLatestVersionByUserID(ctx context.Context, userID string) (int, error) {
	db := r.getReader(ctx)
	var version int
	err := sqlx.GetContext(ctx, db, &version,
		"SELECT COALESCE(MAX(session_version), 0) FROM sessions WHERE user_id = ?",
		userID,
	)
	if err != nil {
		return 0, fmt.Errorf("querying latest session version: %w", err)
	}
	return version, nil
}

// DeleteByUserID removes all sessions for a user.
// RFC-0002 §4.3 Step 3: Hard delete all sessions.
func (r *SQLiteSessionRepository) DeleteByUserID(ctx context.Context, userID string) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx, "DELETE FROM sessions WHERE user_id = ?", userID)
	if err != nil {
		return fmt.Errorf("deleting sessions: %w", err)
	}
	return nil
}

// DeleteTokensBySessionID removes all tokens for a session.
func (r *SQLiteSessionRepository) DeleteTokensBySessionID(ctx context.Context, sessionID string) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx, "DELETE FROM session_tokens WHERE session_id = ?", sessionID)
	if err != nil {
		return fmt.Errorf("deleting session tokens: %w", err)
	}
	return nil
}
