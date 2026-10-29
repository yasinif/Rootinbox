package auditor

import (
	"context"
	"log/slog"
	"time"

	"rootinbox/internal/domain"
)

type AsyncAuditor struct {
	repo   domain.SecurityEventRepository
	ch     chan domain.SecurityEvent
	logger *slog.Logger
}

func NewAsyncAuditor(repo domain.SecurityEventRepository, logger *slog.Logger) *AsyncAuditor {
	a := &AsyncAuditor{
		repo:   repo,
		ch:     make(chan domain.SecurityEvent, 10000), // Buffered channel per ADR-P10-19
		logger: logger,
	}
	go a.worker()
	return a
}

func (a *AsyncAuditor) Emit(event domain.SecurityEvent) {
	select {
	case a.ch <- event:
	default:
		// Queue full, drop event but log it
		a.logger.Warn("security auditor queue full, dropping event", "event_type", event.EventType)
	}
}

func (a *AsyncAuditor) worker() {
	for event := range a.ch {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		err := a.repo.Create(ctx, &event)
		if err != nil {
			a.logger.Error("failed to write security event", "error", err, "event_type", event.EventType)
		}
		cancel()
	}
}
