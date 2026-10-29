package repository

import (
	"context"
	"database/sql"
	"fmt"

	"github.com/jmoiron/sqlx"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"
)

type mediaChunkModel struct {
	FileID     string `db:"file_id"`
	ChunkIndex int    `db:"chunk_index"`
	ChunkHash  string `db:"chunk_hash"`
	CreatedAt  int64  `db:"created_at"`
}

func (m *mediaChunkModel) toDomain() *domain.MediaChunk {
	return &domain.MediaChunk{
		FileID:     m.FileID,
		ChunkIndex: m.ChunkIndex,
		ChunkHash:  m.ChunkHash,
		CreatedAt:  m.CreatedAt,
	}
}

// SQLiteMediaChunkRepository implements domain.MediaChunkRepository.
type SQLiteMediaChunkRepository struct {
	writer *sqlx.DB
	reader *sqlx.DB
}

func NewMediaChunkRepository(writer, reader *sqlx.DB) *SQLiteMediaChunkRepository {
	return &SQLiteMediaChunkRepository{writer: writer, reader: reader}
}

func (r *SQLiteMediaChunkRepository) getWriter(ctx context.Context) sqlx.ExtContext {
	if tx, ok := database.TxFromContext(ctx); ok {
		return tx
	}
	return r.writer
}

func (r *SQLiteMediaChunkRepository) Create(ctx context.Context, chunk *domain.MediaChunk) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx,
		`INSERT OR REPLACE INTO media_chunks (file_id, chunk_index, chunk_hash, created_at)
		 VALUES (?, ?, ?, ?)`,
		chunk.FileID, chunk.ChunkIndex, chunk.ChunkHash, chunk.CreatedAt,
	)
	if err != nil {
		return fmt.Errorf("inserting media chunk: %w", err)
	}
	return nil
}

func (r *SQLiteMediaChunkRepository) GetByFileAndIndex(ctx context.Context, fileID string, chunkIndex int) (*domain.MediaChunk, error) {
	var model mediaChunkModel
	err := sqlx.GetContext(ctx, r.reader, &model,
		`SELECT file_id, chunk_index, chunk_hash, created_at
		 FROM media_chunks WHERE file_id = ? AND chunk_index = ?`,
		fileID, chunkIndex,
	)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil, nil // No chunk found — not an error.
		}
		return nil, fmt.Errorf("querying media chunk: %w", err)
	}
	return model.toDomain(), nil
}

func (r *SQLiteMediaChunkRepository) ListByFileID(ctx context.Context, fileID string) ([]*domain.MediaChunk, error) {
	var models []mediaChunkModel
	err := sqlx.SelectContext(ctx, r.reader, &models,
		`SELECT file_id, chunk_index, chunk_hash, created_at
		 FROM media_chunks WHERE file_id = ? ORDER BY chunk_index ASC`,
		fileID,
	)
	if err != nil {
		return nil, fmt.Errorf("listing media chunks: %w", err)
	}
	chunks := make([]*domain.MediaChunk, len(models))
	for i, m := range models {
		chunks[i] = m.toDomain()
	}
	return chunks, nil
}

func (r *SQLiteMediaChunkRepository) CountByFileID(ctx context.Context, fileID string) (int, error) {
	var count int
	err := sqlx.GetContext(ctx, r.reader, &count,
		"SELECT COUNT(*) FROM media_chunks WHERE file_id = ?", fileID,
	)
	if err != nil {
		return 0, fmt.Errorf("counting media chunks: %w", err)
	}
	return count, nil
}

func (r *SQLiteMediaChunkRepository) DeleteByFileID(ctx context.Context, fileID string) error {
	db := r.getWriter(ctx)
	_, err := db.ExecContext(ctx, "DELETE FROM media_chunks WHERE file_id = ?", fileID)
	if err != nil {
		return fmt.Errorf("deleting media chunks: %w", err)
	}
	return nil
}
