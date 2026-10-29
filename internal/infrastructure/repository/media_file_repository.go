package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jmoiron/sqlx"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"
)

type mediaFileModel struct {
	FileID         string `db:"file_id"`
	UploaderUserID string `db:"uploader_user_id"`
	TokenHash      string `db:"token_hash"`
	TotalChunks    int    `db:"total_chunks"`
	Generation     int64  `db:"generation"`
	Status         string `db:"status"`
	CreatedAt      int64  `db:"created_at"`
}

func (m *mediaFileModel) toDomain() *domain.MediaFile {
	return &domain.MediaFile{
		FileID:         m.FileID,
		UploaderUserID: m.UploaderUserID,
		TokenHash:      m.TokenHash,
		TotalChunks:    m.TotalChunks,
		Generation:     m.Generation,
		Status:         domain.MediaStatus(m.Status),
		CreatedAt:      m.CreatedAt,
	}
}

// SQLiteMediaFileRepository implements domain.MediaFileRepository.
type SQLiteMediaFileRepository struct {
	writer *sqlx.DB
	reader *sqlx.DB
}

func NewMediaFileRepository(writer, reader *sqlx.DB) *SQLiteMediaFileRepository {
	return &SQLiteMediaFileRepository{writer: writer, reader: reader}
}

func (r *SQLiteMediaFileRepository) getWriter(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.writer
}

func (r *SQLiteMediaFileRepository) Create(ctx context.Context, file *domain.MediaFile) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx,
		`INSERT INTO media_files (file_id, uploader_user_id, token_hash, total_chunks, generation, status, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		file.FileID, file.UploaderUserID, file.TokenHash, file.TotalChunks,
		file.Generation, string(file.Status), file.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("inserting media file: %w", err)
	}
	return nil
}

func (r *SQLiteMediaFileRepository) GetByID(ctx context.Context, fileID string) (*domain.MediaFile, error) {
	var model mediaFileModel
	err := sqlx.GetContext(ctx, r.reader, &model,
		`SELECT file_id, uploader_user_id, token_hash, total_chunks, generation, status, created_at
		 FROM media_files WHERE file_id = ?`, fileID,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, domain.NewDomainError(domain.ErrMedia001, "media file not found", nil)
		}
		return nil, fmt.Errorf("querying media file: %w", err)
	}
	return model.toDomain(), nil
}

// UpdateStatus transitions the status with a WHERE guard on the current status.
// RFC-0007 §6.1: Only valid state transitions.
func (r *SQLiteMediaFileRepository) UpdateStatus(ctx context.Context, fileID string, from, to domain.MediaStatus) (int64, error) {
	db := r.getWriter(ctx)
	result, err := db.ExecContext(ctx,
		`UPDATE media_files SET status = ? WHERE file_id = ? AND status = ?`,
		string(to), fileID, string(from),
	)
	if err != nil {
		return 0, fmt.Errorf("updating media status: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("checking status update result: %w", err)
	}
	return rows, nil
}

// IncrementGeneration atomically increments the generation counter.
// RFC-0007 §7.2: OCC — must verify status == PENDING.
func (r *SQLiteMediaFileRepository) IncrementGeneration(ctx context.Context, fileID string) (int64, error) {
	db := r.getWriter(ctx)
	result, err := db.ExecContext(ctx,
		`UPDATE media_files SET generation = generation + 1 WHERE file_id = ? AND status = 'PENDING'`,
		fileID,
	)
	if err != nil {
		return 0, fmt.Errorf("incrementing generation: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return 0, fmt.Errorf("checking generation increment: %w", err)
	}
	return rows, nil
}

func (r *SQLiteMediaFileRepository) Delete(ctx context.Context, fileID string) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx, "DELETE FROM media_files WHERE file_id = ?", fileID)
	if err != nil {
		return fmt.Errorf("deleting media file: %w", err)
	}
	return nil
}

func (r *SQLiteMediaFileRepository) ListByStatusOlderThan(ctx context.Context, status domain.MediaStatus, olderThan int64) ([]*domain.MediaFile, error) {
	var models []mediaFileModel
	err := sqlx.SelectContext(ctx, r.reader, &models,
		`SELECT file_id, uploader_user_id, token_hash, total_chunks, generation, status, created_at
		 FROM media_files WHERE status = ? AND created_at < ?`,
		string(status), olderThan,
	)
	if err != nil {
		return nil, fmt.Errorf("listing media files by status: %w", err)
	}
	files := make([]*domain.MediaFile, len(models))
	for i, m := range models {
		files[i] = m.toDomain()
	}
	return files, nil
}

func (r *SQLiteMediaFileRepository) ListByStatus(ctx context.Context, status domain.MediaStatus) ([]*domain.MediaFile, error) {
	var models []mediaFileModel
	err := sqlx.SelectContext(ctx, r.reader, &models,
		`SELECT file_id, uploader_user_id, token_hash, total_chunks, generation, status, created_at
		 FROM media_files WHERE status = ?`,
		string(status),
	)
	if err != nil {
		return nil, fmt.Errorf("listing media files by status: %w", err)
	}
	files := make([]*domain.MediaFile, len(models))
	for i, m := range models {
		files[i] = m.toDomain()
	}
	return files, nil
}
