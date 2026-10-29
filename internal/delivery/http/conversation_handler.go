package http

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"

	"rootinbox/internal/domain"
)

// createConversationRequest is the request body for POST /api/v1/conversations.
type createConversationRequest struct {
	Type             string   `json:"type,omitempty"`
	PeerIdentityHash string   `json:"peer_identity_hash,omitempty"`
	Name             string   `json:"name,omitempty"`
	Description      string   `json:"description,omitempty"`
	ParticipantIDs   []string `json:"participant_ids,omitempty"`
	MemberUsernames  []string `json:"member_usernames,omitempty"`
	IsPublic         bool     `json:"is_public,omitempty"`
	Username         string   `json:"username,omitempty"`
}

// HandleCreateConversation handles POST /api/v1/conversations.
// Phase 12 / Task 0.5: Idempotent DIRECT conversation creation.
// Bundle 1.3: Idempotent SELF conversation ("My Notes") creation.
// Bundle 3.1 & 3.2: Non-E2EE GROUP and CHANNEL creation (RFC-0007-B).
// Must use ONE BEGIN IMMEDIATE transaction (check-then-create split = duplicate conversations).
func (h *ConversationHandler) HandleCreateConversation() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		var req createConversationRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "invalid request body")
			return
		}

		// Handle GROUP or CHANNEL creation
		if req.Type == string(domain.ConvTypeGroup) || req.Type == string(domain.ConvTypeChannel) {
			participantIDs := append([]string{}, req.ParticipantIDs...)
			for _, username := range req.MemberUsernames {
				u, err := h.userRepo.GetByUsername(r.Context(), username)
				if err == nil && u != nil {
					participantIDs = append(participantIDs, u.ID)
				}
			}
			conv, err := h.convUC.CreateGroupOrChannel(
				r.Context(),
				userID,
				domain.ConversationType(req.Type),
				req.Name,
				req.Description,
				participantIDs,
				req.IsPublic,
				req.Username,
			)
			if err != nil {
				WriteDomainError(w, err)
				return
			}
			res := map[string]interface{}{
				"conversation_id": conv.ID,
				"id":              conv.ID,
				"type":            string(conv.Type),
				"name":            conv.Name,
				"description":     conv.Description,
				"created_at":      conv.CreatedAt,
				"created_by":      conv.CreatedBy,
				"is_public":       conv.IsPublic,
				"username":        conv.Username,
				"invite_code":     conv.InviteCode,
			}
			WriteSuccess(w, http.StatusCreated, res, nil)
			return
		}

		// Handle SELF conversation creation
		if req.Type == string(domain.ConvTypeSelf) || req.PeerIdentityHash == "SELF" {
			conv, err := h.convUC.GetOrCreateSelfConversation(r.Context(), userID)
			if err != nil {
				WriteDomainError(w, err)
				return
			}
			selfUser, _ := h.userRepo.GetByID(r.Context(), userID)
			peerHash := ""
			if selfUser != nil {
				peerHash = selfUser.IdentityHash
			}
			WriteSuccess(w, http.StatusCreated, map[string]interface{}{
				"conversation_id":    conv.ID,
				"type":               string(conv.Type),
				"created_at":         conv.CreatedAt,
				"peer_id":            userID,
				"peer_identity_hash": peerHash,
			}, nil)
			return
		}

		if req.PeerIdentityHash == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "peer_identity_hash is required")
			return
		}

		// Look up peer user by identity hash.
		peer, err := h.userRepo.GetByIdentityHash(r.Context(), req.PeerIdentityHash)
		if err != nil {
			WriteError(w, http.StatusNotFound, string(domain.ErrUsr001), "peer not found")
			return
		}

		if peer.Status == domain.UserStatusDeleted {
			WriteError(w, http.StatusNotFound, string(domain.ErrUsr001), "peer not found")
			return
		}

		// If peer is self, route to SELF conversation
		if peer.ID == userID {
			conv, err := h.convUC.GetOrCreateSelfConversation(r.Context(), userID)
			if err != nil {
				WriteDomainError(w, err)
				return
			}
			WriteSuccess(w, http.StatusCreated, map[string]interface{}{
				"conversation_id":    conv.ID,
				"type":               string(conv.Type),
				"created_at":         conv.CreatedAt,
				"peer_id":            userID,
				"peer_identity_hash": peer.IdentityHash,
			}, nil)
			return
		}

		// Create idempotent DIRECT conversation (inside single transaction in ConvUC).
		conv, err := h.convUC.CreateDirectConversation(r.Context(), userID, peer.ID)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		respData := map[string]interface{}{
			"conversation_id":    conv.ID,
			"type":               string(conv.Type),
			"created_at":         conv.CreatedAt,
			"peer_id":            peer.ID,
			"peer_identity_hash": peer.IdentityHash,
		}
		if peer.Username != nil {
			respData["peer_username"] = *peer.Username
		}
		if peer.DisplayName != nil {
			respData["peer_display_name"] = *peer.DisplayName
		}
		if peer.LastName != nil {
			respData["peer_last_name"] = *peer.LastName
		}

		WriteSuccess(w, http.StatusCreated, respData, nil)
	}
}

// HandleListConversations handles GET /api/v1/conversations.
// Cursor-paginated list with session lookup.
func (h *ConversationHandler) HandleListConversations() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		cursor := r.URL.Query().Get("cursor")
		limitStr := r.URL.Query().Get("limit")
		limit := 20
		if limitStr != "" {
			if parsed, err := strconv.Atoi(limitStr); err == nil && parsed > 0 && parsed <= 100 {
				limit = parsed
			}
		}

		convs, nextCursor, err := h.convUC.ListConversationsForUser(r.Context(), userID, cursor, limit)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		// Build response data.
		items := make([]map[string]interface{}, 0, len(convs))
		for _, c := range convs {
			clearedAt, _ := h.convUC.GetClearedAt(r.Context(), userID, c.ID)
			hiddenAt, _ := h.convUC.GetHiddenAt(r.Context(), userID, c.ID)

			if hiddenAt > 0 {
				var lastAfterHidden *domain.GroupMessage
				if h.groupMsgRepo != nil {
					lastAfterHidden, _ = h.groupMsgRepo.GetLastMessage(r.Context(), c.ID, hiddenAt)
				}
				if lastAfterHidden == nil {
					// Conversation was hidden (deleted for me) and has no new messages since
					continue
				}
			}

			item := map[string]interface{}{
				"id":          c.ID,
				"type":        string(c.Type),
				"created_at":  domain.NormalizeTimestamp(c.CreatedAt),
				"name":        c.Name,
				"description": c.Description,
				"created_by":  c.CreatedBy,
				"is_public":   c.IsPublic,
				"username":    c.Username,
				"invite_code": c.InviteCode,
				"cleared_at":  clearedAt,
			}
			myWatermark, _ := h.convUC.GetWatermark(r.Context(), userID, c.ID)
			effectiveWatermark := myWatermark
			if clearedAt > effectiveWatermark {
				effectiveWatermark = clearedAt
			}
			item["last_read_at"] = effectiveWatermark
			item["my_last_read_at"] = effectiveWatermark

			peerRead, peerDelivered, _ := h.convUC.GetPeerWatermarks(r.Context(), c.ID, userID)
			item["peer_last_read_at"] = peerRead
			item["peer_last_delivered_at"] = peerDelivered

			unreadCount := 0
			if h.groupMsgRepo != nil {
				unreadCount, _ = h.groupMsgRepo.GetUnreadCount(r.Context(), c.ID, userID, effectiveWatermark)
				lastMsg, _ := h.groupMsgRepo.GetLastMessage(r.Context(), c.ID, clearedAt)
				if lastMsg != nil {
					item["last_message"] = map[string]interface{}{
						"id":         lastMsg.ID,
						"sender_id":  lastMsg.SenderID,
						"content":    lastMsg.Content,
						"created_at": lastMsg.CreatedAt,
						"server_id":  lastMsg.ServerID,
					}
				}
				if unreadCount > 0 {
					lastUnreadMsg, _ := h.groupMsgRepo.GetLastUnreadMessage(r.Context(), c.ID, userID, effectiveWatermark)
					if lastUnreadMsg != nil {
						item["last_unread_message"] = map[string]interface{}{
							"id":         lastUnreadMsg.ID,
							"sender_id":  lastUnreadMsg.SenderID,
							"content":    lastUnreadMsg.Content,
							"created_at": lastUnreadMsg.CreatedAt,
							"server_id":  lastUnreadMsg.ServerID,
						}
					}
				}
			}
			item["unread_count"] = unreadCount

			if c.Type == domain.ConvTypeDirect && h.participantRepo != nil {
				parts, err := h.participantRepo.ListByConversationID(r.Context(), c.ID)
				if err == nil {
					for _, p := range parts {
						if p.UserID != userID {
							item["peer_id"] = p.UserID
							item["peer_user_id"] = p.UserID
							peerUser, err := h.userRepo.GetByID(r.Context(), p.UserID)
							if err == nil && peerUser != nil {
								item["peer_identity_hash"] = peerUser.IdentityHash
								if peerUser.Username != nil {
									item["peer_username"] = *peerUser.Username
								}
								if peerUser.DisplayName != nil {
									item["peer_display_name"] = *peerUser.DisplayName
								}
								if peerUser.LastName != nil {
									item["peer_last_name"] = *peerUser.LastName
								}
								lastSeen := peerUser.LastSeenAt
								if lastSeen == 0 {
									if peerRead > 0 {
										lastSeen = peerRead
									} else if peerDelivered > 0 {
										lastSeen = peerDelivered
									}
								}
								item["peer_last_seen_at"] = lastSeen
							}
							if h.presenceChecker != nil {
								item["peer_online"] = h.presenceChecker.IsUserOnline(p.UserID)
							} else {
								item["peer_online"] = false
							}
							break
						}
					}
				}
			} else if c.Type == domain.ConvTypeSelf {
				item["peer_id"] = userID
				selfUser, err := h.userRepo.GetByID(r.Context(), userID)
				if err == nil && selfUser != nil {
					item["peer_identity_hash"] = selfUser.IdentityHash
				}
			}
			items = append(items, item)
		}

		var meta interface{}
		if nextCursor != nil {
			encoded := nextCursor.Encode()
			meta = PaginationMeta{
				Pagination: &PaginationInfo{
					NextCursor: &encoded,
					HasMore:    true,
				},
			}
		} else {
			meta = PaginationMeta{
				Pagination: &PaginationInfo{
					NextCursor: nil,
					HasMore:    false,
				},
			}
		}

		WriteSuccess(w, http.StatusOK, items, meta)
	}
}

// HandleGetOrCreateSelfConversation handles POST /api/v1/conversations/self.
// Bundle 1.3: Dedicated endpoint for self-conversation creation/retrieval.
func (h *ConversationHandler) HandleGetOrCreateSelfConversation() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		conv, err := h.convUC.GetOrCreateSelfConversation(r.Context(), userID)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		selfUser, _ := h.userRepo.GetByID(r.Context(), userID)
		peerHash := ""
		if selfUser != nil {
			peerHash = selfUser.IdentityHash
		}

		WriteSuccess(w, http.StatusCreated, map[string]interface{}{
			"conversation_id":    conv.ID,
			"type":               string(conv.Type),
			"created_at":         conv.CreatedAt,
			"peer_id":            userID,
			"peer_identity_hash": peerHash,
		}, nil)
	}
}

// HandleListGroupMessages handles GET /api/v1/conversations/{id}/messages.
// Phase 1 & 4: Retrieve permanent messages with server_id cursor pagination and advance delivery watermark.
func (h *ConversationHandler) HandleListGroupMessages() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}
		if h.groupMsgUC == nil {
			WriteError(w, http.StatusInternalServerError, "SYS_500", "group messaging not configured")
			return
		}

		convID := r.PathValue("id")
		if convID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "conversation id is required")
			return
		}

		var beforeServerID int64
		if cursorStr := r.URL.Query().Get("cursor"); cursorStr != "" {
			if parsed, err := strconv.ParseInt(cursorStr, 10, 64); err == nil {
				beforeServerID = parsed
			}
		}

		limit := 50
		if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
			if parsed, err := strconv.Atoi(limitStr); err == nil && parsed > 0 && parsed <= 100 {
				limit = parsed
			}
		}

		messages, err := h.groupMsgUC.ListMessages(r.Context(), userID, convID, beforeServerID, limit)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		// Phase 4: Fetching messages updates recipient's delivery watermark and dispatches ack.delivered
		if len(messages) > 0 && h.convUC != nil {
			now := time.Now().UnixMilli()
			_ = h.convUC.SetDeliveryWatermark(r.Context(), userID, convID, now)
			if h.router != nil {
				deliveredEnv := map[string]interface{}{
					"v":               1,
					"type":            domain.EnvelopeTypeAckDelivered,
					"conversation_id": convID,
					"delivered_at":    now,
				}
				if data, err := json.Marshal(deliveredEnv); err == nil {
					notifiedSenders := make(map[string]bool)
					for _, m := range messages {
						if m.SenderID != userID && !notifiedSenders[m.SenderID] {
							notifiedSenders[m.SenderID] = true
							h.router.Route(m.SenderID, data)
						}
					}
				}
			}
		}

		WriteSuccess(w, http.StatusOK, messages, nil)
	}
}

type sendGroupMessageRequest struct {
	ID        string  `json:"id,omitempty"`
	RequestID string  `json:"request_id,omitempty"`
	Content   string  `json:"content"`
	ReplyToID *string `json:"reply_to_id,omitempty"`
}

// HandleSendGroupMessage handles POST /api/v1/conversations/{id}/messages.
// Phase 1: Post a permanent message into any conversation (DIRECT, SELF, GROUP, CHANNEL).
func (h *ConversationHandler) HandleSendGroupMessage() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}
		if h.groupMsgUC == nil {
			WriteError(w, http.StatusInternalServerError, "SYS_500", "group messaging not configured")
			return
		}

		convID := r.PathValue("id")
		if convID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "conversation id is required")
			return
		}

		var req sendGroupMessageRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "invalid request body")
			return
		}

		msgID := req.ID
		if msgID == "" {
			msgID = req.RequestID
		}

		msg, err := h.groupMsgUC.SendMessage(r.Context(), userID, convID, req.Content, req.ReplyToID, msgID)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusCreated, msg, nil)
	}
}

type editGroupMessageRequest struct {
	Content string `json:"content"`
}

// HandleEditGroupMessage handles PATCH /api/v1/conversations/{id}/messages/{msg_id}.
func (h *ConversationHandler) HandleEditGroupMessage() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}
		if h.groupMsgUC == nil {
			WriteError(w, http.StatusInternalServerError, "SYS_500", "group messaging not configured")
			return
		}

		convID := r.PathValue("id")
		msgID := r.PathValue("msg_id")
		if convID == "" || msgID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "conversation id and message id are required")
			return
		}

		var req editGroupMessageRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "invalid request body")
			return
		}

		msg, err := h.groupMsgUC.EditMessage(r.Context(), userID, convID, msgID, req.Content)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusOK, msg, nil)
	}
}

// HandleDeleteGroupMessage handles DELETE /api/v1/conversations/{id}/messages/{msg_id}.
func (h *ConversationHandler) HandleDeleteGroupMessage() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}
		if h.groupMsgUC == nil {
			WriteError(w, http.StatusInternalServerError, "SYS_500", "group messaging not configured")
			return
		}

		convID := r.PathValue("id")
		msgID := r.PathValue("msg_id")
		if convID == "" || msgID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "conversation id and message id are required")
			return
		}

		err := h.groupMsgUC.DeleteMessage(r.Context(), userID, convID, msgID)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusOK, map[string]bool{"deleted": true}, nil)
	}
}

// HandleListMembers handles GET /api/v1/conversations/{id}/members.
func (h *ConversationHandler) HandleListMembers() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		convID := r.PathValue("id")
		if convID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "conversation id is required")
			return
		}

		// Channel privacy: only owner and admin can view members
		conv, err := h.convUC.GetConversation(r.Context(), convID)
		if err != nil {
			WriteDomainError(w, err)
			return
		}
		if conv.Type == domain.ConvTypeChannel {
			callerPart, err := h.participantRepo.GetByConversationAndUser(r.Context(), convID, userID)
			if err != nil || callerPart == nil || (callerPart.Role != domain.RoleOwner && callerPart.Role != domain.RoleAdmin) {
				WriteError(w, http.StatusForbidden, "AUTH_002", "only channel owner and admins can view members")
				return
			}
		}

		members, err := h.convUC.ListMembers(r.Context(), convID)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		type memberItem struct {
			UserID       string  `json:"user_id"`
			Username     *string `json:"username,omitempty"`
			DisplayName  *string `json:"display_name,omitempty"`
			LastName     *string `json:"last_name,omitempty"`
			IdentityHash string  `json:"identity_hash"`
			Role         string  `json:"role"`
			JoinedAt     int64   `json:"joined_at"`
		}

		items := make([]memberItem, 0, len(members))
		for _, m := range members {
			item := memberItem{
				UserID:   m.UserID,
				Role:     string(m.Role),
				JoinedAt: m.JoinedAt,
			}
			if u, err := h.userRepo.GetByID(r.Context(), m.UserID); err == nil && u != nil {
				item.Username = u.Username
				item.DisplayName = u.DisplayName
				item.LastName = u.LastName
				item.IdentityHash = u.IdentityHash
			}
			items = append(items, item)
		}

		WriteSuccess(w, http.StatusOK, items, nil)
	}
}

type addMemberRequest struct {
	UserID   string `json:"user_id,omitempty"`
	Username string `json:"username,omitempty"`
	Role     string `json:"role,omitempty"`
}

// HandleAddMember handles POST /api/v1/conversations/{id}/members.
func (h *ConversationHandler) HandleAddMember() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		callerID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		convID := r.PathValue("id")
		if convID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "conversation id is required")
			return
		}

		var req addMemberRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "invalid request body")
			return
		}

		targetUserID := req.UserID
		if targetUserID == "" && req.Username != "" {
			u, err := h.userRepo.GetByUsername(r.Context(), req.Username)
			if err != nil || u == nil {
				WriteError(w, http.StatusNotFound, string(domain.ErrUsr001), "user not found by username")
				return
			}
			targetUserID = u.ID
		}
		if targetUserID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "user_id or username is required")
			return
		}

		err := h.convUC.AddMember(r.Context(), callerID, convID, targetUserID, domain.ParticipantRole(req.Role))
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusCreated, map[string]bool{"added": true}, nil)
	}
}

// HandleRemoveMember handles DELETE /api/v1/conversations/{id}/members/{user_id}.
func (h *ConversationHandler) HandleRemoveMember() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		callerID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		convID := r.PathValue("id")
		targetUserID := r.PathValue("user_id")
		if convID == "" || targetUserID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "conversation id and user id are required")
			return
		}

		err := h.convUC.RemoveMember(r.Context(), callerID, convID, targetUserID)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusOK, map[string]bool{"removed": true}, nil)
	}
}

type updateRoleRequest struct {
	Role string `json:"role"`
}

// HandleUpdateMemberRole handles PUT /api/v1/conversations/{id}/members/{user_id}.
func (h *ConversationHandler) HandleUpdateMemberRole() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		callerID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		convID := r.PathValue("id")
		targetUserID := r.PathValue("user_id")
		if convID == "" || targetUserID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "conversation id and user id are required")
			return
		}

		var req updateRoleRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "invalid request body")
			return
		}

		err := h.convUC.UpdateMemberRole(r.Context(), callerID, convID, targetUserID, domain.ParticipantRole(req.Role))
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusOK, map[string]bool{"updated": true}, nil)
	}
}

// HandleGetHistory handles GET /api/v1/conversations/{id}/history?cursor=&limit=50.
func (h *ConversationHandler) HandleGetHistory() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}
		if h.historyRepo == nil {
			WriteError(w, http.StatusInternalServerError, "SYS_500", "history repository not configured")
			return
		}

		convID := r.PathValue("id")
		if convID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "conversation id is required")
			return
		}

		var cursor int64
		if cursorStr := r.URL.Query().Get("cursor"); cursorStr != "" {
			if parsed, err := strconv.ParseInt(cursorStr, 10, 64); err == nil {
				cursor = parsed
			}
		}

		limit := 50
		if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
			if parsed, err := strconv.Atoi(limitStr); err == nil && parsed > 0 && parsed <= 100 {
				limit = parsed
			}
		}

		messages, err := h.historyRepo.ListByUserAndConversation(r.Context(), userID, convID, cursor, limit)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		items := make([]map[string]interface{}, 0, len(messages))
		var maxTime int64
		for _, m := range messages {
			itemTime := m.CreatedAt
			if m.UpdatedAt != nil && *m.UpdatedAt > itemTime {
				itemTime = *m.UpdatedAt
			}
			if itemTime > maxTime {
				maxTime = itemTime
			}

			item := map[string]interface{}{
				"id":                m.ID,
				"user_id":           m.UserID,
				"conversation_id":   m.ConversationID,
				"sender_id":         m.SenderID,
				"sequence_number":   m.SequenceNumber,
				"created_at":        m.CreatedAt,
				"updated_at":        m.UpdatedAt,
				"deleted_at":        m.DeletedAt,
				"encrypted_payload": hex.EncodeToString(m.EncryptedPayload),
				"vault_iv":          hex.EncodeToString(m.VaultIV),
			}
			if m.ReceiverID != nil {
				item["receiver_id"] = *m.ReceiverID
			}
			items = append(items, item)
		}

		var meta interface{}
		if len(messages) == limit && maxTime > 0 {
			next := strconv.FormatInt(maxTime, 10)
			meta = PaginationMeta{
				Pagination: &PaginationInfo{
					NextCursor: &next,
					HasMore:    true,
				},
			}
		} else {
			meta = PaginationMeta{
				Pagination: &PaginationInfo{
					NextCursor: nil,
					HasMore:    false,
				},
			}
		}

		WriteSuccess(w, http.StatusOK, items, meta)
	}
}

type postHistoryItem struct {
	ID               string  `json:"id"`
	SenderID         string  `json:"sender_id"`
	ReceiverID       *string `json:"receiver_id,omitempty"`
	EncryptedPayload string  `json:"encrypted_payload"`
	VaultIV          string  `json:"vault_iv"`
	SequenceNumber   int64   `json:"sequence_number"`
	CreatedAt        int64   `json:"created_at"`
}

func decodeCipherOrIV(s string) []byte {
	if b, err := hex.DecodeString(s); err == nil && len(b) > 0 {
		return b
	}
	if b, err := base64.StdEncoding.DecodeString(s); err == nil && len(b) > 0 {
		return b
	}
	if b, err := base64.RawURLEncoding.DecodeString(s); err == nil && len(b) > 0 {
		return b
	}
	return []byte(s)
}

// HandlePostHistory handles POST /api/v1/conversations/{id}/history.
func (h *ConversationHandler) HandlePostHistory() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}
		if h.historyRepo == nil {
			WriteError(w, http.StatusInternalServerError, "SYS_500", "history repository not configured")
			return
		}

		convID := r.PathValue("id")
		if convID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "conversation id is required")
			return
		}

		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "cannot read body")
			return
		}

		var items []postHistoryItem
		if err := json.Unmarshal(bodyBytes, &items); err != nil {
			var single postHistoryItem
			if err2 := json.Unmarshal(bodyBytes, &single); err2 != nil {
				WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "invalid json format")
				return
			}
			items = []postHistoryItem{single}
		}

		now := time.Now().UnixMilli()
		toSave := make([]*domain.HistoryMessage, 0, len(items))
		for _, it := range items {
			if it.ID == "" {
				continue
			}
			created := it.CreatedAt
			if created == 0 {
				created = now
			} else if created > 0 && created < 10000000000 {
				created = created * 1000
			}
			payloadBytes := decodeCipherOrIV(it.EncryptedPayload)
			ivBytes := decodeCipherOrIV(it.VaultIV)
			toSave = append(toSave, &domain.HistoryMessage{
				ID:               it.ID,
				UserID:           userID,
				ConversationID:   convID,
				SenderID:         it.SenderID,
				ReceiverID:       it.ReceiverID,
				EncryptedPayload: payloadBytes,
				VaultIV:          ivBytes,
				SequenceNumber:   it.SequenceNumber,
				CreatedAt:        created,
				UpdatedAt:        &now,
			})
		}

		if err := h.historyRepo.SaveBatch(r.Context(), toSave); err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusCreated, map[string]int{"saved": len(toSave)}, nil)
	}
}

// HandleDeleteHistoryMessage handles DELETE /api/v1/conversations/{id}/history/{message_id}.
func (h *ConversationHandler) HandleDeleteHistoryMessage() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}
		if h.historyRepo == nil {
			WriteError(w, http.StatusInternalServerError, "SYS_500", "history repository not configured")
			return
		}

		convID := r.PathValue("id")
		msgID := r.PathValue("message_id")
		if convID == "" || msgID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "conversation id and message id required")
			return
		}

		mode := r.URL.Query().Get("mode")
		nowUnix := time.Now().UnixMilli()

		var err error
		if mode == "both" {
			err = h.historyRepo.TombstoneForBoth(r.Context(), convID, msgID, nowUnix)
		} else {
			err = h.historyRepo.Tombstone(r.Context(), userID, convID, msgID, nowUnix)
		}

		if err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusOK, map[string]bool{"deleted": true}, nil)
	}
}

// HandleClearHistory handles DELETE /api/v1/conversations/{id}/history.
func (h *ConversationHandler) HandleClearHistory() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		convID := r.PathValue("id")
		if convID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "conversation id is required")
			return
		}

		scope := r.URL.Query().Get("scope")
		if scope == "" {
			scope = r.URL.Query().Get("mode")
		}
		if scope == "" {
			scope = "me"
		}
		nowUnix := time.Now().UnixMilli()

		if scope == "both" {
			if h.groupMsgRepo != nil {
				if err := h.groupMsgRepo.HardDeleteByConversation(r.Context(), convID); err != nil {
					WriteDomainError(w, err)
					return
				}
			}
			if h.historyRepo != nil {
				_ = h.historyRepo.TombstoneAllInConversationForBoth(r.Context(), convID, nowUnix)
			}
			_ = h.convUC.SetClearedAt(r.Context(), userID, convID, nowUnix)

			// Broadcast conv.cleared with scope "both" to all participants
			if h.participantRepo != nil && h.router != nil {
				if parts, err := h.participantRepo.ListByConversationID(r.Context(), convID); err == nil {
					clearedEnv := map[string]interface{}{
						"v":               1,
						"type":            domain.EnvelopeTypeConvCleared,
						"conversation_id": convID,
						"scope":           "both",
						"cleared_at":      nowUnix,
						"cleared_by":      userID,
					}
					if data, err := json.Marshal(clearedEnv); err == nil {
						for _, p := range parts {
							h.router.Route(p.UserID, data)
						}
					}
				}
			}
		} else {
			if err := h.convUC.SetClearedAt(r.Context(), userID, convID, nowUnix); err != nil {
				WriteDomainError(w, err)
				return
			}
			_ = h.convUC.SetReadWatermark(r.Context(), userID, convID, nowUnix)
			if h.historyRepo != nil {
				_ = h.historyRepo.TombstoneAllInConversationForUser(r.Context(), userID, convID, nowUnix)
			}

			// Broadcast conv.cleared with scope "me" to the caller's active sessions
			if h.router != nil {
				clearedEnv := map[string]interface{}{
					"v":               1,
					"type":            domain.EnvelopeTypeConvCleared,
					"conversation_id": convID,
					"scope":           "me",
					"user_id":         userID,
					"cleared_at":      nowUnix,
					"cleared_by":      userID,
				}
				if data, err := json.Marshal(clearedEnv); err == nil {
					h.router.Route(userID, data)
				}
			}
		}

		WriteSuccess(w, http.StatusOK, map[string]bool{"cleared": true}, nil)
	}
}

// HandleDeleteConversation handles DELETE /api/v1/conversations/{id}.
func (h *ConversationHandler) HandleDeleteConversation() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		convID := r.PathValue("id")
		if convID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "conversation id is required")
			return
		}

		scope := r.URL.Query().Get("scope")
		if scope == "" {
			scope = r.URL.Query().Get("mode")
		}
		if scope == "" {
			scope = "me"
		}
		nowUnix := time.Now().UnixMilli()

		conv, _ := h.convUC.GetConversation(r.Context(), convID)

		if scope == "both" {
			// Broadcast conv.deleted with scope "both" before deletion to participants
			if h.participantRepo != nil && h.router != nil {
				if parts, err := h.participantRepo.ListByConversationID(r.Context(), convID); err == nil {
					deletedEnv := map[string]interface{}{
						"v":               1,
						"type":            domain.EnvelopeTypeConvDeleted,
						"conversation_id": convID,
						"scope":           "both",
						"deleted_by":      userID,
					}
					if data, err := json.Marshal(deletedEnv); err == nil {
						for _, p := range parts {
							h.router.Route(p.UserID, data)
						}
					}
				}
			}

			if h.groupMsgRepo != nil {
				_ = h.groupMsgRepo.HardDeleteByConversation(r.Context(), convID)
			}
			if h.historyRepo != nil {
				_ = h.historyRepo.HardDeleteAllInConversation(r.Context(), convID)
			}
			if err := h.convUC.DeleteConversation(r.Context(), userID, convID); err != nil {
				WriteDomainError(w, err)
				return
			}
		} else {
			// One-way delete for the caller
			if conv != nil && (conv.Type == domain.ConvTypeGroup || conv.Type == domain.ConvTypeChannel) {
				_ = h.convUC.RemoveMember(r.Context(), userID, convID, userID)
			} else {
				// Direct or Self: hide conversation and clear messages for caller
				_ = h.convUC.SetHiddenAt(r.Context(), userID, convID, nowUnix)
				_ = h.convUC.SetClearedAt(r.Context(), userID, convID, nowUnix)
				_ = h.convUC.SetReadWatermark(r.Context(), userID, convID, nowUnix)
			}

			if h.historyRepo != nil {
				_ = h.historyRepo.TombstoneAllInConversationForUser(r.Context(), userID, convID, nowUnix)
			}

			// Broadcast conv.deleted with scope "me" to the user's active sessions
			if h.router != nil {
				deletedEnv := map[string]interface{}{
					"v":               1,
					"type":            domain.EnvelopeTypeConvDeleted,
					"conversation_id": convID,
					"scope":           "me",
					"user_id":         userID,
					"deleted_by":      userID,
				}
				if data, err := json.Marshal(deletedEnv); err == nil {
					h.router.Route(userID, data)
				}
			}
		}

		WriteSuccess(w, http.StatusOK, map[string]bool{"deleted": true}, nil)
	}
}

// HandleJoinByInvite handles POST /api/v1/conversations/join/{code}.
func (h *ConversationHandler) HandleJoinByInvite() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		code := r.PathValue("code")
		if code == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "invite code is required")
			return
		}

		conv, err := h.convUC.JoinConversationByInvite(r.Context(), userID, code)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		res := map[string]interface{}{
			"conversation_id": conv.ID,
			"id":              conv.ID,
			"type":            string(conv.Type),
			"name":            conv.Name,
			"description":     conv.Description,
			"created_at":      conv.CreatedAt,
			"created_by":      conv.CreatedBy,
			"is_public":       conv.IsPublic,
			"username":        conv.Username,
			"invite_code":     conv.InviteCode,
		}
		WriteSuccess(w, http.StatusOK, res, nil)
	}
}

// HandleJoinPublic handles POST /api/v1/conversations/join-public/{username}.
func (h *ConversationHandler) HandleJoinPublic() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		username := r.PathValue("username")
		if username == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "username is required")
			return
		}

		conv, err := h.convUC.JoinPublicConversation(r.Context(), userID, username)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		res := map[string]interface{}{
			"conversation_id": conv.ID,
			"id":              conv.ID,
			"type":            string(conv.Type),
			"name":            conv.Name,
			"description":     conv.Description,
			"created_by":      conv.CreatedBy,
			"is_public":       conv.IsPublic,
			"username":        conv.Username,
			"invite_code":     conv.InviteCode,
		}
		WriteSuccess(w, http.StatusOK, res, nil)
	}
}

// HandleSearchPublic handles GET /api/v1/conversations/public/search?q={query}.
func (h *ConversationHandler) HandleSearchPublic() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		_, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		query := r.URL.Query().Get("q")
		if query == "" {
			WriteSuccess(w, http.StatusOK, []map[string]interface{}{}, nil)
			return
		}

		limit := 20
		if limitStr := r.URL.Query().Get("limit"); limitStr != "" {
			if parsed, err := strconv.Atoi(limitStr); err == nil && parsed > 0 && parsed <= 50 {
				limit = parsed
			}
		}

		convs, err := h.convUC.SearchPublicConversations(r.Context(), query, limit)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		items := make([]map[string]interface{}, 0, len(convs))
		for _, c := range convs {
			items = append(items, map[string]interface{}{
				"id":          c.ID,
				"type":        string(c.Type),
				"created_at":  c.CreatedAt,
				"name":        c.Name,
				"description": c.Description,
				"created_by":  c.CreatedBy,
				"is_public":   c.IsPublic,
				"username":    c.Username,
			})
		}
		WriteSuccess(w, http.StatusOK, items, nil)
	}
}

// HandleMarkConversationRead records the read watermark for the authenticated user.
func (h *ConversationHandler) HandleMarkConversationRead() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		convID := r.PathValue("id")
		if convID == "" {
			WriteError(w, http.StatusBadRequest, "CONV_001", "missing conversation id")
			return
		}

		var req struct {
			LastReadAt int64 `json:"last_read_at"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		req.LastReadAt = domain.NormalizeTimestamp(req.LastReadAt)
		if req.LastReadAt <= 0 {
			req.LastReadAt = time.Now().UnixMilli()
		}

		if err := h.convUC.SetReadWatermark(r.Context(), userID, convID, req.LastReadAt); err != nil {
			WriteDomainError(w, err)
			return
		}

		// Dispatch ack.read via WebSocket router to other members of this conversation
		if h.participantRepo != nil && h.router != nil {
			participants, err := h.participantRepo.ListByConversationID(r.Context(), convID)
			if err == nil {
				ackReadEnv := map[string]interface{}{
					"v":               1,
					"type":            domain.EnvelopeTypeAckRead,
					"conversation_id": convID,
					"reader_id":       userID,
					"last_read_at":    req.LastReadAt,
				}
				if ackReadData, err := json.Marshal(ackReadEnv); err == nil {
					for _, p := range participants {
						if p.UserID != userID {
							h.router.Route(p.UserID, ackReadData)
						}
					}
				}
			}
		}

		WriteSuccess(w, http.StatusOK, map[string]interface{}{
			"conversation_id": convID,
			"last_read_at":    req.LastReadAt,
		}, nil)
	}
}

// HandleGetReadWatermarks returns all conversation read watermarks for the authenticated user.
func (h *ConversationHandler) HandleGetReadWatermarks() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		watermarks, err := h.convUC.GetReadWatermarks(r.Context(), userID)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		peerWatermarks := make(map[string]int64)
		if h.participantRepo != nil {
			userParts, err := h.participantRepo.ListByUserID(r.Context(), userID)
			if err == nil {
				for _, up := range userParts {
					convParts, err := h.participantRepo.ListByConversationID(r.Context(), up.ConversationID)
					if err == nil {
						for _, p := range convParts {
							if p.UserID != userID {
								if pwm, err := h.convUC.GetWatermark(r.Context(), p.UserID, up.ConversationID); err == nil && pwm > 0 {
									peerWatermarks[up.ConversationID] = domain.NormalizeTimestamp(pwm)
								}
								break
							}
						}
					}
				}
			}
		}

		WriteSuccess(w, http.StatusOK, map[string]interface{}{
			"watermarks":      watermarks,
			"peer_watermarks": peerWatermarks,
		}, nil)
	}
}



