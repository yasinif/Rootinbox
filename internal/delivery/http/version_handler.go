package http

import (
	"encoding/json"
	"net/http"

	"rootinbox/internal/config"
)

// HandleVersion returns the application version and build hash.
// RFC-0010 §7.2: GET /api/v1/version MUST return Cache-Control: no-store.
// The Service Worker uses this to detect stale builds and prompt reload.
func HandleVersion(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")

		json.NewEncoder(w).Encode(map[string]string{
			"version":    cfg.App.Version,
			"build_hash": cfg.App.BuildHash,
		})
	}
}
