package http

import (
	"net/http"
	"time"

	"rootinbox/internal/config"
)

// NewServer creates an HTTP server with RFC-mandated timeouts.
// RFC-0001A Section 5.4: Explicitly define ReadTimeout, WriteTimeout,
// IdleTimeout, and MaxHeaderBytes.
func NewServer(cfg *config.Config, handler http.Handler) *http.Server {
	return &http.Server{
		Addr:           cfg.Server.Addr(),
		Handler:        handler,
		ReadTimeout:    cfg.Server.ReadTimeout,
		WriteTimeout:   cfg.Server.WriteTimeout,
		IdleTimeout:    cfg.Server.IdleTimeout,
		MaxHeaderBytes: cfg.Server.MaxHeaderBytes,
	}
}

// GracefulShutdownTimeout is the maximum time allowed for graceful shutdown.
// RFC-0001A Section 5.5: 30s Timeout.
const GracefulShutdownTimeout = 30 * time.Second
