package usecase

import (
	"context"
	"log/slog"
	"time"

	"rootinbox/internal/domain"
)

// PendingRingSweeper periodically cleans up expired staged invites.
// RFC-0009 §7.3. Implements domain.Worker.
type PendingRingSweeper struct {
	ringStore domain.PendingRingStore
	clock     domain.Clock
	logger    *slog.Logger
	interval  time.Duration
}

// NewPendingRingSweeper creates a new PendingRingSweeper.
func NewPendingRingSweeper(ringStore domain.PendingRingStore, clock domain.Clock, logger *slog.Logger) *PendingRingSweeper {
	return &PendingRingSweeper{
		ringStore: ringStore,
		clock:     clock,
		logger:    logger,
		interval:  10 * time.Second, // Frequent enough to keep memory bounds tight
	}
}

// Start begins the periodic sweep.
func (w *PendingRingSweeper) Start(ctx context.Context) error {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	w.logger.Info("pending ring sweeper started")

	for {
		select {
		case <-ctx.Done():
			w.logger.Info("pending ring sweeper shutting down")
			return nil
		case <-ticker.C:
			count := w.ringStore.SweepExpired(w.clock.NowUnix())
			if count > 0 {
				w.logger.Info("pending ring sweeper evicted expired invites", "count", count)
				// TODO: Increment PendingRingEvictedTotal{reason="timeout"}
			}
		}
	}
}
