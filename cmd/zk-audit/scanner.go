package main

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/crypto/hkdf"
	_ "modernc.org/sqlite"

	"rootinbox/pkg/crypto"
)

// TargetPattern defines a sensitive value to look for in traffic and storage.
type TargetPattern struct {
	Label    string
	Raw      []byte
	Patterns [][]byte
}

func NewTargetPattern(label string, raw []byte) TargetPattern {
	p := TargetPattern{
		Label: label,
		Raw:   raw,
	}
	p.Patterns = append(p.Patterns, raw)

	// Add Hex and Base64 representations if raw is binary (or has length >= 16)
	if len(raw) >= 16 {
		hexBytes := []byte(hex.EncodeToString(raw))
		b64Bytes := []byte(base64.StdEncoding.EncodeToString(raw))
		b64RawBytes := []byte(base64.RawStdEncoding.EncodeToString(raw))
		b64URLBytes := []byte(base64.URLEncoding.EncodeToString(raw))
		b64RawURLBytes := []byte(base64.RawURLEncoding.EncodeToString(raw))

		p.Patterns = append(p.Patterns, hexBytes, b64Bytes, b64RawBytes, b64URLBytes, b64RawURLBytes)
	}

	return p
}

// RunCategory5Scan checks all recorded HTTP requests and WebSocket frames for plaintext leaks.
func RunCategory5Scan(traffic *RecordedTraffic, targets []TargetPattern) AuditCategoryResult {
	res := AuditCategoryResult{
		Name:   "5. Plaintext at Server Boundary (HTTP Requests & WebSocket Frames)",
		Passed: true,
	}

	if traffic == nil {
		return res
	}

	// 1. Scan HTTP Request Bodies
	httpReqs := traffic.GetHTTPRequests()
	for _, req := range httpReqs {
		if len(req.Body) == 0 {
			continue
		}
		for _, target := range targets {
			for _, pat := range target.Patterns {
				if len(pat) == 0 {
					continue
				}
				if bytes.Contains(req.Body, pat) {
					res.Passed = false
					res.Findings = append(res.Findings,
						fmt.Sprintf("%s found plaintext in HTTP request %s %s (body len=%d)",
							target.Label, req.Method, req.Path, len(req.Body)))
					break // target matched for this request
				}
			}
		}
	}

	// 2. Scan WebSocket Frames (Client -> Server and Server -> Client)
	wsFrames := traffic.GetWSFrames()
	for _, frame := range wsFrames {
		if len(frame.Payload) == 0 {
			continue
		}
		for _, target := range targets {
			for _, pat := range target.Patterns {
				if len(pat) == 0 {
					continue
				}
				if bytes.Contains(frame.Payload, pat) {
					res.Passed = false
					res.Findings = append(res.Findings,
						fmt.Sprintf("%s found plaintext in WebSocket frame (%s, payload len=%d)",
							target.Label, frame.Direction, len(frame.Payload)))
					break
				}
			}
		}
	}

	return res
}

// CandidateKey represents a key derived from server environment, config, or database.
type CandidateKey struct {
	Key    [32]byte
	Source string
}

// RunCategory6Scan checks if any server-reachable secret or derived key can AES-GCM decrypt stored messages or media.
func RunCategory6Scan(serverEnv []string, dbPath string, mediaPath string) AuditCategoryResult {
	res := AuditCategoryResult{
		Name:   "6. Key Material Reachable by Server (Decryptability of Stored Payloads)",
		Passed: true,
	}

	// 1. Collect candidate secrets from environment
	candidateSecrets := make(map[string]string) // secret -> source
	for _, envLine := range serverEnv {
		parts := strings.SplitN(envLine, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.ToUpper(parts[0])
		val := parts[1]
		if len(val) == 0 {
			continue
		}

		if strings.Contains(key, "SECRET") || strings.Contains(key, "KEY") ||
			strings.Contains(key, "PASS") || strings.Contains(key, "TOKEN") ||
			strings.Contains(key, "AUTH") || strings.Contains(key, "HASH") ||
			strings.Contains(key, "SALT") || strings.Contains(key, "VAPID") {
			candidateSecrets[val] = fmt.Sprintf("env:%s", parts[0])
		}
	}

	// 2. Collect candidate secrets from Database
	db, err := sql.Open("sqlite", dbPath)
	if err == nil {
		defer db.Close()

		// Read application_keys table if present
		rows, err := db.Query("SELECT key, value FROM application_keys")
		if err == nil {
			for rows.Next() {
				var k, v string
				if err := rows.Scan(&k, &v); err == nil && v != "" {
					candidateSecrets[v] = fmt.Sprintf("db:application_keys:%s", k)
				}
			}
			rows.Close()
		}

		// Read sessions table if present
		sRows, err := db.Query("SELECT session_token FROM sessions")
		if err == nil {
			for sRows.Next() {
				var tok string
				if err := sRows.Scan(&tok); err == nil && tok != "" {
					candidateSecrets[tok] = "db:sessions:session_token"
				}
			}
			sRows.Close()
		}
	}

	// 3. Derive 32-byte candidate keys
	candidateKeys := make(map[[32]byte]string) // key -> derivation description

	for secret, source := range candidateSecrets {
		rawBytes := []byte(secret)

		// a) Raw bytes (if 32 bytes)
		if len(rawBytes) == 32 {
			var k [32]byte
			copy(k[:], rawBytes)
			candidateKeys[k] = fmt.Sprintf("%s (raw-32)", source)
		}

		// b) Hex decoded (if 64 hex chars)
		if hx, err := hex.DecodeString(secret); err == nil && len(hx) == 32 {
			var k [32]byte
			copy(k[:], hx)
			candidateKeys[k] = fmt.Sprintf("%s (hex-decoded)", source)
		}

		// c) Base64 decoded (standard and URL)
		if b64, err := base64.StdEncoding.DecodeString(secret); err == nil && len(b64) == 32 {
			var k [32]byte
			copy(k[:], b64)
			candidateKeys[k] = fmt.Sprintf("%s (b64-std)", source)
		}
		if b64u, err := base64.RawURLEncoding.DecodeString(secret); err == nil && len(b64u) == 32 {
			var k [32]byte
			copy(k[:], b64u)
			candidateKeys[k] = fmt.Sprintf("%s (b64-rawurl)", source)
		}

		// d) Direct SHA-256
		candidateKeys[sha256.Sum256(rawBytes)] = fmt.Sprintf("%s (sha256)", source)

		// e) Project-specific SHA-256 prefixes
		p1 := sha256.Sum256(append([]byte("rootinbox:message_encryption_at_rest:"), rawBytes...))
		candidateKeys[p1] = fmt.Sprintf("%s (sha256:message_encryption_at_rest)", source)

		p2 := sha256.Sum256(append([]byte("rootinbox:media_encryption:"), rawBytes...))
		candidateKeys[p2] = fmt.Sprintf("%s (sha256:media_encryption)", source)

		p3 := sha256.Sum256(append([]byte("rootinbox:vault:"), rawBytes...))
		candidateKeys[p3] = fmt.Sprintf("%s (sha256:vault)", source)

		// f) HKDF-SHA256 candidate keys
		labels := []string{
			"rootinbox/v1/e2ee-message-key",
			"rootinbox:message_encryption_at_rest",
			"rootinbox:vault",
			"rootinbox:session",
		}
		for _, lbl := range labels {
			hReader := hkdf.New(sha256.New, rawBytes, nil, []byte(lbl))
			var hk [32]byte
			if _, err := io.ReadFull(hReader, hk[:]); err == nil {
				candidateKeys[hk] = fmt.Sprintf("%s (hkdf:%s)", source, lbl)
			}
		}
	}

	// 4. Test decryption on stored message records in SQLite
	if db != nil {
		rows, err := db.Query("SELECT id, conversation_id, content FROM group_messages")
		if err == nil {
			defer rows.Close()
			for rows.Next() {
				var msgID, convID, encContent string
				if err := rows.Scan(&msgID, &convID, &encContent); err != nil {
					continue
				}

				if strings.HasPrefix(encContent, "enc:v1:") {
					trimmed := strings.TrimPrefix(encContent, "enc:v1:")
					parts := strings.SplitN(trimmed, ":", 2)
					if len(parts) == 2 {
						ivBytes, errIV := base64.StdEncoding.DecodeString(parts[0])
						ciphertext, errCT := base64.StdEncoding.DecodeString(parts[1])
						if errIV == nil && errCT == nil && len(ivBytes) == 12 {
							var iv [12]byte
							copy(iv[:], ivBytes)

							// Try each candidate key
							for key, desc := range candidateKeys {
								// Try with AAD = convID
								dec, err := crypto.Decrypt(key, iv, ciphertext, []byte(convID))
								if err == nil {
									res.Passed = false
									res.Findings = append(res.Findings,
										fmt.Sprintf("Server-reachable key [%s] decrypted group_messages[id='%s', conv='%s']! Plaintext snippet: %q",
											desc, msgID, convID, truncateString(string(dec), 40)))
									break
								}
								// Try with AAD = nil
								decNil, errNil := crypto.Decrypt(key, iv, ciphertext, nil)
								if errNil == nil {
									res.Passed = false
									res.Findings = append(res.Findings,
										fmt.Sprintf("Server-reachable key [%s] decrypted group_messages[id='%s', conv='%s'] (no AAD)! Plaintext snippet: %q",
											desc, msgID, convID, truncateString(string(decNil), 40)))
									break
								}
							}
						}
					}
				}
			}
		}
	}

	// 5. Test decryption on stored media chunks
	if mediaPath != "" {
		_ = filepath.Walk(mediaPath, func(path string, info os.FileInfo, err error) error {
			if err != nil || info == nil || info.IsDir() {
				return nil
			}
			chunkBytes, err := os.ReadFile(path)
			if err != nil || len(chunkBytes) < 28 { // 12-byte IV + 16-byte GCM tag
				return nil
			}

			var iv [12]byte
			copy(iv[:], chunkBytes[:12])
			ct := chunkBytes[12:]

			for key, desc := range candidateKeys {
				dec, err := crypto.Decrypt(key, iv, ct, nil)
				if err == nil {
					res.Passed = false
					res.Findings = append(res.Findings,
						fmt.Sprintf("Server-reachable key [%s] decrypted media chunk %s! Plaintext snippet: %q",
							desc, filepath.Base(path), truncateString(string(dec), 40)))
					break
				}
			}
			return nil
		})
	}

	return res
}

func truncateString(s string, maxLen int) string {
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen] + "..."
}
