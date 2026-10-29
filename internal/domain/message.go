package domain

// Envelope type constants for the WebSocket protocol.
// RFC-0005 §4.1, §5.1, §6.1, §6.3.
const (
	EnvelopeTypeAuth         = "auth"
	EnvelopeTypeChatMsg      = "chat.msg"
	EnvelopeTypeAckServer    = "ack.server"
	EnvelopeTypeAckClient    = "ack.client"
	EnvelopeTypeAckDelivered = "ack.delivered"
	EnvelopeTypeAckRead      = "ack.read"
	EnvelopeTypeGroupMsg     = "group.msg"
	EnvelopeTypeConvCleared  = "conv.cleared"
	EnvelopeTypeConvDeleted  = "conv.deleted"
)

// ErrMessageDuplicate indicates a duplicate message (idempotent no-op).
var ErrMessageDuplicate = NewDomainError(ErrDB002, "message already exists (idempotent)", nil)


// Message represents a transient delivery queue entry.
// RFC-0005 §7: Transient Queue Database Contract.
// The server stores ONLY the minimum routing metadata.
// Zero-Knowledge Mandate: no plaintext envelopes, filenames, or MIME types.
// No struct tags (Clean Architecture).
type Message struct {
	ServerID         int64  // Auto-increment PK for cursor pagination (RFC-0006 §4.2)
	ClientUUID       string // UUIDv4 — UNIQUE, idempotency key
	SenderID         string // FK -> users.id
	ReceiverID       string // FK -> users.id
	EncryptedPayload []byte // Strictly opaque ciphertext (BLOB)
	SequenceNumber   int64  // Cryptographic sequence number
	CreatedAt        int64  // UNIX Epoch UTC
}

// MessageRouter abstracts live message delivery to connected clients.
// RFC-0005 §6.2: Atomic Delivery Decision (Live vs Queue).
// RFC-0001A §2: Interface belongs to the consumer (Domain layer).
type MessageRouter interface {
	// Route attempts to deliver data to an online user's write queue.
	// Returns true if the user is online and the data was enqueued to their
	// write channel (Live Delivery). Returns false if the user is offline.
	Route(userID string, data []byte) bool
}

// DeliveryAck represents a persistent delivery confirmation for a sender.
type DeliveryAck struct {
	ID        int64  `json:"id" db:"id"`
	SenderID  string `json:"sender_id" db:"sender_id"`
	RequestID string `json:"request_id" db:"request_id"`
	CreatedAt int64  `json:"created_at" db:"created_at"`
}

