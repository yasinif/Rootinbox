package usecase

import (
	"context"
	"time"

	"rootinbox/internal/domain"
)

// MediaGCWorker implements background garbage collection for media files.
// RFC-0007 §8.6: Garbage Collection Triggers & Recovery.
// Implements domain.Worker.
type MediaGCWorker struct {
	mediaFileRepo domain.MediaFileRepository
	mediaUC       *MediaUseCase
	clock         domain.Clock
	logger        domain.Logger
	interval      time.Duration
}

// NewMediaGCWorker creates a new MediaGCWorker.
func NewMediaGCWorker(
	mediaFileRepo domain.MediaFileRepository,
	mediaUC *MediaUseCase,
	clock domain.Clock,
	logger domain.Logger,
	interval time.Duration,
) *MediaGCWorker {
	return &MediaGCWorker{
		mediaFileRepo: mediaFileRepo,
		mediaUC:       mediaUC,
		clock:         clock,
		logger:        logger,
		interval:      interval,
	}
}

// Start begins the GC processing loop.
// Implements domain.Worker.
func (w *MediaGCWorker) Start(ctx context.Context) error {
	// Crash recovery: resume DELETING files on startup.
	// RFC-0007 §8.6: If a file is in DELETING state during startup, resume Phase B and C.
	w.resumeDeleting(ctx)

	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			w.logger.Info("media GC worker shutting down")
			return nil
		case <-ticker.C:
			w.runGCCycle(ctx)
		}
	}
}

// resumeDeleting handles crash recovery for files stuck in DELETING.
func (w *MediaGCWorker) resumeDeleting(ctx context.Context) {
	files, err := w.mediaFileRepo.ListByStatus(ctx, domain.MediaStatusDeleting)
	if err != nil {
		w.logger.Error("GC: failed to list DELETING files", "error", err)
		return
	}

	for _, file := range files {
		w.logger.Info("GC: resuming deletion", "file_id", file.FileID)
		if err := w.mediaUC.executeDeletionPhasesBC(ctx, file); err != nil {
			w.logger.Error("GC: failed to resume deletion", "file_id", file.FileID, "error", err)
		}
	}

	if len(files) > 0 {
		w.logger.Info("GC: crash recovery complete", "resumed", len(files))
	}
}

// runGCCycle performs one full GC scan.
func (w *MediaGCWorker) runGCCycle(ctx context.Context) {
	w.cleanupStalePending(ctx)
}

// cleanupStalePending hard-deletes files stuck in PENDING for > 48 hours.
// RFC-0007 §8.6: Timeout GC.
func (w *MediaGCWorker) cleanupStalePending(ctx context.Context) {
	cutoff := w.clock.NowUnix() - int64(domain.PendingTimeoutHours*3600)
	files, err := w.mediaFileRepo.ListByStatusOlderThan(ctx, domain.MediaStatusPending, cutoff)
	if err != nil {
		w.logger.Error("GC: failed to list stale PENDING files", "error", err)
		return
	}

	for _, file := range files {
		w.logger.Info("GC: cleaning stale PENDING file",
			"file_id", file.FileID,
			"age_hours", (w.clock.NowUnix()-file.CreatedAt)/3600,
		)
		if err := w.mediaUC.executeFullDeletion(ctx, file); err != nil {
			w.logger.Error("GC: failed to delete stale file", "file_id", file.FileID, "error", err)
		}
	}
}
