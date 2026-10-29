package domain

import (
	"strings"
	"unicode/utf8"
)

// GroupMessage represents a plaintext message in a GROUP or CHANNEL conversation.
// Amendment RFC-0007-B: Stored on server without E2EE to support fanout and server history.
type GroupMessage struct {
	ID             string  `json:"id"`
	ConversationID string  `json:"conversation_id"`
	SenderID       string  `json:"sender_id"`
	Content        string  `json:"content"`
	ReplyToID      *string `json:"reply_to_id,omitempty"`
	EditedAt       *int64  `json:"edited_at,omitempty"`
	DeletedAt      *int64  `json:"deleted_at,omitempty"`
	CreatedAt      int64   `json:"created_at"`
	ServerID       int64   `json:"server_id"`
}

// GroupBroadcaster delivers group messages and actions to active participants via WebSocket.
type GroupBroadcaster interface {
	BroadcastGroupMessage(recipientUserIDs []string, msg *GroupMessage)
	BroadcastGroupAction(recipientUserIDs []string, action string, payload map[string]interface{})
}

// IsValidMessageContent validates that incoming message content is valid printable UTF-8
// and rejects raw binary ciphertext blobs containing replacement characters or binary control bytes.
func IsValidMessageContent(content string) bool {
	if !utf8.ValidString(content) || strings.ContainsRune(content, '\uFFFD') {
		return false
	}
	for i := 0; i < len(content); i++ {
		b := content[i]
		if (b <= 0x08) || (b >= 0x0E && b <= 0x1F) {
			return false
		}
	}
	return true
}


