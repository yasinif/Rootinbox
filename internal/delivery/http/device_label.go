package http

import (
	"strings"
)

// ParseDeviceLabel parses a User-Agent string into a concise, user-friendly device label.
// Example outputs: "Chrome on Windows", "Safari on iPhone", "Chrome on Android", "Firefox on Mac".
func ParseDeviceLabel(ua string) string {
	if ua == "" {
		return "Web Browser"
	}

	// Detect OS
	var os string
	switch {
	case strings.Contains(ua, "iPhone"):
		os = "iPhone"
	case strings.Contains(ua, "iPad"):
		os = "iPad"
	case strings.Contains(ua, "Android"):
		os = "Android"
	case strings.Contains(ua, "Windows"):
		os = "Windows"
	case strings.Contains(ua, "Macintosh") || strings.Contains(ua, "Mac OS"):
		os = "macOS"
	case strings.Contains(ua, "Linux"):
		os = "Linux"
	default:
		os = ""
	}

	// Detect Browser
	var browser string
	switch {
	case strings.Contains(ua, "Edg/"):
		browser = "Edge"
	case strings.Contains(ua, "Chrome/") && !strings.Contains(ua, "Chromium"):
		browser = "Chrome"
	case strings.Contains(ua, "Firefox/"):
		browser = "Firefox"
	case strings.Contains(ua, "Safari/") && !strings.Contains(ua, "Chrome/"):
		browser = "Safari"
	default:
		browser = "Browser"
	}

	if os != "" {
		return browser + " on " + os
	}
	return browser
}
