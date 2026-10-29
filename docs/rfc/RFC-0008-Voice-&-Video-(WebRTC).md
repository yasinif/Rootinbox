# 📞 RFC-0008: Real-Time Voice & Video Calling (WebRTC Signaling & NAT Traversal)
**Status:** Frozen (Execution Ready & Implementation Contract)
**Role:** Principal Real-Time Systems & WebRTC Engineer

## 1. Objective
Establish a Zero-Knowledge, peer-to-peer Voice & Video calling capability layered directly on top of the existing WebSocket transport. Define strict cryptographic binding of the WebRTC session, directional AES-GCM signaling keys with a mandatory deterministic 64-bit Replay Window, a content-blind signaling relay, a self-hosted single-binary NAT traversal infrastructure, Server-Side Glare Arbitration separated from WebRTC Perfect Negotiation, and an explicit Call State Machine with atomic authorization, payload-bound idempotency, and advisory-only server control frames.

## 2. Scope
- Directional Call Signal Key derivation timing (Asymmetric Caller/Callee), RFC-0003 Salt compliance, and strict Replay Protection algorithms (Sequence > 0).
- Deterministic IV Prefix derivation (Zero-Wire Transmission).
- Identity-bound DTLS fingerprint verification and an unbiased Short Authentication String (SAS).
- Self-hosted, single-binary STUN/TURN infrastructure and Immutable Keyring TURN Secret Lifecycle.
- New WebSocket Envelope types layered on RFC-0005 exposing `call_id` and `signal_seq` strictly as untrusted routing/state hints.
- Explicit Call State Machine, Atomic Call Creation executing Request-Bound Idempotency checks BEFORE Single-Active checks, and Server-Side Glare Arbitration with Canonical Call IDs.
- Zero-Knowledge Trust Establishment (Server-synthesized control frames MUST NOT authorize state rollbacks).
- ICE Failure Detection, Reconnection, and Crash Recovery client behavior.
- Codec mandates, SRTP/DTLS-SRTP protection, and strict Track Replacement (Screen Share) rules.

## 3. Out of Scope
- Group Calling (mesh or SFU topologies) — fundamentally incompatible with 1:1 topologies; deferred to a future major RFC.
- Push Notification wake-up of offline callees (Deferred to RFC-0009).
- Server-side recording, transcription, or live streaming.
- Bandwidth estimation / SFU media servers — v1 is strictly P2P (or TURN-relayed transport, never TURN-decrypted).

## 4. Cryptographic Call Session Architecture

### 4.1. Directional Call Signal Key Derivation & Timing Contract
To prevent fatal AES-GCM nonce reuse when both peers transmit frames simultaneously, the signaling channel MUST use two independent, unidirectional keys derived from the same base secret.
- **Key Agreement:** Reuses the cached X25519 ECDH shared secret established between the caller's and callee's active Session Keys.
- **KDF:** `HKDF-SHA256`. 
- **Explicit Salt:** MUST use exactly the protocol-wide HKDF salt defined in RFC-0003. The salt MUST NOT be redefined locally.
- **Directional Info Strings:**
  - `CallerToCalleeKey`: `[]byte("e2ee/v1/call-signal-key/caller-to-callee") || Call ID (16 bytes) || Caller Identity Hash (32 bytes) || Callee Identity Hash (32 bytes)`
  - `CalleeToCallerKey`: `[]byte("e2ee/v1/call-signal-key/callee-to-caller") || Call ID (16 bytes) || Caller Identity Hash (32 bytes) || Callee Identity Hash (32 bytes)`
- **Exact Derivation Timing & Session Rotation Exception:** 
  - The **caller** MUST derive both Call Signal Keys atomically *before* transmitting `call.invite`. 
  - The **callee** MUST derive both Call Signal Keys immediately after extracting the plaintext `call_id` from the first incoming call envelope, and strictly *BEFORE* decrypting or processing its encrypted payload. 
  - If derivation fails, the call MUST transition immediately to `FAILED`. Because derivation strictly occurs before the first frame is processed, mid-call Session Rotation MUST destroy the underlying Shared Secret Cache (per RFC-0003) but MUST NOT destroy an already-derived active Call Signal Key.

### 4.2. Identity-Bound DTLS Fingerprint Verification & SAS
- **Fingerprint Signature Payload:** `[]byte("e2ee/v1/call-fingerprint") || Call ID (16 bytes) || DTLS Fingerprint SHA-256 (32 bytes) || Role Byte (0x01=Caller, 0x02=Callee)`.
- Signed with the sender's `Identity Private Key` (Ed25519).
- **Verification Rule:** Each peer MUST verify the signature against the counterparty's Identity Public Key **before** calling `setRemoteDescription()`. Media MUST be protected via SRTP/DTLS-SRTP. A signature mismatch MUST abort call setup; the call transitions to `FAILED` with reason `SIGNATURE_MISMATCH`.
- **Short Authentication String (SAS) & Modulo Bias Rejection:**
  1. `Hash = SHA256(CallerFingerprint || CalleeFingerprint || CallID)`
  2. `Val = BigEndianUint32(Hash[0:4])`
  3. **Rejection Sampling:** If `Val >= 4294000000`, compute `Hash = SHA256(Hash)` and return to Step 2.
  4. `SAS = Val % 1000000`, zero-padded to 6 digits.

### 4.3. Signaling Frame AAD, IV & Replay Protection Algorithm
- **Directional IV Prefix:** To guarantee both peers share the same IV prefix without transmitting it on the wire, the 4-byte prefix MUST be deterministically derived:
  `Prefix = HKDF-SHA256(Directional Call Signal Key, Info = "e2ee/v1/call-iv-prefix")[0:4]`
- **IV Generation:** `[4-byte Directional IV Prefix] [8-byte Monotonic Frame Sequence (BigEndian)]`. The sequence is extracted directly from the plaintext `signal_seq` envelope property.
- **Signaling AAD:** `[1-byte Version (0x01)] || [16-byte Call ID] || [1-byte Frame Type] || [8-byte Monotonic Frame Sequence (BigEndian)]`. 
- **Mandatory 64-bit Replay Window Algorithm:** 
  Each direction MUST strictly maintain a 64-bit sliding replay window state:
  - **Initial State:** `send_sequence = 1`, `highest_received_sequence = 0`, `replay_window_bitmap = 0`.
  - **Sequence Zero Rule:** Sequence `0` is strictly INVALID. All signaling sequences MUST start at `1`. Any frame with `signal_seq == 0` MUST be discarded silently.
- **Replay Window Authentication Ordering (Anti-DoS Constraint):**
  The plaintext `signal_seq` is untrusted routing metadata. The receiver MUST NOT advance `highest_received_sequence`, modify `replay_window_bitmap`, or permanently mark a sequence as received until AES-256-GCM authentication succeeds. 
  
  Processing order MUST be:
  1. Validate envelope structure and ensure `signal_seq > 0`.
  2. Derive the IV from the received `signal_seq`.
  3. Construct AAD using the received `call_id`, frame type, and `signal_seq`.
  4. Perform AES-256-GCM authentication and decryption.
  5. If authentication fails, silently discard the frame and MUST NOT modify Replay Window state.
  6. If authentication succeeds, apply the 64-bit Replay Window shift and acceptance logic:
     The active window is strictly defined as `[highest_received_sequence - 63, highest_received_sequence]`.
     - **If `sequence > highest_received_sequence`:**
       `shift = sequence - highest_received_sequence`
       `bitmap = (shift >= 64) ? 1 : ((bitmap << shift) | 1)`
       `highest_received_sequence = sequence`
       *Action:* Accept Frame.
     - **If `sequence <= highest_received_sequence`:**
       `delta = highest_received_sequence - sequence`
       If `delta >= 64` OR `(bitmap & (1 << delta)) != 0` -> *Action:* Discard silently (Replay).
       Else -> `bitmap = bitmap | (1 << delta)` -> *Action:* Accept Frame.
  7. Only then process the decrypted signaling payload.
- **Exhaustion:** Sequence exhaustion MUST terminate the signaling session before `uint64` overflow.

## 5. NAT Traversal & Self-Hosted ICE Infrastructure

### 5.1. Single-Binary STUN/TURN Embedding
The Go backend MUST embed a STUN/TURN server as an in-process `Worker`. Third-party STUN/TURN infrastructure (e.g., Google STUN) is strictly **FORBIDDEN**.

### 5.2. Ephemeral TURN Credential Issuance & Keyring Lifecycle
- **Immutable Keyring Lifecycle:** The configuration MUST define a TURN Keyring array: `[Active_Secret, Previous_Secret]`. Both secrets are strictly loaded at startup and are IMMUTABLE during runtime.
- **Rotation & Downtime Acknowledgement:** Rotation is performed through a controlled process restart. The `Previous_Secret` remains accepted during the credential TTL overlap window. Active calls relying on TURN relays MAY be interrupted by the process restart.
- **Endpoint:** `GET /api/v1/calls/turn-credentials` (Auth: `ps_session` cookie).
- **Username:** `{expiry_unix}:{Base64URL(Identity Hash)}`.
- **Password:** `Base64(HMAC-SHA1(Active_Secret, username))`.

## 6. WebSocket Signaling Envelope Extensions
To allow the server to perform state mutations (`UPDATE calls SET status=... WHERE id=?`) without breaking the Zero-Knowledge content boundary, the `call_id` and `signal_seq` MUST be exposed as plaintext routing/state metadata in the JSON Envelope. 
- **Untrusted Plaintext Constraint:** The `signal_seq` and `call_id` MUST NOT be trusted as proof of message authenticity. Cryptographic authenticity and integrity are exclusively guaranteed after decrypting the payload and verifying the AEAD tag.
- **Cryptographic ID Binding Rule:** For every `call.*` E2E payload that contains a `call_id`, the decrypted payload `call_id` MUST exactly equal the plaintext Envelope `call_id`. Any mismatch MUST cause silent payload rejection by the client and MUST NOT trigger any state transition.

**Envelope Schema Example (`call.*` family):**

    {
      "v": 1,
      "type": "call.invite",
      "request_id": "UUIDv4",
      "routing_id": "Base64URL(RoutingIdentifier)",
      "call_id": "UUIDv4",
      "signal_seq": 1,
      "payload": "Base64(Ciphertext)"
    }

| Type | Direction | Payload (Decrypted E2E) | Notes |
|---|---|---|---|
| `call.invite` | Caller → Callee | `{type, sdp_offer, sig}` | Initiates `RINGING` |
| `call.accept` | Callee → Caller | `{call_id, sdp_answer, sig}` | Transitions to `ACTIVE` |
| `call.reject` | Callee → Caller | `{call_id}` | Transitions to `REJECTED` |
| `call.busy` | Server → Caller | `{canonical_call_id, losing_call_id, glare_override}` | Server-synthesized control frame |
| `call.ice` | Bidirectional | `{call_id, candidate}` | Frame Type `0x03` |
| `call.renegotiate` | Bidirectional | `{call_id, sdp}` | Frame Type `0x04`/`0x05` |
| `call.end` | Bidirectional | `{call_id, reason}` | Extends explicitly frozen `CallEndReason` enum |

**Explicit `CallEndReason` Enum:**
Any `call.end` payload MUST contain exactly one of the following reasons. No other values are permitted.
- `USER_ENDED`
- `ICE_FAILED`
- `CONTROL_PLANE_LOST`
- `SIGNATURE_MISMATCH`

## 7. Call State Machine & Server-Side Arbitration

### 7.1. Explicit CallStatus Enum
    type CallStatus string
    const (
        CallStatusRinging  CallStatus = "RINGING"
        CallStatusActive   CallStatus = "ACTIVE"
        CallStatusEnded    CallStatus = "ENDED"
        CallStatusRejected CallStatus = "REJECTED"
        CallStatusMissed   CallStatus = "MISSED"
        CallStatusFailed   CallStatus = "FAILED"
    )
**Valid Transitions:** `RINGING → ACTIVE`, `RINGING → REJECTED`, `RINGING → MISSED`, `RINGING → FAILED`, `ACTIVE → ENDED`, `ACTIVE → FAILED`. Both `ENDED` and `FAILED` are terminal states.

### 7.2. Atomic Request-Bound Idempotency, Authorization & Call Creation Sequence
To process an incoming `call.invite` and strictly prevent cross-request contamination or network retries from being rejected as conflict errors, the server MUST execute the following exact sequence inside a `BEGIN IMMEDIATE` transaction:

1. **Request-Bound Idempotency Lookup (Primary Check):** Check if `call_id` already exists. If yes:
   - Verify ownership: authenticated `caller_id` MUST equal stored `caller_id`, authenticated `callee_id` MUST equal stored `callee_id`, requested `conversation_id` MUST equal stored `conversation_id`.
   - **Exact Request Fingerprint Binding:** The SQLite idempotency fingerprint MUST be computed over the exact wire-level request fields using a deterministic and version-stable encoding.
   - **Request_Fingerprint Input Encoding MUST be:**
     `[UTF-8 bytes of type] || [16 raw UUID bytes of call_id] || [8-byte BigEndian uint64 signal_seq] || [raw ciphertext payload bytes]`
   - No JSON serialization, Base64 representation, UUID string representation, or textual integer encoding may be used when computing `Request_Fingerprint`.
   - The server MUST compare the lowercase hexadecimal `SHA-256` of this exact byte buffer against the stored `request_fingerprint` in the database.
   - If both ownership and `Request_Fingerprint` match, return the existing call state idempotently (and halt further DB execution).
   - If `Request_Fingerprint` differs, return `409 Conflict`. 
   - Any ownership mismatch MUST return a standard stale/authorization failure without revealing whether the `call_id` exists.
2. **Single-Active & Authorization (Secondary Check):** If `call_id` does NOT exist:
   - Verify the Caller belongs to a valid `DIRECT` conversation with the Callee.
   - Verify neither user has an active conflicting call (`RINGING` or `ACTIVE`). If a conflict exists involving a 3rd party, ABORT and return `call.busy`. If the conflict is with the exact same Caller/Callee pair, proceed to **§7.4 Glare Arbitration**.
3. **Creation:** `INSERT INTO calls (id, request_fingerprint, ...)` as `RINGING`, `COMMIT`, and relay the `call.invite`.

### 7.3. Untrusted Routing Hint & Atomic State Validation
Because the server lacks the E2E keys to verify the AES-GCM AAD, the plaintext `call_id` and `signal_seq` in the envelope MUST be treated strictly as **untrusted routing hints**. Before any state mutation, the Server MUST explicitly authorize the authenticated principal against the target SQLite row:
- `call.accept` → authenticated user MUST equal `callee_id`
- `call.reject` → authenticated user MUST equal `callee_id`
- `call.end` → authenticated user MUST equal `caller_id` OR `callee_id`
- `call.invite` → authenticated user MUST equal `caller_id`

The Server MUST NOT treat the `call_id` itself as proof of message authenticity. State transitions MUST atomically require the expected current state (e.g., `UPDATE calls SET status='ACTIVE' WHERE id=? AND callee_id=? AND status='RINGING'`). If `RowsAffected == 0`, the transition MUST abort and return a stale-call error.

### 7.4. Deterministic Glare Arbitration & Perfect Negotiation Separation
If A and B invite each other concurrently, glare MUST be resolved deterministically inside the transaction:
1. Compare `CallerIdentityHash` and `CalleeIdentityHash` lexicographically. The peer with the smaller hash is the **Polite** peer.
2. **State Merge (Server Arbitration):** The canonical Call is ALWAYS the call initiated by the Impolite peer, regardless of arrival order. The transaction MUST atomically resolve both rows: the Polite peer's losing `call.invite` row MUST transition to `REJECTED` (or be deleted before COMMIT if unexposed), and the Impolite peer's invite is accepted or remains as the canonical `RINGING` call.
3. The server returns a synthesized `call.busy` payload: `{ "canonical_call_id": "UUIDv4", "losing_call_id": "UUIDv4", "glare_override": true }`.
4. **Zero-Knowledge Trust Establishment (Advisory Control Frames):** The server-synthesized `call.busy` frame is strictly **advisory** and MUST NOT, by itself, authorize a call-state transition, trust establishment, or local WebRTC rollback.
5. **WebRTC Perfect Negotiation Contract (Client Behavior):** Upon receiving the advisory `glare_override`, the Polite client MUST wait for the incoming `call.invite` matching the `canonical_call_id`. The client MUST perform the local offer rollback (`setLocalDescription(rollback)`) ONLY AFTER successfully authenticating this canonical peer invite via the E2E cryptographic signature verification rules. The Impolite client MUST ignore the collision.

### 7.5. Ring Timeout Policy
A `RINGING` call MUST transition to `MISSED` after exactly `45 seconds` without a valid `call.accept` or `call.reject`.

## 8. Media Policy & Codec Mandates
- **Audio:** `Opus` is MANDATORY, 48kHz.
- **Video:** `VP8` is MANDATORY. `H.264` MAY be offered as a fallback but MUST NOT be preferred.
- **Screen Share & Renegotiation Rule:** `replaceTrack()` MUST NOT trigger an SDP renegotiation (`call.renegotiate`) if the transceiver direction and codec remain unchanged.

## 9. Persistence & Domain Model (Call Log)
**SQLite Schema (`calls`):**
`id` (PK), `conversation_id` (FK), `caller_id` (FK), `callee_id` (FK), `type`, `request_fingerprint` (TEXT, Lowercase Hexadecimal SHA-256), `status`, `started_at`, `ended_at`, `created_at`.

## 10. Security Considerations & Failure Modes

### 10.1. ICE Failure Detection & Reconnection
- If `iceConnectionState` transitions to `failed` (all direct/TURN paths exhausted), the client MUST send `call.end` with reason `ICE_FAILED` and transition locally to `FAILED`.

### 10.2. Client Behavior Post-Backend Restart
- **Server Control-Plane Crash:** On backend restart, the Recovery Worker MUST transition all `RINGING` rows to `FAILED` and `ACTIVE` rows to `ENDED`.
- **Client Behavior:** If the WebSocket reconnects but the server indicates the call session is invalidated, the client MUST immediately close the `RTCPeerConnection`, terminate media, and synthesize a local `call.end` with reason `CONTROL_PLANE_LOST`.