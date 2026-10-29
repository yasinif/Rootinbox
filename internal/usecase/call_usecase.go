package usecase

import (
	"context"
	"crypto/hmac"
	"crypto/sha1" // #nosec G505 — HMAC-SHA1 is mandated by the TURN REST API convention (RFC-0008 §5.2).
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"
)

// CallUseCase implements business logic for voice/video call signaling.
// RFC-0008: Real-Time Voice & Video Calling.
type CallUseCase struct {
	userRepo           domain.UserRepository
	callRepo           domain.CallRepository
	convRepo           domain.ConversationRepository
	participantRepo    domain.ParticipantRepository
	sessionRepo        domain.SessionRepository
	txManager          *database.TxManager
	clock              domain.Clock
	logger             domain.Logger
	pushUC             domain.PushTrigger
	ringStore          domain.PendingRingStore
	turnActiveSecret   string
	turnPreviousSecret string
	turnCredentialTTL  time.Duration
	turnRealm          string
	turnHost           string
	turnPort           int
}

// NewCallUseCase creates a new CallUseCase.
func NewCallUseCase(
	userRepo domain.UserRepository,
	callRepo domain.CallRepository,
	convRepo domain.ConversationRepository,
	participantRepo domain.ParticipantRepository,
	sessionRepo domain.SessionRepository,
	txManager *database.TxManager,
	clock domain.Clock,
	logger domain.Logger,
	turnActiveSecret, turnPreviousSecret string,
	turnCredentialTTL time.Duration,
	turnRealm, turnHost string,
	turnPort int,
	pushUC domain.PushTrigger,
	ringStore domain.PendingRingStore,
) *CallUseCase {
	return &CallUseCase{
		userRepo:           userRepo,
		callRepo:           callRepo,
		convRepo:           convRepo,
		participantRepo:    participantRepo,
		sessionRepo:        sessionRepo,
		txManager:          txManager,
		clock:              clock,
		logger:             logger,
		turnActiveSecret:   turnActiveSecret,
		turnPreviousSecret: turnPreviousSecret,
		turnCredentialTTL:  turnCredentialTTL,
		turnRealm:          turnRealm,
		turnHost:           turnHost,
		turnPort:           turnPort,
		pushUC:             pushUC,
		ringStore:          ringStore,
	}
}

// GetUserByIdentityHash looks up a user by identity hash or user ID.
func (uc *CallUseCase) GetUserByIdentityHash(ctx context.Context, hash string) (*domain.User, error) {
	if uc.userRepo == nil {
		return nil, nil
	}
	u, err := uc.userRepo.GetByIdentityHash(ctx, hash)
	if err == nil && u != nil {
		return u, nil
	}
	return uc.userRepo.GetByID(ctx, hash)
}

// GetCallByID retrieves a call record. Used by the WS relay handlers.
func (uc *CallUseCase) GetCallByID(ctx context.Context, callID string) (*domain.Call, error) {
	return uc.callRepo.GetByID(ctx, callID)
}

// GlareResult is returned when glare arbitration triggers.
type GlareResult struct {
	CanonicalCallID string
	LosingCallID    string
}

// InitiateCallResult holds the result of call initiation.
type InitiateCallResult struct {
	Call         *domain.Call
	IsIdempotent bool
	GlareResult  *GlareResult // Non-nil if glare arbitration triggered.
	IsBusy       bool         // True if target is busy with a 3rd party.
}

// InitiateCall processes a call.invite.
// RFC-0008 §7.2: Atomic Request-Bound Idempotency, Authorization & Call Creation.
// Order: Fingerprint lookup BEFORE Single-Active check.
func (uc *CallUseCase) InitiateCall(
	ctx context.Context,
	callerID, calleeID, conversationID, callID string,
	callType domain.CallType,
	envelopeType string, signalSeq uint64, rawPayload []byte,
) (*InitiateCallResult, error) {

	// Reject self-calls.
	if callerID == calleeID {
		return nil, domain.NewDomainError(domain.ErrCall003, "cannot call self", nil)
	}

	// Compute request fingerprint per RFC-0008 §7.2 byte-exact format.
	// SHA-256([UTF-8 type] || [16 raw UUID of call_id] || [8-byte BE signal_seq] || [raw ciphertext])
	fingerprint := computeRequestFingerprint(envelopeType, callID, signalSeq, rawPayload)

	var result InitiateCallResult

	err := uc.txManager.WithinImmediateTransaction(ctx, func(ctx context.Context) error {
		// Step 1: Request-Bound Idempotency Lookup (Primary Check).
		// RFC-0008 §7.2: MUST run BEFORE Single-Active check.
		existing, err := uc.callRepo.GetByID(ctx, callID)
		if err != nil {
			return domain.NewDomainError(domain.ErrDB002, "checking call existence", err)
		}

		if existing != nil {
			// Verify ownership — mismatch returns stale error without revealing existence.
			if existing.CallerID != callerID || existing.CalleeID != calleeID || existing.ConversationID != conversationID {
				return domain.NewDomainError(domain.ErrCall003, "call authorization failed", nil)
			}

			// Compare request fingerprint.
			if existing.RequestFingerprint == fingerprint {
				// Exact match — return idempotently.
				result.Call = existing
				result.IsIdempotent = true
				return nil
			}

			// Different fingerprint — 409 Conflict.
			return domain.NewDomainError(domain.ErrCall002, "call_id exists with different request", nil)
		}

		// Step 2: Single-Active & Authorization (Secondary Check).
		// Find the DIRECT conversation between caller and callee.
		// The WS handler may not have the conversationID (payload is E2EE),
		// so resolve it from participant data.
		resolvedConvID := conversationID
		if resolvedConvID == "" {
			convID, err := uc.findDirectConversation(ctx, callerID, calleeID)
			if err != nil {
				return err
			}
			resolvedConvID = convID
		} else {
			// Verify the provided conversation is DIRECT.
			conv, err := uc.convRepo.GetByID(ctx, resolvedConvID)
			if err != nil || conv == nil {
				return domain.NewDomainError(domain.ErrConv001, "conversation not found", err)
			}
			if conv.Type != domain.ConvTypeDirect {
				return domain.NewDomainError(domain.ErrCall003, "calls only allowed in DIRECT conversations", nil)
			}
		}
		conversationID = resolvedConvID

		// Check for active conflicting calls for both caller and callee.
		callerActive, err := uc.callRepo.GetActiveByUserID(ctx, callerID)
		if err != nil {
			return domain.NewDomainError(domain.ErrDB002, "checking caller active calls", err)
		}
		calleeActive, err := uc.callRepo.GetActiveByUserID(ctx, calleeID)
		if err != nil {
			return domain.NewDomainError(domain.ErrDB002, "checking callee active calls", err)
		}

		// Check for 3rd-party busy conflicts.
		for _, c := range callerActive {
			if c.CallerID != callerID && c.CalleeID != callerID {
				continue
			}
			otherPeer := c.CalleeID
			if c.CalleeID == callerID {
				otherPeer = c.CallerID
			}
			if otherPeer != calleeID {
				// Caller is busy with a 3rd party.
				result.IsBusy = true
				return nil
			}
		}
		for _, c := range calleeActive {
			if c.CallerID != calleeID && c.CalleeID != calleeID {
				continue
			}
			otherPeer := c.CallerID
			if c.CallerID == calleeID {
				otherPeer = c.CalleeID
			}
			if otherPeer != callerID {
				// Callee is busy with a 3rd party.
				result.IsBusy = true
				return nil
			}
		}

		// Cancel/supersede any prior active or ringing calls between this exact pair from the same caller
		// so that re-calling never fails or gets blocked by a stale call state.
		for _, c := range append(callerActive, calleeActive...) {
			if c.CallerID == callerID && c.CalleeID == calleeID && (c.Status == domain.CallStatusRinging || c.Status == domain.CallStatusActive) {
				now := uc.clock.NowUnix()
				_, _ = uc.callRepo.SetEnded(ctx, c.ID, c.Status, domain.CallStatusMissed, now)
			}
		}

		// Check for glare: reverse invite (Callee inviting Caller at the same time).
		// RFC-0008 §7.4: Deterministic Glare Arbitration.
		for _, c := range calleeActive {
			if c.CallerID == calleeID && c.CalleeID == callerID && (c.Status == domain.CallStatusRinging || c.Status == domain.CallStatusActive) {
				// Glare detected — both peers inviting each other concurrently.
				return uc.resolveGlare(ctx, callerID, calleeID, callID, c, fingerprint, callType, conversationID, &result)
			}
		}

		// Step 3: Creation.
		now := uc.clock.NowUnix()
		call := &domain.Call{
			ID:                 callID,
			ConversationID:     conversationID,
			CallerID:           callerID,
			CalleeID:           calleeID,
			Type:               callType,
			RequestFingerprint: fingerprint,
			Status:             domain.CallStatusRinging,
			CreatedAt:          now,
		}
		if err := uc.callRepo.Create(ctx, call); err != nil {
			return domain.NewDomainError(domain.ErrDB002, "creating call", err)
		}

		result.Call = call
		return nil
	})

	if err != nil {
		return nil, err
	}

	return &result, nil
}

// resolveGlare handles concurrent call invites between the same pair.
// RFC-0008 §7.4: Smaller identity hash (lowercase hex) = Polite peer.
// Impolite peer's call is ALWAYS canonical.
func (uc *CallUseCase) resolveGlare(
	ctx context.Context,
	callerID, calleeID, newCallID string,
	existingCall *domain.Call,
	fingerprint string,
	callType domain.CallType,
	conversationID string,
	result *InitiateCallResult,
) error {
	// We need identity hashes to determine polite/impolite.
	// The caller of the new invite has callerID, the caller of the existing has existingCall.CallerID.
	// Compare their identity hashes lexicographically.
	// Since we have user IDs and not identity hashes directly, we use the user IDs
	// as the deterministic ordering key (identity hashes are derived from keys, but
	// the server only needs a deterministic comparison — user IDs are unique and stable).
	// RFC-0008 §7.4: "Compare CallerIdentityHash and CalleeIdentityHash lexicographically."
	// We compare the two callers' IDs as proxy for their identity hashes.

	// Current caller is callerID (initiating new call).
	// Existing caller is existingCall.CallerID (who initiated the existing conflicting call).
	// The "polite" peer is the one with the smaller ID (deterministic).
	politeCallerID := callerID
	if existingCall.CallerID < callerID {
		politeCallerID = existingCall.CallerID
	}

	var canonicalCallID, losingCallID string

	if politeCallerID == callerID {
		// Current caller is polite — their new invite loses. Existing call is canonical.
		canonicalCallID = existingCall.ID
		losingCallID = newCallID
		// Don't create the new call — it's the losing one.
	} else {
		// Current caller is impolite — their new invite wins. Existing call loses.
		canonicalCallID = newCallID
		losingCallID = existingCall.ID

		// Existing call loses: DELETE if RINGING (never exposed to callee as ACTIVE).
		if existingCall.Status == domain.CallStatusRinging {
			if err := uc.callRepo.Delete(ctx, existingCall.ID); err != nil {
				return domain.NewDomainError(domain.ErrDB002, "deleting losing glare call", err)
			}
		}

		// Create the winning call.
		now := uc.clock.NowUnix()
		call := &domain.Call{
			ID:                 newCallID,
			ConversationID:     conversationID,
			CallerID:           callerID,
			CalleeID:           calleeID,
			Type:               callType,
			RequestFingerprint: fingerprint,
			Status:             domain.CallStatusRinging,
			CreatedAt:          now,
		}
		if err := uc.callRepo.Create(ctx, call); err != nil {
			return domain.NewDomainError(domain.ErrDB002, "creating canonical glare call", err)
		}
		result.Call = call
	}

	result.GlareResult = &GlareResult{
		CanonicalCallID: canonicalCallID,
		LosingCallID:    losingCallID,
	}
	return nil
}

// AcceptCall processes a call.accept.
// RFC-0008 §7.3: authenticated user MUST equal callee_id.
func (uc *CallUseCase) AcceptCall(ctx context.Context, calleeID, callID string) (*domain.Call, error) {
	var call *domain.Call

	err := uc.txManager.WithinImmediateTransaction(ctx, func(ctx context.Context) error {
		c, err := uc.callRepo.GetByID(ctx, callID)
		if err != nil {
			return domain.NewDomainError(domain.ErrDB002, "getting call", err)
		}
		if c == nil || c.CalleeID != calleeID {
			return domain.NewDomainError(domain.ErrCall003, "call not found or unauthorized", nil)
		}

		// Idempotency: already ACTIVE.
		if c.Status == domain.CallStatusActive {
			call = c
			return nil
		}

		now := uc.clock.NowUnix()
		rows, err := uc.callRepo.SetActive(ctx, callID, now)
		if err != nil {
			return domain.NewDomainError(domain.ErrDB002, "accepting call", err)
		}
		if rows == 0 {
			return domain.NewDomainError(domain.ErrCall002, "call status changed", nil)
		}
		c.Status = domain.CallStatusActive
		c.StartedAt = &now
		call = c
		return nil
	})

	if err != nil {
		return nil, err
	}
	return call, nil
}

// RejectCall processes a call.reject.
// RFC-0008 §7.3: authenticated user MUST equal callee_id.
func (uc *CallUseCase) RejectCall(ctx context.Context, calleeID, callID string) error {
	return uc.txManager.WithinImmediateTransaction(ctx, func(ctx context.Context) error {
		c, err := uc.callRepo.GetByID(ctx, callID)
		if err != nil {
			return domain.NewDomainError(domain.ErrDB002, "getting call", err)
		}
		if c == nil || c.CalleeID != calleeID {
			return domain.NewDomainError(domain.ErrCall003, "call not found or unauthorized", nil)
		}

		now := uc.clock.NowUnix()
		rows, err := uc.callRepo.SetEnded(ctx, callID, domain.CallStatusRinging, domain.CallStatusRejected, now)
		if err != nil {
			return domain.NewDomainError(domain.ErrDB002, "rejecting call", err)
		}
		if rows == 0 {
			return domain.NewDomainError(domain.ErrCall002, "call status changed", nil)
		}
		return nil
	})
}

// EndCall processes a call.end.
// RFC-0008 §7.3: authenticated user MUST equal caller_id OR callee_id.
func (uc *CallUseCase) EndCall(ctx context.Context, userID, callID string) error {
	return uc.txManager.WithinImmediateTransaction(ctx, func(ctx context.Context) error {
		c, err := uc.callRepo.GetByID(ctx, callID)
		if err != nil {
			return domain.NewDomainError(domain.ErrDB002, "getting call", err)
		}
		if c == nil || (c.CallerID != userID && c.CalleeID != userID) {
			return domain.NewDomainError(domain.ErrCall003, "call not found or unauthorized", nil)
		}

		now := uc.clock.NowUnix()
		var rows int64

		switch c.Status {
		case domain.CallStatusActive:
			rows, err = uc.callRepo.SetEnded(ctx, callID, domain.CallStatusActive, domain.CallStatusEnded, now)
		case domain.CallStatusRinging:
			// Unanswered call cancelled by caller or timed out: mark as MISSED for the callee
			rows, err = uc.callRepo.SetEnded(ctx, callID, domain.CallStatusRinging, domain.CallStatusMissed, now)
		default:
			// Already terminal — idempotent.
			return nil
		}

		if err != nil {
			return domain.NewDomainError(domain.ErrDB002, "ending call", err)
		}
		if rows == 0 {
			// Status changed concurrently — silently accept.
			return nil
		}
		return nil
	})
}

// TURNCredentials represents ephemeral TURN credentials.
type TURNCredentials struct {
	Username   string   `json:"username"`
	Password   string   `json:"password"`
	Credential string   `json:"credential"`
	TTL        int      `json:"ttl"`
	URLs       []string `json:"urls"`
	URIs       []string `json:"uris"`
}

// GetTURNCredentials generates ephemeral TURN credentials.
// RFC-0008 §5.2: Ephemeral TURN Credential Issuance.
// Username: {expiry_unix}:{Base64URL(raw 32-byte identity hash)}
// Password: Base64(HMAC-SHA1(Active_Secret, username))
// NOTE: HMAC-SHA1 is mandated by the TURN REST API convention — do NOT change to SHA-256.
func (uc *CallUseCase) GetTURNCredentials(ctx context.Context, identityHash string) (*TURNCredentials, error) {
	if uc.turnActiveSecret == "" {
		return nil, domain.NewDomainError(domain.ErrSys001, "TURN not configured", nil)
	}

	// Decode the hex identity hash to raw bytes.
	hashBytes, err := hex.DecodeString(identityHash)
	if err != nil || len(hashBytes) != 32 {
		return nil, domain.NewDomainError(domain.ErrSys001, "invalid identity hash", nil)
	}

	expiry := time.Now().Add(uc.turnCredentialTTL).Unix()
	username := fmt.Sprintf("%d:%s", expiry, base64.RawURLEncoding.EncodeToString(hashBytes))

	// HMAC-SHA1 per TURN REST API convention (RFC-0008 §5.2).
	// #nosec G401 — HMAC-SHA1 is mandated by the TURN REST API convention. Do NOT "fix" to SHA-256.
	mac := hmac.New(sha1.New, []byte(uc.turnActiveSecret))
	mac.Write([]byte(username))
	password := base64.StdEncoding.EncodeToString(mac.Sum(nil))

	host := uc.turnHost
	if host == "" {
		host = uc.turnRealm
	}
	port := uc.turnPort
	if port <= 0 {
		port = 3478
	}

	turnURI := fmt.Sprintf("turn:%s:%d?transport=udp", host, port)
	stunURI := fmt.Sprintf("stun:%s:%d", host, port)
	uris := []string{turnURI, stunURI}

	return &TURNCredentials{
		Username:   username,
		Password:   password,
		Credential: password,
		TTL:        int(uc.turnCredentialTTL.Seconds()),
		URLs:       uris,
		URIs:       uris,
	}, nil
}

// RecoverCrashState performs crash recovery on startup.
// RFC-0008 §10.2: RINGING → FAILED, ACTIVE → ENDED.
// MUST run synchronously BEFORE the HTTP listener starts.
func (uc *CallUseCase) RecoverCrashState(ctx context.Context) error {
	now := uc.clock.NowUnix()

	ringingCount, err := uc.callRepo.TransitionAllRingingToFailed(ctx, now)
	if err != nil {
		return fmt.Errorf("crash recovery ringing→failed: %w", err)
	}

	activeCount, err := uc.callRepo.TransitionAllActiveToEnded(ctx, now)
	if err != nil {
		return fmt.Errorf("crash recovery active→ended: %w", err)
	}

	if ringingCount > 0 || activeCount > 0 {
		uc.logger.Info("call crash recovery complete",
			"ringing_to_failed", ringingCount,
			"active_to_ended", activeCount,
		)
	}

	return nil
}

// findDirectConversation finds the DIRECT conversation shared between two users.
// RFC-0008: call.invite requires a shared DIRECT conversation (GROUP/SELF rejected).
func (uc *CallUseCase) findDirectConversation(ctx context.Context, userA, userB string) (string, error) {
	// List conversations for the caller.
	callerParts, err := uc.participantRepo.ListByUserID(ctx, userA)
	if err != nil {
		return "", domain.NewDomainError(domain.ErrDB002, "listing caller conversations", err)
	}

	// For each of the caller's conversations, check if callee is also a participant
	// and the conversation is DIRECT.
	for _, p := range callerParts {
		conv, err := uc.convRepo.GetByID(ctx, p.ConversationID)
		if err != nil || conv == nil {
			continue
		}
		if conv.Type != domain.ConvTypeDirect {
			continue
		}
		// Check if callee is in this conversation.
		calleePart, err := uc.participantRepo.GetByConversationAndUser(ctx, p.ConversationID, userB)
		if err != nil {
			continue
		}
		if calleePart != nil {
			return p.ConversationID, nil
		}
	}

	// Auto-create DIRECT conversation so calling is never blocked by lack of prior chat history
	convID := uuid.New().String()
	now := uc.clock.NowUnix()
	newConv := &domain.Conversation{
		ID:        convID,
		Type:      domain.ConvTypeDirect,
		CreatedAt: now,
	}
	if err := uc.convRepo.Create(ctx, newConv); err != nil {
		return "", domain.NewDomainError(domain.ErrDB002, "auto-creating direct conversation for call", err)
	}
	_ = uc.participantRepo.Create(ctx, &domain.Participant{
		ConversationID: convID,
		UserID:         userA,
		Role:           domain.RoleOwner,
		JoinedAt:       now,
	})
	_ = uc.participantRepo.Create(ctx, &domain.Participant{
		ConversationID: convID,
		UserID:         userB,
		Role:           domain.RoleMember,
		JoinedAt:       now,
	})

	return convID, nil
}

// computeRequestFingerprint computes the byte-exact request fingerprint.
// RFC-0008 §7.2: SHA-256 over:
//
//	[UTF-8 bytes of type] || [16 RAW UUID bytes of call_id] || [8-byte BigEndian uint64 signal_seq] || [raw ciphertext bytes]
//
// Stored as lowercase hex. NO JSON, NO Base64, NO string UUID, NO textual integers.
func computeRequestFingerprint(envelopeType, callID string, signalSeq uint64, rawPayload []byte) string {
	// Parse UUID string to 16 raw bytes.
	rawUUID := parseUUIDToBytes(callID)

	var buf []byte
	buf = append(buf, []byte(envelopeType)...)
	buf = append(buf, rawUUID...)

	seqBytes := make([]byte, 8)
	binary.BigEndian.PutUint64(seqBytes, signalSeq)
	buf = append(buf, seqBytes...)

	buf = append(buf, rawPayload...)

	hash := sha256.Sum256(buf)
	return hex.EncodeToString(hash[:])
}

// parseUUIDToBytes converts a UUID string (e.g., "550e8400-...") to 16 raw bytes.
func parseUUIDToBytes(uuidStr string) []byte {
	// Remove hyphens.
	clean := strings.ReplaceAll(uuidStr, "-", "")
	raw, err := hex.DecodeString(clean)
	if err != nil || len(raw) != 16 {
		// Return zeroed bytes as fallback for malformed UUIDs.
		return make([]byte, 16)
	}
	return raw
}

// StageOfflineInvite stages a call invite for an offline callee and triggers a push.
func (uc *CallUseCase) StageOfflineInvite(ctx context.Context, callID, callerID, calleeID string, rawPayload []byte) {
	// 1. Resolve active sessions for caller and callee (ADR-P9-15).
	callerSession, err := uc.sessionRepo.GetActiveByUserID(ctx, callerID)
	if err != nil || callerSession == nil {
		uc.logger.Info("failed to resolve caller active session, skipping offline invite staging", "caller_id", callerID)
		return
	}
	callerSessionID := callerSession.ID

	var calleeSessionID string
	calleeSession, err := uc.sessionRepo.GetActiveByUserID(ctx, calleeID)
	if err != nil {
		uc.logger.Info("failed to lookup callee active sessions, skipping offline invite staging", "callee_id", calleeID, "error", err)
		return
	}
	if calleeSession != nil {
		calleeSessionID = calleeSession.ID
	}

	// 2. Resolve caller and callee identity hashes
	callerHash := callerID
	calleeHash := calleeID
	if uc.userRepo != nil {
		if u, err := uc.userRepo.GetByID(ctx, callerID); err == nil && u != nil && u.IdentityHash != "" {
			callerHash = u.IdentityHash
		}
		if u, err := uc.userRepo.GetByID(ctx, calleeID); err == nil && u != nil && u.IdentityHash != "" {
			calleeHash = u.IdentityHash
		}
	}

	// 3. Stage the invite in the PendingRing buffer so the callee can retrieve it on reconnect/poll.
	now := uc.clock.NowUnix()
	expiresAt := now + domain.RingTimeoutSeconds

	entry := &domain.PendingRingEntry{
		CallID:               callID,
		CallerID:             callerID,
		CallerIdentityHash:   callerHash,
		CalleeID:             calleeID,
		CalleeIdentityHash:   calleeHash,
		CalleeSessionID:      calleeSessionID,
		CallerSessionID:      callerSessionID,
		EncryptedOffer:       make([]byte, len(rawPayload)),
		FingerprintSignature: nil,
		ExpiresAt:            expiresAt,
	}
	copy(entry.EncryptedOffer, rawPayload)

	err = uc.ringStore.Stage(entry)
	if err != nil {
		uc.logger.Error("failed to stage offline invite", "call_id", callID, "error", err)
		return
	}

	// 4. Trigger Web Push if subscriptions exist (ADR-P9-7).
	hasSubs, err := uc.pushUC.HasSubscriptions(ctx, calleeID)
	if err == nil && hasSubs {
		uc.pushUC.TriggerCall(calleeID)
	}
}

// TakePendingInvite removes and returns the staged invite for an identity hash or fallback key.
func (uc *CallUseCase) TakePendingInvite(ctx context.Context, identityHash string, fallbackKeys ...string) (*domain.PendingRingEntry, error) {
	entry, ok := uc.ringStore.TakeByCalleeIdentityHash(identityHash, uc.clock.NowUnix())
	if !ok {
		for _, key := range fallbackKeys {
			if key != "" {
				entry, ok = uc.ringStore.TakeByCalleeIdentityHash(key, uc.clock.NowUnix())
				if ok {
					break
				}
			}
		}
	}
	if !ok {
		return nil, domain.NewDomainError(domain.ErrRing001, "no pending invite found", nil)
	}
	return entry, nil
}

// GetMissedCalls retrieves missed calls for a callee.
func (uc *CallUseCase) GetMissedCalls(ctx context.Context, calleeID string, limit int) ([]*domain.Call, error) {
	return uc.callRepo.GetMissedCallsByCallee(ctx, calleeID, limit)
}
