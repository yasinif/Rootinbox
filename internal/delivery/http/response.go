package http

import (
	"encoding/json"
	"errors"
	"net/http"

	"rootinbox/internal/domain"
)

// SuccessResponse is the standard success response envelope.
// RFC-0002 §4.4: All REST endpoints MUST wrap responses.
// The meta object is MANDATORY (returns {} if empty).
type SuccessResponse struct {
	Data any `json:"data"`
	Meta any `json:"meta"`
}

// ErrorResponse is the standard error response envelope.
// RFC-0002 §4.4: Error Response Envelope (4xx, 5xx).
type ErrorResponse struct {
	Error ErrorDetail `json:"error"`
}

// ErrorDetail contains the error code and client-safe message.
// RFC-0002 §4.4: Internal states/logs MUST NOT be exposed.
type ErrorDetail struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

// PaginationMeta is the meta object for paginated responses.
// RFC-0002 §4.5: Cursor-based pagination response contract.
type PaginationMeta struct {
	Pagination *PaginationInfo `json:"pagination"`
}

// PaginationInfo contains cursor pagination details.
// RFC-0002 §4.5: next_cursor is null if end of list.
type PaginationInfo struct {
	NextCursor *string `json:"next_cursor"`
	HasMore    bool    `json:"has_more"`
}

// EmptyMeta returns an empty meta object.
// RFC-0002 §4.4: The meta object is MANDATORY (returns {} if empty).
func EmptyMeta() any {
	return struct{}{}
}

// WriteSuccess writes a success response with the standard envelope.
func WriteSuccess(w http.ResponseWriter, status int, data any, meta any) {
	if meta == nil {
		meta = EmptyMeta()
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(SuccessResponse{
		Data: data,
		Meta: meta,
	})
}

// WriteError writes an error response with the standard envelope.
// RFC-0002 §4.4: Internal states/logs MUST NOT be exposed.
func WriteError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(ErrorResponse{
		Error: ErrorDetail{
			Code:    code,
			Message: message,
		},
	})
}

// WriteDomainError maps a domain error to the appropriate HTTP response.
// RFC-0001 §4: UseCases return Domain errors, Delivery maps them to HTTP statuses.
// RFC-0001A §4.3: delivery maps Domain errors to transport-specific responses.
func WriteDomainError(w http.ResponseWriter, err error) {
	var de *domain.DomainError
	if errors.As(err, &de) {
		status := httpStatusFromCode(de.Code)
		WriteError(w, status, string(de.Code), de.Message)
		return
	}
	// Fallback: unknown error becomes SYS_500.
	WriteError(w, http.StatusInternalServerError, string(domain.ErrSys500), "internal server error")
}

// httpStatusFromCode maps domain error codes to HTTP status codes.
func httpStatusFromCode(code domain.ErrorCode) int {
	switch code {
	case domain.ErrUsr001, domain.ErrConv001, domain.ErrPart001, domain.ErrMedia001, domain.ErrCall001, domain.ErrCall003, domain.ErrPush001, domain.ErrRing001, domain.ErrSess001, domain.ErrVault003:
		return http.StatusNotFound
	case domain.ErrUsr002, domain.ErrUsr003, domain.ErrVault001, domain.ErrMedia002, domain.ErrCall002, domain.ErrAdm002, domain.ErrAdm003:
		return http.StatusConflict
	case domain.ErrAuth001, domain.ErrAdm001:
		return http.StatusUnauthorized
	case domain.ErrSys001, domain.ErrUsr004, domain.ErrVault002, domain.ErrMedia004, domain.ErrPush003, domain.ErrAdm005, domain.ErrSess002:
		return http.StatusBadRequest
	case domain.ErrUsr005:
		return http.StatusUnsupportedMediaType
	case domain.ErrMedia003, domain.ErrSec002, domain.ErrUsr006:
		return http.StatusRequestEntityTooLarge
	case domain.ErrSec001:
		return http.StatusTooManyRequests
	case domain.ErrSec003, domain.ErrAdm006:
		return http.StatusForbidden
	case domain.ErrSys500, domain.ErrDB001, domain.ErrDB002, domain.ErrCfg001, domain.ErrPush002, domain.ErrPush004, domain.ErrPush005, domain.ErrAdm004:
		return http.StatusInternalServerError
	default:
		return http.StatusInternalServerError
	}
}
