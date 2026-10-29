package domain

import "context"

// PushSubscription is a Web Push endpoint registration (RFC-0009 §6.2).
// NOT subject to the Single-Session Rule of RFC-0004 §6 (RFC-0009 §6.4).
// No struct tags (Clean Architecture).
type PushSubscription struct {
	ID         string // Canonical lowercase UUIDv4
	UserID     string // FK -> users.id
	Endpoint   string // Push Service URL, opaque to us
	P256dhKey  string // Base64URL, browser-generated P-256 public key
	AuthSecret string // Base64URL, 16-byte browser-generated secret
	CreatedAt  int64  // UNIX Epoch UTC
}

// PushTriggerClass distinguishes transport-level urgency ONLY.
// RFC-0009 §5.2: payload content is IDENTICAL across classes.
type PushTriggerClass string

const (
	PushClassMessage PushTriggerClass = "MESSAGE"
	PushClassCall    PushTriggerClass = "CALL"
)

// Frozen Web Push parameters (RFC-0009 §5.2).
const (
	WebPushRecordSize         = 64
	WebPushPaddedPlaintextLen  = 32
	MessageTriggerTTLSeconds   = 300
	CallTriggerTTLSeconds      = 25 // MUST stay < RingTimeoutSeconds (RFC-0008 §7.5)
	PushDebounceWindowSeconds  = 60
	VAPIDJWTMaxLifetimeSeconds = 43200 // 12 hours (RFC-0009 §5.1)
)

// WakePayload is the single canonical content-blind plaintext (§5.2).
// This value is FROZEN. Adding fields would break the fixed record size and
// reintroduce the traffic-analysis channel the fixed size exists to close.
const WakePayload = `{"t":"wake"}`

// TTLSeconds returns the transport TTL for a trigger class.
func (c PushTriggerClass) TTLSeconds() int {
	switch c {
	case PushClassMessage:
		return MessageTriggerTTLSeconds
	case PushClassCall:
		return CallTriggerTTLSeconds
	default:
		return MessageTriggerTTLSeconds
	}
}

// Urgency returns the Web Push Urgency header value ("normal" | "high").
func (c PushTriggerClass) Urgency() string {
	switch c {
	case PushClassMessage:
		return "normal"
	case PushClassCall:
		return "high"
	default:
		return "normal"
	}
}

// PushTrigger defines the dependency required to dispatch pushes (RFC-0009 §7.1).
// This breaks the import cycle between use cases.
type PushTrigger interface {
	HasSubscriptions(ctx context.Context, userID string) (bool, error)
	TriggerMessage(userID string)
	TriggerCall(userID string)
}
