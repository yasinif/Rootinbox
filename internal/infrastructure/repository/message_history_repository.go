package repository

import (
	"context"
	"fmt"

	"github.com/jmoiron/sqlx"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"
)

type historyModel struct {
	ID               string  `db:"id"`
	UserID           string  `db:"user_id"`
	ConversationID   string  `db:"conversation_id"`
	SenderID         string  `db:"sender_id"`
	ReceiverID       *string `db:"receiver_id"`
	EncryptedPayload []byte  `db:"encrypted_payload"`
	VaultIV          []byte  `db:"vault_iv"`
	SequenceNumber   int64   `db:"sequence_number"`
	CreatedAt        int64   `db:"created_at"`
	UpdatedAt        *int64  `db:"updated_at"`
	DeletedAt        *int64  `db:"deleted_at"`
}

func (m historyModel) toDomain() *domain.HistoryMessage {
	return &domain.HistoryMessage{
		ID:               m.ID,
		UserID:           m.UserID,
		ConversationID:   m.ConversationID,
		SenderID:         m.SenderID,
		ReceiverID:       m.ReceiverID,
		EncryptedPayload: m.EncryptedPayload,
		VaultIV:          m.VaultIV,
		SequenceNumber:   m.SequenceNumber,
		CreatedAt:        domain.NormalizeTimestamp(m.CreatedAt),
		UpdatedAt:        domain.NormalizeTimestampPtr(m.UpdatedAt),
		DeletedAt:        domain.NormalizeTimestampPtr(m.DeletedAt),
	}
}

// SQLiteMessageHistoryRepository implements domain.MessageHistoryRepository.
type SQLiteMessageHistoryRepository struct {
	writer *sqlx.DB
	reader *sqlx.DB
}

// NewMessageHistoryRepository creates a new SQLiteMessageHistoryRepository.
func NewMessageHistoryRepository(writer, reader *sqlx.DB) *SQLiteMessageHistoryRepository {
	return &SQLiteMessageHistoryRepository{writer: writer, reader: reader}
}

func (r *SQLiteMessageHistoryRepository) getWriter(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.writer
}

func (r *SQLiteMessageHistoryRepository) Save(ctx context.Context, msg *domain.HistoryMessage) error {
	db := r.getWriter(ctx)
	query := `INSERT INTO message_history (id, user_id, conversation_id, sender_id, receiver_id, encrypted_payload, vault_iv, sequence_number, created_at, updated_at, deleted_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, id) DO UPDATE SET
			encrypted_payload = excluded.encrypted_payload,
			vault_iv = excluded.vault_iv,
			updated_at = excluded.updated_at,
			deleted_at = excluded.deleted_at`
	createdAt := domain.NormalizeTimestamp(msg.CreatedAt)
	updatedAt := domain.NormalizeTimestampPtr(msg.UpdatedAt)
	deletedAt := domain.NormalizeTimestampPtr(msg.DeletedAt)
	_, err := db.ExecContext(ctx, query,
		msg.ID, msg.UserID, msg.ConversationID, msg.SenderID, msg.ReceiverID,
		msg.EncryptedPayload, msg.VaultIV, msg.SequenceNumber,
		createdAt, updatedAt, deletedAt,
	)
	if err != nil {
		return fmt.Errorf("saving message history: %w", err)
	}
	return nil
}

func (r *SQLiteMessageHistoryRepository) SaveBatch(ctx context.Context, msgs []*domain.HistoryMessage) error {
	if len(msgs) == 0 {
		return nil
	}
	db := r.getWriter(ctx)
	query := `INSERT INTO message_history (id, user_id, conversation_id, sender_id, receiver_id, encrypted_payload, vault_iv, sequence_number, created_at, updated_at, deleted_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, id) DO UPDATE SET
			encrypted_payload = excluded.encrypted_payload,
			vault_iv = excluded.vault_iv,
			updated_at = excluded.updated_at,
			deleted_at = excluded.deleted_at`
	for _, msg := range msgs {
		createdAt := domain.NormalizeTimestamp(msg.CreatedAt)
		updatedAt := domain.NormalizeTimestampPtr(msg.UpdatedAt)
		deletedAt := domain.NormalizeTimestampPtr(msg.DeletedAt)
		_, err := db.ExecContext(ctx, query,
			msg.ID, msg.UserID, msg.ConversationID, msg.SenderID, msg.ReceiverID,
			msg.EncryptedPayload, msg.VaultIV, msg.SequenceNumber,
			createdAt, updatedAt, deletedAt,
		)
		if err != nil {
			return fmt.Errorf("saving message history batch item %s: %w", msg.ID, err)
		}
	}
	return nil
}

func (r *SQLiteMessageHistoryRepository) ListByUserAndConversation(ctx context.Context, userID, convID string, cursor int64, limit int) ([]*domain.HistoryMessage, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	cursor = domain.NormalizeTimestamp(cursor)

	var query string
	var args []interface{}

	if cursor <= 0 {
		// When no cursor is specified, fetch the most recent messages up to limit in chronological order
		query = `SELECT id, user_id, conversation_id, sender_id, receiver_id, encrypted_payload, vault_iv, sequence_number, created_at, updated_at, deleted_at FROM (
			SELECT id, user_id, conversation_id, sender_id, receiver_id, encrypted_payload, vault_iv, sequence_number, created_at, updated_at, deleted_at,
				(CASE 
					WHEN updated_at IS NOT NULL AND updated_at > 0 AND updated_at < 10000000000 THEN updated_at * 1000 
					WHEN updated_at IS NOT NULL AND updated_at > 0 THEN updated_at 
					WHEN created_at < 10000000000 THEN created_at * 1000 
					ELSE created_at 
				END) AS sort_time
			FROM message_history
			WHERE user_id = ? AND conversation_id = ?
			ORDER BY sort_time DESC, created_at DESC
			LIMIT ?
		) sub
		ORDER BY sort_time ASC, created_at ASC`
		args = []interface{}{userID, convID, limit}
	} else {
		query = `SELECT id, user_id, conversation_id, sender_id, receiver_id, encrypted_payload, vault_iv, sequence_number, created_at, updated_at, deleted_at
			FROM message_history
			WHERE user_id = ? AND conversation_id = ? AND 
				(CASE 
					WHEN updated_at IS NOT NULL AND updated_at > 0 AND updated_at < 10000000000 THEN updated_at * 1000 
					WHEN updated_at IS NOT NULL AND updated_at > 0 THEN updated_at 
					WHEN created_at < 10000000000 THEN created_at * 1000 
					ELSE created_at 
				END) > ?
			ORDER BY 
				(CASE 
					WHEN updated_at IS NOT NULL AND updated_at > 0 AND updated_at < 10000000000 THEN updated_at * 1000 
					WHEN updated_at IS NOT NULL AND updated_at > 0 THEN updated_at 
					WHEN created_at < 10000000000 THEN created_at * 1000 
					ELSE created_at 
				END) ASC, created_at ASC
			LIMIT ?`
		args = []interface{}{userID, convID, cursor, limit}
	}

	var models []historyModel
	err := sqlx.SelectContext(ctx, r.reader, &models, query, args...)
	if err != nil {
		return nil, fmt.Errorf("listing message history: %w", err)
	}
	result := make([]*domain.HistoryMessage, len(models))
	for i := range models {
		result[i] = models[i].toDomain()
	}
	return result, nil
}

func (r *SQLiteMessageHistoryRepository) Tombstone(ctx context.Context, userID, convID, messageID string, nowUnix int64) error {
	db := r.getWriter(ctx)
	query := `UPDATE message_history
		SET deleted_at = ?, updated_at = ?, encrypted_payload = X'', vault_iv = X''
		WHERE user_id = ? AND conversation_id = ? AND id = ?`
	_, err := db.ExecContext(ctx, query, nowUnix, nowUnix, userID, convID, messageID)
	if err != nil {
		return fmt.Errorf("tombstoning message history: %w", err)
	}
	return nil
}

func (r *SQLiteMessageHistoryRepository) TombstoneForBoth(ctx context.Context, convID, messageID string, nowUnix int64) error {
	db := r.getWriter(ctx)
	query := `UPDATE message_history
		SET deleted_at = ?, updated_at = ?, encrypted_payload = X'', vault_iv = X''
		WHERE conversation_id = ? AND id = ?`
	_, err := db.ExecContext(ctx, query, nowUnix, nowUnix, convID, messageID)
	if err != nil {
		return fmt.Errorf("tombstoning message history for both: %w", err)
	}
	return nil
}

func (r *SQLiteMessageHistoryRepository) TombstoneAllInConversationForUser(ctx context.Context, userID, convID string, nowUnix int64) error {
	db := r.getWriter(ctx)
	query := `UPDATE message_history
		SET deleted_at = ?, updated_at = ?, encrypted_payload = X'', vault_iv = X''
		WHERE user_id = ? AND conversation_id = ?`
	_, err := db.ExecContext(ctx, query, nowUnix, nowUnix, userID, convID)
	if err != nil {
		return fmt.Errorf("tombstoning all messages for user: %w", err)
	}
	return nil
}

func (r *SQLiteMessageHistoryRepository) TombstoneAllInConversationForBoth(ctx context.Context, convID string, nowUnix int64) error {
	db := r.getWriter(ctx)
	query := `UPDATE message_history
		SET deleted_at = ?, updated_at = ?, encrypted_payload = X'', vault_iv = X''
		WHERE conversation_id = ?`
	_, err := db.ExecContext(ctx, query, nowUnix, nowUnix, convID)
	if err != nil {
		return fmt.Errorf("tombstoning all messages for both: %w", err)
	}
	return nil
}

func (r *SQLiteMessageHistoryRepository) HardDeleteAllInConversation(ctx context.Context, convID string) error {
	db := r.getWriter(ctx)
	query := `DELETE FROM message_history WHERE conversation_id = ?`
	_, err := db.ExecContext(ctx, query, convID)
	if err != nil {
		return fmt.Errorf("hard deleting all message history in conversation: %w", err)
	}
	return nil
}
