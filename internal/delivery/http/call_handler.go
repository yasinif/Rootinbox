package http

import (
	"net/http"

	"rootinbox/internal/usecase"
)

// CallHandler handles call-related REST endpoints.
type CallHandler struct {
	callUC *usecase.CallUseCase
}

// NewCallHandler creates a new CallHandler.
func NewCallHandler(callUC *usecase.CallUseCase) *CallHandler {
	return &CallHandler{callUC: callUC}
}

// HandleTURNCredentials handles GET /api/v1/calls/turn-credentials.
// RFC-0008 §5.2: Ephemeral TURN Credential Issuance.
func (h *CallHandler) HandleTURNCredentials() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "authentication required")
			return
		}

		// Get identity hash from query parameter.
		identityHash := r.URL.Query().Get("identity_hash")
		if identityHash == "" {
			WriteError(w, http.StatusBadRequest, "SYS_001", "identity_hash query parameter is required")
			return
		}

		_ = userID // userID verified by session auth middleware.

		creds, err := h.callUC.GetTURNCredentials(r.Context(), identityHash)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusOK, creds, nil)
	}
}

// HandlePendingCall handles GET /api/v1/calls/pending.
func (h *CallHandler) HandlePendingCall() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "authentication required")
			return
		}

		identityHash := r.URL.Query().Get("identity_hash")
		if identityHash == "" {
			WriteError(w, http.StatusBadRequest, "SYS_001", "identity_hash query parameter is required")
			return
		}

		entry, err := h.callUC.TakePendingInvite(r.Context(), identityHash, userID)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		// RFC-0009 §7.3: Convert to JSON response.
		// Base64 encode the binary fields
		importB64 := true
		_ = importB64 // rely on goimports

		response := map[string]interface{}{
			"call_id":               entry.CallID,
			"caller_id":             entry.CallerID,
			"caller_identity_hash":  entry.CallerIdentityHash,
			"caller_session_id":     entry.CallerSessionID,
			"encrypted_offer":       entry.EncryptedOffer, // encode? go json encodes []byte as base64 standard encoding
			"fingerprint_signature": entry.FingerprintSignature,
			"expires_at":            entry.ExpiresAt,
		}

		WriteSuccess(w, http.StatusOK, response, nil)
	}
}

// HandleMissedCalls handles GET /api/v1/calls/missed.
func (h *CallHandler) HandleMissedCalls() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "authentication required")
			return
		}

		calls, err := h.callUC.GetMissedCalls(r.Context(), userID, 50)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		type missedCallDTO struct {
			ID             string `json:"id"`
			ConversationID string `json:"conversation_id"`
			CallerID       string `json:"caller_id"`
			Type           string `json:"type"`
			CreatedAt      int64  `json:"created_at"`
		}

		res := make([]missedCallDTO, len(calls))
		for i, c := range calls {
			res[i] = missedCallDTO{
				ID:             c.ID,
				ConversationID: c.ConversationID,
				CallerID:       c.CallerID,
				Type:           string(c.Type),
				CreatedAt:      c.CreatedAt,
			}
		}

		WriteSuccess(w, http.StatusOK, res, nil)
	}
}
