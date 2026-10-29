package ws

import (
	"context"
	"encoding/base64"
	"encoding/json"

	"rootinbox/internal/domain"
)

// handleCallInvite processes a call.invite frame.
// RFC-0008 §7.2: State mutation (create call) then relay post-commit.
// RFC-0008 §5: Silent drop policy — errors are logged, not sent as envelopes.
func (h *Handler) handleCallInvite(client *Client, env Envelope) {
	if env.CallID == "" || env.RoutingID == "" || env.Payload == "" {
		h.logger.Warn("ws call.invite missing required fields", "user_id", client.userID)
		return
	}

	// Decode routing_id to get callee user ID with multi-codec fallbacks.
	calleeID := ""
	if routingIDBytes, err := base64.RawURLEncoding.DecodeString(env.RoutingID); err == nil && len(routingIDBytes) > 0 {
		calleeID = string(routingIDBytes)
	} else if routingIDBytes, err := base64.URLEncoding.DecodeString(env.RoutingID); err == nil && len(routingIDBytes) > 0 {
		calleeID = string(routingIDBytes)
	} else if routingIDBytes, err := base64.StdEncoding.DecodeString(env.RoutingID); err == nil && len(routingIDBytes) > 0 {
		calleeID = string(routingIDBytes)
	} else {
		calleeID = env.RoutingID
	}

	ctx := context.Background()
	if user, err := h.callUC.GetUserByIdentityHash(ctx, calleeID); err == nil && user != nil {
		calleeID = user.ID
	}

	// Decode payload to get raw ciphertext bytes for fingerprint.
	var rawPayload []byte
	if b, err := base64.StdEncoding.DecodeString(env.Payload); err == nil {
		rawPayload = b
	} else if b, err := base64.RawStdEncoding.DecodeString(env.Payload); err == nil {
		rawPayload = b
	} else if b, err := base64.URLEncoding.DecodeString(env.Payload); err == nil {
		rawPayload = b
	} else if b, err := base64.RawURLEncoding.DecodeString(env.Payload); err == nil {
		rawPayload = b
	} else {
		rawPayload = []byte(env.Payload)
	}

	var signalSeq uint64
	if env.SignalSeq != nil {
		signalSeq = *env.SignalSeq
	}

	// We need a conversation_id — extract from the decoded payload or use routing.
	// For call.invite, the conversation is determined by the caller/callee pair.
	// The call use case will verify the conversation exists.
	// Derive conversation_id from the envelope; it's part of the routing context.
	// For now, use request_id as a proxy to carry conversation_id.
	// Actually, let's extract conversation_id from the payload if present,
	// but since payload is encrypted (E2EE), we can't. The server uses routing_id
	// to identify the callee. We need the conversation_id from the envelope.
	// Add it as a parameter to the envelope or look it up.
	// RFC-0008 doesn't add conversation_id to the envelope explicitly.
	// Look up conversation_id from participant data (caller and callee must share a DIRECT conversation).
	// The call use case handles this lookup internally using the participant repo.
	// For now, pass empty conversation_id and let the use case resolve it.
	// Actually, we need to find the DIRECT conversation. Let's query from the use case.
	// Simplified: we'll pass the caller/callee and let the use case validate.
	
	// Use a simplified call initiation that finds the conversation.
	result, err := h.callUC.InitiateCall(
		ctx, client.userID, calleeID, "", env.CallID,
		domain.CallTypeAudio, env.Type, signalSeq, rawPayload,
	)
	if err != nil {
		// Silent drop policy: Warn log, no call.error envelope sent.
		h.logger.Warn("ws call.invite failed",
			"user_id", client.userID,
			"call_id", env.CallID,
			"error", err,
		)
		return
	}

	if result.IsBusy {
		// Send call.busy to caller.
		// RFC-0008 §7.4: sender_id="" and signal_seq=0 (advisory).
		h.sendCallBusy(client, env.CallID, "", env.CallID)
		return
	}

	if result.GlareResult != nil {
		// Send call.busy with glare info to both peers.
		h.sendCallBusy(client,
			result.GlareResult.CanonicalCallID,
			result.GlareResult.LosingCallID,
			env.CallID,
		)
		return
	}

	if result.IsIdempotent {
		// Already processed — don't relay again.
		return
	}

	// Relay post-commit: forward call.invite to callee.
	relayEnv := Envelope{
		V:         1,
		Type:      domain.EnvelopeTypeCallInvite,
		RequestID: env.RequestID,
		CallID:    env.CallID,
		SignalSeq: env.SignalSeq,
		Payload:   env.Payload,
		SenderID:  client.userID,
	}
	relayData, err := json.Marshal(relayEnv)
	if err != nil {
		h.logger.Error("ws call.invite marshal relay failed", "error", err)
		return
	}
	if !h.hub.Route(calleeID, relayData) {
		h.logger.Info("callee offline, staging invite", "callee_id", calleeID, "call_id", env.CallID)
		h.callUC.StageOfflineInvite(ctx, env.CallID, client.userID, calleeID, rawPayload)
	}
}

// sendCallBusy sends a call.busy advisory frame to a client.
// RFC-0008 §7.4/correction #6: sender_id="" and signal_seq=0.
// Payload is plaintext JSON Base64-encoded. This frame MUST NOT authorize state transitions.
func (h *Handler) sendCallBusy(client *Client, canonicalCallID, losingCallID, originalCallID string) {
	busyPayload := map[string]interface{}{
		"canonical_call_id": canonicalCallID,
		"losing_call_id":    losingCallID,
		"glare_override":    losingCallID != "" && losingCallID != originalCallID,
	}
	payloadJSON, _ := json.Marshal(busyPayload)
	payloadB64 := base64.StdEncoding.EncodeToString(payloadJSON)

	var zeroSeq uint64
	busyEnv := Envelope{
		V:         1,
		Type:      domain.EnvelopeTypeCallBusy,
		CallID:    originalCallID,
		SenderID:  "",       // RFC-0008 correction #6: sender_id MUST be "".
		SignalSeq: &zeroSeq, // RFC-0008 correction #6: signal_seq MUST be 0.
		Payload:   payloadB64,
	}
	data, err := json.Marshal(busyEnv)
	if err != nil {
		h.logger.Error("ws call.busy marshal failed", "error", err)
		return
	}
	select {
	case client.send <- data:
	default:
		h.logger.Warn("ws client send channel full for call.busy", "user_id", client.userID)
	}
}

// handleCallAccept processes a call.accept frame.
// RFC-0008 §7.3: callee_id authorization, RINGING→ACTIVE, relay post-commit.
func (h *Handler) handleCallAccept(client *Client, env Envelope) {
	if env.CallID == "" || env.Payload == "" {
		h.logger.Warn("ws call.accept missing required fields", "user_id", client.userID)
		return
	}

	ctx := context.Background()
	call, err := h.callUC.AcceptCall(ctx, client.userID, env.CallID)
	if err != nil {
		h.logger.Warn("ws call.accept failed",
			"user_id", client.userID,
			"call_id", env.CallID,
			"error", err,
		)
		return
	}

	// Relay post-commit to caller.
	relayEnv := Envelope{
		V:         1,
		Type:      domain.EnvelopeTypeCallAccept,
		RequestID: env.RequestID,
		CallID:    env.CallID,
		SignalSeq: env.SignalSeq,
		Payload:   env.Payload,
		SenderID:  client.userID,
	}
	relayData, _ := json.Marshal(relayEnv)
	h.hub.Route(call.CallerID, relayData)
}

// handleCallReject processes a call.reject frame.
// RFC-0008 §7.3: callee_id authorization, RINGING→REJECTED, relay post-commit.
func (h *Handler) handleCallReject(client *Client, env Envelope) {
	if env.CallID == "" {
		h.logger.Warn("ws call.reject missing call_id", "user_id", client.userID)
		return
	}

	ctx := context.Background()
	err := h.callUC.RejectCall(ctx, client.userID, env.CallID)
	if err != nil {
		h.logger.Warn("ws call.reject failed",
			"user_id", client.userID,
			"call_id", env.CallID,
			"error", err,
		)
		return
	}

	// Relay post-commit — need to find the caller.
	// Read the call to get caller_id for relay.
	call, _ := h.callUC.GetCallByID(ctx, env.CallID)
	if call != nil {
		relayEnv := Envelope{
			V:         1,
			Type:      domain.EnvelopeTypeCallReject,
			RequestID: env.RequestID,
			CallID:    env.CallID,
			SignalSeq: env.SignalSeq,
			Payload:   env.Payload,
			SenderID:  client.userID,
		}
		relayData, _ := json.Marshal(relayEnv)
		h.hub.Route(call.CallerID, relayData)
	}
}

// handleCallEnd processes a call.end frame.
// RFC-0008 §7.3: caller_id OR callee_id, relay post-commit.
func (h *Handler) handleCallEnd(client *Client, env Envelope) {
	if env.CallID == "" {
		h.logger.Warn("ws call.end missing call_id", "user_id", client.userID)
		return
	}

	ctx := context.Background()

	// Read call first to determine the peer for relay.
	call, _ := h.callUC.GetCallByID(ctx, env.CallID)

	err := h.callUC.EndCall(ctx, client.userID, env.CallID)
	if err != nil {
		h.logger.Warn("ws call.end failed",
			"user_id", client.userID,
			"call_id", env.CallID,
			"error", err,
		)
		return
	}

	// Relay post-commit to the other peer.
	if call != nil {
		peerID := call.CallerID
		if call.CallerID == client.userID {
			peerID = call.CalleeID
		}
		relayEnv := Envelope{
			V:         1,
			Type:      domain.EnvelopeTypeCallEnd,
			RequestID: env.RequestID,
			CallID:    env.CallID,
			SignalSeq: env.SignalSeq,
			Payload:   env.Payload,
			SenderID:  client.userID,
		}
		relayData, _ := json.Marshal(relayEnv)
		h.hub.Route(peerID, relayData)
	}
}

// handleCallRelay relays call.ice and call.renegotiate frames without state mutation.
// RFC-0008: NO transaction, NO state mutation. Peer is derived from authenticated user.
func (h *Handler) handleCallRelay(client *Client, env Envelope) {
	if env.CallID == "" || env.Payload == "" {
		h.logger.Warn("ws call relay missing fields", "type", env.Type, "user_id", client.userID)
		return
	}

	ctx := context.Background()
	call, err := h.callUC.GetCallByID(ctx, env.CallID)
	if err != nil || call == nil {
		h.logger.Warn("ws call relay: call not found", "call_id", env.CallID, "user_id", client.userID)
		return
	}

	// Verify the authenticated user is a participant.
	if call.CallerID != client.userID && call.CalleeID != client.userID {
		h.logger.Warn("ws call relay: unauthorized", "call_id", env.CallID, "user_id", client.userID)
		return
	}

	// Derive peer from authenticated user — never from routing_id.
	peerID := call.CallerID
	if call.CallerID == client.userID {
		peerID = call.CalleeID
	}

	// Relay as-is with sender_id set.
	relayEnv := Envelope{
		V:         1,
		Type:      env.Type,
		RequestID: env.RequestID,
		CallID:    env.CallID,
		SignalSeq: env.SignalSeq,
		Payload:   env.Payload,
		SenderID:  client.userID,
	}
	relayData, err := json.Marshal(relayEnv)
	if err != nil {
		h.logger.Error("ws call relay marshal failed", "error", err)
		return
	}
	h.hub.Route(peerID, relayData)
}
