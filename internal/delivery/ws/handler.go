package ws

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"rootinbox/internal/config"
	"rootinbox/internal/domain"
	"rootinbox/internal/usecase"
)

const (
	// authTimeout is the max time to wait for the auth frame.
	// RFC-0005 §4.1: Strictly 5000ms.
	authTimeout = 5 * time.Second
)

// Envelope is the JSON wire format for all WebSocket frames.
// RFC-0005 §5.1: All frames MUST conform to this schema.
// RFC-0008 §6: call_id and signal_seq are untrusted plaintext routing hints.
type Envelope struct {
	V              int     `json:"v"`
	Type           string  `json:"type"`
	RequestID      string  `json:"request_id"`
	RoutingID      string  `json:"routing_id,omitempty"`
	Payload        string  `json:"payload,omitempty"`
	SequenceNumber *int64  `json:"sequence_number,omitempty"`
	Ticket         string  `json:"ticket,omitempty"`
	SenderID       string  `json:"sender_id,omitempty"`
	CallID         string  `json:"call_id,omitempty"`
	SignalSeq      *uint64 `json:"signal_seq,omitempty"`
	ConversationID string  `json:"conversation_id,omitempty"`
	Content        string  `json:"content,omitempty"`
	ReplyToID      *string `json:"reply_to_id,omitempty"`
	ServerID       *int64  `json:"server_id,omitempty"`
	EditedAt       *int64  `json:"edited_at,omitempty"`
	DeletedAt      *int64  `json:"deleted_at,omitempty"`
	CreatedAt      *int64  `json:"created_at,omitempty"`
	ReaderID       string  `json:"reader_id,omitempty"`
	LastReadAt     *int64  `json:"last_read_at,omitempty"`
	Scope          string  `json:"scope,omitempty"`
	ClearedAt      *int64  `json:"cleared_at,omitempty"`
	ClearedBy      string  `json:"cleared_by,omitempty"`
	DeletedBy      string  `json:"deleted_by,omitempty"`
}

// Handler handles WebSocket upgrade and message routing.
// RFC-0005 §4: Connection Lifecycle & Authentication Bridge.
// RFC-0008: Call signaling relay with server-side state mutations.
// Amendment RFC-0007-B: Group & channel non-E2EE fanout.
type Handler struct {
	hub         *Hub
	ticketStore domain.TicketStore
	messageUC   *usecase.MessageUseCase
	callUC      *usecase.CallUseCase
	groupMsgUC  *usecase.GroupMessageUseCase
	userRepo    domain.UserRepository
	convUC      *usecase.ConversationUseCase
	logger      *slog.Logger
	cfg         *config.Config
	auditor     domain.SecurityAuditor
	upgrader    websocket.Upgrader
}

// SetGroupMessageUseCase wires the group message usecase.
func (h *Handler) SetGroupMessageUseCase(uc *usecase.GroupMessageUseCase) {
	h.groupMsgUC = uc
}

// SetUserRepository wires the user repository for identity hash resolution.
func (h *Handler) SetUserRepository(repo domain.UserRepository) {
	h.userRepo = repo
}

// SetConversationUseCase wires the conversation usecase for direct conversation lookup.
func (h *Handler) SetConversationUseCase(uc *usecase.ConversationUseCase) {
	h.convUC = uc
}

// NewHandler creates a new WebSocket Handler.
func NewHandler(hub *Hub, ticketStore domain.TicketStore, messageUC *usecase.MessageUseCase, callUC *usecase.CallUseCase, logger *slog.Logger, cfg *config.Config, auditor domain.SecurityAuditor) *Handler {
	up := websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin: func(r *http.Request) bool {
			if cfg.Security.InsecureDevMode {
				return true
			}
			origin := r.Header.Get("Origin")
			if origin == cfg.Security.AppOrigin {
				return true
			}
			
			// Rejection
			if auditor != nil {
				ipHash, _ := domain.IPHashFromContext(r.Context())
				traceID := domain.TraceIDFromContext(r.Context())
				var iph, tid *string
				if ipHash != "" {
					iph = &ipHash
				}
				if traceID != "" {
					tid = &traceID
				}
				auditor.Emit(domain.SecurityEvent{
					ID:           uuid.New().String(),
					EventType:    domain.EventWSOriginRejected,
					IPHash:       iph,
					TraceID:      tid,
					CreatedAt:    time.Now().Unix(),
				})
			}
			logger.Warn("ws origin rejected", "origin", origin, "expected", cfg.Security.AppOrigin)
			return false
		},
	}
	return &Handler{
		hub:         hub,
		ticketStore: ticketStore,
		messageUC:   messageUC,
		callUC:      callUC,
		logger:      logger,
		cfg:         cfg,
		auditor:     auditor,
		upgrader:    up,
	}
}

// ServeHTTP upgrades the HTTP connection to WebSocket and runs the auth flow.
// RFC-0005 §4.1: Handshake & Ticket Consumption.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.logger.Error("ws upgrade failed", "error", err)
		return
	}

	// RFC-0005 §4.1: Auth Window — 5000ms for the first frame.
	conn.SetReadLimit(maxMessageSize)
	conn.SetReadDeadline(time.Now().Add(authTimeout))

	_, data, err := conn.ReadMessage()
	if err != nil {
		h.logger.Warn("ws auth frame read failed", "error", err)
		conn.Close()
		return
	}

	// Parse auth envelope.
	var env Envelope
	if err := json.Unmarshal(data, &env); err != nil || env.Type != domain.EnvelopeTypeAuth || env.Ticket == "" {
		h.logger.Warn("ws invalid auth frame")
		conn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "Policy Violation"))
		conn.Close()
		return
	}

	// RFC-0005 §4.1: Consume the ticket from RFC-0004.
	ticketVal, err := h.ticketStore.Consume(r.Context(), env.Ticket)
	if err != nil {
		h.logger.Warn("ws ticket consumption failed", "error", err)
		conn.WriteMessage(websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "Policy Violation"))
		conn.Close()
		return
	}

	userID := ticketVal
	sessionID := ""
	if parts := strings.SplitN(ticketVal, ":", 2); len(parts) == 2 {
		userID = parts[0]
		sessionID = parts[1]
	}

	h.logger.Info("ws client authenticated", "user_id", userID, "session_id", sessionID)

	// Create client and register.
	client := NewClient(h.hub, conn, userID, sessionID, h.cfg.Push.DispatchQueueSize)
	h.hub.Register(client)

	nowMs := time.Now().UnixMilli()
	if h.userRepo != nil {
		_ = h.userRepo.UpdateLastSeen(r.Context(), userID, nowMs)
	}
	h.hub.BroadcastPresence(userID, true, nowMs)

	// RFC-0005 §4.2: Post-Auth Flush — push pending messages.
	go h.flushPending(client)

	// Start pumps. WritePump in goroutine, ReadPump blocks.
	// RFC-0005 §9: Goroutine isolation.
	go client.WritePump()
	client.ReadPump(h.handleMessage)

	// On disconnect: if no remaining connections, broadcast offline presence
	if !h.hub.IsUserOnline(userID) {
		offlineMs := time.Now().UnixMilli()
		if h.userRepo != nil {
			_ = h.userRepo.UpdateLastSeen(context.Background(), userID, offlineMs)
		}
		h.hub.BroadcastPresence(userID, false, offlineMs)
	}
}

// flushPending delivers any queued messages to the newly connected client.
// In the unified message store, message history is fetched on demand via REST /api/v1/conversations/{id}/messages
// and real-time delivery occurs via group.msg / chat.msg frames. This prevents flushing stale binary frames.
func (h *Handler) flushPending(client *Client) {
	// No-op to eliminate garbled binary message delivery
}

// handleMessage processes incoming WebSocket frames after authentication.
func (h *Handler) handleMessage(client *Client, data []byte) {
	var env Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		h.logger.Warn("ws invalid json frame", "user_id", client.userID, "error", err)
		return
	}

	if env.V != 1 {
		h.logger.Warn("ws unsupported envelope version", "version", env.V)
		return
	}

	switch env.Type {
	case domain.EnvelopeTypeChatMsg:
		h.handleChatMsg(client, env)
	case domain.EnvelopeTypeAckClient:
		h.handleAckClient(client, env)
	case domain.EnvelopeTypeCallInvite:
		h.handleCallInvite(client, env)
	case domain.EnvelopeTypeCallAccept:
		h.handleCallAccept(client, env)
	case domain.EnvelopeTypeCallReject:
		h.handleCallReject(client, env)
	case domain.EnvelopeTypeCallEnd:
		h.handleCallEnd(client, env)
	case domain.EnvelopeTypeCallICE, domain.EnvelopeTypeCallRenegotiate:
		// RFC-0008: Relay-only — NO transaction, NO state mutation.
		h.handleCallRelay(client, env)
	case domain.EnvelopeTypeGroupMsg:
		h.handleGroupMsg(client, env)
	default:
		h.logger.Warn("ws unknown envelope type", "type", env.Type)
	}
}

// handleGroupMsg processes an incoming non-E2EE group or channel message.
// Amendment RFC-0007-B.
func (h *Handler) handleGroupMsg(client *Client, env Envelope) {
	if env.ConversationID == "" || env.Content == "" {
		h.logger.Warn("ws group.msg missing required fields", "user_id", client.userID)
		return
	}
	if !domain.IsValidMessageContent(env.Content) {
		h.logger.Warn("ws group.msg rejected: invalid or corrupted content", "user_id", client.userID)
		return
	}
	if h.groupMsgUC == nil {
		h.logger.Warn("ws group.msg ignored: group message usecase not wired", "user_id", client.userID)
		return
	}

	ctx := context.Background()
	msg, err := h.groupMsgUC.SendMessage(ctx, client.userID, env.ConversationID, env.Content, env.ReplyToID, env.RequestID)
	if err != nil {
		h.logger.Error("ws send group message failed", "user_id", client.userID, "error", err)
		return
	}

	reqID := env.RequestID
	if reqID == "" {
		reqID = msg.ID
	}
	ack := Envelope{
		V:              1,
		Type:           domain.EnvelopeTypeAckServer,
		RequestID:      reqID,
		ConversationID: env.ConversationID,
	}
	ackData, err := json.Marshal(ack)
	if err == nil {
		select {
		case client.send <- ackData:
		default:
			h.logger.Warn("ws client send channel full for ack", "user_id", client.userID)
		}
	}
}

// handleChatMsg processes an incoming chat message.
// Phase 1: Unified server-authoritative message store for DIRECT, SELF, GROUP, and CHANNEL conversations.
func (h *Handler) handleChatMsg(client *Client, env Envelope) {
	ctx := context.Background()

	// Extract content
	content := env.Content
	if content == "" && env.Payload != "" {
		if payloadBytes, err := base64.StdEncoding.DecodeString(env.Payload); err == nil {
			content = string(payloadBytes)
		} else {
			content = env.Payload
		}
	}

	convID := env.ConversationID

	// Resolve direct conversation ID if missing
	if convID == "" && env.RoutingID != "" {
		receiverID := ""
		if routingIDBytes, err := base64.RawURLEncoding.DecodeString(env.RoutingID); err == nil && len(routingIDBytes) > 0 {
			receiverID = string(routingIDBytes)
		} else if routingIDBytes, err := base64.URLEncoding.DecodeString(env.RoutingID); err == nil && len(routingIDBytes) > 0 {
			receiverID = string(routingIDBytes)
		} else if routingIDBytes, err := base64.StdEncoding.DecodeString(env.RoutingID); err == nil && len(routingIDBytes) > 0 {
			receiverID = string(routingIDBytes)
		} else {
			receiverID = env.RoutingID
		}

		if h.userRepo != nil {
			if user, err := h.userRepo.GetByIdentityHash(ctx, receiverID); err == nil && user != nil {
				receiverID = user.ID
			}
		} else if h.callUC != nil {
			if user, err := h.callUC.GetUserByIdentityHash(ctx, receiverID); err == nil && user != nil {
				receiverID = user.ID
			}
		}

		if h.convUC != nil && receiverID != "" {
			existingID, err := h.convUC.FindDirectConversationID(ctx, client.userID, receiverID)
			if err == nil && existingID != "" {
				convID = existingID
			} else {
				newConv, err := h.convUC.CreateConversation(ctx, domain.ConvTypeDirect, client.userID, []string{receiverID})
				if err == nil && newConv != nil {
					convID = newConv.ID
				}
			}
		}
	}

	if convID == "" || content == "" {
		h.logger.Warn("ws chat.msg missing required fields", "user_id", client.userID)
		return
	}
	if !domain.IsValidMessageContent(content) {
		h.logger.Warn("ws chat.msg rejected: invalid or corrupted content", "user_id", client.userID)
		return
	}

	reqID := env.RequestID

	// Unified permanent messaging via GroupMessageUseCase
	if h.groupMsgUC != nil {
		msg, err := h.groupMsgUC.SendMessage(ctx, client.userID, convID, content, env.ReplyToID, reqID)
		if err != nil {
			h.logger.Error("ws send message failed", "user_id", client.userID, "error", err)
			return
		}
		if reqID == "" && msg != nil {
			reqID = msg.ID
		}
	} else if h.messageUC != nil && env.RoutingID != "" {
		// Fallback for messageUC if groupMsgUC not wired
		payloadBytes := []byte(content)
		var seqNum int64
		if env.SequenceNumber != nil {
			seqNum = *env.SequenceNumber
		}
		_ = h.messageUC.SendMessage(ctx, client.userID, reqID, env.RoutingID, payloadBytes, seqNum, convID)
	}

	// Send ack.server to the sender
	ack := Envelope{
		V:              1,
		Type:           domain.EnvelopeTypeAckServer,
		RequestID:      reqID,
		ConversationID: convID,
	}
	ackData, err := json.Marshal(ack)
	if err == nil {
		select {
		case client.send <- ackData:
		default:
			h.logger.Warn("ws client send channel full for ack", "user_id", client.userID)
		}
	}

	// Fan out to sender's other connected devices
	senderFanoutEnv := Envelope{
		V:              1,
		Type:           domain.EnvelopeTypeChatMsg,
		RequestID:      reqID,
		SenderID:       client.userID,
		ConversationID: convID,
		Content:        content,
		Payload:        env.Payload,
		SequenceNumber: env.SequenceNumber,
		ReplyToID:      env.ReplyToID,
	}
	if fanoutData, err := json.Marshal(senderFanoutEnv); err == nil {
		h.hub.RouteExcept(client.userID, client, fanoutData)
	}
}

// handleAckClient processes a client delivery acknowledgement.
// Phase 4: Delivery Watermarks & Live Delivery Confirmation without legacy hard deletion.
func (h *Handler) handleAckClient(client *Client, env Envelope) {
	if env.RequestID == "" {
		h.logger.Warn("ws ack.client missing request_id", "user_id", client.userID)
		return
	}

	ctx := context.Background()
	convID := env.ConversationID
	var senderID string
	var msgCreatedAt int64

	// If convID not directly in envelope, look up via groupMsgUC
	if h.groupMsgUC != nil {
		if msg, err := h.groupMsgUC.GetByID(ctx, env.RequestID); err == nil && msg != nil {
			if convID == "" {
				convID = msg.ConversationID
			}
			senderID = msg.SenderID
			msgCreatedAt = msg.CreatedAt
		}
	}

	now := time.Now().UnixMilli()
	if msgCreatedAt > 0 {
		now = msgCreatedAt
	}

	// Advance delivery watermark for this user in the conversation
	if convID != "" && h.convUC != nil {
		_ = h.convUC.SetDeliveryWatermark(ctx, client.userID, convID, now)
	}

	// Dispatch ack.delivered to sender
	if senderID != "" && senderID != client.userID {
		h.hub.BroadcastAckDelivered(senderID, convID, env.RequestID, now)
	} else if senderID == "" && env.SenderID != "" && env.SenderID != client.userID {
		h.hub.BroadcastAckDelivered(env.SenderID, convID, env.RequestID, now)
	}
}
