// Package metrics provides Prometheus registry setup and application metrics.
// RFC-0001 Section 4: Prometheus Metrics (/api/v1/metrics).
// RFC-0001 Section 6 Step 4: Initialize Prometheus registry.
package metrics

import (
	"github.com/prometheus/client_golang/prometheus"
)

// Metrics holds all Prometheus metrics defined by RFC-0001 Section 4.
type Metrics struct {
	// HTTPRequestsTotal counts total HTTP requests by method, path, and status.
	HTTPRequestsTotal *prometheus.CounterVec

	// HTTPRequestInFlight tracks the number of in-flight HTTP requests.
	HTTPRequestInFlight prometheus.Gauge

	// RequestDurationSeconds measures HTTP request duration in seconds.
	RequestDurationSeconds *prometheus.HistogramVec

	// DBWaitTimeSeconds measures database connection wait time in seconds.
	DBWaitTimeSeconds *prometheus.HistogramVec

	// SQLiteBusyCount counts SQLite busy/locked errors by pool.
	SQLiteBusyCount *prometheus.CounterVec

	// MediaStorageBytes tracks the total size of stored media.
	MediaStorageBytes prometheus.Gauge
}

// NewRegistry creates a new Prometheus registry and registers all application metrics.
// RFC-0001 Section 6 Step 4: Initialize Prometheus registry.
func NewRegistry() (*prometheus.Registry, *Metrics) {
	reg := prometheus.NewRegistry()

	m := &Metrics{
		HTTPRequestsTotal: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "http_requests_total",
				Help: "Total number of HTTP requests.",
			},
			[]string{"method", "path", "status"},
		),
		HTTPRequestInFlight: prometheus.NewGauge(
			prometheus.GaugeOpts{
				Name: "http_request_in_flight",
				Help: "Number of HTTP requests currently being served.",
			},
		),
		RequestDurationSeconds: prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "request_duration_seconds",
				Help:    "HTTP request duration in seconds.",
				Buckets: prometheus.DefBuckets,
			},
			[]string{"method", "path"},
		),
		DBWaitTimeSeconds: prometheus.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "db_wait_time_seconds",
				Help:    "Database connection wait time in seconds.",
				Buckets: prometheus.DefBuckets,
			},
			[]string{"pool"},
		),
		SQLiteBusyCount: prometheus.NewCounterVec(
			prometheus.CounterOpts{
				Name: "sqlite_busy_count",
				Help: "Number of SQLite busy/locked errors.",
			},
			[]string{"pool"},
		),
		MediaStorageBytes: prometheus.NewGauge(
			prometheus.GaugeOpts{
				Name: "media_storage_bytes",
				Help: "Total bytes consumed by media files.",
			},
		),
	}

	reg.MustRegister(
		m.HTTPRequestsTotal,
		m.HTTPRequestInFlight,
		m.RequestDurationSeconds,
		m.DBWaitTimeSeconds,
		m.SQLiteBusyCount,
		m.MediaStorageBytes,
	)

	return reg, m
}
