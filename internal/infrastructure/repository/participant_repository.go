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

// participantModel is the internal SQL model for the participants table.
type participantModel struct {
	ConversationID string `db:"conversation_id"`
	UserID         string `db:"user_id"`
	Role           string `db:"role"`
	JoinedAt       int64  `db:"joined_at"`
}

func (m *participantModel) toDomain() *domain.Participant {
	return &domain.Participant{
		ConversationID: m.ConversationID,
		UserID:         m.UserID,
		Role:           domain.ParticipantRole(m.Role),
		JoinedAt:       m.JoinedAt,
	}
}

// SQLiteParticipantRepository implements domain.ParticipantRepository using SQLite.
type SQLiteParticipantRepository struct {
	writer *sqlx.DB
	reader *sqlx.DB
}

// NewParticipantRepository creates a new SQLite-backed ParticipantRepository.
func NewParticipantRepository(writer, reader *sqlx.DB) *SQLiteParticipantRepository {
	return &SQLiteParticipantRepository{writer: writer, reader: reader}
}

func (r *SQLiteParticipantRepository) getWriter(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.writer
}

func (r *SQLiteParticipantRepository) getReader(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.reader
}

// Create persists a new participant.
func (r *SQLiteParticipantRepository) Create(ctx context.Context, p *domain.Participant) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx,
		"INSERT INTO participants (conversation_id, user_id, role, joined_at) VALUES (?, ?, ?, ?)",
		p.ConversationID, p.UserID, string(p.Role), p.JoinedAt,
	)
	if err != nil {
		return fmt.Errorf("inserting participant: %w", err)
	}
	return nil
}

// GetByConversationAndUser retrieves a participant by composite key.
// RFC-0002 §4.2: PRIMARY KEY (conversation_id, user_id).
func (r *SQLiteParticipantRepository) GetByConversationAndUser(ctx context.Context, convID, userID string) (*domain.Participant, error) {
	db := r.getReader(ctx)
	var m participantModel
	err := sqlx.GetContext(ctx, db, &m,
		"SELECT conversation_id, user_id, role, joined_at FROM participants WHERE conversation_id = ? AND user_id = ?",
		convID, userID,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, domain.NewDomainError(domain.ErrPart001, "participant not found", nil)
		}
		return nil, fmt.Errorf("querying participant: %w", err)
	}
	return m.toDomain(), nil
}

// ListByConversationID retrieves all participants in a conversation.
func (r *SQLiteParticipantRepository) ListByConversationID(ctx context.Context, convID string) ([]*domain.Participant, error) {
	db := r.getReader(ctx)
	var models []participantModel
	err := sqlx.SelectContext(ctx, db, &models,
		"SELECT conversation_id, user_id, role, joined_at FROM participants WHERE conversation_id = ?",
		convID,
	)
	if err != nil {
		return nil, fmt.Errorf("listing participants by conversation: %w", err)
	}

	participants := make([]*domain.Participant, len(models))
	for i, m := range models {
		participants[i] = m.toDomain()
	}
	return participants, nil
}

// ListByUserID retrieves all participant records for a user.
func (r *SQLiteParticipantRepository) ListByUserID(ctx context.Context, userID string) ([]*domain.Participant, error) {
	db := r.getReader(ctx)
	var models []participantModel
	err := sqlx.SelectContext(ctx, db, &models,
		"SELECT conversation_id, user_id, role, joined_at FROM participants WHERE user_id = ?",
		userID,
	)
	if err != nil {
		return nil, fmt.Errorf("listing participants by user: %w", err)
	}

	participants := make([]*domain.Participant, len(models))
	for i, m := range models {
		participants[i] = m.toDomain()
	}
	return participants, nil
}

// Delete removes a participant from a conversation.
func (r *SQLiteParticipantRepository) Delete(ctx context.Context, convID, userID string) error {
	db := r.getWriter(ctx)
	result, err := db.ExecContext(ctx,
		"DELETE FROM participants WHERE conversation_id = ? AND user_id = ?",
		convID, userID,
	)
	if err != nil {
		return fmt.Errorf("deleting participant: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected: %w", err)
	}
	if rows == 0 {
		return domain.NewDomainError(domain.ErrPart001, "participant not found", nil)
	}
	return nil
}

// UpdateRole updates a participant's role in a conversation.
func (r *SQLiteParticipantRepository) UpdateRole(ctx context.Context, convID, userID string, role domain.ParticipantRole) error {
	db := r.getWriter(ctx)
	result, err := db.ExecContext(ctx,
		"UPDATE participants SET role = ? WHERE conversation_id = ? AND user_id = ?",
		string(role), convID, userID,
	)
	if err != nil {
		return fmt.Errorf("updating participant role: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected: %w", err)
	}
	if rows == 0 {
		return domain.NewDomainError(domain.ErrPart001, "participant not found", nil)
	}
	return nil
}

