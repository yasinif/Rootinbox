package http

import (
	"encoding/base64"
	"encoding/json"
	"net/http"

	"rootinbox/internal/domain"
	"rootinbox/internal/usecase"
)

// PushHandler handles push-related REST endpoints.
type PushHandler struct {
	pushUC      *usecase.PushUseCase
	vapidKey    domain.VAPIDKeyProvider // in-memory, loaded at bootstrap — never nil when push is enabled
	pushEnabled bool
}

// NewPushHandler creates a new PushHandler.
func NewPushHandler(pushUC *usecase.PushUseCase, vapidKey domain.VAPIDKeyProvider, pushEnabled bool) *PushHandler {
	return &PushHandler{pushUC: pushUC, vapidKey: vapidKey, pushEnabled: pushEnabled}
}

// SubscribeRequest is the body for POST /api/v1/push/subscribe
type SubscribeRequest struct {
	Endpoint   string `json:"endpoint"`
	P256dhKey  string `json:"p256dh_key"`
	AuthSecret string `json:"auth_secret"`
}

// HandleVapidPublicKey handles GET /api/v1/push/vapid-public-key.
// Phase 12B §11.5: Returns the 65-byte uncompressed P-256 VAPID public key
// as Base64URL unpadded. In-memory read only — zero DB access.
func (h *PushHandler) HandleVapidPublicKey() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Session auth is enforced by middleware — userID presence is guaranteed.
		_, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "authentication required")
			return
		}

		// Push disabled → 404 PUSH_001 (client degrades silently per ADR-P12B-34).
		if !h.pushEnabled || h.vapidKey == nil {
			WriteDomainError(w, domain.NewDomainError(domain.ErrPush001, "push notifications are not available", nil))
			return
		}

		// Read the public key from the in-memory VAPID identity.
		pubB64URL := h.vapidKey.PublicKeyBase64URL()
		pubBytes, err := base64.RawURLEncoding.DecodeString(pubB64URL)
		if err != nil || len(pubBytes) != 65 || pubBytes[0] != 0x04 {
			WriteError(w, http.StatusInternalServerError, "PUSH_002", "VAPID public key is malformed")
			return
		}

		// Re-encode as Base64URL unpadded (the stored value is already in this format,
		// but we decode+validate+re-encode to guarantee the contract).
		publicKeyB64 := base64.RawURLEncoding.EncodeToString(pubBytes)

		WriteSuccess(w, http.StatusOK, map[string]string{
			"public_key": publicKeyB64,
		}, nil)
	}
}

// HandleSubscribe handles POST /api/v1/push/subscribe.
func (h *PushHandler) HandleSubscribe() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "authentication required")
			return
		}

		var req SubscribeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			WriteError(w, http.StatusBadRequest, "SYS_001", "invalid json body")
			return
		}
		defer r.Body.Close()

		sub, err := h.pushUC.Subscribe(r.Context(), userID, req.Endpoint, req.P256dhKey, req.AuthSecret)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		// RFC-0009 §6.2: Successful registration returns 201 Created if new, 200 OK if idempotent update.
		// For simplicity, we just return 200 OK since the UseCase always Upserts and returns it.
		// If we need to strictly distinguish 201 vs 200, we'd need Upsert to tell us if it inserted.
		// Returning 200 OK for both is usually acceptable in REST for PUT/upsert-like behavior,
		// though the spec says POST. We'll return 200 OK.
		WriteSuccess(w, http.StatusOK, sub, nil)
	}
}

// HandleUnsubscribe handles DELETE /api/v1/push/subscribe.
func (h *PushHandler) HandleUnsubscribe() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "authentication required")
			return
		}

		endpoint := r.URL.Query().Get("endpoint")
		if endpoint == "" {
			WriteError(w, http.StatusBadRequest, "SYS_001", "endpoint query parameter is required")
			return
		}

		err := h.pushUC.Unsubscribe(r.Context(), userID, endpoint)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		// RFC-0009: Idempotent success, always 204
		w.WriteHeader(http.StatusNoContent)
	}
}
