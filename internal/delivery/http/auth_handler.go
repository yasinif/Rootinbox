package http

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"rootinbox/internal/domain"
	"rootinbox/internal/usecase"
	"rootinbox/pkg/crypto"
)

// AuthHandler handles authentication HTTP endpoints.
// RFC-0004: Authentication, Challenge-Response & Session Management.
type AuthHandler struct {
	authUC *usecase.AuthUseCase
}

// NewAuthHandler creates a new AuthHandler.
func NewAuthHandler(authUC *usecase.AuthUseCase) *AuthHandler {
	return &AuthHandler{authUC: authUC}
}

const (
	// authFailMessage is the uniform error message for all auth failures.
	// RFC-0004 §8.2: Identical, generic error payload for all auth failures.
	authFailMessage = "Authentication failed. Invalid identity, signature, or expired challenge."

	// cookieName is the session cookie name.
	// RFC-0004 §7.1: Name "ps_session".
	cookieName = "ps_session"

	// cookieMaxAge is the session cookie max age in seconds.
	// RFC-0004 §7.1: MaxAge 604800 (7 Days).
	cookieMaxAge = 604800
)

// HandleRegister handles POST /api/v1/auth/register.
// RFC-0004 §5.1: Registration Flow.
// Request body: Raw 137-byte Registration Wire Format (RFC-0003 §5.1).
func (h *AuthHandler) HandleRegister() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Read raw binary body.
		body, err := io.ReadAll(io.LimitReader(r.Body, int64(crypto.RegistrationWireSize+1)))
		if err != nil {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		username := r.URL.Query().Get("username")
		if username == "" {
			username = r.Header.Get("X-Username")
		}

		displayName := r.URL.Query().Get("display_name")
		if displayName == "" {
			displayName = r.Header.Get("X-Display-Name")
		}

		ua := r.Header.Get("User-Agent")
		deviceLabel := ParseDeviceLabel(ua)
		ctx := domain.WithDeviceLabel(r.Context(), deviceLabel)

		result, err := h.authUC.Register(ctx, body, username, displayName)
		if err != nil {
			slog.Error("register error", "err", err)
			WriteDomainError(w, err)
			return
		}

		rememberMe := true
		if r.URL.Query().Get("remember_me") == "false" || r.Header.Get("X-Remember-Me") == "false" {
			rememberMe = false
		}

		// RFC-0004 §7.1: Issue HTTP-Only Cookie.
		setSessionCookie(w, r, result.RawToken, rememberMe)

		WriteSuccess(w, http.StatusCreated, map[string]string{
			"user_id":       result.UserID,
			"session_id":    result.SessionID,
			"session_token": result.RawToken,
			"token":         result.RawToken,
			"identity_hash": result.IdentityHash,
		}, nil)
	}
}

// challengeRequest is the JSON request body for POST /api/v1/auth/challenge.
type challengeRequest struct {
	IdentityHash string `json:"identity_hash"`
}

// HandleChallenge handles POST /api/v1/auth/challenge.
// RFC-0004 §5.2: Login Flow Phase 1.
func (h *AuthHandler) HandleChallenge() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req challengeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		result, err := h.authUC.Challenge(r.Context(), req.IdentityHash)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		// RFC-0004 §5.2: Response format.
		WriteSuccess(w, http.StatusOK, map[string]interface{}{
			"challenge_id": result.ChallengeID,
			"nonce":        result.Nonce,
			"expires_in":   result.ExpiresIn,
		}, nil)
	}
}

// verifyRequest is the JSON request body for POST /api/v1/auth/verify.
type verifyRequest struct {
	IdentityHash     string `json:"identity_hash"`
	ChallengeID      string `json:"challenge_id"`
	SessionPublicKey string `json:"session_public_key"`
	Signature        string `json:"signature"`
	// Phase 12 / Task 0.5: Session signature fields for server-side MITM prevention.
	// RFC-0003 §5.1: 73-byte session signature that binds the session key to the identity.
	SessionSignature string `json:"session_signature"`
	SessionExpiresAt *int64 `json:"session_expires_at"`
	RememberMe       *bool  `json:"remember_me,omitempty"`
}

// HandleVerify handles POST /api/v1/auth/verify.
// RFC-0004 §5.3: Login Flow Phase 2.
// Phase 12 / Task 0.5: Now requires session_signature + session_expires_at
// for server-side MITM prevention.
func (h *AuthHandler) HandleVerify() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req verifyRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		// Phase 12 / Task 0.5: session_signature and session_expires_at are MANDATORY.
		// Missing either → AUTH_001 (never 400).
		if req.SessionSignature == "" || req.SessionExpiresAt == nil {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		ua := r.Header.Get("User-Agent")
		deviceLabel := ParseDeviceLabel(ua)
		ctx := domain.WithDeviceLabel(r.Context(), deviceLabel)

		result, err := h.authUC.Verify(ctx, req.IdentityHash, req.ChallengeID,
			req.SessionPublicKey, req.Signature, req.SessionSignature, *req.SessionExpiresAt)
		if err != nil {
			slog.Error("verify handler error", "err", err)
			WriteDomainError(w, err)
			return
		}

		rememberMe := true
		if (req.RememberMe != nil && !*req.RememberMe) || r.URL.Query().Get("remember_me") == "false" || r.Header.Get("X-Remember-Me") == "false" {
			rememberMe = false
		}

		// RFC-0004 §7.1: Issue HTTP-Only Cookie.
		setSessionCookie(w, r, result.RawToken, rememberMe)

		WriteSuccess(w, http.StatusOK, map[string]string{
			"user_id":       result.UserID,
			"session_id":    result.SessionID,
			"session_token": result.RawToken,
			"token":         result.RawToken,
			"identity_hash": result.IdentityHash,
		}, nil)
	}
}

// HandleWSTicket handles GET /api/v1/auth/ws-ticket.
// RFC-0004 §7.3: WebSocket Ticket Protocol.
// This endpoint requires authentication (session cookie).
func (h *AuthHandler) HandleWSTicket() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		ticket, err := h.authUC.IssueWSTicket(r.Context(), userID)
		if err != nil {
			WriteError(w, http.StatusInternalServerError, "SYS_500", "internal server error")
			return
		}

		WriteSuccess(w, http.StatusOK, map[string]string{
			"ticket": ticket,
		}, nil)
	}
}

// setSessionCookie sets the ps_session HTTP-Only cookie.
// RFC-0004 §7.1: Strict Cookie Contract.
// In secure contexts (HTTPS), Secure is true and SameSite is Strict.
// SameSite=Lax is acceptable ONLY in local dev / non-TLS localhost or when INSECURE_DEV_MODE=true.
// In production (HTTPS or non-dev), it MUST remain SameSite=Strict.
// When rememberMe is false, MaxAge is 0 (omitted from Set-Cookie header), creating a session-only cookie.
func setSessionCookie(w http.ResponseWriter, r *http.Request, rawToken string, rememberMe bool) {
	secure := r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https"
	sameSite := http.SameSiteStrictMode

	insecureDev := os.Getenv("INSECURE_DEV_MODE") == "true" || (!secure && isLocalhost(r.Host))
	if !secure && insecureDev {
		sameSite = http.SameSiteLaxMode
	}

	cookie := &http.Cookie{
		Name:     cookieName,
		Value:    rawToken,
		Path:     "/",
		HttpOnly: true,
		Secure:   secure,
		SameSite: sameSite,
	}

	if rememberMe {
		cookie.MaxAge = cookieMaxAge
	} else {
		cookie.MaxAge = 0
	}

	http.SetCookie(w, cookie)
}

func isLocalhost(host string) bool {
	if host == "localhost" || host == "127.0.0.1" || host == "::1" {
		return true
	}
	return strings.HasPrefix(host, "localhost:") || strings.HasPrefix(host, "127.0.0.1:") || strings.HasPrefix(host, "[::1]:")
}

// userIDFromRequest extracts the authenticated UserID from the request context.
func userIDFromRequest(r *http.Request) (string, bool) {
	return domain.UserIDFromContext(r.Context())
}

type sessionItemResponse struct {
	ID           string `json:"id"`
	DeviceLabel  string `json:"device_label"`
	IPHash       string `json:"ip_hash"`
	LastActiveAt int64  `json:"last_active_at"`
	CreatedAt    int64  `json:"created_at"`
	IsCurrent    bool   `json:"is_current"`
}

// HandleListSessions handles GET /api/v1/auth/sessions.
func (h *AuthHandler) HandleListSessions() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sessions, currentSessionID, err := h.authUC.ListSessions(r.Context())
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		resp := make([]sessionItemResponse, 0, len(sessions))
		for _, s := range sessions {
			resp = append(resp, sessionItemResponse{
				ID:           s.ID,
				DeviceLabel:  s.DeviceLabel,
				IPHash:       s.IPHash,
				LastActiveAt: s.LastActiveAt,
				CreatedAt:    s.CreatedAt,
				IsCurrent:    s.ID == currentSessionID,
			})
		}

		WriteSuccess(w, http.StatusOK, resp, nil)
	}
}

// HandleTerminateSession handles DELETE /api/v1/auth/sessions/{id}.
func (h *AuthHandler) HandleTerminateSession() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sessionID := r.PathValue("id")
		if sessionID == "" {
			WriteError(w, http.StatusBadRequest, "SYS_400", "session ID required")
			return
		}

		if err := h.authUC.TerminateSession(r.Context(), sessionID); err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusOK, map[string]bool{"terminated": true}, nil)
	}
}

// HandleTerminateOtherSessions handles POST /api/v1/auth/sessions/terminate-others.
func (h *AuthHandler) HandleTerminateOtherSessions() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if err := h.authUC.TerminateOtherSessions(r.Context()); err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusOK, map[string]bool{"terminated_others": true}, nil)
	}
}
