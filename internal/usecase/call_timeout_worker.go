package usecase

import (
	"context"
	"time"

	"rootinbox/internal/domain"
)

// CallTimeoutWorker implements background ring timeout and periodic cleanup.
// RFC-0008 §7.5: Ring Timeout Policy.
// Implements domain.Worker.
type CallTimeoutWorker struct {
	callRepo  domain.CallRepository
	ringStore domain.PendingRingStore
	clock     domain.Clock
	logger    domain.Logger
	interval  time.Duration
}

// NewCallTimeoutWorker creates a new CallTimeoutWorker.
func NewCallTimeoutWorker(
	callRepo domain.CallRepository,
	ringStore domain.PendingRingStore,
	clock domain.Clock,
	logger domain.Logger,
	interval time.Duration,
) *CallTimeoutWorker {
	return &CallTimeoutWorker{
		callRepo:  callRepo,
		ringStore: ringStore,
		clock:     clock,
		logger:    logger,
		interval:  interval,
	}
}

// Start begins the timeout processing loop.
// Implements domain.Worker.
// NOTE: Crash recovery is NOT done here — it runs synchronously in bootstrap
// BEFORE the HTTP listener starts (RFC-0008 §10.2).
func (w *CallTimeoutWorker) Start(ctx context.Context) error {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			w.logger.Info("call timeout worker shutting down")
			return nil
		case <-ticker.C:
			w.cleanupStaleRinging(ctx)
		}
	}
}

// cleanupStaleRinging transitions RINGING calls older than 45s to MISSED.
// RFC-0008 §7.5: Exactly 45 seconds.
func (w *CallTimeoutWorker) cleanupStaleRinging(ctx context.Context) {
	cutoff := w.clock.NowUnix() - int64(domain.RingTimeoutSeconds)
	ids, err := w.callRepo.TransitionStaleRinging(ctx, cutoff)
	if err != nil {
		w.logger.Error("call timeout: failed to transition stale ringing", "error", err)
		return
	}
	if len(ids) > 0 {
		w.logger.Info("call timeout: ringing calls missed", "count", len(ids))
		for _, id := range ids {
			w.ringStore.Evict(id)
		}
	}
}
