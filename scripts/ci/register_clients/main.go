package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"rootinbox/pkg/crypto"
)

func main() {
	baseURL := flag.String("url", "http://127.0.0.1:8995", "Server base URL")
	count := flag.Int("count", 10, "Number of clients to register")
	connectWS := flag.Bool("ws", true, "Connect WebSocket for each client")
	holdSec := flag.Int("hold", 3, "Hold connections for N seconds")
	flag.Parse()

	wsBase := strings.Replace(strings.Replace(*baseURL, "http://", "ws://", 1), "https://", "wss://", 1)
	wsURL := wsBase + "/api/v1/ws"

	var wsConns []*websocket.Conn
	defer func() {
		for _, ws := range wsConns {
			_ = ws.Close()
		}
	}()

	registered := 0
	for i := 1; i <= *count; i++ {
		identPK, identSK, _ := ed25519.GenerateKey(rand.Reader)
		var sessPK [32]byte
		_, _ = rand.Read(sessPK[:])
		expiresAt := time.Now().Unix() + 86400
		var identPK32 [32]byte
		copy(identPK32[:], identPK)

		identHash := crypto.IdentityHash(identPK32)
		sig := crypto.SignSessionKey(identSK, crypto.CryptoSuiteV1, sessPK, expiresAt, identHash)
		wire := crypto.EncodeRegistration(identPK32, sessPK, sig, crypto.CryptoSuiteV1, expiresAt)

		username := fmt.Sprintf("drill_user_%d_%d", time.Now().Unix(), i)
		displayName := fmt.Sprintf("Drill User %d", i)
		regURL := fmt.Sprintf("%s/api/v1/auth/register?username=%s&display_name=%s",
			*baseURL, url.QueryEscape(username), url.QueryEscape(displayName))

		req, err := http.NewRequest(http.MethodPost, regURL, bytes.NewReader(wire[:]))
		if err != nil {
			fmt.Fprintf(os.Stderr, "failed req %d: %v\n", i, err)
			continue
		}
		req.Header.Set("Content-Type", "application/octet-stream")

		resp, err := http.DefaultClient.Do(req)
		if err != nil || resp.StatusCode != http.StatusCreated {
			status := 0
			if resp != nil {
				status = resp.StatusCode
			}
			fmt.Fprintf(os.Stderr, "failed register %d: status=%d err=%v\n", i, status, err)
			continue
		}

		var res struct {
			Data struct {
				SessionToken string `json:"session_token"`
			} `json:"data"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&res)
		resp.Body.Close()
		registered++

		if *connectWS && res.Data.SessionToken != "" {
			h := http.Header{}
			h.Set("Authorization", "Bearer "+res.Data.SessionToken)
			ws, _, err := websocket.DefaultDialer.Dial(wsURL, h)
			if err == nil {
				wsConns = append(wsConns, ws)
			}
		}
	}

	fmt.Printf("REGISTERED=%d WS=%d\n", registered, len(wsConns))
	if *holdSec > 0 {
		time.Sleep(time.Duration(*holdSec) * time.Second)
	}
}
