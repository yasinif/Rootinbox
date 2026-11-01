// Package domain defines core business interfaces, entities, and error models.
// RFC-0001 Section 3: domain has 0 external dependencies.
package domain

import "fmt"

// ErrorCode represents a standard domain error code.
// RFC-0001 Section 4: Define base errors in Domain.
type ErrorCode string

const (
	// ErrSys500 indicates an internal server error.
	ErrSys500 ErrorCode = "SYS_500"
	// ErrSys001 indicates an unspecified system error.
	ErrSys001 ErrorCode = "SYS_001"
	// ErrDB001 indicates a database connection error.
	ErrDB001 ErrorCode = "DB_001"
	// ErrDB002 indicates a database query error.
	ErrDB002 ErrorCode = "DB_002"
	// ErrCfg001 indicates a configuration error.
	ErrCfg001 ErrorCode = "CFG_001"

	// Phase 2 error codes (RFC-0002 domain operations).

	// ErrUsr001 indicates a user was not found.
	ErrUsr001 ErrorCode = "USR_001"
	// ErrUsr002 indicates a user already exists (identity_hash uniqueness violation).
	ErrUsr002 ErrorCode = "USR_002"
	// ErrUsr003 indicates a username is already taken (Amendment RFC-0002-A).
	ErrUsr003 ErrorCode = "USR_003"
	// ErrUsr004 indicates an invalid username format (Amendment RFC-0002-A).
	ErrUsr004 ErrorCode = "USR_004"
	// ErrUsr005 indicates an unsupported avatar image format (Bundle 4).
	ErrUsr005 ErrorCode = "USR_005"
	// ErrUsr006 indicates avatar image exceeds maximum allowed size (Bundle 4).
	ErrUsr006 ErrorCode = "USR_006"
	// ErrConv001 indicates a conversation was not found.
	ErrConv001 ErrorCode = "CONV_001"
	// ErrPart001 indicates a participant was not found.
	ErrPart001 ErrorCode = "PART_001"

	// Phase 4 error codes (RFC-0004 authentication).

	// ErrAuth001 is the uniform authentication failure code.
	// RFC-0004 §8.2: ALL auth failures MUST return this identical code.
	ErrAuth001 ErrorCode = "AUTH_001"

	// Phase 6 error codes (RFC-0006 sync & vaults).

	// ErrVault001 indicates a vault conflict (immutability violation or not found).
	// RFC-0006 §4.3: Server MUST reject overwriting an existing finalized Vault (HTTP 409).
	ErrVault001 ErrorCode = "VAULT_001"

	// ErrVault002 indicates a vault upload integrity failure (hash mismatch).
	// RFC-0006 §6 (F2): SHA-256 hash verification against X-Vault-Hash.
	ErrVault002 ErrorCode = "VAULT_002"

	// ErrVault003 indicates a vault was not found.
	ErrVault003 ErrorCode = "VAULT_003"

	// Phase 7 error codes (RFC-0007 media).

	// ErrMedia001 indicates a media file not found.
	// RFC-0007 §7.1: No existence leakage — return 404 for both missing and other-user files.
	ErrMedia001 ErrorCode = "MEDIA_001"

	// ErrMedia002 indicates a media conflict (status mismatch, parameter mismatch, OCC failure).
	// RFC-0007 §7.1/§7.2: 409 Conflict for state/parameter violations.
	ErrMedia002 ErrorCode = "MEDIA_002"

	// ErrMedia003 indicates quota exceeded.
	// RFC-0007 §8.2: 413 Payload Too Large when quota is exceeded.
	ErrMedia003 ErrorCode = "MEDIA_003"

	// ErrMedia004 indicates a media integrity failure (hash mismatch, size mismatch).
	// RFC-0007 §7.2/§7.3: 400 Bad Request for hash/size violations.
	ErrMedia004 ErrorCode = "MEDIA_004"

	// Phase 8 error codes (RFC-0008 calls).

	// ErrCall001 indicates a call not found.
	ErrCall001 ErrorCode = "CALL_001"

	// ErrCall002 indicates a call conflict (busy, fingerprint mismatch, glare).
	// RFC-0008 §7.2: 409 Conflict.
	ErrCall002 ErrorCode = "CALL_002"

	// ErrCall003 indicates call authorization failure.
	// Maps to stale error without revealing call existence.
	ErrCall003 ErrorCode = "CALL_003"

	// Phase 9 error codes (RFC-0009 push notifications).

	// ErrPush001 indicates a subscription or application key was not found.
	ErrPush001 ErrorCode = "PUSH_001"
	// ErrPush002 indicates VAPID key decryption/encoding failure (bootstrap-fatal).
	ErrPush002 ErrorCode = "PUSH_002"
	// ErrPush003 indicates an invalid subscription payload.
	ErrPush003 ErrorCode = "PUSH_003"
	// ErrPush004 indicates Web Push encryption or dispatch failure.
	ErrPush004 ErrorCode = "PUSH_004"
	// ErrPush005 indicates fixed-record-size assertion failed (ADR-P9-6).
	ErrPush005 ErrorCode = "PUSH_005"
	// ErrRing001 indicates no pending call offer, expired, or session mismatch.
	ErrRing001 ErrorCode = "RING_001"

	// Phase 10 error codes (RFC-0011 & RFC-0014 security & admin).

	// ErrSec001 indicates Rate limit exceeded.
	ErrSec001 ErrorCode = "SEC_001"
	// ErrSec002 indicates Request body exceeds ceiling.
	ErrSec002 ErrorCode = "SEC_002"
	// ErrSec003 indicates WebSocket Origin rejected.
	ErrSec003 ErrorCode = "SEC_003"
	// ErrAdm001 indicates Admin authentication failed (uniform).
	ErrAdm001 ErrorCode = "ADM_001"
	// ErrAdm002 indicates Invalid admin state transition.
	ErrAdm002 ErrorCode = "ADM_002"
	// ErrAdm003 indicates Missing or invalid confirmation token.
	ErrAdm003 ErrorCode = "ADM_003"
	// ErrAdm004 indicates Admin operation failed.
	ErrAdm004 ErrorCode = "ADM_004"
	// ErrAdm005 indicates Invalid admin query parameter.
	ErrAdm005 ErrorCode = "ADM_005"
	// ErrAdm006 indicates IP blocked.
	ErrAdm006 ErrorCode = "ADM_006"

	// Phase 13 error codes.

	// ErrGrp001 indicates a group/channel not found or unauthorized.
	ErrGrp001 ErrorCode = "GRP_001"
	// ErrGrp002 indicates a group/channel permission denied.
	ErrGrp002 ErrorCode = "GRP_002"
	// ErrGrp003 indicates a group/channel member limit exceeded.
	ErrGrp003 ErrorCode = "GRP_003"
	// ErrMsg001 indicates a message was not found.
	ErrMsg001 ErrorCode = "MSG_001"

	// Phase 14 error codes (Active Sessions).
	ErrSess001 ErrorCode = "SESS_001" // Session not found
	ErrSess002 ErrorCode = "SESS_002" // Invalid session operation
)

// DomainError is the standard error type returned by use cases.
// Delivery maps these to HTTP statuses.
type DomainError struct {
	Code    ErrorCode
	Message string
	Err     error
}

// Error implements the error interface.
func (e *DomainError) Error() string {
	if e.Err != nil {
		return fmt.Sprintf("[%s] %s: %v", e.Code, e.Message, e.Err)
	}
	return fmt.Sprintf("[%s] %s", e.Code, e.Message)
}

// Unwrap returns the underlying error for errors.Is/As compatibility.
func (e *DomainError) Unwrap() error {
	return e.Err
}

// NewDomainError creates a new DomainError with the given code, message, and optional underlying error.
func NewDomainError(code ErrorCode, message string, err error) *DomainError {
	return &DomainError{Code: code, Message: message, Err: err}
}
