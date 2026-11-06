package http

import (
	"bufio"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

var (
	rehearsalMu       sync.Mutex
	rehearsalLogFile  *os.File
	rehearsalInitDone bool
)

// initRehearsalLog initializes rehearsal logging file destination if REHEARSAL_MODE is active.
func initRehearsalLog() io.Writer {
	rehearsalMu.Lock()
	defer rehearsalMu.Unlock()

	if rehearsalInitDone {
		if rehearsalLogFile != nil {
			return rehearsalLogFile
		}
		return nil
	}
	rehearsalInitDone = true

	logPath := os.Getenv("REHEARSAL_LOG_FILE")
	if logPath == "" {
		dataDir := os.Getenv("REHEARSAL_DATA_DIR")
		if dataDir == "" {
			dataDir = os.Getenv("DATA_DIR")
		}
		if dataDir != "" {
			logPath = filepath.Join(dataDir, "rehearsal.log")
		}
	}

	if logPath != "" {
		_ = os.MkdirAll(filepath.Dir(logPath), 0755)
		f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644)
		if err == nil {
			rehearsalLogFile = f
			return f
		}
	}
	return nil
}

// CloseRehearsalLog closes the rehearsal log file if open.
func CloseRehearsalLog() {
	rehearsalMu.Lock()
	defer rehearsalMu.Unlock()
	if rehearsalLogFile != nil {
		_ = rehearsalLogFile.Close()
		rehearsalLogFile = nil
	}
	rehearsalInitDone = false
}

// RehearsalAccessLogger middleware logs each request concisely for LAN rehearsal diagnostics:
// (time, remote address, method, path, status, duration, user-agent family).
// Failed register/login/verify print their typed reason code.
// Never logs bodies, credentials or tokens.
func RehearsalAccessLogger() func(http.Handler) http.Handler {
	fileWriter := initRehearsalLog()
	isRehearsal := os.Getenv("REHEARSAL_MODE") == "true" || os.Getenv("LAN_REHEARSAL") == "true" || fileWriter != nil

	return func(next http.Handler) http.Handler {
		if !isRehearsal {
			return next
		}

		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()

			rec := &statusRecorder{
				ResponseWriter: w,
				statusCode:     http.StatusOK,
			}

			next.ServeHTTP(rec, r)

			duration := time.Since(start).Round(time.Millisecond)
			if duration < time.Millisecond {
				duration = time.Since(start).Round(time.Microsecond)
			}

			// Extract failure reason code if set by auth handlers
			reason := rec.Header().Get("X-Auth-Reason")
			// Strip the internal header so it is never exposed externally
			rec.Header().Del("X-Auth-Reason")

			uaLabel := ParseDeviceLabel(r.UserAgent())
			timestamp := time.Now().UTC().Format(time.RFC3339)

			var line string
			if reason != "" {
				line = fmt.Sprintf("[%s] %s %s %s %d %s %q reason=%s\n",
					timestamp, r.RemoteAddr, r.Method, r.URL.Path, rec.statusCode, duration, uaLabel, reason)
			} else {
				line = fmt.Sprintf("[%s] %s %s %s %d %s %q\n",
					timestamp, r.RemoteAddr, r.Method, r.URL.Path, rec.statusCode, duration, uaLabel)
			}

			// Print to console
			_, _ = os.Stdout.WriteString(line)

			// Append to rehearsal log file if available
			if fileWriter != nil {
				rehearsalMu.Lock()
				_, _ = fileWriter.Write([]byte(line))
				rehearsalMu.Unlock()
			}
		})
	}
}

type statusRecorder struct {
	http.ResponseWriter
	statusCode int
}

func (r *statusRecorder) WriteHeader(code int) {
	r.statusCode = code
	r.ResponseWriter.WriteHeader(code)
}

func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := r.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, fmt.Errorf("webserver doesn't support hijacking")
}

func (r *statusRecorder) Flush() {
	if fl, ok := r.ResponseWriter.(http.Flusher); ok {
		fl.Flush()
	}
}
