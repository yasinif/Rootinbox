package domain

type SecurityEventType string

const (
	EventAuthSuccess       SecurityEventType = "AUTH_SUCCESS"
	EventAuthFailure       SecurityEventType = "AUTH_FAILURE"
	EventSessionRevoked    SecurityEventType = "SESSION_REVOKED"
	EventIdentityMigration SecurityEventType = "IDENTITY_MIGRATION"
	EventRateLimitTripped  SecurityEventType = "RATE_LIMIT_TRIPPED"
	EventWSOriginRejected  SecurityEventType = "WS_ORIGIN_REJECTED"
	EventQuotaExceeded     SecurityEventType = "QUOTA_EXCEEDED"
	EventMediaTokenIssued  SecurityEventType = "MEDIA_TOKEN_ISSUED"
	EventAdminAction       SecurityEventType = "ADMIN_ACTION"
)

func IsValidSecurityEventType(t SecurityEventType) bool {
	switch t {
	case EventAuthSuccess, EventAuthFailure, EventSessionRevoked, EventIdentityMigration,
		EventRateLimitTripped, EventWSOriginRejected, EventQuotaExceeded, EventMediaTokenIssued, EventAdminAction:
		return true
	default:
		return false
	}
}

type AdminAction string

const (
	AdminActionSuspend         AdminAction = "SUSPEND"
	AdminActionResume          AdminAction = "RESUME"
	AdminActionTombstone       AdminAction = "TOMBSTONE"
	AdminActionIPBan           AdminAction = "IP_BAN"
	AdminActionIPUnban         AdminAction = "IP_UNBAN"
	AdminActionTriggerAccepted AdminAction = "TRIGGER_ACCEPTED"
	AdminActionAuthCoalesced   AdminAction = "AUTH_COALESCED"
)

func IsValidAdminAction(a AdminAction) bool {
	switch a {
	case AdminActionSuspend, AdminActionResume, AdminActionTombstone, AdminActionIPBan,
		AdminActionIPUnban, AdminActionTriggerAccepted, AdminActionAuthCoalesced:
		return true
	default:
		return false
	}
}

type SecurityEvent struct {
	ID           string
	EventType    SecurityEventType
	IdentityHash *string
	IPHash       *string
	TraceID      *string
	AdminAction  *AdminAction
	CreatedAt    int64
}

type SecurityEventFilter struct {
	EventType    *SecurityEventType
	IdentityHash *string
	IPHash       *string
	StartTime    *int64
	EndTime      *int64
	Cursor       *string
	Limit        int
}
