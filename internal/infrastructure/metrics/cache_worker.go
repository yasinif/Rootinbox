package metrics

import (
	"context"
	"log/slog"
	"time"
)

// MetricsCacheWorker implements Task 11.2 (storage gauges).
type MetricsCacheWorker struct {
	metrics *Metrics
	logger  *slog.Logger
	stopCh  chan struct{}
}

// NewMetricsCacheWorker creates a new MetricsCacheWorker.
func NewMetricsCacheWorker(metrics *Metrics, logger *slog.Logger) *MetricsCacheWorker {
	return &MetricsCacheWorker{
		metrics: metrics,
		logger:  logger,
		stopCh:  make(chan struct{}),
	}
}

// Start runs the metrics collection loop.
func (w *MetricsCacheWorker) Start(ctx context.Context) error {
	w.logger.Info("metrics cache worker started")
	go w.loop()
	return nil
}

func (w *MetricsCacheWorker) loop() {
	ticker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			// In a real implementation, we would query the DB for sizes.
			w.metrics.MediaStorageBytes.Set(0) // Dummy for now
		case <-w.stopCh:
			return
		}
	}
}
