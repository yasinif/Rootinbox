package http

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestServeFrontend_PWAAssetsAndHeaders(t *testing.T) {
	handler := ServeFrontend()

	tests := []struct {
		name               string
		path               string
		expectedStatus     int
		expectedTypePrefix string
		expectedCache      string
	}{
		{
			name:               "manifest.webmanifest served with manifest+json and no-cache",
			path:               "/manifest.webmanifest",
			expectedStatus:     http.StatusOK,
			expectedTypePrefix: "application/manifest+json",
			expectedCache:      "no-cache",
		},
		{
			name:               "manifest.json served with manifest+json and no-cache",
			path:               "/manifest.json",
			expectedStatus:     http.StatusOK,
			expectedTypePrefix: "application/manifest+json",
			expectedCache:      "no-cache",
		},
		{
			name:               "favicon.ico served with image/x-icon",
			path:               "/favicon.ico",
			expectedStatus:     http.StatusOK,
			expectedTypePrefix: "image/x-icon",
		},
		{
			name:           "sw.js served with no-cache",
			path:           "/sw.js",
			expectedStatus: http.StatusOK,
			expectedCache:  "no-cache",
		},
		{
			name:           "SPA fallback for arbitrary client route",
			path:           "/auth",
			expectedStatus: http.StatusOK,
			expectedCache:  "no-cache",
		},
		{
			name:           "API route returns 404 from frontend handler",
			path:           "/api/v1/unknown",
			expectedStatus: http.StatusNotFound,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, tc.path, nil)
			w := httptest.NewRecorder()

			handler.ServeHTTP(w, req)

			if w.Code != tc.expectedStatus {
				t.Fatalf("expected status %d, got %d", tc.expectedStatus, w.Code)
			}

			if tc.expectedTypePrefix != "" {
				contentType := w.Header().Get("Content-Type")
				if !strings.HasPrefix(contentType, tc.expectedTypePrefix) {
					t.Errorf("expected Content-Type starting with %q, got %q", tc.expectedTypePrefix, contentType)
				}
			}

			if tc.expectedCache != "" {
				cacheControl := w.Header().Get("Cache-Control")
				if !strings.Contains(cacheControl, tc.expectedCache) {
					t.Errorf("expected Cache-Control containing %q, got %q", tc.expectedCache, cacheControl)
				}
			}
		})
	}
}
