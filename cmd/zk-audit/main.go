package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	_ "modernc.org/sqlite"

	"rootinbox/pkg/crypto"
)

type AuditCategoryResult struct {
	Name     string
	Passed   bool
	Findings []string
}

func main() {
	var mode string
	var outputPath string
	flag.StringVar(&mode, "mode", "baseline", "Audit mode: 'baseline' (report only for known baseline failures [4, 5, 6]) or 'require-pass' (blocking)")
	flag.StringVar(&outputPath, "output", "", "Optional path to write audit report to in clean UTF-8")
	flag.Parse()

	var reportBuf bytes.Buffer
	out := io.MultiWriter(os.Stdout, &reportBuf)
	printF := func(format string, a ...interface{}) {
		fmt.Fprintf(out, format, a...)
	}
	printlnF := func(a ...interface{}) {
		fmt.Fprintln(out, a...)
	}

	finish := func(code int) {
		if outputPath != "" {
			absPath, _ := filepath.Abs(outputPath)
			_ = os.MkdirAll(filepath.Dir(absPath), 0755)
			if err := os.WriteFile(absPath, reportBuf.Bytes(), 0644); err != nil {
				fmt.Fprintf(os.Stderr, "[-] Failed to write report to %s: %v\n", absPath, err)
			} else {
				fmt.Fprintf(os.Stderr, "[+] Report written to %s (%d bytes)\n", absPath, reportBuf.Len())
			}
		}
		os.Exit(code)
	}

	printlnF("================================================================================")
	printF(" ROOTINBOX ZERO-KNOWLEDGE AUDIT (scripts/zk-audit) [MODE: %s]\n", strings.ToUpper(mode))
	printlnF("================================================================================")

	tempDir, err := os.MkdirTemp("", "zk-audit-*")
	if err != nil {
		fmt.Printf("[-] Failed to create temp dir: %v\n", err)
		os.Exit(1)
	}
	defer os.RemoveAll(tempDir)

	dbPath := filepath.Join(tempDir, "app.db")
	mediaPath := filepath.Join(tempDir, "media")
	logPath := filepath.Join(tempDir, "server.log")
	if err := os.MkdirAll(mediaPath, 0755); err != nil {
		fmt.Printf("[-] Failed to create media dir: %v\n", err)
		os.Exit(1)
	}

	// 1. Find free port for backend server
	serverPort, err := getFreePort()
	if err != nil {
		fmt.Printf("[-] Failed to find free port: %v\n", err)
		os.Exit(1)
	}
	backendServerURL := fmt.Sprintf("http://127.0.0.1:%d", serverPort)

	ipHashSecret := "zk_audit_ip_hash_secret_at_least_32_bytes_long_random_entropy!!"

	// 2. Build rootinbox server binary
	binExt := ""
	if runtime.GOOS == "windows" {
		binExt = ".exe"
	}
	serverBin := filepath.Join(tempDir, "rootinbox-server"+binExt)
	printF("[+] Building rootinbox server binary -> %s\n", serverBin)
	buildCmd := exec.Command("go", "build", "-o", serverBin, "./cmd/rootinbox")
	buildCmd.Stdout = os.Stdout
	buildCmd.Stderr = os.Stderr
	if err := buildCmd.Run(); err != nil {
		printF("[-] Failed to build server: %v\n", err)
		finish(1)
	}

	// 3. Start backend server
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		printF("[-] Failed to open server log file: %v\n", err)
		finish(1)
	}
	defer logFile.Close()

	serverCmd := exec.Command(serverBin)
	serverEnv := append(os.Environ(),
		fmt.Sprintf("PORT=%d", serverPort),
		"SERVER_HOST=127.0.0.1",
		fmt.Sprintf("APP_ORIGIN=%s", backendServerURL),
		"INSECURE_DEV_MODE=true",
		fmt.Sprintf("IP_HASH_SECRET=%s", ipHashSecret),
		fmt.Sprintf("DB_PATH=%s", dbPath),
		fmt.Sprintf("MEDIA_PATH=%s", mediaPath),
		"LOG_LEVEL=debug",
		"PUSH_ENABLED=false",
	)
	serverCmd.Env = serverEnv
	serverCmd.Stdout = logFile
	serverCmd.Stderr = logFile

	printF("[+] Starting backend server on %s (DB: %s, Media: %s)\n", backendServerURL, dbPath, mediaPath)
	if err := serverCmd.Start(); err != nil {
		printF("[-] Failed to start server: %v\n", err)
		finish(1)
	}

	defer func() {
		if serverCmd.Process != nil {
			_ = serverCmd.Process.Kill()
			_ = serverCmd.Wait()
		}
	}()

	if err := waitForReady(backendServerURL, 15*time.Second); err != nil {
		printF("[-] Server failed to become ready: %v\n", err)
		printFileTail(logPath, 50)
		finish(1)
	}
	printlnF("[+] Backend server is ready and healthy.")

	// 4. Start Recording Reverse Proxy (Category 5 server boundary recorder)
	traffic := &RecordedTraffic{}
	proxy, err := NewRecordingProxy(backendServerURL, traffic)
	if err != nil {
		printF("[-] Failed to start recording proxy: %v\n", err)
		finish(1)
	}
	defer proxy.Close()

	clientURL := proxy.URL()
	clientWSURL := proxy.WSURL()
	printF("[+] Recording reverse proxy active on %s (forwarding to %s)\n", clientURL, backendServerURL)

	// 5. Generate Users & Cryptographic Keys
	aliceIdentPK, aliceIdentSK, _ := ed25519.GenerateKey(rand.Reader)
	aliceSessPK, _ := generateEd25519Raw()
	aliceVaultKey := make([]byte, 32)
	_, _ = rand.Read(aliceVaultKey)

	bobIdentPK, bobIdentSK, _ := ed25519.GenerateKey(rand.Reader)
	bobSessPK, _ := generateEd25519Raw()
	bobVaultKey := make([]byte, 32)
	_, _ = rand.Read(bobVaultKey)

	photoMediaKey := make([]byte, 32)
	_, _ = rand.Read(photoMediaKey)

	voiceMediaKey := make([]byte, 32)
	_, _ = rand.Read(voiceMediaKey)

	docMediaKey := make([]byte, 32)
	_, _ = rand.Read(docMediaKey)

	photoFileName := "TOP_SECRET_ZK_PHOTO_vacation_snapshot_2026.jpg"
	voiceFileName := "TOP_SECRET_ZK_VOICE_confidential_memo_007.webm"
	docFileName := "TOP_SECRET_ZK_DOC_financial_audit_ledger_private.pdf"

	engMarker := fmt.Sprintf("ZK_AUDIT_MARKER_ENG_PLAINTEXT_%s", uuid.New().String())
	faMarker := fmt.Sprintf("نشانگر_حسابرسی_فارسی_متن_رمزنگاری_%s", uuid.New().String()[:8])

	// 6. Execute Scenario via the Recording Proxy
	printlnF("[+] Registering User A (Alice)...")
	aliceUser, err := registerUser(clientURL, "alice_audit", "آلیس حسام", aliceIdentPK, aliceIdentSK, aliceSessPK)
	if err != nil {
		printF("[-] Failed to register Alice: %v\n", err)
		finish(1)
	}

	printlnF("[+] Registering User B (Bob)...")
	bobUser, err := registerUser(clientURL, "bob_audit", "باب راد", bobIdentPK, bobIdentSK, bobSessPK)
	if err != nil {
		printF("[-] Failed to register Bob: %v\n", err)
		finish(1)
	}

	printlnF("[+] Creating 1:1 conversation between Alice and Bob...")
	convID, err := createConversation(clientURL, aliceUser.Token, bobUser.IdentityHash)
	if err != nil {
		printF("[-] Failed to create conversation: %v\n", err)
		finish(1)
	}
	printF("[+] Conversation created: ID=%s\n", convID)

	printF("[+] Exchanging text messages with markers:\n    ENG: %s\n    FA:  %s\n", engMarker, faMarker)
	if err := sendMessage(clientURL, aliceUser.Token, convID, engMarker); err != nil {
		printF("[-] Alice failed to send message: %v\n", err)
		finish(1)
	}
	if err := sendMessage(clientURL, bobUser.Token, convID, faMarker); err != nil {
		printF("[-] Bob failed to send message: %v\n", err)
		finish(1)
	}

	printF("[+] Uploading photo with distinctive filename: %s\n", photoFileName)
	photoFileID := uuid.New().String()
	photoData := []byte("FAKE_JPEG_IMAGE_CONTENT_WITH_HEADER_JFIF_ZK_PHOTO")
	if err := uploadMediaFile(clientURL, aliceUser.Token, photoFileID, photoData); err != nil {
		printF("[-] Failed to upload photo media: %v\n", err)
		finish(1)
	}
	photoMCEMsg := fmt.Sprintf(`{"v":1,"type":"image","file_id":"%s","file_name":"%s","media_key":"%s","mime_type":"image/jpeg"}`,
		photoFileID, photoFileName, hex.EncodeToString(photoMediaKey))
	if err := sendMessage(clientURL, aliceUser.Token, convID, photoMCEMsg); err != nil {
		printF("[-] Failed to send photo MCE message: %v\n", err)
		finish(1)
	}

	printF("[+] Uploading voice memo with distinctive filename: %s\n", voiceFileName)
	voiceFileID := uuid.New().String()
	voiceData := []byte("FAKE_WEBM_OPUS_AUDIO_CONTENT_ZK_VOICE_MEMO")
	if err := uploadMediaFile(clientURL, bobUser.Token, voiceFileID, voiceData); err != nil {
		printF("[-] Failed to upload voice media: %v\n", err)
		finish(1)
	}
	voiceMCEMsg := fmt.Sprintf(`{"v":1,"type":"voice","file_id":"%s","file_name":"%s","media_key":"%s","mime_type":"audio/webm"}`,
		voiceFileID, voiceFileName, hex.EncodeToString(voiceMediaKey))
	if err := sendMessage(clientURL, bobUser.Token, convID, voiceMCEMsg); err != nil {
		printF("[-] Failed to send voice MCE message: %v\n", err)
		finish(1)
	}

	printF("[+] Uploading document with distinctive filename: %s\n", docFileName)
	docFileID := uuid.New().String()
	docData := []byte("FAKE_PDF_1.7_FINANCIAL_AUDIT_REPORT_DOCUMENT_CONTENT")
	if err := uploadMediaFile(clientURL, aliceUser.Token, docFileID, docData); err != nil {
		printF("[-] Failed to upload document media: %v\n", err)
		finish(1)
	}
	docMCEMsg := fmt.Sprintf(`{"v":1,"type":"file","file_name":"%s","file_id":"%s","media_key":"%s","mime_type":"application/pdf"}`,
		docFileName, docFileID, hex.EncodeToString(docMediaKey))
	if err := sendMessage(clientURL, aliceUser.Token, convID, docMCEMsg); err != nil {
		printF("[-] Failed to send document MCE message: %v\n", err)
		finish(1)
	}

	printlnF("[+] Executing WebRTC call signalling exchange over WebSocket...")
	if err := exchangeCallSignalling(clientURL, clientWSURL, aliceUser, bobUser); err != nil {
		printF("[-] Call signalling exchange error: %v (continuing audit)\n", err)
	}

	time.Sleep(500 * time.Millisecond)

	// Stop server to commit DB buffers
	if serverCmd.Process != nil {
		_ = serverCmd.Process.Kill()
		_ = serverCmd.Wait()
		serverCmd.Process = nil
	}

	printlnF("\n================================================================================")
	printlnF(" COMMENCING FORENSIC SCAN OF SERVER ARTIFACTS & TRAFFIC")
	printlnF("================================================================================")

	scanFiles := []string{dbPath, logPath}
	walPath := dbPath + "-wal"
	shmPath := dbPath + "-shm"
	if _, err := os.Stat(walPath); err == nil {
		scanFiles = append(scanFiles, walPath)
	}
	if _, err := os.Stat(shmPath); err == nil {
		scanFiles = append(scanFiles, shmPath)
	}
	_ = filepath.Walk(mediaPath, func(path string, info os.FileInfo, err error) error {
		if err == nil && info != nil && !info.IsDir() {
			scanFiles = append(scanFiles, path)
		}
		return nil
	})

	printF("[*] Files to scan (%d):\n", len(scanFiles))
	for _, f := range scanFiles {
		fi, _ := os.Stat(f)
		size := int64(0)
		if fi != nil {
			size = fi.Size()
		}
		printF("    - %s (%d bytes)\n", f, size)
	}

	// -------------------------------------------------------------------------
	// Category 1: Plaintext Markers in Storage/Logs/Env
	// -------------------------------------------------------------------------
	cat1 := AuditCategoryResult{Name: "1. Plaintext Markers in Storage / Logs / Process Env", Passed: true}
	markerTargets := []struct {
		Label string
		Bytes []byte
	}{
		{Label: "English Text Marker", Bytes: []byte(engMarker)},
		{Label: "Persian Text Marker", Bytes: []byte(faMarker)},
	}

	for _, target := range markerTargets {
		for _, fpath := range scanFiles {
			offsets := findByteOffsets(fpath, target.Bytes)
			for _, off := range offsets {
				cat1.Passed = false
				cat1.Findings = append(cat1.Findings,
					fmt.Sprintf("%s found unencrypted in %s at byte offset 0x%X (%d)", target.Label, fpath, off, off))
			}
		}
		for _, envLine := range serverEnv {
			if strings.Contains(envLine, string(target.Bytes)) {
				cat1.Passed = false
				cat1.Findings = append(cat1.Findings,
					fmt.Sprintf("%s found in process environment variable: %s", target.Label, envLine[:strings.Index(envLine, "=")]))
			}
		}
	}

	// -------------------------------------------------------------------------
	// Category 2: Sensitive File Names in Storage/Logs/Env
	// -------------------------------------------------------------------------
	cat2 := AuditCategoryResult{Name: "2. Plaintext File Names in Storage / Logs / Process Env", Passed: true}
	fileNameTargets := []struct {
		Label string
		Bytes []byte
	}{
		{Label: "Photo File Name", Bytes: []byte(photoFileName)},
		{Label: "Voice Memo File Name", Bytes: []byte(voiceFileName)},
		{Label: "Confidential Document File Name", Bytes: []byte(docFileName)},
	}

	for _, target := range fileNameTargets {
		for _, fpath := range scanFiles {
			offsets := findByteOffsets(fpath, target.Bytes)
			for _, off := range offsets {
				cat2.Passed = false
				cat2.Findings = append(cat2.Findings,
					fmt.Sprintf("%s found unencrypted in %s at byte offset 0x%X (%d)", target.Label, fpath, off, off))
			}
		}
		for _, envLine := range serverEnv {
			if strings.Contains(envLine, string(target.Bytes)) {
				cat2.Passed = false
				cat2.Findings = append(cat2.Findings,
					fmt.Sprintf("%s found in process environment variable: %s", target.Label, envLine[:strings.Index(envLine, "=")]))
			}
		}
	}

	// -------------------------------------------------------------------------
	// Category 3: Private Keys / Vault Keys / Media Keys in Storage/Logs/Env
	// -------------------------------------------------------------------------
	cat3 := AuditCategoryResult{Name: "3. Private / Vault / Media Keys in Storage / Logs / Process Env", Passed: true}
	keyTargets := []struct {
		Label string
		Raw   []byte
	}{
		{Label: "Alice Identity Private Key (Seed)", Raw: aliceIdentSK.Seed()},
		{Label: "Bob Identity Private Key (Seed)", Raw: bobIdentSK.Seed()},
		{Label: "Alice Vault Key", Raw: aliceVaultKey},
		{Label: "Bob Vault Key", Raw: bobVaultKey},
		{Label: "Photo Media Key", Raw: photoMediaKey},
		{Label: "Voice Media Key", Raw: voiceMediaKey},
		{Label: "Document Media Key", Raw: docMediaKey},
	}

	for _, target := range keyTargets {
		patterns := [][]byte{
			target.Raw,
			[]byte(hex.EncodeToString(target.Raw)),
			[]byte(base64.StdEncoding.EncodeToString(target.Raw)),
			[]byte(base64.RawStdEncoding.EncodeToString(target.Raw)),
			[]byte(base64.URLEncoding.EncodeToString(target.Raw)),
			[]byte(base64.RawURLEncoding.EncodeToString(target.Raw)),
		}

		for _, pat := range patterns {
			if len(pat) < 16 {
				continue
			}
			for _, fpath := range scanFiles {
				offsets := findByteOffsets(fpath, pat)
				for _, off := range offsets {
					cat3.Passed = false
					cat3.Findings = append(cat3.Findings,
						fmt.Sprintf("%s found in %s at byte offset 0x%X (%d)", target.Label, fpath, off, off))
				}
			}
			for _, envLine := range serverEnv {
				if bytes.Contains([]byte(envLine), pat) {
					cat3.Passed = false
					cat3.Findings = append(cat3.Findings,
						fmt.Sprintf("%s found in process environment variable", target.Label))
				}
			}
		}
	}

	// -------------------------------------------------------------------------
	// Category 4: Content Decryptable using Server IP_HASH_SECRET
	// -------------------------------------------------------------------------
	cat4 := AuditCategoryResult{Name: "4. Content Decryptable using Server IP_HASH_SECRET (Data-at-Rest Leak)", Passed: true}
	serverAtRestKey := sha256.Sum256(append([]byte("rootinbox:message_encryption_at_rest:"), []byte(ipHashSecret)...))

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		cat4.Passed = false
		cat4.Findings = append(cat4.Findings, fmt.Sprintf("Failed to open SQLite database: %v", err))
	} else {
		defer db.Close()
		_, _ = db.Exec("PRAGMA wal_checkpoint(TRUNCATE);")
		rows, err := db.Query("SELECT id, conversation_id, content FROM group_messages")
		if err != nil {
			cat4.Passed = false
			cat4.Findings = append(cat4.Findings, fmt.Sprintf("Failed to query group_messages: %v", err))
		} else {
			defer rows.Close()
			rowCount := 0
			for rows.Next() {
				rowCount++
				var msgID, cID, encContent string
				if err := rows.Scan(&msgID, &cID, &encContent); err != nil {
					continue
				}

				if strings.HasPrefix(encContent, "enc:v1:") {
					decrypted, err := decryptAtRest(encContent, cID, serverAtRestKey)
					if err == nil {
						decStr := string(decrypted)
						var leakTypes []string
						if strings.Contains(decStr, engMarker) {
							leakTypes = append(leakTypes, "English Text Marker")
						}
						if strings.Contains(decStr, faMarker) {
							leakTypes = append(leakTypes, "Persian Text Marker")
						}
						if strings.Contains(decStr, photoFileName) {
							leakTypes = append(leakTypes, "Photo File Name")
						}
						if strings.Contains(decStr, voiceFileName) {
							leakTypes = append(leakTypes, "Voice Memo File Name")
						}
						if strings.Contains(decStr, docFileName) {
							leakTypes = append(leakTypes, "Confidential Document File Name")
						}
						if strings.Contains(decStr, hex.EncodeToString(photoMediaKey)) {
							leakTypes = append(leakTypes, "Photo Media Key")
						}
						if strings.Contains(decStr, hex.EncodeToString(voiceMediaKey)) {
							leakTypes = append(leakTypes, "Voice Media Key")
						}
						if strings.Contains(decStr, hex.EncodeToString(docMediaKey)) {
							leakTypes = append(leakTypes, "Document Media Key")
						}

						if len(leakTypes) > 0 {
							cat4.Passed = false
							cat4.Findings = append(cat4.Findings,
								fmt.Sprintf("DB row group_messages[id='%s', conv='%s'] decrypted using IP_HASH_SECRET! Revealed: %s",
									msgID, cID, strings.Join(leakTypes, ", ")))
						}
					}
				}
			}
			printF("[*] Scanned %d group_messages rows for IP_HASH_SECRET decryptability\n", rowCount)
		}
	}

	// -------------------------------------------------------------------------
	// Category 5: Plaintext at the Server Boundary (A2)
	// -------------------------------------------------------------------------
	var cat5Targets []TargetPattern
	cat5Targets = append(cat5Targets, NewTargetPattern("English Text Marker", []byte(engMarker)))
	cat5Targets = append(cat5Targets, NewTargetPattern("Persian Text Marker", []byte(faMarker)))
	cat5Targets = append(cat5Targets, NewTargetPattern("Photo File Name", []byte(photoFileName)))
	cat5Targets = append(cat5Targets, NewTargetPattern("Voice File Name", []byte(voiceFileName)))
	cat5Targets = append(cat5Targets, NewTargetPattern("Document File Name", []byte(docFileName)))
	cat5Targets = append(cat5Targets, NewTargetPattern("Photo Media Key", photoMediaKey))
	cat5Targets = append(cat5Targets, NewTargetPattern("Voice Media Key", voiceMediaKey))
	cat5Targets = append(cat5Targets, NewTargetPattern("Document Media Key", docMediaKey))
	cat5Targets = append(cat5Targets, NewTargetPattern("Alice Identity Private Key (Seed)", aliceIdentSK.Seed()))
	cat5Targets = append(cat5Targets, NewTargetPattern("Bob Identity Private Key (Seed)", bobIdentSK.Seed()))
	cat5Targets = append(cat5Targets, NewTargetPattern("Alice Vault Key", aliceVaultKey))
	cat5Targets = append(cat5Targets, NewTargetPattern("Bob Vault Key", bobVaultKey))

	cat5 := RunCategory5Scan(traffic, cat5Targets)

	// -------------------------------------------------------------------------
	// Category 6: Key Material Reachable by Server (A2)
	// -------------------------------------------------------------------------
	cat6 := RunCategory6Scan(serverEnv, dbPath, mediaPath)

	// -------------------------------------------------------------------------
	// Final Report Generation
	// -------------------------------------------------------------------------
	printlnF("\n================================================================================")
	printlnF(" AUDIT RESULTS BY CATEGORY")
	printlnF("================================================================================")

	categories := []*AuditCategoryResult{&cat1, &cat2, &cat3, &cat4, &cat5, &cat6}
	allPassed := true
	unexpectedFailure := false

	for idx, cat := range categories {
		catNum := idx + 1
		status := "PASS"
		if !cat.Passed {
			status = "FAIL"
			allPassed = false
			// Categories 1, 2, 3 are expected to pass even in baseline mode
			if catNum <= 3 {
				unexpectedFailure = true
			}
		}
		printF("\n[%s] %s\n", status, cat.Name)
		if len(cat.Findings) == 0 {
			printlnF("    (Zero leaks detected)")
		} else {
			for _, f := range cat.Findings {
				printF("    - EVIDENCE: %s\n", f)
			}
		}
	}

	printlnF("\n================================================================================")
	if mode == "require-pass" {
		if allPassed {
			printlnF(" OVERALL ZERO-KNOWLEDGE STATUS: PASS (Complete zero-knowledge client)")
			printlnF("================================================================================")
			finish(0)
		} else {
			printlnF(" OVERALL ZERO-KNOWLEDGE STATUS: FAIL (Blocking)")
			printlnF(" REASON: One or more audit categories failed in require-pass mode.")
			printlnF("================================================================================")
			finish(1)
		}
	} else {
		// Baseline mode (report only for known baseline failures 4, 5, 6)
		if unexpectedFailure {
			printlnF(" OVERALL ZERO-KNOWLEDGE STATUS: REGRESSION FAIL (Unexpected failure in Cat 1-3)")
			printlnF(" REASON: Sensitive data or key material leaked into unencrypted disk storage or logs.")
			printlnF("================================================================================")
			finish(1)
		}
		if allPassed {
			printlnF(" OVERALL ZERO-KNOWLEDGE STATUS: PASS (All categories passed)")
			printlnF("================================================================================")
			finish(0)
		}

		printlnF(" OVERALL ZERO-KNOWLEDGE STATUS: BASELINE RECORDED (Report Only)")
		printlnF(" EXPECTED BASELINE FAILURES: Category 4 (at-rest encryption), Category 5 (server boundary),")
		printlnF("                            Category 6 (server-reachable keys).")
		printlnF(" Categories 1-3 PASSED cleanly (no unencrypted storage/log leaks).")
		printlnF("================================================================================")
		finish(0)
	}
}

type UserSession struct {
	Username     string
	DisplayName  string
	UserID       string
	SessionID    string
	Token        string
	IdentityHash string
}

func registerUser(serverURL, username, displayName string, identPK ed25519.PublicKey, identSK ed25519.PrivateKey, sessPK [32]byte) (*UserSession, error) {
	expiresAt := time.Now().Unix() + 86400
	var identPK32 [32]byte
	copy(identPK32[:], identPK)

	identHash := crypto.IdentityHash(identPK32)
	sig := crypto.SignSessionKey(identSK, crypto.CryptoSuiteV1, sessPK, expiresAt, identHash)

	wire := crypto.EncodeRegistration(identPK32, sessPK, sig, crypto.CryptoSuiteV1, expiresAt)

	regURL := fmt.Sprintf("%s/api/v1/auth/register?username=%s&display_name=%s",
		serverURL, url.QueryEscape(username), url.QueryEscape(displayName))

	req, err := http.NewRequest(http.MethodPost, regURL, bytes.NewReader(wire[:]))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/octet-stream")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(body))
	}

	var res struct {
		Data struct {
			UserID       string `json:"user_id"`
			SessionID    string `json:"session_id"`
			SessionToken string `json:"session_token"`
			IdentityHash string `json:"identity_hash"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return nil, err
	}

	return &UserSession{
		Username:     username,
		DisplayName:  displayName,
		UserID:       res.Data.UserID,
		SessionID:    res.Data.SessionID,
		Token:        res.Data.SessionToken,
		IdentityHash: res.Data.IdentityHash,
	}, nil
}

func createConversation(serverURL, token, peerIdentityHash string) (string, error) {
	reqBody, _ := json.Marshal(map[string]string{
		"peer_identity_hash": peerIdentityHash,
	})
	req, err := http.NewRequest(http.MethodPost, serverURL+"/api/v1/conversations", bytes.NewReader(reqBody))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var res struct {
		Data struct {
			ID             string `json:"id"`
			ConversationID string `json:"conversation_id"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return "", err
	}
	if res.Data.ID != "" {
		return res.Data.ID, nil
	}
	return res.Data.ConversationID, nil
}

func sendMessage(serverURL, token, convID, content string) error {
	reqBody, _ := json.Marshal(map[string]string{
		"content": content,
	})
	req, err := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/v1/conversations/%s/messages", serverURL, convID), bytes.NewReader(reqBody))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, string(b))
	}
	return nil
}

func uploadMediaFile(serverURL, token, fileID string, data []byte) error {
	chunkHash := sha256.Sum256(data)
	initBody, _ := json.Marshal(map[string]interface{}{
		"file_id":      fileID,
		"total_chunks": 1,
		"token_hash":   hex.EncodeToString(chunkHash[:]),
	})
	req, err := http.NewRequest(http.MethodPost, serverURL+"/api/v1/media/init", bytes.NewReader(initBody))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()

	chunkURL := fmt.Sprintf("%s/api/v1/media/upload/%s/0", serverURL, fileID)
	req2, err := http.NewRequest(http.MethodPut, chunkURL, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req2.Header.Set("Authorization", "Bearer "+token)
	req2.Header.Set("X-Chunk-Hash", hex.EncodeToString(chunkHash[:]))
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		return err
	}
	resp2.Body.Close()

	manifestHash := sha256.Sum256([]byte(fmt.Sprintf("%s:0:%s", fileID, hex.EncodeToString(chunkHash[:]))))
	finalBody, _ := json.Marshal(map[string]string{
		"file_manifest_hash": hex.EncodeToString(manifestHash[:]),
	})
	req3, err := http.NewRequest(http.MethodPost, fmt.Sprintf("%s/api/v1/media/finalize/%s", serverURL, fileID), bytes.NewReader(finalBody))
	if err != nil {
		return err
	}
	req3.Header.Set("Content-Type", "application/json")
	req3.Header.Set("Authorization", "Bearer "+token)
	resp3, err := http.DefaultClient.Do(req3)
	if err != nil {
		return err
	}
	resp3.Body.Close()
	return nil
}

func exchangeCallSignalling(serverURL, wsURL string, alice, bob *UserSession) error {
	aliceTicket, err := getWSTicket(serverURL, alice.Token)
	if err != nil {
		return err
	}
	bobTicket, err := getWSTicket(serverURL, bob.Token)
	if err != nil {
		return err
	}

	aliceWS, _, err := websocket.DefaultDialer.Dial(fmt.Sprintf("%s/api/v1/ws?ticket=%s", wsURL, aliceTicket), nil)
	if err != nil {
		return err
	}
	defer aliceWS.Close()

	bobWS, _, err := websocket.DefaultDialer.Dial(fmt.Sprintf("%s/api/v1/ws?ticket=%s", wsURL, bobTicket), nil)
	if err != nil {
		return err
	}
	defer bobWS.Close()

	callID := "call-audit-" + uuid.New().String()[:8]
	offerPayload := base64.StdEncoding.EncodeToString([]byte("CONFIDENTIAL_WEBRTC_SDP_OFFER_AUDIO_VIDEO_ZK_AUDIT"))
	inviteFrame := map[string]interface{}{
		"type":       "call.invite",
		"call_id":    callID,
		"routing_id": bob.UserID,
		"payload":    offerPayload,
	}
	if err := aliceWS.WriteJSON(inviteFrame); err != nil {
		return err
	}

	time.Sleep(100 * time.Millisecond)

	acceptPayload := base64.StdEncoding.EncodeToString([]byte("CONFIDENTIAL_WEBRTC_SDP_ANSWER_ZK_AUDIT"))
	acceptFrame := map[string]interface{}{
		"type":       "call.accept",
		"call_id":    callID,
		"routing_id": alice.UserID,
		"payload":    acceptPayload,
	}
	_ = bobWS.WriteJSON(acceptFrame)

	time.Sleep(100 * time.Millisecond)
	return nil
}

func getWSTicket(serverURL, token string) (string, error) {
	req, err := http.NewRequest(http.MethodGet, serverURL+"/api/v1/auth/ws-ticket", nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var res struct {
		Data struct {
			Ticket string `json:"ticket"`
		} `json:"data"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return "", err
	}
	return res.Data.Ticket, nil
}

func decryptAtRest(encContent, convID string, key [32]byte) ([]byte, error) {
	if !strings.HasPrefix(encContent, "enc:v1:") {
		return nil, fmt.Errorf("not encrypted with enc:v1:")
	}
	trimmed := strings.TrimPrefix(encContent, "enc:v1:")
	parts := strings.SplitN(trimmed, ":", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("invalid enc:v1 format")
	}
	ivBytes, err := base64.StdEncoding.DecodeString(parts[0])
	if err != nil || len(ivBytes) != 12 {
		return nil, fmt.Errorf("invalid iv")
	}
	ciphertext, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return nil, err
	}
	var iv [12]byte
	copy(iv[:], ivBytes)
	return crypto.Decrypt(key, iv, ciphertext, []byte(convID))
}

func findByteOffsets(fpath string, pattern []byte) []int64 {
	content, err := os.ReadFile(fpath)
	if err != nil || len(pattern) == 0 {
		return nil
	}
	var offsets []int64
	start := 0
	for {
		idx := bytes.Index(content[start:], pattern)
		if idx == -1 {
			break
		}
		offsets = append(offsets, int64(start+idx))
		start += idx + len(pattern)
	}
	return offsets
}

func getFreePort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func waitForReady(serverURL string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, err := http.Get(serverURL + "/health/ready")
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("server timed out after %v", timeout)
}

func generateEd25519Raw() ([32]byte, [64]byte) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	var pub32 [32]byte
	var priv64 [64]byte
	copy(pub32[:], pub)
	copy(priv64[:], priv)
	return pub32, priv64
}

func printFileTail(path string, lines int) {
	content, err := os.ReadFile(path)
	if err != nil {
		return
	}
	allLines := strings.Split(string(content), "\n")
	start := 0
	if len(allLines) > lines {
		start = len(allLines) - lines
	}
	fmt.Printf("--- TAIL OF %s ---\n", path)
	for _, l := range allLines[start:] {
		fmt.Println(l)
	}
}
