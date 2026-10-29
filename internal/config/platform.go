package config

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
)

const (
	PlatformRailway  = "Railway"
	PlatformDocker   = "Docker"
	PlatformBareHost = "Bare Host"
)

// DetectPlatform determines the deployment environment.
// Railway is detected via standard environment variables injected by the Railway runtime.
// Docker is detected via container marker files or environment flags.
func DetectPlatform() string {
	if os.Getenv("RAILWAY_ENVIRONMENT") != "" ||
		os.Getenv("RAILWAY_PROJECT_ID") != "" ||
		os.Getenv("RAILWAY_SERVICE_ID") != "" {
		return PlatformRailway
	}

	if _, err := os.Stat("/.dockerenv"); err == nil {
		return PlatformDocker
	}
	if _, err := os.Stat("/run/.containerenv"); err == nil {
		return PlatformDocker
	}
	if os.Getenv("DOCKER_CONTAINER") == "true" || os.Getenv("DOCKER_CONTAINER") == "1" {
		return PlatformDocker
	}

	return PlatformBareHost
}

// DetectDataDir determines the base data directory and whether persistent storage is detected.
// In Railway, checks RAILWAY_VOLUME_MOUNT_PATH or verifies if /data is mounted.
// In Docker, checks /data.
// On Bare Host, defaults to ./data.
func DetectDataDir(platform string) (dataDir string, isPersistent bool) {
	switch platform {
	case PlatformRailway:
		if v := os.Getenv("RAILWAY_VOLUME_MOUNT_PATH"); v != "" {
			return v, isDirWritable(v)
		}
		if v := os.Getenv("DATA_DIR"); v != "" {
			// On Railway, custom DATA_DIR without RAILWAY_VOLUME_MOUNT_PATH is ephemeral
			return v, false
		}
		// Railway standard volume mount recommendation is /data
		if isDirWritable("/data") {
			return "/data", true
		}
		// If /data is not mounted/writable, fallback to local ephemeral data directory
		return "./data", false

	case PlatformDocker:
		if v := os.Getenv("DATA_DIR"); v != "" {
			return v, isDirWritable(v)
		}
		if isDirWritable("/data") {
			return "/data", true
		}
		return "./data", false

	default: // PlatformBareHost
		if v := os.Getenv("DATA_DIR"); v != "" {
			return v, true
		}
		return "./data", true
	}
}

// DefaultRailwayProxyCIDRs returns verified private network CIDRs used by Railway's reverse proxy mesh.
// References RFC1918 private IPv4 subnets and IPv6 ULA subnets.
func DefaultRailwayProxyCIDRs() []*net.IPNet {
	rawCIDRs := []string{
		"10.0.0.0/8",
		"100.64.0.0/10", // CGNAT mesh
		"172.16.0.0/12",
		"192.168.0.0/16",
		"127.0.0.1/32",
		"::1/128",
		"fc00::/7", // IPv6 ULA
	}

	var parsed []*net.IPNet
	for _, raw := range rawCIDRs {
		_, cidr, err := net.ParseCIDR(raw)
		if err == nil {
			parsed = append(parsed, cidr)
		}
	}
	return parsed
}

// isDirWritable checks if a directory exists and can be written to.
func isDirWritable(dir string) bool {
	info, err := os.Stat(dir)
	if err != nil {
		// Attempt to create test directory if parent is writable
		if os.IsNotExist(err) {
			if err := os.MkdirAll(dir, 0755); err == nil {
				return true
			}
		}
		return false
	}
	if !info.IsDir() {
		return false
	}

	// Probe write permission with a temporary marker file
	testFile := filepath.Join(dir, fmt.Sprintf(".write_test_%d", os.Getpid()))
	if err := os.WriteFile(testFile, []byte("ok"), 0600); err != nil {
		return false
	}
	_ = os.Remove(testFile)
	return true
}

// CleanAppOrigin normalizes an application origin URL.
func CleanAppOrigin(raw string) string {
	raw = strings.TrimSpace(raw)
	return strings.TrimRight(raw, "/")
}
