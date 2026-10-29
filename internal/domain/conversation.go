package domain

// ConversationType represents the type of a conversation.
// RFC-0002 §4.1: Domain Entity contract.
type ConversationType string

const (
	ConvTypeDirect  ConversationType = "DIRECT"
	ConvTypeGroup   ConversationType = "GROUP"
	ConvTypeSelf    ConversationType = "SELF"
	ConvTypeChannel ConversationType = "CHANNEL" // Amendment RFC-0007-B: Non-E2EE broadcast
)

// Conversation represents a messaging conversation.
// RFC-0002 §4.1: No database/SQL tags allowed (Clean Architecture).
// Amendment RFC-0007-B: Name, Description, CreatedBy for GROUP and CHANNEL.
type Conversation struct {
	ID          string // Canonical UUIDv4
	Type        ConversationType
	CreatedAt   int64
	Name        *string
	Description *string
	CreatedBy   *string
	IsPublic    bool
	Username    *string
	InviteCode  *string
}

// ConversationReadWatermark represents a user's read and delivery position in a conversation.
type ConversationReadWatermark struct {
	UserID          string `json:"user_id"`
	ConversationID  string `json:"conversation_id"`
	LastReadAt      int64  `json:"last_read_at"`
	LastDeliveredAt int64  `json:"last_delivered_at"`
}

