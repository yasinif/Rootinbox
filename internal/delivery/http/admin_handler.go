package http

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"rootinbox/internal/config"
	"rootinbox/internal/domain"
	"rootinbox/internal/usecase"
)

type AdminHandler struct {
	adminUC *usecase.AdminUseCase
}

func NewAdminHandler(adminUC *usecase.AdminUseCase) *AdminHandler {
	return &AdminHandler{adminUC: adminUC}
}

type confirmRequest struct {
	Action string `json:"action"`
	Target string `json:"target"`
}

type tombstoneRequest struct {
	Token string `json:"token"`
}

// HandleSuspendUser handles POST /api/v1/admin/users/{identity_hash}/suspend
func (h *AdminHandler) HandleSuspendUser() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := r.PathValue("identity_hash")
		if userID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "missing identity_hash")
			return
		}

		if err := h.adminUC.SuspendUser(r.Context(), userID); err != nil {
			WriteDomainError(w, err)
			return
		}
		WriteSuccess(w, http.StatusOK, map[string]string{"status": "suspended"}, nil)
	}
}

// HandleResumeUser handles POST /api/v1/admin/users/{identity_hash}/resume
func (h *AdminHandler) HandleResumeUser() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := r.PathValue("identity_hash")
		if userID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "missing identity_hash")
			return
		}

		if err := h.adminUC.ResumeUser(r.Context(), userID); err != nil {
			WriteDomainError(w, err)
			return
		}
		WriteSuccess(w, http.StatusOK, map[string]string{"status": "active"}, nil)
	}
}

// HandleTombstoneUser handles POST /api/v1/admin/users/{identity_hash}/tombstone
func (h *AdminHandler) HandleTombstoneUser() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := r.PathValue("identity_hash")
		if userID == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "missing identity_hash")
			return
		}

		var req tombstoneRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Token == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "invalid request format or missing token")
			return
		}

		if err := h.adminUC.TombstoneUser(r.Context(), userID, req.Token); err != nil {
			WriteDomainError(w, err)
			return
		}
		WriteSuccess(w, http.StatusOK, map[string]string{"status": "tombstoned"}, nil)
	}
}

// HandleBanIP handles POST /api/v1/admin/ip-blocks/{ip_hash}/ban
func (h *AdminHandler) HandleBanIP() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ipHash := r.PathValue("ip_hash")
		if ipHash == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "missing ip_hash")
			return
		}

		if err := h.adminUC.BanIP(r.Context(), ipHash); err != nil {
			WriteDomainError(w, err)
			return
		}
		WriteSuccess(w, http.StatusOK, map[string]string{"status": "banned"}, nil)
	}
}

// HandleUnbanIP handles POST /api/v1/admin/ip-blocks/{ip_hash}/unban
func (h *AdminHandler) HandleUnbanIP() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ipHash := r.PathValue("ip_hash")
		if ipHash == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "missing ip_hash")
			return
		}

		if err := h.adminUC.UnbanIP(r.Context(), ipHash); err != nil {
			WriteDomainError(w, err)
			return
		}
		WriteSuccess(w, http.StatusOK, map[string]string{"status": "unbanned"}, nil)
	}
}

// HandleListBlockedIPs handles GET /api/v1/admin/ip/blocks
func (h *AdminHandler) HandleListBlockedIPs() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		blocks, err := h.adminUC.ListBlockedIPs(r.Context())
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		// Return array even if empty
		if blocks == nil {
			blocks = []*domain.IPBlock{}
		}
		WriteSuccess(w, http.StatusOK, blocks, nil)
	}
}

// HandleQueryAuditLogs handles GET /api/v1/admin/audit-events
func (h *AdminHandler) HandleQueryAuditLogs() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Parse query params
		filter := domain.SecurityEventFilter{
			Limit: 50,
		}

		q := r.URL.Query()
		if et := q.Get("event_type"); et != "" {
			etyp := domain.SecurityEventType(et)
			filter.EventType = &etyp
		}
		if iph := q.Get("ip_hash"); iph != "" {
			filter.IPHash = &iph
		}
		if id := q.Get("user_id"); id != "" {
			filter.IdentityHash = &id
		}
		if l := q.Get("limit"); l != "" {
			if lim, err := strconv.Atoi(l); err == nil && lim > 0 && lim <= 100 {
				filter.Limit = lim
			}
		}
		if c := q.Get("cursor"); c != "" {
			filter.Cursor = &c
		}

		st := q.Get("start_time")
		et := q.Get("end_time")

		if st == "" {
			// 90 days default range
			now := time.Now().Unix()
			start := now - (90 * 24 * 3600)
			filter.StartTime = &start
			filter.EndTime = &now
		} else {
			if sti, err := strconv.ParseInt(st, 10, 64); err == nil {
				filter.StartTime = &sti
			}
			if et != "" {
				if eti, err := strconv.ParseInt(et, 10, 64); err == nil {
					filter.EndTime = &eti
				}
			}
		}
		events, nextCursor, err := h.adminUC.QueryAuditLogs(r.Context(), filter)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		if events == nil {
			events = []*domain.SecurityEvent{}
		}

		meta := make(map[string]interface{})
		if nextCursor != nil {
			meta["next_cursor"] = *nextCursor
		}

		WriteSuccess(w, http.StatusOK, events, meta)
	}
}

// HandleGenerateConfirmation handles POST /api/v1/admin/confirmations
func (h *AdminHandler) HandleGenerateConfirmation() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req confirmRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Action == "" || req.Target == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "invalid request format")
			return
		}

		token, err := h.adminUC.GenerateConfirmation(r.Context(), req.Action, req.Target)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusOK, map[string]string{"token": token}, nil)
	}
}

// HandleTriggerWorker handles POST /api/v1/admin/workers/{name}/trigger
func (h *AdminHandler) HandleTriggerWorker() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		workerName := r.PathValue("name")
		if workerName == "" {
			WriteError(w, http.StatusBadRequest, string(domain.ErrSys001), "missing worker name")
			return
		}

		opID, err := h.adminUC.TriggerWorker(r.Context(), workerName)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusAccepted, map[string]string{"operation_id": opID}, nil)
	}
}

// HandleGetWarnings handles GET /api/v1/admin/warnings.
// Returns non-fatal operational and configuration warnings without exposing any secrets.
func (h *AdminHandler) HandleGetWarnings(cfg *config.Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		warnings := cfg.Warnings
		if warnings == nil {
			warnings = []string{}
		}
		WriteSuccess(w, http.StatusOK, map[string]interface{}{
			"warnings": warnings,
		}, nil)
	}
}
