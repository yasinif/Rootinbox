package repository

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jmoiron/sqlx"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"
)

// messageModel is the internal SQL model for the messages table.
type messageModel struct {
	ServerID         int64  `db:"server_id"`
	ClientUUID       string `db:"client_uuid"`
	SenderID         string `db:"sender_id"`
	ReceiverID       string `db:"receiver_id"`
	EncryptedPayload []byte `db:"encrypted_payload"`
	SequenceNumber   int64  `db:"sequence_number"`
	CreatedAt        int64  `db:"created_at"`
}

func (m *messageModel) toDomain() *domain.Message {
	return &domain.Message{
		ServerID:         m.ServerID,
		ClientUUID:       m.ClientUUID,
		SenderID:         m.SenderID,
		ReceiverID:       m.ReceiverID,
		EncryptedPayload: m.EncryptedPayload,
		SequenceNumber:   m.SequenceNumber,
		CreatedAt:        domain.NormalizeTimestamp(m.CreatedAt),
	}
}

// SQLiteMessageRepository implements domain.MessageRepository using SQLite.
type SQLiteMessageRepository struct {
	writer *sqlx.DB
	reader *sqlx.DB
}

// NewMessageRepository creates a new SQLite-backed MessageRepository.
func NewMessageRepository(writer, reader *sqlx.DB) *SQLiteMessageRepository {
	return &SQLiteMessageRepository{writer: writer, reader: reader}
}

func (r *SQLiteMessageRepository) getWriter(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.writer
}

// Create persists a message using INSERT OR IGNORE for idempotency.
// RFC-0005 §6.1: SQLite PRIMARY KEY constraint is the source of truth for idempotency.
func (r *SQLiteMessageRepository) Create(ctx context.Context, msg *domain.Message) error {
	db := r.getWriter(ctx)
	normalizedCreatedAt := domain.NormalizeTimestamp(msg.CreatedAt)
	msg.CreatedAt = normalizedCreatedAt
	result, err := db.ExecContext(ctx,
		`INSERT OR IGNORE INTO messages (client_uuid, sender_id, receiver_id, encrypted_payload, sequence_number, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		msg.ClientUUID, msg.SenderID, msg.ReceiverID, msg.EncryptedPayload,
		msg.SequenceNumber, normalizedCreatedAt,
	)
	if err != nil {
		return fmt.Errorf("inserting message: %w", err)
	}

	// Check if the row was actually inserted (not a duplicate).
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected: %w", err)
	}
	if rows == 0 {
		// Duplicate — idempotent success, but signal with a sentinel.
		return ErrMessageDuplicate
	}
	return nil
}

// ErrMessageDuplicate indicates a duplicate message (idempotent no-op).
var ErrMessageDuplicate = domain.ErrMessageDuplicate

// GetPendingByReceiverID retrieves all pending messages for a receiver.
// RFC-0005 §4.2: Post-Auth Flush — query pending messages on connect.
func (r *SQLiteMessageRepository) GetPendingByReceiverID(ctx context.Context, receiverID string) ([]*domain.Message, error) {
	var models []messageModel
	err := sqlx.SelectContext(ctx, r.reader, &models,
		`SELECT server_id, client_uuid, sender_id, receiver_id, encrypted_payload, sequence_number, created_at
		 FROM messages WHERE receiver_id = ? ORDER BY server_id ASC`,
		receiverID,
	)
	if err != nil {
		return nil, fmt.Errorf("querying pending messages: %w", err)
	}

	messages := make([]*domain.Message, len(models))
	for i, m := range models {
		messages[i] = m.toDomain()
	}
	return messages, nil
}

// GetPendingPaginated retrieves pending messages with cursor-based pagination.
// RFC-0006 §4.2: Cursor-based sync via auto-incrementing server_id.
func (r *SQLiteMessageRepository) GetPendingPaginated(ctx context.Context, receiverID string, cursor int64, limit int) ([]*domain.Message, error) {
	var models []messageModel
	err := sqlx.SelectContext(ctx, r.reader, &models,
		`SELECT server_id, client_uuid, sender_id, receiver_id, encrypted_payload, sequence_number, created_at
		 FROM messages WHERE receiver_id = ? AND server_id > ?
		 ORDER BY server_id ASC LIMIT ?`,
		receiverID, cursor, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("querying paginated messages: %w", err)
	}

	messages := make([]*domain.Message, len(models))
	for i, m := range models {
		messages[i] = m.toDomain()
	}
	return messages, nil
}

// GetSenderByClientUUID looks up the sender_id of a message by its client_uuid.
func (r *SQLiteMessageRepository) GetSenderByClientUUID(ctx context.Context, clientUUID string) (string, error) {
	var senderID string
	err := sqlx.GetContext(ctx, r.reader, &senderID,
		"SELECT sender_id FROM messages WHERE client_uuid = ?",
		clientUUID,
	)
	if err != nil {
		return "", fmt.Errorf("looking up sender for message: %w", err)
	}
	return senderID, nil
}

// DeleteByClientUUID hard-deletes a message after ACK validation.
// RFC-0005 §6.3: Server executes HARD DELETE upon validated ACK.
func (r *SQLiteMessageRepository) DeleteByClientUUID(ctx context.Context, clientUUID string) error {
	db := r.getWriter(ctx)
	result, err := db.ExecContext(ctx, "DELETE FROM messages WHERE client_uuid = ?", clientUUID)
	if err != nil {
		return fmt.Errorf("deleting message: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking delete result: %w", err)
	}
	if rows == 0 {
		// Message not found — already deleted or never existed.
		return nil
	}
	return nil
}

func (r *SQLiteMessageRepository) CountRecentBySenderID(ctx context.Context, senderID string, since int64) (int, error) {
	var count int
	err := sqlx.GetContext(ctx, r.reader, &count,
		"SELECT COUNT(*) FROM messages WHERE sender_id = ? AND created_at >= ?",
		senderID, since,
	)
	if err != nil {
		return 0, fmt.Errorf("counting recent messages: %w", err)
	}
	return count, nil
}

// isMessageDuplicate checks the sentinel error.
func isMessageDuplicate(err error) bool {
	return err != nil && strings.Contains(err.Error(), "idempotent")
}

// DeleteByClientUUIDs batch hard-deletes messages after bulk ACK.
// RFC-0006 §4.2: POST /api/v1/messages/ack with array of client_uuids.
func (r *SQLiteMessageRepository) DeleteByClientUUIDs(ctx context.Context, clientUUIDs []string) (int64, error) {
	if len(clientUUIDs) == 0 {
		return 0, nil
	}

	db := r.getWriter(ctx)

	// Build placeholders for IN clause.
	placeholders := make([]string, len(clientUUIDs))
	args := make([]interface{}, len(clientUUIDs))
	for i, uuid := range clientUUIDs {
		placeholders[i] = "?"
		args[i] = uuid
	}

	query := fmt.Sprintf("DELETE FROM messages WHERE client_uuid IN (%s)",
		strings.Join(placeholders, ","))

	result, err := db.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, fmt.Errorf("batch deleting messages: %w", err)
	}

	rows, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("checking batch delete result: %w", err)
	}
	return rows, nil
}

// GetPendingByClientUUIDAndReceiver checks if a pending message exists for the specific recipient.
func (r *SQLiteMessageRepository) GetPendingByClientUUIDAndReceiver(ctx context.Context, clientUUID, receiverID string) (*domain.Message, error) {
	query := `SELECT server_id, client_uuid, sender_id, receiver_id, encrypted_payload, sequence_number, created_at FROM messages WHERE client_uuid = ? AND receiver_id = ?`
	var m messageModel
	if err := sqlx.GetContext(ctx, r.reader, &m, query, clientUUID, receiverID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, nil
		}
		return nil, fmt.Errorf("getting pending message by client_uuid and receiver: %w", err)
	}
	return m.toDomain(), nil
}

// DeleteByClientUUIDAndReceiver hard deletes a message only if the acknowledging user is the genuine recipient.
func (r *SQLiteMessageRepository) DeleteByClientUUIDAndReceiver(ctx context.Context, clientUUID, receiverID string) (int64, error) {
	db := r.getWriter(ctx)
	query := `DELETE FROM messages WHERE client_uuid = ? AND receiver_id = ?`
	res, err := db.ExecContext(ctx, query, clientUUID, receiverID)
	if err != nil {
		return 0, fmt.Errorf("deleting message by client_uuid and receiver: %w", err)
	}
	return res.RowsAffected()
}

// GetSendersByClientUUIDsAndReceiver retrieves clientUUID -> senderID mapping strictly for messages destined to receiverID.
func (r *SQLiteMessageRepository) GetSendersByClientUUIDsAndReceiver(ctx context.Context, clientUUIDs []string, receiverID string) (map[string]string, error) {
	if len(clientUUIDs) == 0 {
		return map[string]string{}, nil
	}
	query, args, err := sqlx.In("SELECT client_uuid, sender_id FROM messages WHERE client_uuid IN (?) AND receiver_id = ?", clientUUIDs, receiverID)
	if err != nil {
		return nil, fmt.Errorf("building in query: %w", err)
	}
	query = r.reader.Rebind(query)

	type row struct {
		ClientUUID string `db:"client_uuid"`
		SenderID   string `db:"sender_id"`
	}
	var rows []row
	if err := sqlx.SelectContext(ctx, r.reader, &rows, query, args...); err != nil {
		return nil, fmt.Errorf("selecting senders for batch: %w", err)
	}

	result := make(map[string]string, len(rows))
	for _, rw := range rows {
		result[rw.ClientUUID] = rw.SenderID
	}
	return result, nil
}

// DeleteByClientUUIDsAndReceiver batch deletes messages strictly matching clientUUIDs and receiverID.
func (r *SQLiteMessageRepository) DeleteByClientUUIDsAndReceiver(ctx context.Context, clientUUIDs []string, receiverID string) (int64, error) {
	if len(clientUUIDs) == 0 {
		return 0, nil
	}
	query, args, err := sqlx.In("DELETE FROM messages WHERE client_uuid IN (?) AND receiver_id = ?", clientUUIDs, receiverID)
	if err != nil {
		return 0, fmt.Errorf("building in delete query: %w", err)
	}
	query = r.getWriter(ctx).Rebind(query)
	res, err := r.getWriter(ctx).ExecContext(ctx, query, args...)
	if err != nil {
		return 0, fmt.Errorf("deleting messages by client_uuids and receiver: %w", err)
	}
	return res.RowsAffected()
}

// QueueDeliveryAck records a delivery receipt in SQLite for multi-device sync and offline recovery.
func (r *SQLiteMessageRepository) QueueDeliveryAck(ctx context.Context, senderID, requestID string, createdAt int64) error {
	db := r.getWriter(ctx)
	normCreatedAt := domain.NormalizeTimestamp(createdAt)
	query := `INSERT OR IGNORE INTO delivery_acks (sender_id, request_id, created_at) VALUES (?, ?, ?)`
	_, err := db.ExecContext(ctx, query, senderID, requestID, normCreatedAt)
	if err != nil {
		return fmt.Errorf("queueing delivery ack: %w", err)
	}
	return nil
}

// GetDeliveryAcks retrieves delivery acks for a sender using cursor pagination, bounded by a 14-day retention window.
func (r *SQLiteMessageRepository) GetDeliveryAcks(ctx context.Context, senderID string, cursor int64, limit int) ([]*domain.DeliveryAck, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	// Retention cutoff: 14 days in milliseconds
	minCreatedAt := (time.Now().Unix() - 14*24*3600) * 1000
	var acks []*domain.DeliveryAck
	query := `SELECT id, sender_id, request_id, 
		CASE WHEN created_at < 10000000000 THEN created_at * 1000 ELSE created_at END AS created_at 
		FROM delivery_acks WHERE sender_id = ? AND id > ? AND (CASE WHEN created_at < 10000000000 THEN created_at * 1000 ELSE created_at END) >= ? ORDER BY id ASC LIMIT ?`
	if err := sqlx.SelectContext(ctx, r.reader, &acks, query, senderID, cursor, minCreatedAt, limit); err != nil {
		return nil, fmt.Errorf("querying delivery acks: %w", err)
	}
	return acks, nil
}

// DeleteExpiredDeliveryAcks removes delivery acks older than the specified epoch seconds.
func (r *SQLiteMessageRepository) DeleteExpiredDeliveryAcks(ctx context.Context, olderThan int64) error {
	db := r.getWriter(ctx)
	query := `DELETE FROM delivery_acks WHERE created_at < ?`
	_, err := db.ExecContext(ctx, query, olderThan)
	if err != nil {
		return fmt.Errorf("deleting expired delivery acks: %w", err)
	}
	return nil
}

