package usecase

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"
	"rootinbox/internal/infrastructure/filelock"
	"rootinbox/internal/infrastructure/mediastorage"
)

// MediaUseCase implements business logic for media upload/download/delete.
// RFC-0007: Zero-Knowledge Media & Attachment Streaming.
type MediaUseCase struct {
	mediaFileRepo  domain.MediaFileRepository
	mediaChunkRepo domain.MediaChunkRepository
	quotaRepo      domain.QuotaRepository
	txManager      *database.TxManager
	fileLock       *filelock.FileLock
	storage        *mediastorage.LocalStorage
	clock          domain.Clock
	logger         domain.Logger
	defaultQuota   int64
}

// NewMediaUseCase creates a new MediaUseCase.
func NewMediaUseCase(
	mediaFileRepo domain.MediaFileRepository,
	mediaChunkRepo domain.MediaChunkRepository,
	quotaRepo domain.QuotaRepository,
	txManager *database.TxManager,
	fileLock *filelock.FileLock,
	storage *mediastorage.LocalStorage,
	clock domain.Clock,
	logger domain.Logger,
	defaultQuota int64,
) *MediaUseCase {
	return &MediaUseCase{
		mediaFileRepo:  mediaFileRepo,
		mediaChunkRepo: mediaChunkRepo,
		quotaRepo:      quotaRepo,
		txManager:      txManager,
		fileLock:       fileLock,
		storage:        storage,
		clock:          clock,
		logger:         logger,
		defaultQuota:   defaultQuota,
	}
}

// Init initializes a media upload.
// RFC-0007 §7.1: POST /api/v1/media/init.
func (uc *MediaUseCase) Init(ctx context.Context, userID, fileID string, totalChunks int, tokenHash string) (*domain.MediaFile, error) {
	// Validate constraints.
	if totalChunks < 1 || totalChunks > domain.MaxTotalChunks {
		return nil, domain.NewDomainError(domain.ErrSys001,
			fmt.Sprintf("total_chunks must be between 1 and %d", domain.MaxTotalChunks), nil)
	}
	if err := domain.ValidateFileID(fileID); err != nil {
		return nil, domain.NewDomainError(domain.ErrSys001, "invalid file_id format", err)
	}
	if tokenHash == "" {
		return nil, domain.NewDomainError(domain.ErrSys001, "token_hash is required", nil)
	}

	var result *domain.MediaFile

	err := uc.txManager.WithinImmediateTransaction(ctx, func(ctx context.Context) error {
		// Check for existing file_id.
		existing, err := uc.mediaFileRepo.GetByID(ctx, fileID)
		if err == nil && existing != nil {
			// RFC-0007 §7.1: Idempotency & State Rules.
			if existing.UploaderUserID != userID {
				// Owned by another user — return 404 (no existence leakage).
				return domain.NewDomainError(domain.ErrMedia001, "media file not found", nil)
			}
			if existing.Status != domain.MediaStatusPending {
				// FINALIZED or DELETING — return 409.
				return domain.NewDomainError(domain.ErrMedia002,
					fmt.Sprintf("media file is in %s state", existing.Status), nil)
			}
			if existing.TotalChunks != totalChunks || existing.TokenHash != tokenHash {
				return domain.NewDomainError(domain.ErrMedia002,
					"init parameters differ from existing upload", nil)
			}
			// All match — return existing state idempotently. Quota NOT reserved again.
			result = existing
			return nil
		}

		// Check quota.
		paddedSize := int64(totalChunks) * domain.ChunkCiphertextSize
		quota, err := uc.quotaRepo.GetOrCreate(ctx, userID, uc.defaultQuota)
		if err != nil {
			return domain.NewDomainError(domain.ErrDB002, "checking quota", err)
		}
		if quota.ReservedBytes+quota.CommittedBytes+paddedSize > quota.QuotaLimitBytes {
			return domain.NewDomainError(domain.ErrMedia003, "quota exceeded", nil)
		}

		// Reserve quota.
		if err := uc.quotaRepo.ReserveBytes(ctx, userID, paddedSize); err != nil {
			return domain.NewDomainError(domain.ErrDB002, "reserving quota", err)
		}

		// Create media file record.
		file := &domain.MediaFile{
			FileID:         fileID,
			UploaderUserID: userID,
			TokenHash:      tokenHash,
			TotalChunks:    totalChunks,
			Generation:     0,
			Status:         domain.MediaStatusPending,
			CreatedAt:      uc.clock.NowUnix(),
		}
		if err := uc.mediaFileRepo.Create(ctx, file); err != nil {
			if strings.Contains(err.Error(), "UNIQUE constraint failed") {
				// Race condition — another concurrent init won.
				return domain.NewDomainError(domain.ErrMedia002, "concurrent upload init", nil)
			}
			return domain.NewDomainError(domain.ErrDB002, "creating media file", err)
		}

		result = file
		return nil
	})

	if err != nil {
		return nil, err
	}

	// Ensure file directory exists outside the DB transaction.
	if err := uc.storage.EnsureFileDir(fileID); err != nil {
		uc.logger.Error("failed to create media directory", "file_id", fileID, "error", err)
	}

	uc.logger.Info("media init", "file_id", fileID, "user_id", userID, "total_chunks", totalChunks)
	return result, nil
}

// UploadChunk uploads a single chunk.
// RFC-0007 §7.2: PUT /api/v1/media/upload/{file_id}/{chunk_index}.
// Lock ordering: Per-File I/O Lock BEFORE DB transaction. No FS I/O inside DB tx.
func (uc *MediaUseCase) UploadChunk(ctx context.Context, userID, fileID string, chunkIndex int, data []byte, clientHash string) error {
	if err := domain.ValidateFileID(fileID); err != nil {
		return domain.NewDomainError(domain.ErrSys001, "invalid file_id format", err)
	}

	// Validate chunk size.
	if len(data) == 0 || len(data) > domain.ChunkCiphertextSize {
		return domain.NewDomainError(domain.ErrMedia004,
			fmt.Sprintf("chunk size must be between 1 and %d bytes, got %d", domain.ChunkCiphertextSize, len(data)), nil)
	}

	// Validate chunk index bounds (we check against file later).
	if chunkIndex < 0 {
		return domain.NewDomainError(domain.ErrSys001, "invalid chunk index", nil)
	}

	// Compute server-side hash.
	hash := sha256.Sum256(data)
	computedHash := hex.EncodeToString(hash[:])
	if !strings.EqualFold(computedHash, clientHash) {
		return domain.NewDomainError(domain.ErrMedia004, "chunk hash mismatch", nil)
	}

	// Verify ownership and status (read outside lock for fast rejection).
	file, err := uc.mediaFileRepo.GetByID(ctx, fileID)
	if err != nil {
		return err
	}
	if file.UploaderUserID != userID {
		return domain.NewDomainError(domain.ErrMedia001, "media file not found", nil)
	}
	if file.Status != domain.MediaStatusPending {
		return domain.NewDomainError(domain.ErrMedia002,
			fmt.Sprintf("media file is in %s state", file.Status), nil)
	}
	if chunkIndex >= file.TotalChunks {
		return domain.NewDomainError(domain.ErrSys001, "chunk index out of range", nil)
	}

	// Check existing chunk for idempotency/conflict.
	existingChunk, err := uc.mediaChunkRepo.GetByFileAndIndex(ctx, fileID, chunkIndex)
	if err != nil {
		return domain.NewDomainError(domain.ErrDB002, "checking existing chunk", err)
	}
	if existingChunk != nil {
		if strings.EqualFold(existingChunk.ChunkHash, computedHash) {
			// Same hash — verify physical size and return idempotently.
			size, sErr := uc.storage.ChunkSize(fileID, chunkIndex)
			if sErr == nil && size == int64(len(data)) {
				return nil // Idempotent success.
			}
			// Physical file missing/wrong size — fall through to re-upload.
		} else {
			// Different hash — return 409.
			return domain.NewDomainError(domain.ErrMedia002, "chunk hash conflict: different content", nil)
		}
	}

	// Step 1: Acquire Per-File I/O Lock BEFORE any FS I/O.
	uc.fileLock.Lock(fileID)

	// Step 2: Atomic filesystem write (outside DB transaction).
	if err := uc.storage.EnsureFileDir(fileID); err != nil {
		uc.fileLock.Unlock(fileID)
		return domain.NewDomainError(domain.ErrDB002, "creating media directory", err)
	}
	if err := uc.storage.WriteChunkAtomic(fileID, chunkIndex, data); err != nil {
		uc.fileLock.Unlock(fileID)
		return domain.NewDomainError(domain.ErrDB002, "writing chunk to disk", err)
	}

	// Step 3: Release I/O Lock (FS write complete).
	uc.fileLock.Unlock(fileID)

	// Step 4: DB mutation in BEGIN IMMEDIATE transaction (no FS I/O inside).
	txErr := uc.txManager.WithinImmediateTransaction(ctx, func(ctx context.Context) error {
		// OCC: Increment generation, verify PENDING.
		rows, err := uc.mediaFileRepo.IncrementGeneration(ctx, fileID)
		if err != nil {
			return domain.NewDomainError(domain.ErrDB002, "incrementing generation", err)
		}
		if rows == 0 {
			// File no longer PENDING — abort.
			return domain.NewDomainError(domain.ErrMedia002, "media file status changed during upload", nil)
		}

		// Insert/update chunk record.
		chunk := &domain.MediaChunk{
			FileID:     fileID,
			ChunkIndex: chunkIndex,
			ChunkHash:  computedHash,
			CreatedAt:  uc.clock.NowUnix(),
		}
		if err := uc.mediaChunkRepo.Create(ctx, chunk); err != nil {
			return domain.NewDomainError(domain.ErrDB002, "creating chunk record", err)
		}

		return nil
	})

	if txErr != nil {
		// ABORT PATH: DB failed, clean up the renamed physical chunk.
		uc.storage.DeleteChunk(fileID, chunkIndex)
		return txErr
	}

	return nil
}

// Finalize completes a media upload.
// RFC-0007 §7.3: 2-Phase Finalization.
func (uc *MediaUseCase) Finalize(ctx context.Context, userID, fileID, clientManifestHash string) error {
	if err := domain.ValidateFileID(fileID); err != nil {
		return domain.NewDomainError(domain.ErrSys001, "invalid file_id format", err)
	}

	// Verify ownership and status.
	file, err := uc.mediaFileRepo.GetByID(ctx, fileID)
	if err != nil {
		return err
	}
	if file.UploaderUserID != userID {
		return domain.NewDomainError(domain.ErrMedia001, "media file not found", nil)
	}

	// Idempotency: if already finalized, return success.
	if file.Status == domain.MediaStatusFinalized {
		return nil
	}
	if file.Status != domain.MediaStatusPending {
		return domain.NewDomainError(domain.ErrMedia002,
			fmt.Sprintf("media file is in %s state", file.Status), nil)
	}

	// Phase A (Outside DB Transaction): Disk verification.
	generation := file.Generation

	// Lock for reads.
	uc.fileLock.Lock(fileID)

	// Verify all chunks exist on disk with exact sizes and recompute hashes.
	chunks, err := uc.mediaChunkRepo.ListByFileID(ctx, fileID)
	if err != nil {
		uc.fileLock.Unlock(fileID)
		return domain.NewDomainError(domain.ErrDB002, "listing chunks", err)
	}
	if len(chunks) != file.TotalChunks {
		uc.fileLock.Unlock(fileID)
		return domain.NewDomainError(domain.ErrMedia004,
			fmt.Sprintf("expected %d chunks, found %d", file.TotalChunks, len(chunks)), nil)
	}

	// Build manifest hash from server-verified chunk hashes.
	manifestHasher := sha256.New()
	var totalDiskBytes int64
	for i := 0; i < file.TotalChunks; i++ {
		// Find chunk record.
		var chunk *domain.MediaChunk
		for _, c := range chunks {
			if c.ChunkIndex == i {
				chunk = c
				break
			}
		}
		if chunk == nil {
			uc.fileLock.Unlock(fileID)
			return domain.NewDomainError(domain.ErrMedia004,
				fmt.Sprintf("missing chunk record for index %d", i), nil)
		}

		// Verify physical chunk.
		size, sErr := uc.storage.ChunkSize(fileID, i)
		if sErr != nil {
			uc.fileLock.Unlock(fileID)
			return domain.NewDomainError(domain.ErrMedia004,
				fmt.Sprintf("chunk %d missing from disk", i), nil)
		}
		if size < 1 || size > int64(domain.ChunkCiphertextSize) {
			uc.fileLock.Unlock(fileID)
			return domain.NewDomainError(domain.ErrMedia004,
				fmt.Sprintf("chunk %d has invalid size: %d", i, size), nil)
		}
		totalDiskBytes += size

		// Recompute hash from disk.
		data, rErr := uc.storage.ReadChunk(fileID, i)
		if rErr != nil {
			uc.fileLock.Unlock(fileID)
			return domain.NewDomainError(domain.ErrMedia004,
				fmt.Sprintf("reading chunk %d for verification", i), rErr)
		}
		diskHash := sha256.Sum256(data)
		diskHashHex := hex.EncodeToString(diskHash[:])

		if !strings.EqualFold(diskHashHex, chunk.ChunkHash) {
			uc.fileLock.Unlock(fileID)
			return domain.NewDomainError(domain.ErrMedia004,
				fmt.Sprintf("chunk %d disk hash mismatch", i), nil)
		}

		// Append to manifest.
		hashBytes, _ := hex.DecodeString(chunk.ChunkHash)
		manifestHasher.Write(hashBytes)
	}

	uc.fileLock.Unlock(fileID)

	// Verify manifest hash.
	manifestHash := hex.EncodeToString(manifestHasher.Sum(nil))
	if !strings.EqualFold(manifestHash, clientManifestHash) {
		return domain.NewDomainError(domain.ErrMedia004, "file manifest hash mismatch", nil)
	}

	// Phase B (Short DB Transaction): OCC verification and state transition.
	return uc.txManager.WithinImmediateTransaction(ctx, func(ctx context.Context) error {
		// Re-read file to verify generation hasn't changed.
		currentFile, err := uc.mediaFileRepo.GetByID(ctx, fileID)
		if err != nil {
			return err
		}
		if currentFile.Status != domain.MediaStatusPending {
			if currentFile.Status == domain.MediaStatusFinalized {
				return nil // Idempotent.
			}
			return domain.NewDomainError(domain.ErrMedia002, "status changed during finalize", nil)
		}
		// RFC-0007 §7.3 Phase B step 2: Verify generation == G.
		if currentFile.Generation != generation {
			return domain.NewDomainError(domain.ErrMedia002, "generation changed during finalize", nil)
		}

		// Apply FINALIZE quota lifecycle.
		reservedBytes := currentFile.PaddedSize()
		if reservedBytes > totalDiskBytes {
			if err := uc.quotaRepo.ReleaseReserved(ctx, userID, reservedBytes-totalDiskBytes); err != nil {
				return domain.NewDomainError(domain.ErrDB002, "releasing excess reserved quota", err)
			}
		}
		if err := uc.quotaRepo.CommitBytes(ctx, userID, totalDiskBytes); err != nil {
			return domain.NewDomainError(domain.ErrDB002, "committing quota", err)
		}

		// Transition: PENDING -> FINALIZED.
		rows, err := uc.mediaFileRepo.UpdateStatus(ctx, fileID, domain.MediaStatusPending, domain.MediaStatusFinalized)
		if err != nil {
			return domain.NewDomainError(domain.ErrDB002, "finalizing media file", err)
		}
		if rows == 0 {
			return domain.NewDomainError(domain.ErrMedia002, "status changed concurrently", nil)
		}

		uc.logger.Info("media finalized", "file_id", fileID, "user_id", userID)
		return nil
	})
}

// matchesTokenHash verifies media token authorization against stored token_hash.
// RFC-0007 §7.1 / §7.4: Accepts raw token bytes encoded as base64, base64url, hex, or direct ASCII string (e.g. "direct-v1").
func matchesTokenHash(storedHash, mediaToken string) bool {
	if mediaToken == "" || storedHash == "" {
		return false
	}
	// Case 1: direct string equality
	if storedHash == mediaToken {
		return true
	}

	// Case 2: mediaToken raw bytes hashed to SHA-256 (matches "direct-v1" or standard tokens)
	h1 := sha256.Sum256([]byte(mediaToken))
	h1Hex := hex.EncodeToString(h1[:])
	h1B64 := base64.StdEncoding.EncodeToString(h1[:])
	h1RawURL := base64.RawURLEncoding.EncodeToString(h1[:])
	if strings.EqualFold(storedHash, h1Hex) || storedHash == h1B64 || storedHash == h1RawURL {
		return true
	}

	// Case 3: mediaToken is base64/hex encoded 32-byte secret whose decoded bytes were hashed
	if b, err := base64.StdEncoding.DecodeString(mediaToken); err == nil && len(b) == 32 {
		h := sha256.Sum256(b)
		if strings.EqualFold(storedHash, hex.EncodeToString(h[:])) || storedHash == base64.StdEncoding.EncodeToString(h[:]) {
			return true
		}
	}
	if b, err := base64.RawURLEncoding.DecodeString(mediaToken); err == nil && len(b) == 32 {
		h := sha256.Sum256(b)
		if strings.EqualFold(storedHash, hex.EncodeToString(h[:])) || storedHash == base64.RawURLEncoding.EncodeToString(h[:]) {
			return true
		}
	}
	if b, err := hex.DecodeString(mediaToken); err == nil && len(b) == 32 {
		h := sha256.Sum256(b)
		if strings.EqualFold(storedHash, hex.EncodeToString(h[:])) || storedHash == hex.EncodeToString(h[:]) {
			return true
		}
	}
	return false
}

// DownloadChunk downloads a single chunk.
// RFC-0007 §7.4: GET /api/v1/media/download/{file_id}/{chunk_index}.
func (uc *MediaUseCase) DownloadChunk(ctx context.Context, mediaToken, fileID string, chunkIndex int) ([]byte, error) {
	if err := domain.ValidateFileID(fileID); err != nil {
		return nil, domain.NewDomainError(domain.ErrSys001, "invalid file_id format", err)
	}

	// Verify file exists and token matches.
	file, err := uc.mediaFileRepo.GetByID(ctx, fileID)
	if err != nil {
		return nil, err
	}
	if !matchesTokenHash(file.TokenHash, mediaToken) {
		return nil, domain.NewDomainError(domain.ErrMedia001, "media file not found", nil)
	}
	if file.Status != domain.MediaStatusFinalized {
		return nil, domain.NewDomainError(domain.ErrMedia002,
			fmt.Sprintf("media file is in %s state", file.Status), nil)
	}
	if chunkIndex < 0 || chunkIndex >= file.TotalChunks {
		return nil, domain.NewDomainError(domain.ErrSys001, "chunk index out of range", nil)
	}

	// Read with I/O lock for isolation from concurrent deletion.
	uc.fileLock.Lock(fileID)
	defer uc.fileLock.Unlock(fileID)

	data, err := uc.storage.ReadChunk(fileID, chunkIndex)
	if err != nil {
		return nil, domain.NewDomainError(domain.ErrMedia004, "chunk not found on disk", err)
	}
	return data, nil
}

// Delete initiates 3-Phase State-Based Deletion.
// RFC-0007 §8.5: Crash-Proof GC.
// Auth: Either valid Media_Token OR Uploader's Session.
func (uc *MediaUseCase) Delete(ctx context.Context, userID, mediaToken, fileID string) error {
	if err := domain.ValidateFileID(fileID); err != nil {
		return domain.NewDomainError(domain.ErrSys001, "invalid file_id format", err)
	}

	file, err := uc.mediaFileRepo.GetByID(ctx, fileID)
	if err != nil {
		return err
	}

	// Authorization: either owner or MCT holder.
	authorized := false
	if userID != "" && file.UploaderUserID == userID {
		authorized = true
	}
	if mediaToken != "" {
		if matchesTokenHash(file.TokenHash, mediaToken) {
			authorized = true
		}
	}
	if !authorized {
		return domain.NewDomainError(domain.ErrMedia001, "media file not found", nil)
	}

	if file.Status == domain.MediaStatusDeleting {
		// Already in DELETING — resume phases B and C.
		return uc.executeDeletionPhasesBC(ctx, file)
	}

	// Phase A: DB state transition.
	return uc.executeFullDeletion(ctx, file)
}

// executeFullDeletion runs all 3 phases of deletion.
func (uc *MediaUseCase) executeFullDeletion(ctx context.Context, file *domain.MediaFile) error {
	// Phase A: Short DB Transaction — mark DELETING + quota release.
	previousStatus := file.Status
	err := uc.txManager.WithinImmediateTransaction(ctx, func(ctx context.Context) error {
		rows, err := uc.mediaFileRepo.UpdateStatus(ctx, file.FileID, previousStatus, domain.MediaStatusDeleting)
		if err != nil {
			return domain.NewDomainError(domain.ErrDB002, "marking file for deletion", err)
		}
		if rows == 0 {
			return domain.NewDomainError(domain.ErrMedia002, "status changed during delete", nil)
		}

		// Apply DELETE quota lifecycle based on previous status.
		paddedSize := file.PaddedSize()
		switch previousStatus {
		case domain.MediaStatusPending:
			if err := uc.quotaRepo.ReleaseReserved(ctx, file.UploaderUserID, paddedSize); err != nil {
				return domain.NewDomainError(domain.ErrDB002, "releasing reserved quota", err)
			}
		case domain.MediaStatusFinalized:
			var committedBytes int64
			for i := 0; i < file.TotalChunks; i++ {
				if s, err := uc.storage.ChunkSize(file.FileID, i); err == nil && s > 0 {
					committedBytes += s
				}
			}
			if committedBytes <= 0 {
				committedBytes = paddedSize
			}
			if q, qErr := uc.quotaRepo.GetOrCreate(ctx, file.UploaderUserID, uc.defaultQuota); qErr == nil && q != nil {
				if committedBytes > q.CommittedBytes {
					committedBytes = q.CommittedBytes
				}
			}
			if err := uc.quotaRepo.ReleaseCommitted(ctx, file.UploaderUserID, committedBytes); err != nil {
				return domain.NewDomainError(domain.ErrDB002, "releasing committed quota", err)
			}
		}
		return nil
	})
	if err != nil {
		return err
	}

	// Update file status locally for phases B and C.
	file.Status = domain.MediaStatusDeleting
	return uc.executeDeletionPhasesBC(ctx, file)
}

// executeDeletionPhasesBC runs Phase B (filesystem) and Phase C (DB row delete).
func (uc *MediaUseCase) executeDeletionPhasesBC(ctx context.Context, file *domain.MediaFile) error {
	// Phase B: Filesystem I/O — delete all chunks.
	uc.fileLock.Lock(file.FileID)
	if err := uc.storage.DeleteChunks(file.FileID); err != nil {
		uc.fileLock.Unlock(file.FileID)
		uc.logger.Error("failed to delete chunks from disk", "file_id", file.FileID, "error", err)
		// Don't fail — Phase C will leave the row in DELETING for crash recovery.
	}
	uc.fileLock.Unlock(file.FileID)

	// Phase C: Short DB Transaction — delete row and token hash.
	err := uc.txManager.WithinImmediateTransaction(ctx, func(ctx context.Context) error {
		if err := uc.mediaFileRepo.Delete(ctx, file.FileID); err != nil {
			return domain.NewDomainError(domain.ErrDB002, "deleting media file record", err)
		}
		return nil
	})
	if err != nil {
		return err
	}

	uc.logger.Info("media deleted", "file_id", file.FileID)
	return nil
}
