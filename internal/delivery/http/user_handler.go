package http

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"rootinbox/internal/domain"
	"rootinbox/internal/usecase"
)

// UserHandler handles user profile, search, and avatar endpoints.
// Amendment RFC-0002-A: Username Registry.
// Bundle 4: Personalization.
type UserHandler struct {
	userUC          *usecase.UserUseCase
	presenceChecker PresenceChecker
}

// SetPresenceChecker sets the optional presence checker.
func (h *UserHandler) SetPresenceChecker(pc PresenceChecker) {
	h.presenceChecker = pc
}

// NewUserHandler creates a new UserHandler.
func NewUserHandler(userUC *usecase.UserUseCase) *UserHandler {
	return &UserHandler{userUC: userUC}
}

// HandleSearch handles GET /api/v1/users/search?q={query}.
// Amendment RFC-0002-A §7A.4: Search by username prefix.
// Rate-limited at 10/min per user (RouteClassUserSearch).
func (h *UserHandler) HandleSearch() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query().Get("q")
		if query == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrUsr004), "query parameter 'q' is required")
			return
		}

		limitStr := r.URL.Query().Get("limit")
		limit := 20
		if limitStr != "" {
			if parsed, err := strconv.Atoi(limitStr); err == nil && parsed > 0 && parsed <= 20 {
				limit = parsed
			}
		}

		users, err := h.userUC.SearchUsers(r.Context(), query, limit)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		// Build response — privacy: only user_id, username, identity_hash (+ optional avatar metadata).
		items := make([]map[string]interface{}, 0, len(users))
		for _, u := range users {
			if u.Username == nil {
				continue // Should not happen, but guard.
			}
			item := map[string]interface{}{
				"user_id":       u.ID,
				"username":      *u.Username,
				"identity_hash": u.IdentityHash,
			}
			if u.DisplayName != nil {
				item["display_name"] = *u.DisplayName
			}
			if u.LastName != nil {
				item["last_name"] = *u.LastName
			}
			if u.AvatarUpdatedAt != nil {
				item["avatar_updated_at"] = *u.AvatarUpdatedAt
			}
			items = append(items, item)
		}

		WriteSuccess(w, http.StatusOK, items, nil)
	}
}

// updateUsernameRequest is the JSON request body for PUT /api/v1/users/me/username.
type updateUsernameRequest struct {
	Username *string `json:"username"`
}

// HandleUpdateUsername handles PUT /api/v1/users/me/username.
// Amendment RFC-0002-A §7A.5: Set or clear username.
func (h *UserHandler) HandleUpdateUsername() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		var req updateUsernameRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "invalid request body")
			return
		}

		user, err := h.userUC.UpdateUsername(r.Context(), userID, req.Username)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		responseData := map[string]interface{}{
			"user_id": user.ID,
		}
		if user.Username != nil {
			responseData["username"] = *user.Username
		} else {
			responseData["username"] = nil
		}
		if user.AvatarUpdatedAt != nil {
			responseData["avatar_updated_at"] = *user.AvatarUpdatedAt
		}

		WriteSuccess(w, http.StatusOK, responseData, nil)
	}
}

// HandleGetMe handles GET /api/v1/users/me.
// Returns the authenticated user's profile.
func (h *UserHandler) HandleGetMe() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		user, err := h.userUC.GetUserByID(r.Context(), userID)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		responseData := map[string]interface{}{
			"user_id":       user.ID,
			"identity_hash": user.IdentityHash,
			"status":        string(user.Status),
			"created_at":    user.CreatedAt,
		}
		if user.Username != nil {
			responseData["username"] = *user.Username
		}
		if user.DisplayName != nil {
			responseData["display_name"] = *user.DisplayName
		}
		if user.LastName != nil {
			responseData["last_name"] = *user.LastName
		}
		if user.Bio != nil {
			responseData["bio"] = *user.Bio
		}
		if user.AvatarUpdatedAt != nil {
			responseData["avatar_updated_at"] = *user.AvatarUpdatedAt
		}

		WriteSuccess(w, http.StatusOK, responseData, nil)
	}
}

// updateProfileRequest is the JSON request body for PUT /api/v1/users/me/profile.
type updateProfileRequest struct {
	DisplayName *string `json:"display_name"`
	LastName    *string `json:"last_name"`
	Bio         *string `json:"bio"`
}

// HandleGetProfile handles GET /api/v1/users/{id}/profile.
// Public to authenticated users: username, display_name, last_name, bio, avatar_updated_at.
func (h *UserHandler) HandleGetProfile() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetUserID := r.PathValue("id")
		if targetUserID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "user id is required")
			return
		}

		user, err := h.userUC.GetProfile(r.Context(), targetUserID)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		responseData := map[string]interface{}{
			"user_id":      user.ID,
			"last_seen_at": user.LastSeenAt,
			"online":       false,
		}
		if h.presenceChecker != nil {
			responseData["online"] = h.presenceChecker.IsUserOnline(user.ID)
		}
		if user.Username != nil {
			responseData["username"] = *user.Username
		}
		if user.DisplayName != nil {
			responseData["display_name"] = *user.DisplayName
		}
		if user.LastName != nil {
			responseData["last_name"] = *user.LastName
		}
		if user.Bio != nil {
			responseData["bio"] = *user.Bio
		}
		if user.AvatarUpdatedAt != nil {
			responseData["avatar_updated_at"] = *user.AvatarUpdatedAt
		}

		WriteSuccess(w, http.StatusOK, responseData, nil)
	}
}

// HandleUpdateProfile handles PUT /api/v1/users/me/profile.
func (h *UserHandler) HandleUpdateProfile() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		var req updateProfileRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "invalid request body")
			return
		}

		user, err := h.userUC.UpdateProfile(r.Context(), userID, req.DisplayName, req.LastName, req.Bio)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		responseData := map[string]interface{}{
			"user_id": user.ID,
		}
		if user.Username != nil {
			responseData["username"] = *user.Username
		}
		if user.DisplayName != nil {
			responseData["display_name"] = *user.DisplayName
		}
		if user.LastName != nil {
			responseData["last_name"] = *user.LastName
		}
		if user.Bio != nil {
			responseData["bio"] = *user.Bio
		}
		if user.AvatarUpdatedAt != nil {
			responseData["avatar_updated_at"] = *user.AvatarUpdatedAt
		}

		WriteSuccess(w, http.StatusOK, responseData, nil)
	}
}

// HandleUploadAvatar handles POST /api/v1/users/me/avatar.
// Accepts multipart/form-data or raw image binary body up to 2MB.
func (h *UserHandler) HandleUploadAvatar() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		// Limit upload body size to 2MB + 1KB headroom.
		r.Body = http.MaxBytesReader(w, r.Body, domain.MaxAvatarSizeBytes+1024)

		var data []byte
		var mimeType string

		contentType := r.Header.Get("Content-Type")
		if strings.HasPrefix(contentType, "multipart/form-data") {
			if err := r.ParseMultipartForm(domain.MaxAvatarSizeBytes + 1024); err != nil {
				WriteError(w, http.StatusBadRequest, string(domain.ErrUsr006), "avatar image exceeds 2MB limit or invalid multipart form")
				return
			}
			file, header, err := r.FormFile("avatar")
			if err != nil {
				file, header, err = r.FormFile("file")
			}
			if err != nil {
				WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "missing 'avatar' or 'file' in multipart form")
				return
			}
			defer file.Close()

			mimeType = header.Header.Get("Content-Type")
			fileBytes, err := io.ReadAll(file)
			if err != nil {
				WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "failed to read uploaded file")
				return
			}
			data = fileBytes
		} else {
			mimeType = contentType
			bodyBytes, err := io.ReadAll(r.Body)
			if err != nil {
				WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "failed to read request body")
				return
			}
			data = bodyBytes
		}

		// If MIME type is not set or generic, sniff content
		if mimeType == "" || mimeType == "application/octet-stream" {
			mimeType = http.DetectContentType(data)
		}
		if idx := strings.Index(mimeType, ";"); idx != -1 {
			mimeType = strings.TrimSpace(mimeType[:idx])
		}

		user, err := h.userUC.UploadAvatar(r.Context(), userID, mimeType, data)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		updatedAt := int64(0)
		if user.AvatarUpdatedAt != nil {
			updatedAt = *user.AvatarUpdatedAt
		}

		WriteSuccess(w, http.StatusOK, map[string]interface{}{
			"avatar_url":        "/api/v1/users/" + user.ID + "/avatar",
			"avatar_updated_at": updatedAt,
		}, nil)
	}
}

// HandleGetAvatar handles GET /api/v1/users/{id}/avatar.
// Serves avatar images with ETag and 304 Not Modified caching.
func (h *UserHandler) HandleGetAvatar() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		targetUserID := r.PathValue("id")
		if targetUserID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "user id is required")
			return
		}

		data, mimeType, updatedAt, err := h.userUC.GetAvatar(r.Context(), targetUserID)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		etag := fmt.Sprintf("\"avatar-%d\"", updatedAt)
		if match := r.Header.Get("If-None-Match"); match == etag {
			w.WriteHeader(http.StatusNotModified)
			return
		}

		w.Header().Set("Content-Type", mimeType)
		w.Header().Set("ETag", etag)
		w.Header().Set("Cache-Control", "public, max-age=86400, stale-while-revalidate=3600")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(data)
	}
}

// HandleDeleteAvatar handles DELETE /api/v1/users/me/avatar.
func (h *UserHandler) HandleDeleteAvatar() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", authFailMessage)
			return
		}

		_, err := h.userUC.DeleteAvatar(r.Context(), userID)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusOK, map[string]interface{}{
			"deleted": true,
		}, nil)
	}
}
