package main

import (
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	_ "modernc.org/sqlite"

	"rootinbox/pkg/crypto"
)

func TestCategory5_UnitFixtures(t *testing.T) {
	engMarker := "ZK_AUDIT_MARKER_ENG_PLAINTEXT_TEST123"
	faMarker := "نشانگر_حسابرسی_فارسی_تست"
	photoFileName := "secret_photo_snapshot.jpg"
	photoMediaKey := make([]byte, 32)
	_, _ = rand.Read(photoMediaKey)

	targets := []TargetPattern{
		NewTargetPattern("English Text Marker", []byte(engMarker)),
		NewTargetPattern("Persian Text Marker", []byte(faMarker)),
		NewTargetPattern("Photo File Name", []byte(photoFileName)),
		NewTargetPattern("Photo Media Key", photoMediaKey),
	}

	t.Run("Positive Fixture (Plaintext Leak Detected)", func(t *testing.T) {
		traffic := &RecordedTraffic{}

		// 1. HTTP request with English marker in JSON body
		traffic.AddHTTPRequest(RecordedHTTPRequest{
			Method: http.MethodPost,
			Path:   "/api/v1/conversations/123/messages",
			Body:   []byte(fmt.Sprintf(`{"content":"%s"}`, engMarker)),
		})

		// 2. HTTP request with photo filename in JSON body
		traffic.AddHTTPRequest(RecordedHTTPRequest{
			Method: http.MethodPost,
			Path:   "/api/v1/conversations/123/messages",
			Body:   []byte(fmt.Sprintf(`{"file_name":"%s"}`, photoFileName)),
		})

		// 3. WS frame with hex media key
		traffic.AddWSFrame("client->server", []byte(fmt.Sprintf(`{"key":"%s"}`, hex.EncodeToString(photoMediaKey))))

		res := RunCategory5Scan(traffic, targets)
		if res.Passed {
			t.Fatalf("Expected Category 5 to fail on positive fixture, but passed")
		}
		if len(res.Findings) < 3 {
			t.Fatalf("Expected at least 3 findings, got %d: %v", len(res.Findings), res.Findings)
		}

		foundEng := false
		foundPhotoFile := false
		foundMediaKey := false
		for _, f := range res.Findings {
			if strings.Contains(f, "English Text Marker") {
				foundEng = true
			}
			if strings.Contains(f, "Photo File Name") {
				foundPhotoFile = true
			}
			if strings.Contains(f, "Photo Media Key") {
				foundMediaKey = true
			}
		}

		if !foundEng || !foundPhotoFile || !foundMediaKey {
			t.Fatalf("Findings missing expected detections: eng=%v, photo=%v, key=%v\nFindings: %v",
				foundEng, foundPhotoFile, foundMediaKey, res.Findings)
		}
	})

	t.Run("Negative Fixture (Clean Encrypted Traffic)", func(t *testing.T) {
		traffic := &RecordedTraffic{}

		// Harmless requests containing only random/opaque ciphertext
		opaqueCT := base64.StdEncoding.EncodeToString([]byte("totally_opaque_encrypted_blob_data_no_markers"))
		traffic.AddHTTPRequest(RecordedHTTPRequest{
			Method: http.MethodGet,
			Path:   "/health/ready",
			Body:   nil,
		})
		traffic.AddHTTPRequest(RecordedHTTPRequest{
			Method: http.MethodPost,
			Path:   "/api/v1/conversations/123/messages",
			Body:   []byte(fmt.Sprintf(`{"content":"enc:v1:%s"}`, opaqueCT)),
		})
		traffic.AddWSFrame("client->server", []byte(`{"type":"ping"}`))
		traffic.AddWSFrame("server->client", []byte(`{"type":"pong"}`))

		res := RunCategory5Scan(traffic, targets)
		if !res.Passed {
			t.Fatalf("Expected Category 5 to pass on clean fixture, but failed: %v", res.Findings)
		}
		if len(res.Findings) != 0 {
			t.Fatalf("Expected 0 findings, got %d: %v", len(res.Findings), res.Findings)
		}
	})
}

func TestCategory6_UnitFixtures(t *testing.T) {
	tempDir, err := os.MkdirTemp("", "zk-audit-cat6-test-*")
	if err != nil {
		t.Fatalf("Failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tempDir)

	dbPath := filepath.Join(tempDir, "test.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("Failed to open SQLite: %v", err)
	}
	defer db.Close()

	_, err = db.Exec(`CREATE TABLE group_messages (
		id TEXT PRIMARY KEY,
		conversation_id TEXT NOT NULL,
		content TEXT NOT NULL
	);`)
	if err != nil {
		t.Fatalf("Failed to create table: %v", err)
	}

	t.Run("Positive Fixture (Key Material Reachable by Server)", func(t *testing.T) {
		serverSecret := "zk_test_ip_hash_secret_at_least_32_bytes_super_secret"
		serverEnv := []string{
			"PORT=8080",
			"IP_HASH_SECRET=" + serverSecret,
		}

		// Encrypt message using key derived from server secret (current architecture)
		atRestKey := sha256.Sum256(append([]byte("rootinbox:message_encryption_at_rest:"), []byte(serverSecret)...))
		convID := "conv-positive-101"
		plaintext := "Confidential message body readable by server key!"

		var iv [12]byte
		_, _ = rand.Read(iv[:])
		ciphertext, err := crypto.Encrypt(atRestKey, iv, []byte(plaintext), []byte(convID))
		if err != nil {
			t.Fatalf("Failed to encrypt positive fixture: %v", err)
		}
		encContent := fmt.Sprintf("enc:v1:%s:%s",
			base64.StdEncoding.EncodeToString(iv[:]),
			base64.StdEncoding.EncodeToString(ciphertext))

		_, err = db.Exec("INSERT INTO group_messages (id, conversation_id, content) VALUES (?, ?, ?)",
			"msg-positive-1", convID, encContent)
		if err != nil {
			t.Fatalf("Failed to insert message: %v", err)
		}

		res := RunCategory6Scan(serverEnv, dbPath, "")
		if res.Passed {
			t.Fatalf("Expected Category 6 to fail on positive fixture, but passed")
		}
		if len(res.Findings) == 0 {
			t.Fatalf("Expected findings for Category 6, got none")
		}

		foundDerivation := false
		for _, f := range res.Findings {
			if strings.Contains(f, "env:IP_HASH_SECRET") && strings.Contains(f, "msg-positive-1") {
				foundDerivation = true
			}
		}
		if !foundDerivation {
			t.Fatalf("Findings did not mention expected derivation: %v", res.Findings)
		}
	})

	t.Run("Negative Fixture (Zero Server-Reachable Keys)", func(t *testing.T) {
		// Clean table
		_, _ = db.Exec("DELETE FROM group_messages")

		serverEnv := []string{
			"PORT=8080",
			"IP_HASH_SECRET=completely_unrelated_server_hash_secret_32bytes",
		}

		// Encrypt message using a pure client-side key NOT derivable from server env or DB
		var clientKey [32]byte
		_, _ = rand.Read(clientKey[:])
		convID := "conv-negative-202"
		plaintext := "True zero-knowledge end-to-end encrypted message body"

		var iv [12]byte
		_, _ = rand.Read(iv[:])
		ciphertext, err := crypto.Encrypt(clientKey, iv, []byte(plaintext), []byte(convID))
		if err != nil {
			t.Fatalf("Failed to encrypt fixture: %v", err)
		}
		encContent := fmt.Sprintf("enc:v1:%s:%s",
			base64.StdEncoding.EncodeToString(iv[:]),
			base64.StdEncoding.EncodeToString(ciphertext))

		_, err = db.Exec("INSERT INTO group_messages (id, conversation_id, content) VALUES (?, ?, ?)",
			"msg-negative-2", convID, encContent)
		if err != nil {
			t.Fatalf("Failed to insert negative fixture: %v", err)
		}

		res := RunCategory6Scan(serverEnv, dbPath, "")
		if !res.Passed {
			t.Fatalf("Expected Category 6 to pass on negative fixture, but failed: %v", res.Findings)
		}
		if len(res.Findings) != 0 {
			t.Fatalf("Expected 0 findings, got %d: %v", len(res.Findings), res.Findings)
		}
	})
}
