package domain

// CallStatus represents the state of a call.
// RFC-0008 §7.1: Explicit CallStatus Enum.
type CallStatus string

const (
	CallStatusRinging  CallStatus = "RINGING"
	CallStatusActive   CallStatus = "ACTIVE"
	CallStatusEnded    CallStatus = "ENDED"
	CallStatusRejected CallStatus = "REJECTED"
	CallStatusMissed   CallStatus = "MISSED"
	CallStatusFailed   CallStatus = "FAILED"
)

// CallEndReason represents the reason a call ended.
// RFC-0008 §6: Explicit CallEndReason Enum. No other values permitted.
type CallEndReason string

const (
	CallEndReasonUserEnded        CallEndReason = "USER_ENDED"
	CallEndReasonICEFailed        CallEndReason = "ICE_FAILED"
	CallEndReasonControlPlaneLost CallEndReason = "CONTROL_PLANE_LOST"
	CallEndReasonSignatureMismatch CallEndReason = "SIGNATURE_MISMATCH"
)

// CallType represents the type of call.
type CallType string

const (
	CallTypeAudio CallType = "AUDIO"
	CallTypeVideo CallType = "VIDEO"
)

// Call represents a voice/video call record.
// RFC-0008 §9: SQLite Schema (calls).
// No struct tags (Clean Architecture).
type Call struct {
	ID                 string     // UUIDv4 — PRIMARY KEY
	ConversationID     string     // FK -> conversations.id
	CallerID           string     // FK -> users.id
	CalleeID           string     // FK -> users.id
	Type               CallType   // AUDIO or VIDEO
	RequestFingerprint string     // SHA-256 hex of request-bound idempotency data
	Status             CallStatus // RINGING, ACTIVE, ENDED, REJECTED, MISSED, FAILED
	StartedAt          *int64     // UNIX Epoch UTC — set when ACTIVE
	EndedAt            *int64     // UNIX Epoch UTC — set when terminal state
	CreatedAt          int64      // UNIX Epoch UTC
}

// IsTerminal returns true if the call is in a terminal state.
func (c *Call) IsTerminal() bool {
	switch c.Status {
	case CallStatusEnded, CallStatusRejected, CallStatusMissed, CallStatusFailed:
		return true
	}
	return false
}

// Call constants.
const (
	// RingTimeoutSeconds is the maximum ring duration before MISSED.
	// RFC-0008 §7.5: Exactly 45 seconds.
	RingTimeoutSeconds = 45
)

// Call-related envelope types.
// RFC-0008 §6: WebSocket Signaling Envelope Extensions.
const (
	EnvelopeTypeCallInvite      = "call.invite"
	EnvelopeTypeCallAccept      = "call.accept"
	EnvelopeTypeCallReject      = "call.reject"
	EnvelopeTypeCallBusy        = "call.busy"
	EnvelopeTypeCallICE         = "call.ice"
	EnvelopeTypeCallRenegotiate = "call.renegotiate"
	EnvelopeTypeCallEnd         = "call.end"
)
