package http

import (
	"io/fs"
	"net/http"
	"strings"

	"rootinbox/web"
)

// ServeFrontend returns an http.Handler that serves the embedded Vite build.
// RFC-0010 §7.1: The Vite production build is embedded via embed.FS and
// served with an explicit SPA fallback (non-API paths → index.html).
func ServeFrontend() http.Handler {
	// Strip the "dist" prefix to get the root of the static files.
	distFS, err := fs.Sub(web.DistFS, "dist")
	if err != nil {
		panic("failed to create sub filesystem for web/dist: " + err.Error())
	}

	fileServer := http.FileServer(http.FS(distFS))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		// Skip API routes — they are handled by the mux before this handler.
		if strings.HasPrefix(path, "/api/") {
			http.NotFound(w, r)
			return
		}

		// Try to serve the file directly.
		// For hashed assets (JS/CSS with content hashes), set immutable cache.
		if strings.Contains(path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}

		// Check if the file exists in the embedded FS.
		cleanPath := strings.TrimPrefix(path, "/")
		if cleanPath == "" {
			cleanPath = "index.html"
		}

		const noStoreHeaders = "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0"

		_, err := fs.Stat(distFS, cleanPath)
		if err != nil {
			// SPA fallback: serve index.html for client-side routing.
			// index.html MUST NOT be cached (§7.2 — version detection relies on fresh loads).
			w.Header().Set("Cache-Control", noStoreHeaders)
			r.URL.Path = "/"
			fileServer.ServeHTTP(w, r)
			return
		}

		// Serve the actual file.
		if strings.HasSuffix(cleanPath, ".webmanifest") || cleanPath == "manifest.json" {
			w.Header().Set("Content-Type", "application/manifest+json")
			w.Header().Set("Cache-Control", noStoreHeaders)
		} else if cleanPath == "index.html" || cleanPath == "sw.js" {
			w.Header().Set("Cache-Control", noStoreHeaders)
		} else if cleanPath == "favicon.ico" {
			w.Header().Set("Content-Type", "image/x-icon")
			w.Header().Set("Cache-Control", "public, max-age=86400")
		}
		fileServer.ServeHTTP(w, r)
	})
}
