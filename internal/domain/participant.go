package domain

// ParticipantRole represents the role of a user in a conversation.
// RFC-0002 §4.1: Domain Entity contract.
type ParticipantRole string

const (
	RoleOwner      ParticipantRole = "OWNER"
	RoleAdmin      ParticipantRole = "ADMIN"
	RoleMember     ParticipantRole = "MEMBER"
	RoleSubscriber ParticipantRole = "SUBSCRIBER" // Amendment RFC-0007-B: Read-only for CHANNEL
)

// Participant represents a user's membership in a conversation.
// RFC-0002 §4.1: No database/SQL tags allowed (Clean Architecture).
type Participant struct {
	ConversationID string
	UserID         string
	Role           ParticipantRole
	JoinedAt       int64
}
