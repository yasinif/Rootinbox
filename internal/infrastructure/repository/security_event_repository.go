package repository

import (
	"context"
	"encoding/base64"
	"fmt"
	"strings"

	"github.com/jmoiron/sqlx"
	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"
)

type SQLiteSecurityEventRepository struct {
	writer *sqlx.DB
	reader *sqlx.DB
}

func NewSecurityEventRepository(writer, reader *sqlx.DB) *SQLiteSecurityEventRepository {
	return &SQLiteSecurityEventRepository{
		writer: writer,
		reader: reader,
	}
}

type securityEventModel struct {
	ID           string  `db:"id"`
	EventType    string  `db:"event_type"`
	IdentityHash *string `db:"identity_hash"`
	IPHash       *string `db:"ip_hash"`
	TraceID      *string `db:"trace_id"`
	AdminAction  *string `db:"admin_action"`
	CreatedAt    int64   `db:"created_at"`
}

func (m *securityEventModel) toDomain() *domain.SecurityEvent {
	e := &domain.SecurityEvent{
		ID:           m.ID,
		EventType:    domain.SecurityEventType(m.EventType),
		IdentityHash: m.IdentityHash,
		IPHash:       m.IPHash,
		TraceID:      m.TraceID,
		CreatedAt:    m.CreatedAt,
	}
	if m.AdminAction != nil {
		aa := domain.AdminAction(*m.AdminAction)
		e.AdminAction = &aa
	}
	return e
}

func (r *SQLiteSecurityEventRepository) Create(ctx context.Context, e *domain.SecurityEvent) error {
	query := `
		INSERT INTO security_events (id, event_type, identity_hash, ip_hash, trace_id, admin_action, created_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`
	var adminAction *string
	if e.AdminAction != nil {
		s := string(*e.AdminAction)
		adminAction = &s
	}

	var exec sqlx.ExtContext = r.writer
	if tx, ok := database.TxFromContext(ctx); ok {
		exec = tx
	}

	_, err := exec.ExecContext(ctx, query,
		e.ID,
		string(e.EventType),
		e.IdentityHash,
		e.IPHash,
		e.TraceID,
		adminAction,
		e.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("insert security event: %w", err)
	}
	return nil
}

func (r *SQLiteSecurityEventRepository) Query(ctx context.Context, f domain.SecurityEventFilter) ([]*domain.SecurityEvent, *string, error) {
	query := `SELECT id, event_type, identity_hash, ip_hash, trace_id, admin_action, created_at FROM security_events WHERE 1=1`
	var args []interface{}

	if f.EventType != nil {
		query += ` AND event_type = ?`
		args = append(args, string(*f.EventType))
	}
	if f.IdentityHash != nil {
		query += ` AND identity_hash = ?`
		args = append(args, *f.IdentityHash)
	}
	if f.IPHash != nil {
		query += ` AND ip_hash = ?`
		args = append(args, *f.IPHash)
	}
	if f.StartTime != nil {
		query += ` AND created_at >= ?`
		args = append(args, *f.StartTime)
	}
	if f.EndTime != nil {
		query += ` AND created_at <= ?`
		args = append(args, *f.EndTime)
	}

	if f.Cursor != nil && *f.Cursor != "" {
		dec, err := base64.RawURLEncoding.DecodeString(*f.Cursor)
		if err == nil {
			parts := strings.Split(string(dec), "|")
			if len(parts) == 2 {
				query += ` AND (created_at < ? OR (created_at = ? AND id < ?))`
				args = append(args, parts[0], parts[0], parts[1])
			}
		}
	}

	limit := f.Limit
	if limit <= 0 {
		limit = 50
	} else if limit > 100 {
		limit = 100
	}
	query += ` ORDER BY created_at DESC, id DESC LIMIT ?`
	args = append(args, limit+1)

	rows, err := r.reader.QueryxContext(ctx, query, args...)
	if err != nil {
		return nil, nil, fmt.Errorf("query security events: %w", err)
	}
	defer rows.Close()

	var events []*domain.SecurityEvent
	for rows.Next() {
		var m securityEventModel
		if err := rows.StructScan(&m); err != nil {
			return nil, nil, fmt.Errorf("scan security event: %w", err)
		}
		events = append(events, m.toDomain())
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("rows security events: %w", err)
	}

	var nextCursor *string
	if len(events) > limit {
		events = events[:limit]
		last := events[len(events)-1]
		c := base64.RawURLEncoding.EncodeToString([]byte(fmt.Sprintf("%d|%s", last.CreatedAt, last.ID)))
		nextCursor = &c
	}

	return events, nextCursor, nil
}

func (r *SQLiteSecurityEventRepository) DeleteOlderThan(ctx context.Context, cutoffUnix int64, batchSize int) (int64, error) {
	query := `DELETE FROM security_events WHERE id IN (SELECT id FROM security_events WHERE created_at < ? LIMIT ?)`
	var exec sqlx.ExtContext = r.writer
	if tx, ok := database.TxFromContext(ctx); ok {
		exec = tx
	}

	res, err := exec.ExecContext(ctx, query, cutoffUnix, batchSize)
	if err != nil {
		return 0, fmt.Errorf("delete old security events: %w", err)
	}
	return res.RowsAffected()
}
