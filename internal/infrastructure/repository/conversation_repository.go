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

// convModel is the internal SQL model for the conversations table.
type convModel struct {
	ID          string  `db:"id"`
	Type        string  `db:"type"`
	CreatedAt   int64   `db:"created_at"`
	Name        *string `db:"name"`
	Description *string `db:"description"`
	CreatedBy   *string `db:"created_by"`
	IsPublic    int     `db:"is_public"`
	Username    *string `db:"username"`
	InviteCode  *string `db:"invite_code"`
}

func (m *convModel) toDomain() *domain.Conversation {
	return &domain.Conversation{
		ID:          m.ID,
		Type:        domain.ConversationType(m.Type),
		CreatedAt:   domain.NormalizeTimestamp(m.CreatedAt),
		Name:        m.Name,
		Description: m.Description,
		CreatedBy:   m.CreatedBy,
		IsPublic:    m.IsPublic == 1,
		Username:    m.Username,
		InviteCode:  m.InviteCode,
	}
}

// SQLiteConversationRepository implements domain.ConversationRepository using SQLite.
type SQLiteConversationRepository struct {
	writer *sqlx.DB
	reader *sqlx.DB
}

// NewConversationRepository creates a new SQLite-backed ConversationRepository.
// Defensively ensures conversation_read_watermarks table exists.
func NewConversationRepository(writer, reader *sqlx.DB) *SQLiteConversationRepository {
	repo := &SQLiteConversationRepository{writer: writer, reader: reader}
	_ = repo.EnsureWatermarksTable(context.Background())
	return repo
}

func (r *SQLiteConversationRepository) getWriter(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.writer
}

func (r *SQLiteConversationRepository) getReader(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.reader
}

// Create persists a new conversation.
func (r *SQLiteConversationRepository) Create(ctx context.Context, conv *domain.Conversation) error {
	db := r.getWriter(ctx)
	isPublicInt := 0
	if conv.IsPublic {
		isPublicInt = 1
	}
	normCreatedAt := domain.NormalizeTimestamp(conv.CreatedAt)
	conv.CreatedAt = normCreatedAt
	_, err := db.ExecContext(ctx,
		"INSERT INTO conversations (id, type, created_at, name, description, created_by, is_public, username, invite_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		conv.ID, string(conv.Type), normCreatedAt, conv.Name, conv.Description, conv.CreatedBy, isPublicInt, conv.Username, conv.InviteCode,
	)
	if err != nil {
		return fmt.Errorf("inserting conversation: %w", err)
	}
	return nil
}

// GetByID retrieves a conversation by its canonical UUIDv4.
func (r *SQLiteConversationRepository) GetByID(ctx context.Context, id string) (*domain.Conversation, error) {
	db := r.getReader(ctx)
	var m convModel
	err := sqlx.GetContext(ctx, db, &m, "SELECT id, type, created_at, name, description, created_by, is_public, username, invite_code FROM conversations WHERE id = ?", id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, domain.NewDomainError(domain.ErrConv001, "conversation not found", nil)
		}
		return nil, fmt.Errorf("querying conversation by id: %w", err)
	}
	return m.toDomain(), nil
}

// GetByInviteCode retrieves a conversation by its private invite code.
func (r *SQLiteConversationRepository) GetByInviteCode(ctx context.Context, inviteCode string) (*domain.Conversation, error) {
	db := r.getReader(ctx)
	var m convModel
	err := sqlx.GetContext(ctx, db, &m, "SELECT id, type, created_at, name, description, created_by, is_public, username, invite_code FROM conversations WHERE invite_code = ?", inviteCode)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, domain.NewDomainError(domain.ErrConv001, "conversation not found", nil)
		}
		return nil, fmt.Errorf("querying conversation by invite code: %w", err)
	}
	return m.toDomain(), nil
}

// GetByUsername retrieves a public conversation by its username.
func (r *SQLiteConversationRepository) GetByUsername(ctx context.Context, username string) (*domain.Conversation, error) {
	db := r.getReader(ctx)
	var m convModel
	err := sqlx.GetContext(ctx, db, &m, "SELECT id, type, created_at, name, description, created_by, is_public, username, invite_code FROM conversations WHERE LOWER(username) = LOWER(?) AND is_public = 1", username)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, domain.NewDomainError(domain.ErrConv001, "conversation not found", nil)
		}
		return nil, fmt.Errorf("querying conversation by username: %w", err)
	}
	return m.toDomain(), nil
}

// SearchPublic retrieves public conversations matching query with limit.
func (r *SQLiteConversationRepository) SearchPublic(ctx context.Context, query string, limit int) ([]*domain.Conversation, error) {
	db := r.getReader(ctx)
	pattern := "%" + query + "%"
	var models []convModel
	err := sqlx.SelectContext(ctx, db, &models,
		`SELECT id, type, created_at, name, description, created_by, is_public, username, invite_code
		 FROM conversations
		 WHERE is_public = 1
		   AND (LOWER(username) LIKE LOWER(?) OR LOWER(name) LIKE LOWER(?))
		 ORDER BY created_at DESC
		 LIMIT ?`,
		pattern, pattern, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("searching public conversations: %w", err)
	}
	convs := make([]*domain.Conversation, len(models))
	for i, m := range models {
		convs[i] = m.toDomain()
	}
	return convs, nil
}

// ListByUserID retrieves conversations for a user with cursor-based pagination.
// RFC-0002 §4.5: Traditional OFFSET/LIMIT pagination is FORBIDDEN.
// RFC-0002 §4.5: Cursor Format is Base64URL(last_created_at + "_" + last_uuid).
func (r *SQLiteConversationRepository) ListByUserID(ctx context.Context, userID string, cursor *domain.Cursor, limit int) ([]*domain.Conversation, *domain.Cursor, error) {
	db := r.getReader(ctx)

	var models []convModel
	var err error

	if cursor != nil {
		// Paginated query: fetch conversations older than cursor position.
		// Expanded (created_at, id) < (cursor_created_at, cursor_id) for SQLite compatibility.
		err = sqlx.SelectContext(ctx, db, &models,
			`SELECT c.id, c.type, c.created_at, c.name, c.description, c.created_by, c.is_public, c.username, c.invite_code
			 FROM conversations c
			 INNER JOIN participants p ON p.conversation_id = c.id
			 WHERE p.user_id = ?
			   AND (c.created_at < ? OR (c.created_at = ? AND c.id < ?))
			 GROUP BY c.id
			 ORDER BY c.created_at DESC, c.id DESC
			 LIMIT ?`,
			userID, cursor.CreatedAt, cursor.CreatedAt, cursor.ID, limit+1,
		)
	} else {
		// First page: no cursor condition.
		err = sqlx.SelectContext(ctx, db, &models,
			`SELECT c.id, c.type, c.created_at, c.name, c.description, c.created_by, c.is_public, c.username, c.invite_code
			 FROM conversations c
			 INNER JOIN participants p ON p.conversation_id = c.id
			 WHERE p.user_id = ?
			 GROUP BY c.id
			 ORDER BY c.created_at DESC, c.id DESC
			 LIMIT ?`,
			userID, limit+1,
		)
	}
	if err != nil {
		return nil, nil, fmt.Errorf("listing conversations for user: %w", err)
	}

	// Determine if there are more results.
	var nextCursor *domain.Cursor
	if len(models) > limit {
		models = models[:limit]
		last := models[len(models)-1]
		nextCursor = &domain.Cursor{
			CreatedAt: last.CreatedAt,
			ID:        last.ID,
		}
	}

	convs := make([]*domain.Conversation, len(models))
	for i, m := range models {
		convs[i] = m.toDomain()
	}

	return convs, nextCursor, nil
}

// Delete removes a conversation by ID.
func (r *SQLiteConversationRepository) Delete(ctx context.Context, id string) error {
	db := r.getWriter(ctx)
	result, err := db.ExecContext(ctx, "DELETE FROM conversations WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("deleting conversation: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("checking rows affected: %w", err)
	}
	if rows == 0 {
		return domain.NewDomainError(domain.ErrConv001, "conversation not found", nil)
	}
	return nil
}

// DeleteOrphaned removes all conversations with zero participants.
// RFC-0002 §4.3 Step 2: Delete all orphaned conversations where count(participants) == 0.
func (r *SQLiteConversationRepository) DeleteOrphaned(ctx context.Context) (int64, error) {
	db := r.getWriter(ctx)
	result, err := db.ExecContext(ctx,
		`DELETE FROM conversations
		 WHERE id NOT IN (SELECT DISTINCT conversation_id FROM participants)`,
	)
	if err != nil {
		return 0, fmt.Errorf("deleting orphaned conversations: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("checking rows affected: %w", err)
	}
	return rows, nil
}

// EnsureWatermarksTable initializes the conversation_read_watermarks schema idempotently.
func (r *SQLiteConversationRepository) EnsureWatermarksTable(ctx context.Context) error {
	query := `
	CREATE TABLE IF NOT EXISTS conversation_read_watermarks (
		user_id TEXT NOT NULL,
		conversation_id TEXT NOT NULL,
		last_read_at INTEGER NOT NULL,
		last_delivered_at INTEGER NOT NULL DEFAULT 0,
		cleared_at INTEGER NOT NULL DEFAULT 0,
		hidden_at INTEGER NOT NULL DEFAULT 0,
		PRIMARY KEY (user_id, conversation_id),
		FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
	);
	CREATE INDEX IF NOT EXISTS idx_conv_watermarks_user ON conversation_read_watermarks(user_id);
	`
	db := r.getWriter(ctx)
	if _, err := db.ExecContext(ctx, query); err != nil {
		return err
	}
	// Backward compatibility: ensure columns exist if table pre-existed
	_, _ = db.ExecContext(ctx, "ALTER TABLE conversation_read_watermarks ADD COLUMN last_delivered_at INTEGER NOT NULL DEFAULT 0")
	_, _ = db.ExecContext(ctx, "ALTER TABLE conversation_read_watermarks ADD COLUMN cleared_at INTEGER NOT NULL DEFAULT 0")
	_, _ = db.ExecContext(ctx, "ALTER TABLE conversation_read_watermarks ADD COLUMN hidden_at INTEGER NOT NULL DEFAULT 0")
	return nil
}

// SetWatermark records the last read timestamp for a user in a conversation.
// Phase 4: Reading a conversation also advances delivery watermark to lastReadAt.
func (r *SQLiteConversationRepository) SetWatermark(ctx context.Context, userID, conversationID string, lastReadAt int64) error {
	normLastReadAt := domain.NormalizeTimestamp(lastReadAt)
	query := `
		INSERT INTO conversation_read_watermarks (user_id, conversation_id, last_read_at, last_delivered_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(user_id, conversation_id) DO UPDATE SET
			last_read_at = MAX(
				CASE 
					WHEN conversation_read_watermarks.last_read_at > 0 AND conversation_read_watermarks.last_read_at < 10000000000 
					THEN conversation_read_watermarks.last_read_at * 1000 
					ELSE conversation_read_watermarks.last_read_at 
				END,
				CASE 
					WHEN excluded.last_read_at > 0 AND excluded.last_read_at < 10000000000 
					THEN excluded.last_read_at * 1000 
					ELSE excluded.last_read_at 
				END
			),
			last_delivered_at = MAX(
				CASE 
					WHEN conversation_read_watermarks.last_delivered_at > 0 AND conversation_read_watermarks.last_delivered_at < 10000000000 
					THEN conversation_read_watermarks.last_delivered_at * 1000 
					ELSE conversation_read_watermarks.last_delivered_at 
				END,
				CASE 
					WHEN excluded.last_delivered_at > 0 AND excluded.last_delivered_at < 10000000000 
					THEN excluded.last_delivered_at * 1000 
					ELSE excluded.last_delivered_at 
				END
			)
	`
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx, query, userID, conversationID, normLastReadAt, normLastReadAt)
	if err != nil {
		return fmt.Errorf("setting conversation watermark: %w", err)
	}
	return nil
}

// SetDeliveryWatermark records the last delivered timestamp for a user in a conversation.
func (r *SQLiteConversationRepository) SetDeliveryWatermark(ctx context.Context, userID, conversationID string, lastDeliveredAt int64) error {
	normDeliveredAt := domain.NormalizeTimestamp(lastDeliveredAt)
	query := `
		INSERT INTO conversation_read_watermarks (user_id, conversation_id, last_read_at, last_delivered_at)
		VALUES (?, ?, 0, ?)
		ON CONFLICT(user_id, conversation_id) DO UPDATE SET
			last_delivered_at = MAX(
				CASE 
					WHEN conversation_read_watermarks.last_delivered_at > 0 AND conversation_read_watermarks.last_delivered_at < 10000000000 
					THEN conversation_read_watermarks.last_delivered_at * 1000 
					ELSE conversation_read_watermarks.last_delivered_at 
				END,
				CASE 
					WHEN excluded.last_delivered_at > 0 AND excluded.last_delivered_at < 10000000000 
					THEN excluded.last_delivered_at * 1000 
					ELSE excluded.last_delivered_at 
				END
			)
	`
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx, query, userID, conversationID, normDeliveredAt)
	if err != nil {
		return fmt.Errorf("setting conversation delivery watermark: %w", err)
	}
	return nil
}

// GetDeliveryWatermark retrieves the last delivered timestamp for a user in a conversation.
func (r *SQLiteConversationRepository) GetDeliveryWatermark(ctx context.Context, userID, conversationID string) (int64, error) {
	query := `SELECT 
		CASE 
			WHEN last_delivered_at > 0 AND last_delivered_at < 10000000000 THEN last_delivered_at * 1000 
			ELSE last_delivered_at 
		END AS last_delivered_at 
		FROM conversation_read_watermarks WHERE user_id = ? AND conversation_id = ?`
	db := r.getReader(ctx)
	var lastDeliveredAt int64
	err := sqlx.GetContext(ctx, db, &lastDeliveredAt, query, userID, conversationID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, nil
		}
		return 0, fmt.Errorf("getting conversation delivery watermark: %w", err)
	}
	return domain.NormalizeTimestamp(lastDeliveredAt), nil
}

// GetPeerWatermarks retrieves the highest read and delivery watermarks among other participants.
func (r *SQLiteConversationRepository) GetPeerWatermarks(ctx context.Context, conversationID, currentUserID string) (int64, int64, error) {
	query := `SELECT 
		COALESCE(MAX(
			CASE 
				WHEN last_read_at > 0 AND last_read_at < 10000000000 THEN last_read_at * 1000 
				ELSE last_read_at 
			END
		), 0) AS peer_last_read_at,
		COALESCE(MAX(
			MAX(
				CASE 
					WHEN last_delivered_at > 0 AND last_delivered_at < 10000000000 THEN last_delivered_at * 1000 
					ELSE last_delivered_at 
				END,
				CASE 
					WHEN last_read_at > 0 AND last_read_at < 10000000000 THEN last_read_at * 1000 
					ELSE last_read_at 
				END
			)
		), 0) AS peer_last_delivered_at
		FROM conversation_read_watermarks
		WHERE conversation_id = ? AND user_id != ?`
	db := r.getReader(ctx)
	type peerWatermarksRow struct {
		PeerLastReadAt      int64 `db:"peer_last_read_at"`
		PeerLastDeliveredAt int64 `db:"peer_last_delivered_at"`
	}
	var row peerWatermarksRow
	err := sqlx.GetContext(ctx, db, &row, query, conversationID, currentUserID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, 0, nil
		}
		return 0, 0, fmt.Errorf("getting peer watermarks: %w", err)
	}
	return domain.NormalizeTimestamp(row.PeerLastReadAt), domain.NormalizeTimestamp(row.PeerLastDeliveredAt), nil
}

// GetWatermark retrieves the last read timestamp for a user in a conversation.
func (r *SQLiteConversationRepository) GetWatermark(ctx context.Context, userID, conversationID string) (int64, error) {
	query := `SELECT 
		CASE 
			WHEN last_read_at > 0 AND last_read_at < 10000000000 THEN last_read_at * 1000 
			ELSE last_read_at 
		END AS last_read_at 
		FROM conversation_read_watermarks WHERE user_id = ? AND conversation_id = ?`
	db := r.getReader(ctx)
	var lastReadAt int64
	err := sqlx.GetContext(ctx, db, &lastReadAt, query, userID, conversationID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, nil
		}
		return 0, fmt.Errorf("getting conversation watermark: %w", err)
	}
	return domain.NormalizeTimestamp(lastReadAt), nil
}

// GetWatermarksForUser retrieves all conversation read watermarks for a user.
func (r *SQLiteConversationRepository) GetWatermarksForUser(ctx context.Context, userID string) (map[string]int64, error) {
	query := `SELECT conversation_id, 
		CASE 
			WHEN last_read_at > 0 AND last_read_at < 10000000000 THEN last_read_at * 1000 
			ELSE last_read_at 
		END AS last_read_at 
		FROM conversation_read_watermarks WHERE user_id = ?`
	db := r.getReader(ctx)
	type watermarkRow struct {
		ConversationID string `db:"conversation_id"`
		LastReadAt     int64  `db:"last_read_at"`
	}
	var rows []watermarkRow
	err := sqlx.SelectContext(ctx, db, &rows, query, userID)
	if err != nil {
		return nil, fmt.Errorf("getting user watermarks: %w", err)
	}
	watermarks := make(map[string]int64, len(rows))
	for _, row := range rows {
		watermarks[row.ConversationID] = domain.NormalizeTimestamp(row.LastReadAt)
	}
	return watermarks, nil
}

// SetClearedAt records the cleared_at timestamp for a user in a conversation and advances last_read_at.
func (r *SQLiteConversationRepository) SetClearedAt(ctx context.Context, userID, conversationID string, clearedAt int64) error {
	normClearedAt := domain.NormalizeTimestamp(clearedAt)
	query := `
		INSERT INTO conversation_read_watermarks (user_id, conversation_id, last_read_at, last_delivered_at, cleared_at, hidden_at)
		VALUES (?, ?, ?, ?, ?, 0)
		ON CONFLICT(user_id, conversation_id) DO UPDATE SET
			cleared_at = excluded.cleared_at,
			last_read_at = MAX(
				CASE 
					WHEN conversation_read_watermarks.last_read_at > 0 AND conversation_read_watermarks.last_read_at < 10000000000 
					THEN conversation_read_watermarks.last_read_at * 1000 
					ELSE conversation_read_watermarks.last_read_at 
				END,
				excluded.last_read_at
			)
	`
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx, query, userID, conversationID, normClearedAt, normClearedAt, normClearedAt)
	if err != nil {
		return fmt.Errorf("setting conversation cleared watermark: %w", err)
	}
	return nil
}

// GetClearedAt retrieves the cleared_at timestamp for a user in a conversation.
func (r *SQLiteConversationRepository) GetClearedAt(ctx context.Context, userID, conversationID string) (int64, error) {
	query := `SELECT 
		CASE 
			WHEN cleared_at > 0 AND cleared_at < 10000000000 THEN cleared_at * 1000 
			ELSE cleared_at 
		END AS cleared_at 
		FROM conversation_read_watermarks WHERE user_id = ? AND conversation_id = ?`
	db := r.getReader(ctx)
	var clearedAt int64
	err := sqlx.GetContext(ctx, db, &clearedAt, query, userID, conversationID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, nil
		}
		return 0, fmt.Errorf("getting conversation cleared watermark: %w", err)
	}
	return domain.NormalizeTimestamp(clearedAt), nil
}

// SetHiddenAt sets hidden_at, cleared_at, and last_read_at when deleting a conversation "for me".
func (r *SQLiteConversationRepository) SetHiddenAt(ctx context.Context, userID, conversationID string, hiddenAt int64) error {
	normHiddenAt := domain.NormalizeTimestamp(hiddenAt)
	query := `
		INSERT INTO conversation_read_watermarks (user_id, conversation_id, last_read_at, last_delivered_at, cleared_at, hidden_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, conversation_id) DO UPDATE SET
			hidden_at = excluded.hidden_at,
			cleared_at = excluded.cleared_at,
			last_read_at = MAX(
				CASE 
					WHEN conversation_read_watermarks.last_read_at > 0 AND conversation_read_watermarks.last_read_at < 10000000000 
					THEN conversation_read_watermarks.last_read_at * 1000 
					ELSE conversation_read_watermarks.last_read_at 
				END,
				excluded.last_read_at
			)
	`
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx, query, userID, conversationID, normHiddenAt, normHiddenAt, normHiddenAt, normHiddenAt)
	if err != nil {
		return fmt.Errorf("setting conversation hidden watermark: %w", err)
	}
	return nil
}

// GetHiddenAt retrieves the hidden_at timestamp for a user in a conversation.
func (r *SQLiteConversationRepository) GetHiddenAt(ctx context.Context, userID, conversationID string) (int64, error) {
	query := `SELECT 
		CASE 
			WHEN hidden_at > 0 AND hidden_at < 10000000000 THEN hidden_at * 1000 
			ELSE hidden_at 
		END AS hidden_at 
		FROM conversation_read_watermarks WHERE user_id = ? AND conversation_id = ?`
	db := r.getReader(ctx)
	var hiddenAt int64
	err := sqlx.GetContext(ctx, db, &hiddenAt, query, userID, conversationID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, nil
		}
		return 0, fmt.Errorf("getting conversation hidden watermark: %w", err)
	}
	return domain.NormalizeTimestamp(hiddenAt), nil
}

