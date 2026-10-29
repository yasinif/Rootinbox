package usecase

import (
	"context"
	"log/slog"
)

// PushDispatchWorker drains the PushUseCase channel and executes pushes sequentially (single goroutine).
// RFC-0009 §7.1. Implements domain.Worker (ADR-P9-9).
type PushDispatchWorker struct {
	pushUC *PushUseCase
	logger *slog.Logger
}

// NewPushDispatchWorker creates a new PushDispatchWorker.
func NewPushDispatchWorker(pushUC *PushUseCase, logger *slog.Logger) *PushDispatchWorker {
	return &PushDispatchWorker{
		pushUC: pushUC,
		logger: logger,
	}
}

// Start begins processing the push queue sequentially.
func (w *PushDispatchWorker) Start(ctx context.Context) error {
	queue := w.pushUC.Queue()

	w.logger.Info("push dispatch worker started")

	for {
		select {
		case <-ctx.Done():
			w.logger.Info("push dispatch worker shutdown complete")
			return nil
		case job := <-queue:
			err := w.pushUC.Dispatch(ctx, job)
			if err != nil {
				w.logger.Error("push dispatch failed", "user_id", job.UserID, "error", err)
			}
		}
	}
}
