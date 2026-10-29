package http

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"

	"rootinbox/internal/usecase"
)

// MediaHandler handles media REST endpoints.
// RFC-0007: Zero-Knowledge Media & Attachment Streaming.
type MediaHandler struct {
	mediaUC *usecase.MediaUseCase
}

// NewMediaHandler creates a new MediaHandler.
func NewMediaHandler(mediaUC *usecase.MediaUseCase) *MediaHandler {
	return &MediaHandler{mediaUC: mediaUC}
}

// initRequest is the JSON body for POST /api/v1/media/init.
type initRequest struct {
	FileID      string `json:"file_id"`
	TotalChunks int    `json:"total_chunks"`
	TokenHash   string `json:"token_hash"`
}

// initResponse is the JSON response for POST /api/v1/media/init.
type initResponse struct {
	FileID      string `json:"file_id"`
	TotalChunks int    `json:"total_chunks"`
	Status      string `json:"status"`
	Generation  int64  `json:"generation"`
}

// HandleInit handles POST /api/v1/media/init.
// RFC-0007 §7.1: Initialization (Upload Auth).
func (h *MediaHandler) HandleInit() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "authentication required")
			return
		}

		var req initRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			WriteError(w, http.StatusBadRequest, "SYS_001", "invalid request body")
			return
		}

		file, err := h.mediaUC.Init(r.Context(), userID, req.FileID, req.TotalChunks, req.TokenHash)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusOK, initResponse{
			FileID:      file.FileID,
			TotalChunks: file.TotalChunks,
			Status:      string(file.Status),
			Generation:  file.Generation,
		}, nil)
	}
}

// HandleUploadChunk handles PUT /api/v1/media/upload/{file_id}/{chunk_index}.
// RFC-0007 §7.2: Chunk Upload.
func (h *MediaHandler) HandleUploadChunk() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "authentication required")
			return
		}

		fileID := r.PathValue("file_id")
		chunkIndexStr := r.PathValue("chunk_index")
		if fileID == "" || chunkIndexStr == "" {
			WriteError(w, http.StatusBadRequest, "SYS_001", "file_id and chunk_index are required")
			return
		}

		chunkIndex, err := strconv.Atoi(chunkIndexStr)
		if err != nil {
			WriteError(w, http.StatusBadRequest, "SYS_001", "invalid chunk_index")
			return
		}

		// Read X-Chunk-Hash header.
		clientHash := r.Header.Get("X-Chunk-Hash")
		if clientHash == "" {
			WriteError(w, http.StatusBadRequest, "SYS_001", "X-Chunk-Hash header is required")
			return
		}

		// Read raw body (exact chunk ciphertext).
		// Limit to chunk size + 1 byte to detect oversized uploads.
		const maxSize = 5_242_896 + 1
		body, err := io.ReadAll(io.LimitReader(r.Body, maxSize))
		if err != nil {
			WriteError(w, http.StatusBadRequest, "SYS_001", "failed to read request body")
			return
		}

		if err := h.mediaUC.UploadChunk(r.Context(), userID, fileID, chunkIndex, body, clientHash); err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusOK, map[string]string{"status": "ok"}, nil)
	}
}

// finalizeRequest is the JSON body for POST /api/v1/media/finalize/{file_id}.
type finalizeRequest struct {
	FileManifestHash string `json:"file_manifest_hash"`
}

// HandleFinalize handles POST /api/v1/media/finalize/{file_id}.
// RFC-0007 §7.3: Finalization (2-Phase).
func (h *MediaHandler) HandleFinalize() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "authentication required")
			return
		}

		fileID := r.PathValue("file_id")
		if fileID == "" {
			WriteError(w, http.StatusBadRequest, "SYS_001", "file_id is required")
			return
		}

		var req finalizeRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			WriteError(w, http.StatusBadRequest, "SYS_001", "invalid request body")
			return
		}

		if err := h.mediaUC.Finalize(r.Context(), userID, fileID, req.FileManifestHash); err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusOK, map[string]string{"status": "finalized"}, nil)
	}
}

// HandleDownloadChunk handles GET /api/v1/media/download/{file_id}/{chunk_index}.
// RFC-0007 §7.4: Streaming Download (MCT authorized).
func (h *MediaHandler) HandleDownloadChunk() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Extract Bearer token, X-Media-Token header, or ?token= query parameter.
		mediaToken := ""
		authHeader := r.Header.Get("Authorization")
		if strings.HasPrefix(authHeader, "Bearer ") {
			mediaToken = strings.TrimPrefix(authHeader, "Bearer ")
		} else if token := r.Header.Get("X-Media-Token"); token != "" {
			mediaToken = token
		} else if token := r.URL.Query().Get("token"); token != "" {
			mediaToken = token
		}
		if mediaToken == "" {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "Bearer token required")
			return
		}

		fileID := r.PathValue("file_id")
		chunkIndexStr := r.PathValue("chunk_index")
		if fileID == "" || chunkIndexStr == "" {
			WriteError(w, http.StatusBadRequest, "SYS_001", "file_id and chunk_index are required")
			return
		}

		chunkIndex, err := strconv.Atoi(chunkIndexStr)
		if err != nil {
			WriteError(w, http.StatusBadRequest, "SYS_001", "invalid chunk_index")
			return
		}

		data, err := h.mediaUC.DownloadChunk(r.Context(), mediaToken, fileID, chunkIndex)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("Content-Length", strconv.Itoa(len(data)))
		w.WriteHeader(http.StatusOK)
		w.Write(data)
	}
}

// HandleDelete handles DELETE /api/v1/media/{file_id}.
// RFC-0007 §8.6: Explicit Delete — either MCT or Session auth.
func (h *MediaHandler) HandleDelete() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		fileID := r.PathValue("file_id")
		if fileID == "" {
			WriteError(w, http.StatusBadRequest, "SYS_001", "file_id is required")
			return
		}

		// Extract auth: either session user or Bearer token.
		userID, _ := userIDFromRequest(r)
		var mediaToken string
		authHeader := r.Header.Get("Authorization")
		if strings.HasPrefix(authHeader, "Bearer ") {
			mediaToken = strings.TrimPrefix(authHeader, "Bearer ")
		}

		if userID == "" && mediaToken == "" {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "authentication required")
			return
		}

		if err := h.mediaUC.Delete(r.Context(), userID, mediaToken, fileID); err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusOK, map[string]string{"status": "deleted"}, nil)
	}
}
