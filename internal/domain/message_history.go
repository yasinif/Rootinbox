package domain

import "context"

// HistoryMessage represents an archived E2EE message encrypted with the user's vault key.
// Zero-Knowledge invariant: Server stores vault-ciphertext and IV only.
type HistoryMessage struct {
	ID               string  `json:"id" db:"id"`
	UserID           string  `json:"user_id" db:"user_id"`
	ConversationID   string  `json:"conversation_id" db:"conversation_id"`
	SenderID         string  `json:"sender_id" db:"sender_id"`
	ReceiverID       *string `json:"receiver_id,omitempty" db:"receiver_id"`
	EncryptedPayload []byte  `json:"encrypted_payload" db:"encrypted_payload"`
	VaultIV          []byte  `json:"vault_iv" db:"vault_iv"`
	SequenceNumber   int64   `json:"sequence_number" db:"sequence_number"`
	CreatedAt        int64   `json:"created_at" db:"created_at"`
	UpdatedAt        *int64  `json:"updated_at,omitempty" db:"updated_at"`
	DeletedAt        *int64  `json:"deleted_at,omitempty" db:"deleted_at"`
}

// MessageHistoryRepository defines persistence methods for the E2EE vault history archive.
type MessageHistoryRepository interface {
	Save(ctx context.Context, msg *HistoryMessage) error
	SaveBatch(ctx context.Context, msgs []*HistoryMessage) error
	ListByUserAndConversation(ctx context.Context, userID, convID string, cursor int64, limit int) ([]*HistoryMessage, error)
	Tombstone(ctx context.Context, userID, convID, messageID string, nowUnix int64) error
	TombstoneForBoth(ctx context.Context, convID, messageID string, nowUnix int64) error
	TombstoneAllInConversationForUser(ctx context.Context, userID, convID string, nowUnix int64) error
	TombstoneAllInConversationForBoth(ctx context.Context, convID string, nowUnix int64) error
	HardDeleteAllInConversation(ctx context.Context, convID string) error
}
