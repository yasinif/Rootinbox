// Package web provides the embedded frontend filesystem.
// RFC-0010 §7.1: The Vite production build output (dist/) is embedded into
// the Go binary.
package web

import "embed"

//go:embed all:dist
var DistFS embed.FS
