//go:build linux

package main

import (
	"log"
	"os"
	"path/filepath"
	"syscall"
)

const (
	targetUID = 65532
	targetGID = 65532
)

func run() {
	// 1. Resolve paths
	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "/data/db/app.db"
	}
	dbDir := filepath.Dir(dbPath)

	mediaPath := os.Getenv("MEDIA_PATH")
	if mediaPath == "" {
		mediaPath = os.Getenv("MEDIA_STORAGE_PATH")
		if mediaPath == "" {
			mediaPath = "/data/media"
		}
	}

	// 2. Prepare volume directory structure if running as root
	if os.Geteuid() == 0 {
		// If /data exists, ensure it is owned by targetUID:targetGID
		if fi, err := os.Stat("/data"); err == nil && fi.IsDir() {
			_ = os.Chown("/data", targetUID, targetGID)
			_ = os.Chmod("/data", 0750)
		}

		// Ensure dbDir exists and is owned by targetUID:targetGID
		if err := os.MkdirAll(dbDir, 0750); err != nil {
			log.Printf("launcher: warning: creating db dir %s: %v", dbDir, err)
		} else {
			_ = os.Chown(dbDir, targetUID, targetGID)
		}

		// Ensure mediaPath exists and is owned by targetUID:targetGID
		if err := os.MkdirAll(mediaPath, 0750); err != nil {
			log.Printf("launcher: warning: creating media dir %s: %v", mediaPath, err)
		} else {
			_ = os.Chown(mediaPath, targetUID, targetGID)
		}

		// Recursively ensure all items in /data are owned by targetUID:targetGID
		if fi, err := os.Stat("/data"); err == nil && fi.IsDir() {
			_ = filepath.Walk("/data", func(path string, info os.FileInfo, err error) error {
				if err == nil {
					_ = os.Chown(path, targetUID, targetGID)
				}
				return nil
			})
		}

		// 3. Drop privileges to nonroot (UID 65532, GID 65532)
		_ = syscall.Setgroups([]int{targetGID})
		if err := syscall.Setgid(targetGID); err != nil {
			log.Fatalf("launcher: failed to setgid(%d): %v", targetGID, err)
		}
		if err := syscall.Setuid(targetUID); err != nil {
			log.Fatalf("launcher: failed to setuid(%d): %v", targetUID, err)
		}
	}

	// 4. Exec /rootinbox with original arguments
	binary := "/rootinbox"
	args := append([]string{binary}, os.Args[1:]...)
	env := os.Environ()

	if err := syscall.Exec(binary, args, env); err != nil {
		log.Fatalf("launcher: failed to exec %s: %v", binary, err)
	}
}
