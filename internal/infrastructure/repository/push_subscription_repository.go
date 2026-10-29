package repository

import (
	"context"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"

	"github.com/jmoiron/sqlx"
)

type SQLitePushSubscriptionRepository struct {
	writer *sqlx.DB
	reader *sqlx.DB
}

func NewPushSubscriptionRepository(writer, reader *sqlx.DB) *SQLitePushSubscriptionRepository {
	return &SQLitePushSubscriptionRepository{
		writer: writer,
		reader: reader,
	}
}

type pushSubscriptionModel struct {
	ID         string `db:"id"`
	UserID     string `db:"user_id"`
	Endpoint   string `db:"endpoint"`
	P256dhKey  string `db:"p256dh_key"`
	AuthSecret string `db:"auth_secret"`
	CreatedAt  int64  `db:"created_at"`
}

func (m *pushSubscriptionModel) toDomain() *domain.PushSubscription {
	return &domain.PushSubscription{
		ID:         m.ID,
		UserID:     m.UserID,
		Endpoint:   m.Endpoint,
		P256dhKey:  m.P256dhKey,
		AuthSecret: m.AuthSecret,
		CreatedAt:  m.CreatedAt,
	}
}

// getWriter returns the active transaction or the default writer DB.
func (r *SQLitePushSubscriptionRepository) getWriter(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.writer
}

// getReader returns the active transaction or the default reader DB.
func (r *SQLitePushSubscriptionRepository) getReader(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.reader
}

func (r *SQLitePushSubscriptionRepository) Upsert(ctx context.Context, sub *domain.PushSubscription) error {
	exec := r.getWriter(ctx)

	query := `
		INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh_key, auth_secret, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(user_id, endpoint) DO UPDATE SET
			p256dh_key = excluded.p256dh_key,
			auth_secret = excluded.auth_secret`

	_, err := exec.ExecContext(ctx, query,
		sub.ID,
		sub.UserID,
		sub.Endpoint,
		sub.P256dhKey,
		sub.AuthSecret,
		sub.CreatedAt,
	)
	if err != nil {
		return domain.NewDomainError(domain.ErrDB002, "upserting push subscription", err)
	}

	return nil
}

func (r *SQLitePushSubscriptionRepository) ListByUserID(ctx context.Context, userID string) ([]*domain.PushSubscription, error) {
	exec := r.getReader(ctx)

	query := `
		SELECT id, user_id, endpoint, p256dh_key, auth_secret, created_at
		FROM push_subscriptions
		WHERE user_id = ?
		ORDER BY created_at ASC`

	var models []pushSubscriptionModel
	err := sqlx.SelectContext(ctx, exec, &models, query, userID)
	if err != nil {
		return nil, domain.NewDomainError(domain.ErrDB002, "listing push subscriptions", err)
	}

	subs := make([]*domain.PushSubscription, len(models))
	for i, m := range models {
		subs[i] = m.toDomain()
	}
	return subs, nil
}

func (r *SQLitePushSubscriptionRepository) CountByUserID(ctx context.Context, userID string) (int, error) {
	exec := r.getReader(ctx)

	query := `SELECT COUNT(*) FROM push_subscriptions WHERE user_id = ?`

	var count int
	err := sqlx.GetContext(ctx, exec, &count, query, userID)
	if err != nil {
		return 0, domain.NewDomainError(domain.ErrDB002, "counting push subscriptions", err)
	}

	return count, nil
}

func (r *SQLitePushSubscriptionRepository) DeleteByUserAndEndpoint(ctx context.Context, userID, endpoint string) (int64, error) {
	exec := r.getWriter(ctx)

	query := `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?`

	res, err := exec.ExecContext(ctx, query, userID, endpoint)
	if err != nil {
		return 0, domain.NewDomainError(domain.ErrDB002, "deleting push subscription by user and endpoint", err)
	}

	rows, _ := res.RowsAffected()
	return rows, nil
}

func (r *SQLitePushSubscriptionRepository) DeleteByID(ctx context.Context, id string) (int64, error) {
	exec := r.getWriter(ctx)

	query := `DELETE FROM push_subscriptions WHERE id = ?`

	res, err := exec.ExecContext(ctx, query, id)
	if err != nil {
		return 0, domain.NewDomainError(domain.ErrDB002, "deleting push subscription by id", err)
	}

	rows, _ := res.RowsAffected()
	return rows, nil
}

func (r *SQLitePushSubscriptionRepository) DeleteByUserID(ctx context.Context, userID string) error {
	exec := r.getWriter(ctx)

	query := `DELETE FROM push_subscriptions WHERE user_id = ?`

	_, err := exec.ExecContext(ctx, query, userID)
	if err != nil {
		return domain.NewDomainError(domain.ErrDB002, "deleting push subscriptions by user", err)
	}

	return nil
}
