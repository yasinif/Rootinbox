package http

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"

	"rootinbox/internal/config"
	"rootinbox/internal/infrastructure/database"
	"rootinbox/internal/infrastructure/migrations"
)

// HealthChecker verifies application readiness.
// RFC-0001 Section 4: /health/ready must verify: Migrations Complete,
// Writer DB ping, Reader DB ping, Disk Writable.
// RFC-0001A Section 6: /health/ready must verify: DB, Migrations, Config,
// Dependencies, AND Application Version is successfully loaded.
type HealthChecker struct {
	db        *database.DB
	migRunner *migrations.Runner
	cfg       *config.Config
}

// NewHealthChecker creates a HealthChecker with all required dependencies.
func NewHealthChecker(db *database.DB, migRunner *migrations.Runner, cfg *config.Config) *HealthChecker {
	return &HealthChecker{
		db:        db,
		migRunner: migRunner,
		cfg:       cfg,
	}
}

// healthStatus represents the result of a single health check.
type healthStatus struct {
	Name    string `json:"name"`
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}

// healthResponse is the JSON response for the health endpoint.
type healthResponse struct {
	Status string         `json:"status"`
	Checks []healthStatus `json:"checks"`
}

// HandleReady returns an HTTP handler for GET /health/ready.
func (hc *HealthChecker) HandleReady() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()
		checks := hc.runChecks(ctx)

		allPassed := true
		for _, c := range checks {
			if c.Status != "pass" {
				allPassed = false
				break
			}
		}

		resp := healthResponse{
			Status: "pass",
			Checks: checks,
		}
		if !allPassed {
			resp.Status = "fail"
		}

		w.Header().Set("Content-Type", "application/json")
		if allPassed {
			w.WriteHeader(http.StatusOK)
		} else {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		_ = json.NewEncoder(w).Encode(resp)
	}
}

// runChecks executes all RFC-required health verifications.
func (hc *HealthChecker) runChecks(ctx context.Context) []healthStatus {
	var checks []healthStatus

	// RFC-0001 Section 4: Writer DB ping.
	checks = append(checks, hc.checkWriterDB(ctx))

	// RFC-0001 Section 4: Reader DB ping.
	checks = append(checks, hc.checkReaderDB(ctx))

	// RFC-0001 Section 4: Migrations Complete.
	checks = append(checks, hc.checkMigrations(ctx))

	// RFC-0001 Section 4: Disk Writable.
	checks = append(checks, hc.checkDiskWritable())

	// RFC-0001A Section 6: Config loaded.
	checks = append(checks, hc.checkConfig())

	// RFC-0001A Section 6: Application Version loaded.
	checks = append(checks, hc.checkAppVersion())

	return checks
}

func (hc *HealthChecker) checkWriterDB(ctx context.Context) healthStatus {
	if err := hc.db.Writer.PingContext(ctx); err != nil {
		return healthStatus{Name: "writer_db", Status: "fail", Message: fmt.Sprintf("ping failed: %v", err)}
	}
	return healthStatus{Name: "writer_db", Status: "pass"}
}

func (hc *HealthChecker) checkReaderDB(ctx context.Context) healthStatus {
	if err := hc.db.Reader.PingContext(ctx); err != nil {
		return healthStatus{Name: "reader_db", Status: "fail", Message: fmt.Sprintf("ping failed: %v", err)}
	}
	return healthStatus{Name: "reader_db", Status: "pass"}
}

func (hc *HealthChecker) checkMigrations(ctx context.Context) healthStatus {
	complete, err := hc.migRunner.IsComplete(ctx)
	if err != nil {
		return healthStatus{Name: "migrations", Status: "fail", Message: fmt.Sprintf("check failed: %v", err)}
	}
	if !complete {
		return healthStatus{Name: "migrations", Status: "fail", Message: "pending migrations exist"}
	}
	return healthStatus{Name: "migrations", Status: "pass"}
}

func (hc *HealthChecker) checkDiskWritable() healthStatus {
	dbDir := filepath.Dir(hc.cfg.Database.Path)
	if dbDir == "" || dbDir == "." {
		dbDir = "."
	}

	f, err := os.CreateTemp(dbDir, ".health-check-*")
	if err != nil {
		return healthStatus{Name: "disk_writable", Status: "fail", Message: fmt.Sprintf("disk not writable: %v", err)}
	}
	name := f.Name()
	f.Close()
	os.Remove(name)

	return healthStatus{Name: "disk_writable", Status: "pass"}
}

func (hc *HealthChecker) checkConfig() healthStatus {
	if hc.cfg == nil {
		return healthStatus{Name: "config", Status: "fail", Message: "configuration not loaded"}
	}
	return healthStatus{Name: "config", Status: "pass"}
}

func (hc *HealthChecker) checkAppVersion() healthStatus {
	if hc.cfg.App.Version == "" {
		return healthStatus{Name: "app_version", Status: "fail", Message: "application version not loaded"}
	}
	return healthStatus{Name: "app_version", Status: "pass"}
}
