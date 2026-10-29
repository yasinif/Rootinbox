package http

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strconv"

	"rootinbox/internal/domain"
	"rootinbox/internal/usecase"
)

// SyncHandler handles REST-based message sync endpoints.
// RFC-0006 §4.2: REST Pending Sync (Idempotent & Cursor-Based).
type SyncHandler struct {
	syncUC *usecase.SyncUseCase
	convUC *usecase.ConversationUseCase
}

// NewSyncHandler creates a new SyncHandler.
func NewSyncHandler(syncUC *usecase.SyncUseCase) *SyncHandler {
	return &SyncHandler{syncUC: syncUC}
}

// SetConversationUseCase sets the ConversationUseCase for conversation ID resolution.
func (h *SyncHandler) SetConversationUseCase(convUC *usecase.ConversationUseCase) {
	h.convUC = convUC
}

// pendingMessageResponse is a single message in the pending response.
type pendingMessageResponse struct {
	ServerID       int64  `json:"server_id"`
	ClientUUID     string `json:"client_uuid"`
	SenderID       string `json:"sender_id"`
	Payload        string `json:"payload"`
	SequenceNumber int64  `json:"sequence_number"`
	CreatedAt      int64  `json:"created_at"`
	ConversationID string `json:"conversation_id,omitempty"`
}

// HandleGetPending handles GET /api/v1/messages/pending.
// RFC-0006 §4.2: GET /api/v1/messages/pending?limit=100&cursor=<last_server_message_id>.
func (h *SyncHandler) HandleGetPending() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "authentication required")
			return
		}

		// Parse query params.
		cursorStr := r.URL.Query().Get("cursor")
		limitStr := r.URL.Query().Get("limit")

		var cursor int64
		if cursorStr != "" {
			var err error
			cursor, err = strconv.ParseInt(cursorStr, 10, 64)
			if err != nil {
				WriteError(w, http.StatusBadRequest, "SYS_001", "invalid cursor value")
				return
			}
		}

		limit := 100
		if limitStr != "" {
			parsed, err := strconv.Atoi(limitStr)
			if err == nil && parsed > 0 && parsed <= 100 {
				limit = parsed
			}
		}

		messages, err := h.syncUC.GetPendingPaginated(r.Context(), userID, cursor, limit)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		// Convert to response format.
		resp := make([]pendingMessageResponse, len(messages))
		for i, msg := range messages {
			var convID string
			if h.convUC != nil {
				convID, _ = h.convUC.FindDirectConversationID(r.Context(), userID, msg.SenderID)
			}
			resp[i] = pendingMessageResponse{
				ServerID:       msg.ServerID,
				ClientUUID:     msg.ClientUUID,
				SenderID:       msg.SenderID,
				Payload:        base64.StdEncoding.EncodeToString(msg.EncryptedPayload),
				SequenceNumber: msg.SequenceNumber,
				CreatedAt:      domain.NormalizeTimestamp(msg.CreatedAt),
				ConversationID: convID,
			}
		}

		WriteSuccess(w, http.StatusOK, resp, nil)
	}
}

// ackRequest is the JSON request body for POST /api/v1/messages/ack.
type ackRequest struct {
	ClientUUIDs []string `json:"client_uuids"`
}

// HandleAcknowledge handles POST /api/v1/messages/ack.
// RFC-0006 §4.2: POST /api/v1/messages/ack with array of client_uuids.
func (h *SyncHandler) HandleAcknowledge() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "authentication required")
			return
		}

		var req ackRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			WriteError(w, http.StatusBadRequest, "SYS_001", "invalid request body")
			return
		}

		deleted, err := h.syncUC.AcknowledgeMessages(r.Context(), userID, req.ClientUUIDs)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusOK, map[string]int64{
			"deleted": deleted,
		}, nil)
	}
}

// HandleGetDeliveryAcks handles GET /api/v1/messages/delivery-acks?cursor=&limit=.
func (h *SyncHandler) HandleGetDeliveryAcks() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "authentication required")
			return
		}

		cursorStr := r.URL.Query().Get("cursor")
		limitStr := r.URL.Query().Get("limit")

		var cursor int64
		if cursorStr != "" {
			if c, err := strconv.ParseInt(cursorStr, 10, 64); err == nil {
				cursor = c
			}
		}

		limit := 100
		if limitStr != "" {
			if l, err := strconv.Atoi(limitStr); err == nil && l > 0 && l <= 100 {
				limit = l
			}
		}

		acks, err := h.syncUC.GetDeliveryAcks(r.Context(), userID, cursor, limit)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusOK, acks, nil)
	}
}

