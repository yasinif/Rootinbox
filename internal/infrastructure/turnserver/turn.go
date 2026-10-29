package turnserver

import (
	"context"
	"crypto/hmac"
	"crypto/sha1" // #nosec G505 — HMAC-SHA1 is mandated by the TURN REST API convention.
	"encoding/base64"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"strings"

	"github.com/pion/turn/v4"
)

// Worker implements domain.Worker for the embedded STUN/TURN server.
// RFC-0008 §5.1: Single-Binary STUN/TURN Embedding.
// RFC-0008 §5.2: Immutable Keyring TURN Secret Lifecycle.
type Worker struct {
	listenAddr     string
	realm          string
	activeSecret   string
	previousSecret string
	relayIP        net.IP
	minPort        uint16
	maxPort        uint16
	logger         *slog.Logger
	readyCh        chan struct{}
	actualAddr     string
}

// New creates a new TURN server Worker with configurable relay IP and port bounds.
func New(listenAddr, realm, activeSecret, previousSecret string, relayIP net.IP, minPort, maxPort uint16, logger *slog.Logger) *Worker {
	if relayIP == nil {
		relayIP = net.ParseIP("127.0.0.1")
	}
	return &Worker{
		listenAddr:     listenAddr,
		realm:          realm,
		activeSecret:   activeSecret,
		previousSecret: previousSecret,
		relayIP:        relayIP,
		minPort:        minPort,
		maxPort:        maxPort,
		logger:         logger,
		readyCh:        make(chan struct{}),
	}
}

// Addr returns the bound address of the TURN listener once ready.
func (w *Worker) Addr() string {
	<-w.readyCh
	return w.actualAddr
}

// Start runs the TURN server until the context is cancelled.
// Implements domain.Worker.
func (w *Worker) Start(ctx context.Context) error {
	udpListener, err := net.ListenPacket("udp4", w.listenAddr)
	if err != nil {
		return fmt.Errorf("turn: failed to listen on %s: %w", w.listenAddr, err)
	}

	w.logger.Info("turn server starting", "addr", w.listenAddr, "realm", w.realm, "relay_ip", w.relayIP.String(), "min_port", w.minPort, "max_port", w.maxPort)

	var relayGenerator turn.RelayAddressGenerator
	if w.minPort > 0 && w.maxPort > 0 {
		relayGenerator = &turn.RelayAddressGeneratorPortRange{
			RelayAddress: w.relayIP,
			Address:      "0.0.0.0",
			MinPort:      w.minPort,
			MaxPort:      w.maxPort,
		}
	} else {
		relayGenerator = &turn.RelayAddressGeneratorStatic{
			RelayAddress: w.relayIP,
			Address:      "0.0.0.0",
		}
	}

	server, err := turn.NewServer(turn.ServerConfig{
		Realm: w.realm,
		// RFC-0008 §5.2: Verify credentials against EITHER keyring secret.
		// HMAC-SHA1 is mandated by the TURN REST API convention — do NOT change.
		AuthHandler: func(username, realm string, srcAddr net.Addr) ([]byte, bool) {
			return w.authHandler(username, realm)
		},
		PacketConnConfigs: []turn.PacketConnConfig{
			{
				PacketConn:            udpListener,
				RelayAddressGenerator: relayGenerator,
			},
		},
	})
	if err != nil {
		udpListener.Close()
		return fmt.Errorf("turn: failed to create server: %w", err)
	}

	w.actualAddr = udpListener.LocalAddr().String()
	close(w.readyCh)

	w.logger.Info("turn server started", "bound_addr", w.actualAddr)

	// Wait for context cancellation.
	<-ctx.Done()

	w.logger.Info("turn server shutting down")
	if err := server.Close(); err != nil {
		w.logger.Error("turn server close error", "error", err)
	}

	return nil
}

// authHandler validates TURN credentials against the immutable keyring.
// RFC-0008 §5.2: Username = "{expiry_unix}:{Base64URL(identity_hash)}".
// Password = Base64(HMAC-SHA1(secret, username)).
// Accepts EITHER active or previous secret during rotation overlap.
// HMAC-SHA1 is mandated by the TURN REST API convention — do NOT "fix" to SHA-256.
func (w *Worker) authHandler(username, realm string) ([]byte, bool) {
	// Validate username format: must contain ":"
	parts := strings.SplitN(username, ":", 2)
	if len(parts) != 2 {
		w.logger.Warn("turn: invalid username format", "username", username)
		return nil, false
	}

	// Parse expiry from username to validate format.
	_, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		w.logger.Warn("turn: invalid expiry in username", "username", username)
		return nil, false
	}

	// Try active secret first, then previous secret.
	// #nosec G401 — HMAC-SHA1 is mandated by the TURN REST API convention.
	if key := w.computeKey(username, realm, w.activeSecret); key != nil {
		return key, true
	}
	if w.previousSecret != "" {
		if key := w.computeKey(username, realm, w.previousSecret); key != nil {
			return key, true
		}
	}

	w.logger.Warn("turn: auth failed", "username", username, "realm", realm)
	return nil, false
}

// computeKey computes the TURN long-term credential key.
// Returns the key for pion/turn's AuthHandler (MD5(username:realm:password)).
// #nosec G401 — HMAC-SHA1 is mandated by the TURN REST API convention.
func (w *Worker) computeKey(username, realm, secret string) []byte {
	// Compute password = Base64(HMAC-SHA1(secret, username)).
	mac := hmac.New(sha1.New, []byte(secret))
	mac.Write([]byte(username))
	password := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	// pion/turn expects MD5(username:realm:password) for long-term credential mechanism
	return turn.GenerateAuthKey(username, realm, password)
}
