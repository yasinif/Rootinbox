// Package ws implements the WebSocket transport layer.
// RFC-0005: WebSocket Protocol, Envelope Routing & Delivery Guarantees.
package ws

import (
	"encoding/json"
	"log/slog"
	"sync"

	"rootinbox/internal/domain"
)

// Hub manages active WebSocket client connections.
// Implements domain.MessageRouter for the atomic delivery decision (RFC-0005 §6.2).
// Implements domain.GroupBroadcaster for non-E2EE fan-out (Amendment RFC-0007-B).
// Thread-safe via mutex.
type Hub struct {
	mu      sync.RWMutex
	clients map[string]map[*Client]struct{} // userID -> set of *Client
	logger  *slog.Logger
}

// NewHub creates a new Hub.
func NewHub(logger *slog.Logger) *Hub {
	return &Hub{
		clients: make(map[string]map[*Client]struct{}),
		logger:  logger,
	}
}

// Register adds a client to the hub, supporting multi-device concurrent sessions.
func (h *Hub) Register(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.clients[client.userID] == nil {
		h.clients[client.userID] = make(map[*Client]struct{})
	}
	h.clients[client.userID][client] = struct{}{}
	h.logger.Info("ws client registered", "user_id", client.userID, "connections", len(h.clients[client.userID]))
}

// Unregister removes a client from the hub.
func (h *Hub) Unregister(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if conns, ok := h.clients[client.userID]; ok {
		delete(conns, client)
		if len(conns) == 0 {
			delete(h.clients, client.userID)
		}
		h.logger.Info("ws client unregistered", "user_id", client.userID)
	}
}

// Route attempts to deliver data to all online clients for a user.
// Returns true if delivered to at least one client.
// Implements domain.MessageRouter.
func (h *Hub) Route(userID string, data []byte) bool {
	h.mu.RLock()
	conns := h.clients[userID]
	targets := make([]*Client, 0, len(conns))
	for c := range conns {
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	if len(targets) == 0 {
		return false
	}

	delivered := false
	for _, client := range targets {
		select {
		case client.send <- data:
			delivered = true
		default:
			h.logger.Warn("ws client send channel full", "user_id", userID)
		}
	}
	return delivered
}

// RouteExcept delivers data to all online clients for a user EXCEPT the specified client.
// Used for multi-device fan-out so a user's other open devices receive outgoing messages.
func (h *Hub) RouteExcept(userID string, excludeClient *Client, data []byte) bool {
	h.mu.RLock()
	conns := h.clients[userID]
	targets := make([]*Client, 0, len(conns))
	for c := range conns {
		if c != excludeClient {
			targets = append(targets, c)
		}
	}
	h.mu.RUnlock()

	if len(targets) == 0 {
		return false
	}

	delivered := false
	for _, client := range targets {
		select {
		case client.send <- data:
			delivered = true
		default:
			h.logger.Warn("ws client send channel full during fanout", "user_id", userID)
		}
	}
	return delivered
}

// CloseAll closes all client connections. Used during shutdown.
func (h *Hub) CloseAll() {
	h.mu.Lock()
	defer h.mu.Unlock()

	for userID, conns := range h.clients {
		for client := range conns {
			close(client.send)
		}
		delete(h.clients, userID)
	}
	h.logger.Info("all ws clients closed")
}

// CloseSession terminates all WebSocket connections associated with a specific sessionID.
// Implements domain.SessionTerminator.
func (h *Hub) CloseSession(sessionID string, code int, reason string) {
	if sessionID == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()

	for userID, conns := range h.clients {
		for client := range conns {
			if client.sessionID == sessionID {
				client.CloseWithCode(code, reason)
				delete(conns, client)
				h.logger.Info("ws client session terminated", "user_id", userID, "session_id", sessionID, "code", code)
			}
		}
		if len(conns) == 0 {
			delete(h.clients, userID)
		}
	}
}

// BroadcastGroupMessage broadcasts a group message envelope to all specified online recipients.
func (h *Hub) BroadcastGroupMessage(recipientUserIDs []string, msg *domain.GroupMessage) {
	env := map[string]interface{}{
		"v":               1,
		"type":            domain.EnvelopeTypeGroupMsg,
		"request_id":      msg.ID,
		"conversation_id": msg.ConversationID,
		"sender_id":       msg.SenderID,
		"content":         msg.Content,
		"reply_to_id":     msg.ReplyToID,
		"edited_at":       msg.EditedAt,
		"deleted_at":      msg.DeletedAt,
		"created_at":      msg.CreatedAt,
		"server_id":       msg.ServerID,
	}
	data, err := json.Marshal(env)
	if err != nil {
		h.logger.Error("failed to marshal group message envelope", "error", err)
		return
	}
	for _, uid := range recipientUserIDs {
		h.Route(uid, data)
	}
}

// BroadcastGroupAction broadcasts a group action envelope to all specified online recipients.
func (h *Hub) BroadcastGroupAction(recipientUserIDs []string, action string, payload map[string]interface{}) {
	env := map[string]interface{}{
		"v":      1,
		"type":   "group.action",
		"action": action,
	}
	for k, v := range payload {
		env[k] = v
	}
	data, err := json.Marshal(env)
	if err != nil {
		h.logger.Error("failed to marshal group action envelope", "error", err)
		return
	}
	for _, uid := range recipientUserIDs {
		h.Route(uid, data)
	}
}

// IsOnline returns true if the user currently has at least one active WebSocket connection.
func (h *Hub) IsOnline(userID string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients[userID]) > 0
}

// IsUserOnline returns true if the user currently has at least one active WebSocket connection.
func (h *Hub) IsUserOnline(userID string) bool {
	return h.IsOnline(userID)
}

// BroadcastPresence broadcasts a user.presence frame to all active connections.
func (h *Hub) BroadcastPresence(userID string, online bool, lastSeenAt int64) {
	env := map[string]interface{}{
		"v":            1,
		"type":         "user.presence",
		"user_id":      userID,
		"online":       online,
		"last_seen_at": lastSeenAt,
	}
	data, err := json.Marshal(env)
	if err != nil {
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, conns := range h.clients {
		for c := range conns {
			select {
			case c.send <- data:
			default:
			}
		}
	}
}

// BroadcastAckDelivered dispatches an ack.delivered frame to the sender.
func (h *Hub) BroadcastAckDelivered(senderID, convID, requestID string, deliveredAt int64) {
	ack := map[string]interface{}{
		"v":               1,
		"type":            domain.EnvelopeTypeAckDelivered,
		"conversation_id": convID,
		"request_id":      requestID,
		"delivered_at":    deliveredAt,
	}
	if data, err := json.Marshal(ack); err == nil {
		h.Route(senderID, data)
	}
}

// BroadcastAckRead dispatches an ack.read frame to other participants in the conversation.
func (h *Hub) BroadcastAckRead(recipientUserIDs []string, readerID, convID string, readAt int64) {
	ack := map[string]interface{}{
		"v":               1,
		"type":            domain.EnvelopeTypeAckRead,
		"conversation_id": convID,
		"reader_id":       readerID,
		"last_read_at":    readAt,
	}
	if data, err := json.Marshal(ack); err == nil {
		for _, uid := range recipientUserIDs {
			if uid != readerID {
				h.Route(uid, data)
			}
		}
	}
}


