package ws

import (
	"time"

	"github.com/gorilla/websocket"
)

const (
	// writeWait is the time allowed to write a message to the peer.
	writeWait = 10 * time.Second

	// pongWait is the read deadline after which the connection is considered dead.
	// RFC-0005 §8: Pong Deadline of 45 seconds.
	pongWait = 45 * time.Second

	// pingPeriod is the interval for sending ping frames.
	// RFC-0005 §8: Ping Interval exactly every 30 seconds.
	pingPeriod = 30 * time.Second

	// maxMessageSize is the maximum frame size.
	// RFC-0005 §5.2: 7,500,000 bytes (7.5 MB).
	maxMessageSize = 7_500_000
)

// Client represents a single WebSocket connection.
// RFC-0005 §9: Read Pump and Write Pump goroutine isolation.
type Client struct {
	hub       *Hub
	conn      *websocket.Conn
	userID    string
	sessionID string
	send      chan []byte // Buffered channel for outbound messages.
}

// NewClient creates a new Client.
func NewClient(hub *Hub, conn *websocket.Conn, userID, sessionID string, sendBufferSize int) *Client {
	return &Client{
		hub:       hub,
		conn:      conn,
		userID:    userID,
		sessionID: sessionID,
		send:      make(chan []byte, sendBufferSize),
	}
}

// CloseWithCode writes a formatted close frame and closes the connection.
func (c *Client) CloseWithCode(code int, reason string) {
	_ = c.conn.WriteControl(
		websocket.CloseMessage,
		websocket.FormatCloseMessage(code, reason),
		time.Now().Add(writeWait),
	)
	_ = c.conn.Close()
}

// ReadPump runs in a dedicated goroutine, reading frames from the WebSocket.
// RFC-0005 §9: A single dedicated Goroutine per connection that only reads.
// The messageHandler callback processes each incoming message.
func (c *Client) ReadPump(messageHandler func(client *Client, data []byte)) {
	defer func() {
		c.hub.Unregister(c)
		c.conn.Close()
	}()

	c.conn.SetReadLimit(maxMessageSize)
	c.conn.SetReadDeadline(time.Now().Add(pongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			break
		}
		messageHandler(c, message)
	}
}

// WritePump runs in a dedicated goroutine, writing frames to the WebSocket.
// RFC-0005 §9: A single dedicated Goroutine per connection that writes.
// All outbound data MUST be passed to this pump via the send channel.
func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// Hub closed the channel.
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)

			if err := w.Close(); err != nil {
				return
			}

		case <-ticker.C:
			// RFC-0005 §8: Send Ping frame every 30 seconds.
			c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}
