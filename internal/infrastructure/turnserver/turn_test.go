package turnserver_test

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha1" // #nosec G505
	"encoding/base64"
	"fmt"
	"io"
	"log/slog"
	"net"
	"testing"
	"time"

	"github.com/pion/turn/v4"

	"rootinbox/internal/infrastructure/turnserver"
)

func generateCredentials(usernamePrefix, secret string) (username, password string) {
	expiry := time.Now().Add(1 * time.Hour).Unix()
	username = fmt.Sprintf("%d:%s", expiry, usernamePrefix)
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	password = base64.StdEncoding.EncodeToString(mac.Sum(nil))
	return username, password
}

func TestTURNServer_RelayAllocationAndDataExchange(t *testing.T) {
	activeSecret := "test_active_secret_32_bytes_long_12345"
	previousSecret := "test_prev_secret_32_bytes_long_123456"
	realm := "rootinbox.test"
	relayIP := net.ParseIP("127.0.0.1")
	var minPort uint16 = 50020
	var maxPort uint16 = 50040

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	worker := turnserver.New("127.0.0.1:0", realm, activeSecret, previousSecret, relayIP, minPort, maxPort, logger)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	errCh := make(chan error, 1)
	go func() {
		errCh <- worker.Start(ctx)
	}()

	serverAddr := worker.Addr()
	if serverAddr == "" {
		t.Fatal("turn server did not report bound address")
	}

	// --- Setup Client A (active secret) ---
	userA, passA := generateCredentials("client_a_hash", activeSecret)
	connA, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("client A net.ListenPacket failed: %v", err)
	}
	defer connA.Close()

	clientA, err := turn.NewClient(&turn.ClientConfig{
		TURNServerAddr: serverAddr,
		Conn:           connA,
		Username:       userA,
		Password:       passA,
		Realm:          realm,
	})
	if err != nil {
		t.Fatalf("client A NewClient failed: %v", err)
	}
	defer clientA.Close()

	if err := clientA.Listen(); err != nil {
		t.Fatalf("client A Listen failed: %v", err)
	}

	relayConnA, err := clientA.Allocate()
	if err != nil {
		t.Fatalf("client A Allocate failed: %v", err)
	}
	defer relayConnA.Close()

	// --- Setup Client B (active secret) ---
	userB, passB := generateCredentials("client_b_hash", activeSecret)
	connB, err := net.ListenPacket("udp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("client B net.ListenPacket failed: %v", err)
	}
	defer connB.Close()

	clientB, err := turn.NewClient(&turn.ClientConfig{
		TURNServerAddr: serverAddr,
		Conn:           connB,
		Username:       userB,
		Password:       passB,
		Realm:          realm,
	})
	if err != nil {
		t.Fatalf("client B NewClient failed: %v", err)
	}
	defer clientB.Close()

	if err := clientB.Listen(); err != nil {
		t.Fatalf("client B Listen failed: %v", err)
	}

	relayConnB, err := clientB.Allocate()
	if err != nil {
		t.Fatalf("client B Allocate failed: %v", err)
	}
	defer relayConnB.Close()

	// --- Assert Relayed Addresses & Bounded Port Range ---
	addrA, ok := relayConnA.LocalAddr().(*net.UDPAddr)
	if !ok {
		t.Fatalf("relayConnA.LocalAddr() is not *net.UDPAddr, got %T", relayConnA.LocalAddr())
	}
	if addrA.IP.String() != relayIP.String() {
		t.Fatalf("relayConnA IP mismatch: expected %s, got %s", relayIP.String(), addrA.IP.String())
	}
	if addrA.IP.String() == "0.0.0.0" {
		t.Fatalf("relayConnA IP is unroutable 0.0.0.0")
	}
	if addrA.Port < int(minPort) || addrA.Port > int(maxPort) {
		t.Fatalf("relayConnA Port %d out of bounds [%d, %d]", addrA.Port, minPort, maxPort)
	}

	addrB, ok := relayConnB.LocalAddr().(*net.UDPAddr)
	if !ok {
		t.Fatalf("relayConnB.LocalAddr() is not *net.UDPAddr, got %T", relayConnB.LocalAddr())
	}
	if addrB.IP.String() != relayIP.String() {
		t.Fatalf("relayConnB IP mismatch: expected %s, got %s", relayIP.String(), addrB.IP.String())
	}
	if addrB.IP.String() == "0.0.0.0" {
		t.Fatalf("relayConnB IP is unroutable 0.0.0.0")
	}
	if addrB.Port < int(minPort) || addrB.Port > int(maxPort) {
		t.Fatalf("relayConnB Port %d out of bounds [%d, %d]", addrB.Port, minPort, maxPort)
	}

	// --- Create Permissions ---
	if err := clientA.CreatePermission(addrB); err != nil {
		t.Fatalf("client A CreatePermission failed: %v", err)
	}
	if err := clientB.CreatePermission(addrA); err != nil {
		t.Fatalf("client B CreatePermission failed: %v", err)
	}

	// --- Exchange Data: A -> B ---
	msgAtoB := []byte("ping from client A to client B over TURN relay")
	if _, err := relayConnA.WriteTo(msgAtoB, addrB); err != nil {
		t.Fatalf("relayConnA.WriteTo failed: %v", err)
	}

	buf := make([]byte, 1500)
	if err := relayConnB.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("relayConnB.SetReadDeadline failed: %v", err)
	}
	n, from, err := relayConnB.ReadFrom(buf)
	if err != nil {
		t.Fatalf("relayConnB.ReadFrom failed: %v", err)
	}
	if !bytes.Equal(buf[:n], msgAtoB) {
		t.Fatalf("relayConnB payload mismatch: expected %q, got %q", msgAtoB, buf[:n])
	}
	if from.String() != addrA.String() {
		t.Fatalf("relayConnB sender address mismatch: expected %s, got %s", addrA.String(), from.String())
	}

	// --- Exchange Data: B -> A ---
	msgBtoA := []byte("pong from client B to client A over TURN relay")
	if _, err := relayConnB.WriteTo(msgBtoA, addrA); err != nil {
		t.Fatalf("relayConnB.WriteTo failed: %v", err)
	}

	if err := relayConnA.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("relayConnA.SetReadDeadline failed: %v", err)
	}
	n, from, err = relayConnA.ReadFrom(buf)
	if err != nil {
		t.Fatalf("relayConnA.ReadFrom failed: %v", err)
	}
	if !bytes.Equal(buf[:n], msgBtoA) {
		t.Fatalf("relayConnA payload mismatch: expected %q, got %q", msgBtoA, buf[:n])
	}
	if from.String() != addrB.String() {
		t.Fatalf("relayConnA sender address mismatch: expected %s, got %s", addrB.String(), from.String())
	}

	// --- Clean Shutdown ---
	cancel()
	select {
	case err := <-errCh:
		if err != nil {
			t.Fatalf("turn server returned error on shutdown: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("turn server did not shut down in time")
	}
}
