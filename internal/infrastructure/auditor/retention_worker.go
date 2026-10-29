package auditor

import (
	"context"
	"log/slog"
	"time"

	"rootinbox/internal/domain"
)

// AuditRetentionWorker periodically trims old security events.
// Implements ADR-P10-18 (Audit Log Lifecycle).
type AuditRetentionWorker struct {
	repo         domain.SecurityEventRepository
	retention    time.Duration
	interval     time.Duration
	logger       *slog.Logger
	stopCh       chan struct{}
}

// NewAuditRetentionWorker creates a new retention worker.
func NewAuditRetentionWorker(repo domain.SecurityEventRepository, retentionDays int, logger *slog.Logger) *AuditRetentionWorker {
	return &AuditRetentionWorker{
		repo:      repo,
		retention: time.Duration(retentionDays) * 24 * time.Hour,
		interval:  24 * time.Hour,
		logger:    logger,
		stopCh:    make(chan struct{}),
	}
}

// Start runs the retention loop in a goroutine.
func (w *AuditRetentionWorker) Start(ctx context.Context) error {
	go w.loop()
	w.logger.Info("audit retention worker started", "retention_days", int(w.retention.Hours()/24))
	return nil
}

func (w *AuditRetentionWorker) loop() {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	// Run once on startup
	w.trim()

	for {
		select {
		case <-ticker.C:
			w.trim()
		case <-w.stopCh:
			return
		}
	}
}

func (w *AuditRetentionWorker) trim() {
	cutoff := time.Now().Add(-w.retention).Unix()
	
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	rows, err := w.repo.DeleteOlderThan(ctx, cutoff, 1000) // 1000 batch size
	if err != nil {
		w.logger.Error("failed to trim audit logs", "error", err)
		return
	}
	
	if rows > 0 {
		w.logger.Info("audit logs trimmed", "deleted_rows", rows)
	}
}
