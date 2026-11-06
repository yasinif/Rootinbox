package http

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRehearsalAccessLogger_LogFormatAndReason(t *testing.T) {
	tempDir := t.TempDir()
	logFile := filepath.Join(tempDir, "rehearsal.log")

	t.Setenv("REHEARSAL_MODE", "true")
	t.Setenv("REHEARSAL_LOG_FILE", logFile)

	t.Cleanup(CloseRehearsalLog)
	CloseRehearsalLog()

	// Redirect stdout to buffer to capture console log
	oldStdout := os.Stdout
	rOut, wOut, _ := os.Pipe()
	os.Stdout = wOut

	handler := RehearsalAccessLogger()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/fail-auth" {
			w.Header().Set("X-Auth-Reason", "AUTH_001_missing_session_sig")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"Authentication failed"}`))
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`OK`))
	}))

	// Test 1: Normal 200 GET
	req1 := httptest.NewRequest("GET", "/", nil)
	req1.RemoteAddr = "172.24.249.139:54321"
	req1.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0")
	rec1 := httptest.NewRecorder()
	handler.ServeHTTP(rec1, req1)

	// Test 2: Failed 401 with typed error reason
	req2 := httptest.NewRequest("POST", "/fail-auth", bytes.NewBufferString(`{"password":"secret_password"}`))
	req2.RemoteAddr = "172.24.249.140:54322"
	req2.Header.Set("User-Agent", "Mozilla/5.0 (iPhone; CPU iPhone OS 15_8_8 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1")
	rec2 := httptest.NewRecorder()
	handler.ServeHTTP(rec2, req2)

	_ = wOut.Close()
	os.Stdout = oldStdout
	var stdoutBuf bytes.Buffer
	_, _ = io.Copy(&stdoutBuf, rOut)
	consoleOutput := stdoutBuf.String()

	// Verify X-Auth-Reason was NOT leaked in HTTP response to client
	if rec2.Header().Get("X-Auth-Reason") != "" {
		t.Errorf("X-Auth-Reason header must be stripped from HTTP response")
	}

	// Verify console output contains required fields
	if !strings.Contains(consoleOutput, "172.24.249.139:54321") || !strings.Contains(consoleOutput, "GET / 200") {
		t.Errorf("Console output missing request 1 fields: %s", consoleOutput)
	}
	if !strings.Contains(consoleOutput, "Chrome on Windows") {
		t.Errorf("Console output missing user-agent family: %s", consoleOutput)
	}
	if !strings.Contains(consoleOutput, "POST /fail-auth 401") || !strings.Contains(consoleOutput, "reason=AUTH_001_missing_session_sig") {
		t.Errorf("Console output missing failure reason code: %s", consoleOutput)
	}
	if !strings.Contains(consoleOutput, "Safari on iPhone") {
		t.Errorf("Console output missing iPhone UA: %s", consoleOutput)
	}

	// Verify no secret payload / credentials leaked in logs
	if strings.Contains(consoleOutput, "secret_password") {
		t.Errorf("Console output leaked request body/credentials!")
	}

	// Verify log file content matches
	CloseRehearsalLog()
	fileBytes, err := os.ReadFile(logFile)
	if err != nil {
		t.Fatalf("Failed to read rehearsal log file: %v", err)
	}
	fileOutput := string(fileBytes)
	if !strings.Contains(fileOutput, "172.24.249.139:54321") || !strings.Contains(fileOutput, "reason=AUTH_001_missing_session_sig") {
		t.Errorf("Log file missing expected entries: %s", fileOutput)
	}
	if strings.Contains(fileOutput, "secret_password") {
		t.Errorf("Log file leaked credentials!")
	}
}
