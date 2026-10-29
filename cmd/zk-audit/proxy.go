package main

import (
	"bytes"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"sync"

	"github.com/gorilla/websocket"
)

// RecordedHTTPRequest represents an intercepted HTTP request sent to the server.
type RecordedHTTPRequest struct {
	Method string
	Path   string
	Query  string
	Header http.Header
	Body   []byte
}

// RecordedWSFrame represents an intercepted WebSocket frame.
type RecordedWSFrame struct {
	Direction string // "client->server" or "server->client"
	Payload   []byte
}

// RecordedTraffic stores all intercepted HTTP requests and WebSocket frames.
type RecordedTraffic struct {
	mu              sync.Mutex
	HTTPRequests    []RecordedHTTPRequest
	WebSocketFrames []RecordedWSFrame
}

func (rt *RecordedTraffic) AddHTTPRequest(req RecordedHTTPRequest) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	rt.HTTPRequests = append(rt.HTTPRequests, req)
}

func (rt *RecordedTraffic) AddWSFrame(direction string, payload []byte) {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	copied := make([]byte, len(payload))
	copy(copied, payload)
	rt.WebSocketFrames = append(rt.WebSocketFrames, RecordedWSFrame{
		Direction: direction,
		Payload:   copied,
	})
}

func (rt *RecordedTraffic) GetHTTPRequests() []RecordedHTTPRequest {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	out := make([]RecordedHTTPRequest, len(rt.HTTPRequests))
	copy(out, rt.HTTPRequests)
	return out
}

func (rt *RecordedTraffic) GetWSFrames() []RecordedWSFrame {
	rt.mu.Lock()
	defer rt.mu.Unlock()
	out := make([]RecordedWSFrame, len(rt.WebSocketFrames))
	copy(out, rt.WebSocketFrames)
	return out
}

// RecordingProxy is a test-only reverse proxy that forwards traffic to the backend server
// while recording every HTTP request body and WebSocket frame.
type RecordingProxy struct {
	serverURL *url.URL
	traffic   *RecordedTraffic
	upgrader  websocket.Upgrader
	listener  net.Listener
	httpSrv   *http.Server
	Port      int
}

// NewRecordingProxy creates a new recording proxy listening on a free localhost port.
func NewRecordingProxy(targetServerURL string, traffic *RecordedTraffic) (*RecordingProxy, error) {
	u, err := url.Parse(targetServerURL)
	if err != nil {
		return nil, fmt.Errorf("invalid target server URL: %w", err)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("failed to listen for proxy: %w", err)
	}

	port := listener.Addr().(*net.TCPAddr).Port

	rp := &RecordingProxy{
		serverURL: u,
		traffic:   traffic,
		listener:  listener,
		Port:      port,
		upgrader: websocket.Upgrader{
			CheckOrigin: func(r *http.Request) bool { return true },
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/", rp.handleTraffic)

	rp.httpSrv = &http.Server{
		Handler: mux,
	}

	go func() {
		_ = rp.httpSrv.Serve(listener)
	}()

	return rp, nil
}

func (rp *RecordingProxy) Close() error {
	return rp.httpSrv.Close()
}

func (rp *RecordingProxy) URL() string {
	return fmt.Sprintf("http://127.0.0.1:%d", rp.Port)
}

func (rp *RecordingProxy) WSURL() string {
	return fmt.Sprintf("ws://127.0.0.1:%d", rp.Port)
}

func (rp *RecordingProxy) handleTraffic(w http.ResponseWriter, r *http.Request) {
	// 1. Check for WebSocket upgrade
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		rp.handleWebSocket(w, r)
		return
	}

	// 2. Standard HTTP Request
	var bodyBytes []byte
	if r.Body != nil {
		var err error
		bodyBytes, err = io.ReadAll(r.Body)
		if err == nil {
			r.Body = io.NopCloser(bytes.NewReader(bodyBytes))
		}
	}

	// Record request
	rp.traffic.AddHTTPRequest(RecordedHTTPRequest{
		Method: r.Method,
		Path:   r.URL.Path,
		Query:  r.URL.RawQuery,
		Header: r.Header.Clone(),
		Body:   bodyBytes,
	})

	// Forward using SingleHostReverseProxy
	proxy := httputil.NewSingleHostReverseProxy(rp.serverURL)
	proxy.ServeHTTP(w, r)
}

func (rp *RecordingProxy) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Upgrade client connection
	clientConn, err := rp.upgrader.Upgrade(w, r, nil)
	if err != nil {
		http.Error(w, fmt.Sprintf("Proxy WS upgrade failed: %v", err), http.StatusInternalServerError)
		return
	}
	defer clientConn.Close()

	// Dial backend server WebSocket
	targetWSURL := fmt.Sprintf("ws://%s%s", rp.serverURL.Host, r.RequestURI)
	dialer := websocket.DefaultDialer
	passHeaders := http.Header{}
	for k, vv := range r.Header {
		if strings.EqualFold(k, "Upgrade") || strings.EqualFold(k, "Connection") ||
			strings.EqualFold(k, "Sec-WebSocket-Key") || strings.EqualFold(k, "Sec-WebSocket-Version") ||
			strings.EqualFold(k, "Sec-WebSocket-Extensions") {
			continue
		}
		for _, v := range vv {
			passHeaders.Add(k, v)
		}
	}

	serverConn, _, err := dialer.Dial(targetWSURL, passHeaders)
	if err != nil {
		_ = clientConn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "Failed to connect to backend WS"))
		return
	}
	defer serverConn.Close()

	var wg sync.WaitGroup
	wg.Add(2)

	// Pump Client -> Server
	go func() {
		defer wg.Done()
		for {
			msgType, data, err := clientConn.ReadMessage()
			if err != nil {
				_ = serverConn.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
				break
			}
			rp.traffic.AddWSFrame("client->server", data)
			if err := serverConn.WriteMessage(msgType, data); err != nil {
				break
			}
		}
	}()

	// Pump Server -> Client
	go func() {
		defer wg.Done()
		for {
			msgType, data, err := serverConn.ReadMessage()
			if err != nil {
				_ = clientConn.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
				break
			}
			rp.traffic.AddWSFrame("server->client", data)
			if err := clientConn.WriteMessage(msgType, data); err != nil {
				break
			}
		}
	}()

	wg.Wait()
}
