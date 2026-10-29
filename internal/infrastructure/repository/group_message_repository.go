package repository

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/jmoiron/sqlx"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"
	"rootinbox/pkg/crypto"
)

const encPrefix = "enc:v1:"

func defaultFallbackKey() [32]byte {
	return sha256.Sum256([]byte("rootinbox:message_encryption_at_rest:default_fallback_key"))
}

// isCorruptedContent checks whether content contains unicode replacement char (\uFFFD)
// or non-printable binary control bytes (0x00-0x08, 0x0E-0x1F).
func isCorruptedContent(content string) bool {
	if !utf8.ValidString(content) || strings.ContainsRune(content, '\uFFFD') {
		return true
	}
	for i := 0; i < len(content); i++ {
		b := content[i]
		if (b <= 0x08) || (b >= 0x0E && b <= 0x1F) {
			return true
		}
	}
	return false
}

type groupMessageModel struct {
	ID             string         `db:"id"`
	ConversationID string         `db:"conversation_id"`
	SenderID       string         `db:"sender_id"`
	Content        string         `db:"content"`
	ReplyToID      sql.NullString `db:"reply_to_id"`
	EditedAt       sql.NullInt64  `db:"edited_at"`
	DeletedAt      sql.NullInt64  `db:"deleted_at"`
	CreatedAt      int64          `db:"created_at"`
	ServerID       int64          `db:"server_id"`
}

func (m *groupMessageModel) toDomain(r *SQLiteGroupMessageRepository) *domain.GroupMessage {
	content := m.Content
	if r != nil {
		content = r.decryptContent(m.ConversationID, m.Content)
	}
	if isCorruptedContent(content) {
		if r != nil && r.writer != nil {
			_, _ = r.writer.Exec("DELETE FROM group_messages WHERE id = ?", m.ID)
		}
		return nil
	}
	gm := &domain.GroupMessage{
		ID:             m.ID,
		ConversationID: m.ConversationID,
		SenderID:       m.SenderID,
		Content:        content,
		CreatedAt:      domain.NormalizeTimestamp(m.CreatedAt),
		ServerID:       m.ServerID,
	}
	if m.ReplyToID.Valid {
		gm.ReplyToID = &m.ReplyToID.String
	}
	if m.EditedAt.Valid {
		gm.EditedAt = domain.NormalizeTimestampPtr(&m.EditedAt.Int64)
	}
	if m.DeletedAt.Valid {
		gm.DeletedAt = domain.NormalizeTimestampPtr(&m.DeletedAt.Int64)
	}
	return gm
}

// SQLiteGroupMessageRepository implements domain.GroupMessageRepository using SQLite.
// Implements Level-2 Security: Transparent Server-Side AES-256-GCM Encryption-at-Rest.
type SQLiteGroupMessageRepository struct {
	writer *sqlx.DB
	reader *sqlx.DB
	encKey [32]byte
}

// NewGroupMessageRepository creates a new SQLiteGroupMessageRepository.
// Accepts optional 32-byte key derived from server secret, or falls back safely for unit tests.
func NewGroupMessageRepository(writer, reader *sqlx.DB, encKey ...[32]byte) *SQLiteGroupMessageRepository {
	k := defaultFallbackKey()
	if len(encKey) > 0 {
		k = encKey[0]
	}
	return &SQLiteGroupMessageRepository{writer: writer, reader: reader, encKey: k}
}

func (r *SQLiteGroupMessageRepository) getWriter(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.writer
}

func (r *SQLiteGroupMessageRepository) getReader(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.reader
}

func (r *SQLiteGroupMessageRepository) getKey() [32]byte {
	if r.encKey == [32]byte{} {
		return defaultFallbackKey()
	}
	return r.encKey
}

func (r *SQLiteGroupMessageRepository) encryptContent(convID, plaintext string) (string, error) {
	if plaintext == "" || plaintext == "[deleted]" {
		return plaintext, nil
	}
	var iv [12]byte
	if _, err := rand.Read(iv[:]); err != nil {
		return "", fmt.Errorf("generating encryption IV: %w", err)
	}
	key := r.getKey()
	ciphertext, err := crypto.Encrypt(key, iv, []byte(plaintext), []byte(convID))
	if err != nil {
		return "", fmt.Errorf("encrypting message content: %w", err)
	}
	return fmt.Sprintf("%s%s:%s", encPrefix, base64.StdEncoding.EncodeToString(iv[:]), base64.StdEncoding.EncodeToString(ciphertext)), nil
}

func (r *SQLiteGroupMessageRepository) decryptContent(convID, stored string) string {
	if !strings.HasPrefix(stored, encPrefix) {
		return stored
	}
	trimmed := strings.TrimPrefix(stored, encPrefix)
	parts := strings.SplitN(trimmed, ":", 2)
	if len(parts) != 2 {
		return stored
	}
	ivBytes, err := base64.StdEncoding.DecodeString(parts[0])
	if err != nil || len(ivBytes) != 12 {
		return stored
	}
	ciphertext, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return stored
	}
	var iv [12]byte
	copy(iv[:], ivBytes)
	key := r.getKey()
	plaintext, err := crypto.Decrypt(key, iv, ciphertext, []byte(convID))
	if err != nil {
		return stored
	}
	return string(plaintext)
}

// Save inserts a new group message, allocating next monotonic server_id per conversation.
// Idempotent: If message with same UUID already exists, returns without error and populates msg with existing record.
// Level-2 Security: Transparently encrypts message content with AES-256-GCM bound to conversation_id AAD.
func (r *SQLiteGroupMessageRepository) Save(ctx context.Context, msg *domain.GroupMessage) error {
	if isCorruptedContent(msg.Content) {
		return domain.NewDomainError(domain.ErrSys001, "invalid message content: corrupted or binary data rejected", nil)
	}

	db := r.getWriter(ctx)

	// Idempotency check: if message with same ID already exists, preserve it and treat as success
	if msg.ID != "" {
		existing, err := r.GetByID(ctx, msg.ID)
		if err == nil && existing != nil {
			*msg = *existing
			return nil
		}
	}

	var nextServerID int64
	err := sqlx.GetContext(ctx, db, &nextServerID,
		"SELECT COALESCE(MAX(server_id), 0) + 1 FROM group_messages WHERE conversation_id = ?",
		msg.ConversationID,
	)
	if err != nil {
		return fmt.Errorf("allocating server_id for group message: %w", err)
	}

	msg.ServerID = nextServerID

	var replyTo sql.NullString
	if msg.ReplyToID != nil {
		replyTo = sql.NullString{String: *msg.ReplyToID, Valid: true}
	}
	var editedAt sql.NullInt64
	if msg.EditedAt != nil {
		editedAt = sql.NullInt64{Int64: domain.NormalizeTimestamp(*msg.EditedAt), Valid: true}
	}
	var deletedAt sql.NullInt64
	if msg.DeletedAt != nil {
		deletedAt = sql.NullInt64{Int64: domain.NormalizeTimestamp(*msg.DeletedAt), Valid: true}
	}

	normCreatedAt := domain.NormalizeTimestamp(msg.CreatedAt)
	msg.CreatedAt = normCreatedAt

	storedContent, err := r.encryptContent(msg.ConversationID, msg.Content)
	if err != nil {
		return fmt.Errorf("encrypting message content: %w", err)
	}

	_, err = db.ExecContext(ctx,
		`INSERT INTO group_messages (id, conversation_id, sender_id, content, reply_to_id, edited_at, deleted_at, created_at, server_id)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		msg.ID, msg.ConversationID, msg.SenderID, storedContent, replyTo, editedAt, deletedAt, normCreatedAt, msg.ServerID,
	)
	if err != nil {
		if msg.ID != "" {
			existing, getErr := r.GetByID(ctx, msg.ID)
			if getErr == nil && existing != nil {
				*msg = *existing
				return nil
			}
		}
		return fmt.Errorf("inserting group message: %w", err)
	}
	return nil
}

// GetByID retrieves a group message by ID, transparently decrypting content.
func (r *SQLiteGroupMessageRepository) GetByID(ctx context.Context, id string) (*domain.GroupMessage, error) {
	db := r.getReader(ctx)
	var m groupMessageModel
	err := sqlx.GetContext(ctx, db, &m,
		"SELECT id, conversation_id, sender_id, content, reply_to_id, edited_at, deleted_at, created_at, server_id FROM group_messages WHERE id = ?",
		id,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, domain.NewDomainError(domain.ErrMsg001, "group message not found", nil)
		}
		return nil, fmt.Errorf("querying group message: %w", err)
	}
	gm := m.toDomain(r)
	if gm == nil {
		return nil, domain.NewDomainError(domain.ErrMsg001, "group message not found", nil)
	}
	return gm, nil
}

// ListByConversation retrieves messages in a conversation, cursor-paginated by server_id.
// Transparently decrypts all encrypted messages before returning.
func (r *SQLiteGroupMessageRepository) ListByConversation(ctx context.Context, convID string, beforeServerID int64, limit int) ([]*domain.GroupMessage, error) {
	db := r.getReader(ctx)
	if limit <= 0 || limit > 100 {
		limit = 50
	}

	var models []groupMessageModel
	var err error
	if beforeServerID > 0 {
		err = sqlx.SelectContext(ctx, db, &models,
			`SELECT id, conversation_id, sender_id, content, reply_to_id, edited_at, deleted_at, created_at, server_id
			 FROM group_messages
			 WHERE conversation_id = ? AND server_id < ?
			 ORDER BY server_id DESC
			 LIMIT ?`,
			convID, beforeServerID, limit,
		)
	} else {
		err = sqlx.SelectContext(ctx, db, &models,
			`SELECT id, conversation_id, sender_id, content, reply_to_id, edited_at, deleted_at, created_at, server_id
			 FROM group_messages
			 WHERE conversation_id = ?
			 ORDER BY server_id DESC
			 LIMIT ?`,
			convID, limit,
		)
	}
	if err != nil {
		return nil, fmt.Errorf("listing group messages: %w", err)
	}

	messages := make([]*domain.GroupMessage, 0, len(models))
	for _, m := range models {
		gm := m.toDomain(r)
		if gm != nil {
			messages = append(messages, gm)
		}
	}
	return messages, nil
}

// UpdateContent modifies the content of a group message and marks edited_at.
// Transparently re-encrypts the updated plaintext using AES-256-GCM.
func (r *SQLiteGroupMessageRepository) UpdateContent(ctx context.Context, id string, content string, editedAt int64) error {
	if isCorruptedContent(content) {
		return domain.NewDomainError(domain.ErrSys001, "invalid message content: corrupted or binary data rejected", nil)
	}

	db := r.getWriter(ctx)

	var convID string
	err := sqlx.GetContext(ctx, db, &convID, "SELECT conversation_id FROM group_messages WHERE id = ? AND deleted_at IS NULL", id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return domain.NewDomainError(domain.ErrMsg001, "message not found or already deleted", nil)
		}
		return fmt.Errorf("querying message conversation: %w", err)
	}

	storedContent, err := r.encryptContent(convID, content)
	if err != nil {
		return fmt.Errorf("encrypting message content: %w", err)
	}

	normEditedAt := domain.NormalizeTimestamp(editedAt)
	result, err := db.ExecContext(ctx,
		"UPDATE group_messages SET content = ?, edited_at = ? WHERE id = ? AND deleted_at IS NULL",
		storedContent, normEditedAt, id,
	)
	if err != nil {
		return fmt.Errorf("updating group message content: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected: %w", err)
	}
	if rows == 0 {
		return domain.NewDomainError(domain.ErrMsg001, "message not found or already deleted", nil)
	}
	return nil
}

// SoftDelete marks a group message as deleted.
func (r *SQLiteGroupMessageRepository) SoftDelete(ctx context.Context, id string, deletedAt int64) error {
	db := r.getWriter(ctx)
	normDeletedAt := domain.NormalizeTimestamp(deletedAt)
	result, err := db.ExecContext(ctx,
		"UPDATE group_messages SET deleted_at = ?, content = '[deleted]' WHERE id = ?",
		normDeletedAt, id,
	)
	if err != nil {
		return fmt.Errorf("soft deleting group message: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected: %w", err)
	}
	if rows == 0 {
		return domain.NewDomainError(domain.ErrMsg001, "message not found", nil)
	}
	return nil
}

// HardDeleteByConversation permanently deletes all messages in a conversation.
func (r *SQLiteGroupMessageRepository) HardDeleteByConversation(ctx context.Context, convID string) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx, "DELETE FROM group_messages WHERE conversation_id = ?", convID)
	if err != nil {
		return fmt.Errorf("hard deleting group messages for conversation: %w", err)
	}
	return nil
}

// GetUnreadCount counts non-deleted messages in conversation where sender != currentUserID and created_at > myLastReadAt.
func (r *SQLiteGroupMessageRepository) GetUnreadCount(ctx context.Context, convID, currentUserID string, myLastReadAt int64) (int, error) {
	db := r.getReader(ctx)
	normReadAt := domain.NormalizeTimestamp(myLastReadAt)
	var count int
	query := `
		SELECT COUNT(*)
		FROM group_messages
		WHERE conversation_id = ?
		  AND sender_id != ?
		  AND deleted_at IS NULL
		  AND (CASE WHEN created_at > 0 AND created_at < 10000000000 THEN created_at * 1000 ELSE created_at END) > ?
	`
	err := sqlx.GetContext(ctx, db, &count, query, convID, currentUserID, normReadAt)
	if err != nil {
		return 0, fmt.Errorf("counting unread messages: %w", err)
	}
	return count, nil
}

// GetLastMessage returns the newest non-deleted message in conversation, decrypted.
func (r *SQLiteGroupMessageRepository) GetLastMessage(ctx context.Context, convID string, minCreatedAt ...int64) (*domain.GroupMessage, error) {
	db := r.getReader(ctx)
	minTime := int64(0)
	if len(minCreatedAt) > 0 && minCreatedAt[0] > 0 {
		minTime = domain.NormalizeTimestamp(minCreatedAt[0])
	}
	var models []groupMessageModel
	var err error
	if minTime > 0 {
		err = sqlx.SelectContext(ctx, db, &models, `
			SELECT id, conversation_id, sender_id, content, reply_to_id, edited_at, deleted_at, created_at, server_id
			FROM group_messages
			WHERE conversation_id = ? AND deleted_at IS NULL
			  AND (CASE WHEN created_at > 0 AND created_at < 10000000000 THEN created_at * 1000 ELSE created_at END) > ?
			ORDER BY server_id DESC, created_at DESC
			LIMIT 10
		`, convID, minTime)
	} else {
		err = sqlx.SelectContext(ctx, db, &models, `
			SELECT id, conversation_id, sender_id, content, reply_to_id, edited_at, deleted_at, created_at, server_id
			FROM group_messages
			WHERE conversation_id = ? AND deleted_at IS NULL
			ORDER BY server_id DESC, created_at DESC
			LIMIT 10
		`, convID)
	}
	if err != nil {
		return nil, fmt.Errorf("getting last message: %w", err)
	}
	for _, m := range models {
		gm := m.toDomain(r)
		if gm != nil {
			return gm, nil
		}
	}
	return nil, nil
}

// GetLastUnreadMessage returns newest unread message sent by another participant, decrypted.
func (r *SQLiteGroupMessageRepository) GetLastUnreadMessage(ctx context.Context, convID, currentUserID string, myLastReadAt int64) (*domain.GroupMessage, error) {
	db := r.getReader(ctx)
	normReadAt := domain.NormalizeTimestamp(myLastReadAt)
	var models []groupMessageModel
	query := `
		SELECT id, conversation_id, sender_id, content, reply_to_id, edited_at, deleted_at, created_at, server_id
		FROM group_messages
		WHERE conversation_id = ?
		  AND sender_id != ?
		  AND deleted_at IS NULL
		  AND (CASE WHEN created_at > 0 AND created_at < 10000000000 THEN created_at * 1000 ELSE created_at END) > ?
		ORDER BY server_id DESC, created_at DESC
		LIMIT 10
	`
	err := sqlx.SelectContext(ctx, db, &models, query, convID, currentUserID, normReadAt)
	if err != nil {
		return nil, fmt.Errorf("getting last unread message: %w", err)
	}
	for _, m := range models {
		gm := m.toDomain(r)
		if gm != nil {
			return gm, nil
		}
	}
	return nil, nil
}
