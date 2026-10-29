package http

import (
	"net/http"

	"rootinbox/internal/domain"
	"rootinbox/internal/usecase"
)

// DirectoryHandler handles peer discovery endpoints.
// Phase 12 / Task 0.5: Frontend cannot discover peer session keys without this.
type DirectoryHandler struct {
	userRepo    domain.UserRepository
	sessionRepo domain.SessionRepository
}

// NewDirectoryHandler creates a new DirectoryHandler.
func NewDirectoryHandler(userRepo domain.UserRepository, sessionRepo domain.SessionRepository) *DirectoryHandler {
	return &DirectoryHandler{userRepo: userRepo, sessionRepo: sessionRepo}
}

// HandleLookup handles GET /api/v1/directory/{identity_hash}.
// Returns the user's identity public key and active session info.
// 404 for unknown AND tombstoned users (indistinguishable).
func (h *DirectoryHandler) HandleLookup() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		identityHash := r.PathValue("identity_hash")
		if identityHash == "" {
			WriteError(w, http.StatusNotFound, string(domain.ErrUsr001), "not found")
			return
		}

		user, err := h.userRepo.GetByIdentityHash(r.Context(), identityHash)
		if err != nil {
			// Fallback: check by ID if identityHash didn't match directly (e.g. sender_id UUID)
			user, err = h.userRepo.GetByID(r.Context(), identityHash)
			if err != nil {
				// Fallback: check by session ID if caller_session_id was passed
				sess, sErr := h.sessionRepo.GetByID(r.Context(), identityHash)
				if sErr == nil && sess != nil {
					user, err = h.userRepo.GetByID(r.Context(), sess.UserID)
				}
				if err != nil || user == nil {
					// Unknown user: 404, indistinguishable from tombstoned.
					WriteError(w, http.StatusNotFound, string(domain.ErrUsr001), "not found")
					return
				}
			}
		}

		// Tombstoned (DELETED) users also return 404, indistinguishable from unknown.
		if user.Status == domain.UserStatusDeleted {
			WriteError(w, http.StatusNotFound, string(domain.ErrUsr001), "not found")
			return
		}

		// Suspended users are discoverable but cannot initiate sessions.
		// Look up active session.
		session, err := h.sessionRepo.GetActiveByUserID(r.Context(), user.ID)
		if err != nil {
			WriteError(w, http.StatusInternalServerError, string(domain.ErrSys500), "internal server error")
			return
		}

		allSessions, _ := h.sessionRepo.GetActiveSessionsByUserID(r.Context(), user.ID)
		if session == nil && len(allSessions) > 0 {
			session = allSessions[0]
		}

		var sessionData map[string]interface{}
		if session != nil {
			sessionData = map[string]interface{}{
				"x25519_public_key":  session.X25519PublicKey,
				"session_id":         session.ID,
				"session_version":    session.SessionVersion,
				"session_signature":  session.SessionSignature,
				"signed_expires_at":  session.SignedExpiresAt,
			}
		}

		sessionsList := make([]map[string]interface{}, 0, len(allSessions))
		for _, s := range allSessions {
			sessionsList = append(sessionsList, map[string]interface{}{
				"session_id":        s.ID,
				"x25519_public_key": s.X25519PublicKey,
				"session_version":   s.SessionVersion,
			})
		}

		WriteSuccess(w, http.StatusOK, map[string]interface{}{
			"user_id":             user.ID,
			"identity_hash":       user.IdentityHash,
			"identity_public_key": user.PublicKey,
			"active_session":      sessionData,
			"sessions":            sessionsList,
		}, nil)
	}
}

// PresenceChecker checks user online status.
type PresenceChecker interface {
	IsUserOnline(userID string) bool
}

// ConversationHandler handles conversation CRUD endpoints.
// Phase 12 / Task 0.5: Frontend needs conversation creation and listing.
// Amendment RFC-0007-B: Non-E2EE group and channel messaging and member management.
type ConversationHandler struct {
	convUC          *usecase.ConversationUseCase
	userRepo        domain.UserRepository
	participantRepo domain.ParticipantRepository
	groupMsgUC      *usecase.GroupMessageUseCase
	groupMsgRepo    domain.GroupMessageRepository
	historyRepo     domain.MessageHistoryRepository
	router          domain.MessageRouter
	presenceChecker PresenceChecker
}

// NewConversationHandler creates a new ConversationHandler.
func NewConversationHandler(convUC *usecase.ConversationUseCase, userRepo domain.UserRepository, participantRepo domain.ParticipantRepository) *ConversationHandler {
	return &ConversationHandler{convUC: convUC, userRepo: userRepo, participantRepo: participantRepo}
}

// SetGroupMessageUseCase sets the GroupMessageUseCase.
func (h *ConversationHandler) SetGroupMessageUseCase(uc *usecase.GroupMessageUseCase) {
	h.groupMsgUC = uc
}

// SetGroupMessageRepository sets the GroupMessageRepository.
func (h *ConversationHandler) SetGroupMessageRepository(repo domain.GroupMessageRepository) {
	h.groupMsgRepo = repo
}

// SetHistoryRepository sets the MessageHistoryRepository.
func (h *ConversationHandler) SetHistoryRepository(repo domain.MessageHistoryRepository) {
	h.historyRepo = repo
}

// SetMessageRouter sets the MessageRouter for real-time delivery.
func (h *ConversationHandler) SetMessageRouter(router domain.MessageRouter) {
	h.router = router
}

// SetPresenceChecker sets the PresenceChecker for online status.
func (h *ConversationHandler) SetPresenceChecker(checker PresenceChecker) {
	h.presenceChecker = checker
}


