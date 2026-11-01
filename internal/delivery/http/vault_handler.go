package http

import (
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"

	"rootinbox/internal/usecase"
)

// VaultHandler handles vault HTTP endpoints.
// RFC-0006 §4.3: Vault Archival Lifecycle.
type VaultHandler struct {
	vaultUC *usecase.VaultUseCase
}

// NewVaultHandler creates a new VaultHandler.
func NewVaultHandler(vaultUC *usecase.VaultUseCase) *VaultHandler {
	return &VaultHandler{vaultUC: vaultUC}
}

// vaultMetadataResponse represents vault metadata in API responses.
type vaultMetadataResponse struct {
	ID            string `json:"id"`
	MonthYear     string `json:"month_year"`
	ContentHash   string `json:"content_hash"`
	SchemaVersion int    `json:"schema_version"`
	CreatedAt     int64  `json:"created_at"`
}

// HandleUpload handles PUT /api/v1/vaults/{month_year}.
// RFC-0006 §4.3: Vault upload with staging, hash verification, immutability.
// RFC-0006 §6 (F2): Complete reception, Content-Length validation, SHA-256 verification, atomic commit.
func (h *VaultHandler) HandleUpload() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "authentication required")
			return
		}

		// Extract month_year from path.
		monthYear := r.PathValue("month_year")
		if monthYear == "" {
			WriteError(w, http.StatusBadRequest, "SYS_001", "month_year is required")
			return
		}

		// Extract X-Vault-Hash header.
		// RFC-0006 §4.3: Client calculates SHA-256(Ciphertext) and attaches via X-Vault-Hash.
		expectedHash := r.Header.Get("X-Vault-Hash")
		if expectedHash == "" {
			WriteError(w, http.StatusBadRequest, "SYS_001", "X-Vault-Hash header is required")
			return
		}

		// Extract schema version (default 1).
		schemaVersion := 1
		if sv := r.Header.Get("X-Vault-Schema-Version"); sv != "" {
			if parsed, err := strconv.Atoi(sv); err == nil && parsed > 0 {
				schemaVersion = parsed
			}
		}

		// Read body (ciphertext).
		// RFC-0006 §6 (F2): Complete byte reception.
		// Limit to 50MB to prevent memory exhaustion.
		body, err := io.ReadAll(io.LimitReader(r.Body, 50*1024*1024+1))
		if err != nil {
			WriteError(w, http.StatusBadRequest, "SYS_001", "failed to read request body")
			return
		}
		if len(body) > 50*1024*1024 {
			WriteError(w, http.StatusRequestEntityTooLarge, "SYS_001", "vault data exceeds maximum size")
			return
		}
		if len(body) == 0 {
			WriteError(w, http.StatusBadRequest, "SYS_001", "vault data is required")
			return
		}

		// Upload via use case (staging + hash verification + atomic commit).
		vault, err := h.vaultUC.UploadVault(r.Context(), userID, monthYear, body, expectedHash, schemaVersion)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		WriteSuccess(w, http.StatusCreated, vaultMetadataResponse{
			ID:            vault.ID,
			MonthYear:     vault.MonthYear,
			ContentHash:   vault.ContentHash,
			SchemaVersion: vault.SchemaVersion,
			CreatedAt:     vault.CreatedAt,
		}, nil)
	}
}

// HandleDownload handles GET /api/v1/vaults/{month_year}.
// Returns raw ciphertext bytes for vault recovery.
func (h *VaultHandler) HandleDownload() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "authentication required")
			return
		}

		monthYear := r.PathValue("month_year")
		if monthYear == "" {
			WriteError(w, http.StatusBadRequest, "SYS_001", "month_year is required")
			return
		}

		vault, err := h.vaultUC.GetVault(r.Context(), userID, monthYear)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		w.Header().Set("Content-Type", "application/octet-stream")
		w.Header().Set("X-Vault-Hash", vault.ContentHash)
		w.Header().Set("X-Vault-Schema-Version", strconv.Itoa(vault.SchemaVersion))
		w.WriteHeader(http.StatusOK)
		w.Write(vault.EncryptedData)
	}
}

// HandleList handles GET /api/v1/vaults.
// Returns vault metadata list (no BLOB data).
func (h *VaultHandler) HandleList() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "authentication required")
			return
		}

		vaults, err := h.vaultUC.ListVaults(r.Context(), userID)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		resp := make([]vaultMetadataResponse, len(vaults))
		for i, v := range vaults {
			resp[i] = vaultMetadataResponse{
				ID:            v.ID,
				MonthYear:     v.MonthYear,
				ContentHash:   v.ContentHash,
				SchemaVersion: v.SchemaVersion,
				CreatedAt:     v.CreatedAt,
			}
		}

		WriteSuccess(w, http.StatusOK, resp, nil)
	}
}

type putZKVaultRequest struct {
	ExpectedVersion *int   `json:"expected_version"`
	Ciphertext      string `json:"ciphertext"` // hex or base64 string
	Signature       string `json:"signature"`  // hex signature
}

// HandleGetZKVault handles GET /api/v1/vault/current.
// RFC Stage 1a: Returns the user's Zero-Knowledge Vault with ETag.
func (h *VaultHandler) HandleGetZKVault() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "authentication required")
			return
		}

		vault, err := h.vaultUC.GetZKVault(r.Context(), userID)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		w.Header().Set("ETag", fmt.Sprintf("\"%d\"", vault.Version))
		WriteSuccess(w, http.StatusOK, map[string]any{
			"user_id":    vault.UserID,
			"version":    vault.Version,
			"ciphertext": hex.EncodeToString(vault.Ciphertext),
			"signature":  vault.Signature,
			"updated_at": vault.UpdatedAt,
		}, nil)
	}
}

// HandlePutZKVault handles PUT /api/v1/vault/current.
// RFC Stage 1a: Updates the user's Zero-Knowledge Vault with optimistic concurrency control.
func (h *VaultHandler) HandlePutZKVault() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID, ok := userIDFromRequest(r)
		if !ok {
			WriteError(w, http.StatusUnauthorized, "AUTH_001", "authentication required")
			return
		}

		var req putZKVaultRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			WriteError(w, http.StatusBadRequest, "SYS_001", "invalid request body")
			return
		}

		expectedVersion := 0
		if ifMatch := r.Header.Get("If-Match"); ifMatch != "" {
			trimmed := strings.Trim(ifMatch, "\" ")
			if v, err := strconv.Atoi(trimmed); err == nil && v >= 0 {
				expectedVersion = v
			}
		} else if req.ExpectedVersion != nil {
			expectedVersion = *req.ExpectedVersion
		}

		ciphertextBytes, err := hex.DecodeString(req.Ciphertext)
		if err != nil {
			// Try base64 fallback
			if b64Bytes, b64Err := base64.RawURLEncoding.DecodeString(req.Ciphertext); b64Err == nil {
				ciphertextBytes = b64Bytes
			} else if stdBytes, stdErr := base64.StdEncoding.DecodeString(req.Ciphertext); stdErr == nil {
				ciphertextBytes = stdBytes
			} else {
				WriteError(w, http.StatusBadRequest, "SYS_001", "invalid ciphertext encoding (must be hex or base64)")
				return
			}
		}

		vault, err := h.vaultUC.SaveZKVault(r.Context(), userID, expectedVersion, ciphertextBytes, req.Signature)
		if err != nil {
			WriteDomainError(w, err)
			return
		}

		w.Header().Set("ETag", fmt.Sprintf("\"%d\"", vault.Version))
		WriteSuccess(w, http.StatusOK, map[string]any{
			"user_id":    vault.UserID,
			"version":    vault.Version,
			"ciphertext": hex.EncodeToString(vault.Ciphertext),
			"signature":  vault.Signature,
			"updated_at": vault.UpdatedAt,
		}, nil)
	}
}
