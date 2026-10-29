package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jmoiron/sqlx"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"
)

type callModel struct {
	ID                 string  `db:"id"`
	ConversationID     string  `db:"conversation_id"`
	CallerID           string  `db:"caller_id"`
	CalleeID           string  `db:"callee_id"`
	Type               string  `db:"type"`
	RequestFingerprint string  `db:"request_fingerprint"`
	Status             string  `db:"status"`
	StartedAt          *int64  `db:"started_at"`
	EndedAt            *int64  `db:"ended_at"`
	CreatedAt          int64   `db:"created_at"`
}

func (m *callModel) toDomain() *domain.Call {
	return &domain.Call{
		ID:                 m.ID,
		ConversationID:     m.ConversationID,
		CallerID:           m.CallerID,
		CalleeID:           m.CalleeID,
		Type:               domain.CallType(m.Type),
		RequestFingerprint: m.RequestFingerprint,
		Status:             domain.CallStatus(m.Status),
		StartedAt:          m.StartedAt,
		EndedAt:            m.EndedAt,
		CreatedAt:          m.CreatedAt,
	}
}

// SQLiteCallRepository implements domain.CallRepository.
type SQLiteCallRepository struct {
	writer *sqlx.DB
	reader *sqlx.DB
}

func NewCallRepository(writer, reader *sqlx.DB) *SQLiteCallRepository {
	return &SQLiteCallRepository{writer: writer, reader: reader}
}

func (r *SQLiteCallRepository) getWriter(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.writer
}

func (r *SQLiteCallRepository) Create(ctx context.Context, call *domain.Call) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx,
		`INSERT INTO calls (id, conversation_id, caller_id, callee_id, type, request_fingerprint, status, started_at, ended_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		call.ID, call.ConversationID, call.CallerID, call.CalleeID,
		string(call.Type), call.RequestFingerprint, string(call.Status),
		call.StartedAt, call.EndedAt, call.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("inserting call: %w", err)
	}
	return nil
}

func (r *SQLiteCallRepository) GetByID(ctx context.Context, id string) (*domain.Call, error) {
	// Read from writer to support reads within transactions.
	db := r.getWriter(ctx)
	var model callModel
	err := sqlx.GetContext(ctx, db, &model,
		`SELECT id, conversation_id, caller_id, callee_id, type, request_fingerprint, status, started_at, ended_at, created_at
		 FROM calls WHERE id = ?`, id,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("querying call: %w", err)
	}
	return model.toDomain(), nil
}

// UpdateStatus atomically transitions a call status.
func (r *SQLiteCallRepository) UpdateStatus(ctx context.Context, id string, from, to domain.CallStatus) (int64, error) {
	db := r.getWriter(ctx)
	result, err := db.ExecContext(ctx,
		`UPDATE calls SET status = ? WHERE id = ? AND status = ?`,
		string(to), id, string(from),
	)
	if err != nil {
		return 0, fmt.Errorf("updating call status: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("checking call status update: %w", err)
	}
	return rows, nil
}

// SetActive transitions RINGING→ACTIVE and sets started_at.
func (r *SQLiteCallRepository) SetActive(ctx context.Context, id string, startedAt int64) (int64, error) {
	db := r.getWriter(ctx)
	result, err := db.ExecContext(ctx,
		`UPDATE calls SET status = 'ACTIVE', started_at = ? WHERE id = ? AND status = 'RINGING'`,
		startedAt, id,
	)
	if err != nil {
		return 0, fmt.Errorf("setting call active: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("checking set active: %w", err)
	}
	return rows, nil
}

// SetEnded transitions to a terminal state and sets ended_at.
func (r *SQLiteCallRepository) SetEnded(ctx context.Context, id string, from, to domain.CallStatus, endedAt int64) (int64, error) {
	db := r.getWriter(ctx)
	result, err := db.ExecContext(ctx,
		`UPDATE calls SET status = ?, ended_at = ? WHERE id = ? AND status = ?`,
		string(to), endedAt, id, string(from),
	)
	if err != nil {
		return 0, fmt.Errorf("ending call: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("checking call end: %w", err)
	}
	return rows, nil
}

// GetActiveByUserID finds RINGING or ACTIVE calls involving a user.
func (r *SQLiteCallRepository) GetActiveByUserID(ctx context.Context, userID string) ([]*domain.Call, error) {
	db := r.getWriter(ctx)
	var models []callModel
	err := sqlx.SelectContext(ctx, db, &models,
		`SELECT id, conversation_id, caller_id, callee_id, type, request_fingerprint, status, started_at, ended_at, created_at
		 FROM calls WHERE (caller_id = ? OR callee_id = ?) AND status IN ('RINGING', 'ACTIVE')`,
		userID, userID,
	)
	if err != nil {
		return nil, fmt.Errorf("querying active calls: %w", err)
	}
	calls := make([]*domain.Call, len(models))
	for i, m := range models {
		calls[i] = m.toDomain()
	}
	return calls, nil
}

// TransitionStaleRinging transitions RINGING calls older than a timestamp to MISSED.
func (r *SQLiteCallRepository) TransitionStaleRinging(ctx context.Context, olderThan int64) ([]string, error) {
	var ids []string
	err := r.writer.SelectContext(ctx, &ids,
		`UPDATE calls SET status = 'MISSED', ended_at = ? WHERE status = 'RINGING' AND created_at < ? RETURNING id`,
		olderThan, olderThan,
	)
	if err != nil {
		return nil, fmt.Errorf("transitioning stale ringing: %w", err)
	}
	return ids, nil
}

// TransitionAllRingingToFailed transitions all RINGING to FAILED (crash recovery).
func (r *SQLiteCallRepository) TransitionAllRingingToFailed(ctx context.Context, endedAt int64) (int64, error) {
	result, err := r.writer.ExecContext(ctx,
		`UPDATE calls SET status = 'FAILED', ended_at = ? WHERE status = 'RINGING'`,
		endedAt,
	)
	if err != nil {
		return 0, fmt.Errorf("transitioning ringing to failed: %w", err)
	}
	return result.RowsAffected()
}

// TransitionAllActiveToEnded transitions all ACTIVE to ENDED (crash recovery).
func (r *SQLiteCallRepository) TransitionAllActiveToEnded(ctx context.Context, endedAt int64) (int64, error) {
	result, err := r.writer.ExecContext(ctx,
		`UPDATE calls SET status = 'ENDED', ended_at = ? WHERE status = 'ACTIVE'`,
		endedAt,
	)
	if err != nil {
		return 0, fmt.Errorf("transitioning active to ended: %w", err)
	}
	return result.RowsAffected()
}

func (r *SQLiteCallRepository) Delete(ctx context.Context, id string) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx, "DELETE FROM calls WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("deleting call: %w", err)
	}
	return nil
}

// GetMissedCallsByCallee retrieves missed calls for a callee, ordered by created_at DESC.
func (r *SQLiteCallRepository) GetMissedCallsByCallee(ctx context.Context, calleeID string, limit int) ([]*domain.Call, error) {
	db := r.getWriter(ctx)
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	var models []callModel
	err := sqlx.SelectContext(ctx, db, &models,
		`SELECT id, conversation_id, caller_id, callee_id, type, request_fingerprint, status, started_at, ended_at, created_at
		 FROM calls WHERE callee_id = ? AND status = 'MISSED' ORDER BY created_at DESC LIMIT ?`,
		calleeID, limit,
	)
	if err != nil {
		return nil, fmt.Errorf("querying missed calls: %w", err)
	}
	calls := make([]*domain.Call, len(models))
	for i, m := range models {
		calls[i] = m.toDomain()
	}
	return calls, nil
}
