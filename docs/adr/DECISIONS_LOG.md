# Architecture Decisions Log

## Phase 9: Push Notifications

1. **VAPID Keys**: We encrypt VAPID keys at-rest using AES-256-GCM and the `PUSH_VAPID_ENCRYPTION_KEY`.
2. **Pending Ring Store**: We use a `MemoryPendingRing` for fast staging and polling. State doesn't persist across restarts.
3. **Dispatch Worker**: We use a parallel worker pattern `PushDispatchWorker` for sending HTTP Web Push requests.
4. **Push Client**: We adopted `SherClockHolmes/webpush-go` and encapsulated it strictly within the infrastructure layer (`push.Client`).
5. **Debouncer**: Implemented an in-memory debouncer to strictly prevent multiple wake requests within 60s for the same user.
6. **Web Push Payload Size (T-PAD-1)**: Verified that setting `RecordSize: 64` (rs=64) with an 86-byte RFC 8291 header produces an exactly 150-byte encrypted payload across all push classes. This identical padding resolves Flag #2.

## Phase 12B — Frontend Integration (Calls, Media, Push)

This phase delivered the frontend integration for end-to-end encrypted WebRTC audio/video call signaling and lifecycle state machine, encrypted chunked media upload, download, and thumbnail generation pipelines, and user-opt-in Web Push subscriptions coupled with an 8-step Service Worker background wake sync. Explicitly excluded from this phase were deployment infrastructure (RFC-0012), load and stress testing, TURN server deployment changes, and any backend modifications beyond the authorized §11.5 VAPID public key endpoint.

### ADR-P12B-1 — Call Signal Key HKDF Derivation
Call signal keys are derived through the existing 12A hkdfSha256 primitive with the RFC-0003 protocol-wide salt SHA256("rootinbox-hkdf-salt-v1"); no call-specific salt exists. This avoids inventing new salts and ensures strict cryptographic uniformity across all HKDF derivations in the protocol. Resolves RFC-0008 §4.1.

### ADR-P12B-2 — Atomic Directional Key Derivation
Both directional keys (caller-to-callee and callee-to-caller) are derived atomically in one Worker call; a partial derivation is treated as total failure transitioning the call to FAILED. This prevents half-initialized cryptographic states and asymmetric signaling security. Resolves RFC-0008 §4.1.

### ADR-P12B-3 — Derivation Timing and Pre-Decryption Gate
The caller derives keys before transmitting call.invite; the callee derives immediately after reading the plaintext call_id and strictly before decrypting any payload. This ensures keys are available in Worker memory before any ciphertext processing occurs while preventing unauthenticated payload processing. Resolves RFC-0008 §4.1.

### ADR-P12B-4 — Call Key Isolation from Session Rotation
Mid-call session rotation destroys the shared-secret cache but MUST NOT destroy an already-derived active call signal key; call keys are held in a separate Worker-RAM map keyed by call_id, not in the shared-secret cache. Session key re-negotiation in the background chat plane must not disrupt an in-progress media call. Resolves RFC-0008 §4.1.

### ADR-P12B-5 — Signaling Frame Type Byte Assignments
The frame-type byte assignments (0x01 invite, 0x02 accept, 0x03 ice, 0x04 renegotiate-offer, 0x05 renegotiate-answer, 0x06 reject, 0x07 end) constitute a client-to-client contract only: the server is content-blind and never computes or verifies the signaling AAD. RFC-0008 fixed only 0x03 and 0x04/0x05; 0x01, 0x02, 0x06, and 0x07 are assigned client-side by this ADR. This allows client-side end-to-end authentication of all signaling frame types while preserving server content-blindness. Resolves RFC-0008 §6.

### ADR-P12B-6 — Renegotiation Frame Type Semantics
0x04 represents renegotiate offer, and 0x05 represents renegotiate answer. The transmission direction and role of the offer/answer frame, not the initiating peer's call role, selects the byte. This disambiguates SDP offer vs. answer during mid-call renegotiation. Resolves RFC-0008 §6.

### ADR-P12B-7 — IV Prefix Derivation Salt
The IV-prefix HKDF uses the protocol-wide salt with IKM = the directional call signal key and Info = "e2ee/v1/call-iv-prefix". RFC-0008 §4.3 omits the salt; RFC-0003 §4.4 dictates a unique Info per usage with the single protocol-wide salt. Resolves RFC-0008 §4.3.

### ADR-P12B-8 — Ephemeral In-Memory Signaling Replay Windows
Signaling replay windows are strictly RAM-only, one per direction per call, and are discarded immediately upon any terminal call transition. They are never written to IndexedDB. Calls are inherently transient; persisting replay windows to disk would leak call existence, timing, and metadata to storage. Resolves RFC-0008 §4.3.

### ADR-P12B-9 — Reuse of 12A Replay Window Algorithm
Signaling windows reuse the 12A replay.ts Check/Accept primitives without alteration. RFC-0008 §4.3's algorithm is byte-for-byte identical to RFC-0003 §7; maintaining a second implementation is prohibited. Resolves RFC-0008 §4.3, RFC-0003 §7.

### ADR-P12B-10 — Sequence Number Allocation and Masking
send_sequence starts at 1 and increments per transmitted frame per direction in Worker RAM. Sequence 0 is invalid. BigInt arithmetic with 64-bit masking is enforced to prevent overflow. This adheres to replay window indexing rules and avoids Javascript 53-bit number precision issues. Resolves RFC-0008 §4.3.

### ADR-P12B-11 — Call ID Binding via AAD and Payload
For call.invite, envelope-to-payload call_id binding is provided solely by the 26-byte AAD because the invite payload lacks an internal call_id. For all other call.* frames, the decrypted payload call_id must match the envelope call_id, or the frame is silently dropped. This precludes cross-call frame injection and signaling replay attacks across call sessions. Resolves RFC-0008 §6.

### ADR-P12B-12 — Unencrypted Advisory Nature of call.busy
call.busy is server-synthesized, unencrypted, and strictly advisory. It is parsed as plaintext JSON, never decrypted, never AAD-checked, and never directly drives state transitions beyond glare rollback. The server does not possess the call signal keys; treating unauthenticated server frames as authoritative state drivers would create an injection vector. Resolves RFC-0008 §6, RFC-0008 §7.4.4.

### ADR-P12B-13 — DTLS Fingerprint Canonicalization
DTLS fingerprints are canonicalized from SDP a=fingerprint:sha-256 AA:BB:... by stripping colons, lowercasing, and hex-decoding to exactly 32 bytes. Any algorithm other than SHA-256 triggers immediate call abortion with SIGNATURE_MISMATCH. This enforces strict algorithmic consistency with RFC-0008 mandates and eliminates string encoding variations. Resolves RFC-0008 §4.2.

### ADR-P12B-14 — Worker-Isolated Fingerprint Authentication
Fingerprint signing and signature verification are executed exclusively inside the Crypto Worker. Ed25519 identity keys never leave the Worker thread. Verification occurs strictly before RTCPeerConnection.setRemoteDescription(). This enforces the cryptographic security boundary and prevents SDP injection into the WebRTC state machine prior to cryptographic authentication. Resolves RFC-0008 §4.2, RFC-0010 §5.2.

### ADR-P12B-15 — SAS Rejection Sampling Bound
Rejection sampling for Short Authentication String (SAS) generation is capped at 16 iterations. Exceeding this bound aborts the call as FAILED rather than falling back to biased modular arithmetic. This prevents infinite loops while guaranteeing zero uniform distribution bias. Resolves RFC-0008 §4.2.

### ADR-P12B-16 — Worker-Derived SAS Display Formats
SAS computation is performed in the Worker, which returns both the 6-digit zero-padded decimal string and the raw fingerprint hex strings to the main thread. The main thread never recalculates SAS. This guarantees single-source-of-truth cryptographic derivation and prevents client-side presentation desynchronization. Resolves RFC-0008 §4.2.

### ADR-P12B-17 — Separation of Glare Arbitration and Perfect Negotiation
Server glare arbitration (call.busy / HTTP 409) and client-side Perfect Negotiation are decoupled. The Polite peer rolls back its offer only after cryptographically verifying the incoming canonical peer invite. The Impolite peer ignores colliding offers. This prevents rogue or unauthenticated colliding offers from resetting the WebRTC peer connection. Resolves RFC-0008 §7.4.

### ADR-P12B-18 — Deterministic Client-Side Politeness Evaluation
Politeness is computed by comparing the local and peer lowercase hexadecimal identity_hash strings (local < peer), identical to the Go server's strings.Compare. Politeness is static per peer pair and independent of caller/callee roles. This eliminates reliance on server arbitration for role determination, guaranteeing symmetry. Resolves RFC-0008 §7.4.

### ADR-P12B-19 — Media Survival Across WebSocket Control-Plane Interruption
Transient loss of the WebSocket signaling connection during an ACTIVE call does not tear down media tracks. A 20-second control-plane grace timer (CALL_CONTROL_PLANE_GRACE_MS) governs reconnect; if the socket fails to re-authenticate within 20s, CONTROL_PLANE_LOST terminates the call. P2P and TURN media flows are transport-independent of the signaling channel; transient socket drops should not disconnect active voice/video calls. Resolves RFC-0008 §10.2.

### ADR-P12B-20 — ICE Transport Policy and Server Isolation
iceTransportPolicy is set to 'all', and ICE servers are restricted strictly to the deployment-owned TURN server (which also acts as STUN). External or public STUN servers are prohibited. This protects user IP address privacy from leaking to third-party STUN providers. Resolves RFC-0008 §5.2, RFC-0011.

### ADR-P12B-21 — TURN Credential Ephemerality
TURN credentials are requested immediately before RTCPeerConnection instantiation and are never cached across calls, despite the 24-hour server TTL. Credentials are held in RAM and zeroed upon call teardown. This prevents credential re-use and ensures stale credentials are not used after account state changes. Resolves RFC-0008 §5.2.

### ADR-P12B-22 — Codec Preference Enforcement via WebRTC API
Codec preference is applied using RTCRtpTransceiver.setCodecPreferences, prioritizing VP8 first and placing H.264 last. Opus at 48 kHz is asserted mandatory. Manual SDP string editing is forbidden. This complies with platform standards, prevents SDP syntax corruption, and guarantees high-fidelity audio/video codecs. Resolves RFC-0008 §8.

### ADR-P12B-23 — Screen Share Track Replacement without Renegotiation
Screen sharing utilizes RTCRtpSender.replaceTrack() on existing video transceivers. call.renegotiate is emitted only if negotiationneeded fires due to direction or codec parameter changes; track replacements with identical parameters emit zero signaling frames. This minimizes signaling overhead and avoids glare and ICE restarts during screen sharing toggle. Resolves RFC-0008 §8.

### ADR-P12B-24 — Media Chunk Encryption Nonce Layout
Media chunk encryption utilizes aesGcmSeal with a 12-byte nonce composed of [4-byte File_IV_Prefix][8-byte BE chunk_index]. This guarantees unique nonces per chunk and aligns with the protocol's 4+8 IV layout. Resolves RFC-0007 §4.2.

### ADR-P12B-25 — Ciphertext-Only Chunk Caching for Idempotent Retries
Upload chunks are cached to IndexedDB (media_chunk_cache) as encrypted ciphertext blobs keyed by (file_id, chunk_index). Retries retransmit byte-identical ciphertext without re-encrypting. Plaintext is never stored in this cache. This protects against nonce-reuse vulnerabilities and satisfies the requirement that retries must be byte-identical. Resolves RFC-0007 §4.2.

### ADR-P12B-26 — Client-Side Upload Rate Throttling
Upload chunk transmission is throttled in RAM by a token bucket at <= 30 chunks per minute, matching the server's media.chunk rate class. This prevents HTTP 429 rate limit errors on large file transfers. Resolves RFC-0011 §4.

### ADR-P12B-27 — Progressive Media Rendering with Manifest Gate
Progressive rendering of decrypted chunks is permitted during download, but the asset is marked "unverified" until the SHA-256 chunk manifest hash is validated. A manifest mismatch immediately revokes the object URL and purges the buffer. This provides low-latency user feedback while preserving complete cryptographic integrity enforcement. Resolves RFC-0007 §4.3.

### ADR-P12B-28 — Isolated OffscreenCanvas Thumbnail Generation
Thumbnails are generated by OffscreenCanvas in a dedicated thumbnail.worker.ts separate from the Crypto Worker. Images are padded to 32,768 bytes and encrypted under the file's Media_Key with a fresh 12-byte IV. This isolates complex image decoding/scaling from cryptographic key handling and preserves fixed thumbnail record sizes. Resolves RFC-0007 §4.3, RFC-0010 §5.3.

### ADR-P12B-29 — Media Token Confidentiality and Scoping
The 32-byte Media_Token is generated client-side, hashed for the /init endpoint, and transferred to the recipient strictly inside the end-to-end encrypted message metadata. It is never placed in query strings or logs. This protects media access capabilities from exposure to network intermediaries or logs. Resolves RFC-0007 §5.1.

### ADR-P12B-30 — PENDING_DECRYPT State for Key-Blind Ingestion
The decrypted_state enum is extended with PENDING_DECRYPT for messages stored by the Service Worker during background push wakes where decryption keys are absent. This enables durable background message storage without violating the key-blind Service Worker boundary. Resolves RFC-0010 §5.3, ADR-P12A-28.

### ADR-P12B-31 — Message Content Envelope (MCE) v1 Specification
Plaintext payloads are encoded as JSON Message Content Envelopes: {"v":1,"t":"text","b":"..."} or {"v":1,"t":"media","m":{...}}. Non-JSON payloads fall back to legacy raw text rendering. This establishes a structured, typed message protocol for multimedia while maintaining backwards compatibility with 12A. Resolves RFC-0005, Phase 12A Amendment 2.

### ADR-P12B-32 — Service Worker Wake Deferral to Visible Windows
When a push wake event occurs, the Service Worker inspects active window clients. If any window client is visible, the worker posts a wake message to the page and displays no notification, delegating sync to the main thread. This avoids concurrent database synchronization races and eliminates redundant notifications. Resolves RFC-0010 §6.2.

### ADR-P12B-33 — Durable-Write-Gated Message Acknowledgment
Both the main-thread sync and Service Worker push wake send POST /api/v1/messages/ack only for client_uuids that have been durably written to IndexedDB. This prevents permanent message data loss on the server if client processing fails before disk commit. Resolves RFC-0006 §4.2, RFC-0010 §6.3.

### ADR-P12B-34 — Explicit Opt-In Push Subscription and Graceful Degradation
Push subscriptions require explicit user opt-in, perform at most 1 retry, and degrade silently if push is unavailable or rejected. A 404 from /push/vapid-public-key disables the push UI without user-facing errors. This respects user privacy, complies with browser notification policies, and ensures push remains optional. Resolves RFC-0009 §6.1.

### ADR-P12B-35 — Thumbnail Plaintext Length Prefix
The 32,768-byte padded thumbnail plaintext is structured as [4-byte BE image length][image bytes][zero padding]. The maximum image payload is 32,764 bytes. Decoders slice strictly by the 4-byte prefix. RFC-0007 §4.3 padded thumbnails to 32,768 bytes but omitted a length field in metadata, rendering variable-length images unrecoverable without a prefix. Resolves RFC-0007 §4.3, RFC-0007 §4.4.

### ADR-P12B-36 — Non-Resumability of Uploads Across Page Reloads
Uploads cannot resume across page reloads. The Media_Key is held strictly in Worker RAM; persisting it would constitute key persistence. Boot reconciliation marks interrupted uploads as FAILED and purges cached ciphertext chunks. This preserves the core security invariant that ephemeral media keys are never written to persistent storage. Resolves RFC-0007 §4.2, RFC-0010 §5.3.

### ADR-P12B-37 — Plaintext Media Metadata Ephemerality
Decrypted media metadata (media_key, media_token, file_name, etc.) exists strictly in RAM and is never written to IndexedDB. Downloads reconstruct metadata by re-decrypting the parent message record via redecryptStored. This prevents unencrypted file metadata and media decryption keys from resting in browser storage. Resolves RFC-0007 §4.4, RFC-0010 §5.3.

### ADR-P12B-38 — Strict MIME Render Allowlist with Download Default
Only vetted, safe media MIME types are rendered inline. All other types default strictly to download affordances with sanitized filenames. Unrecognized types are never rendered inline. This prevents script execution, HTML/SVG payload injection, and MIME spoofing attacks. Resolves RFC-0010 §9.2, RFC-0011 §6.

### ADR-P12B-39 — Image-Only Thumbnail Generation Scope
Thumbnail generation is restricted to static image formats. Video thumbnail generation is excluded because canvas video capture requires main-thread decode and exposes attack surface. Non-image files have inline_thumbnail: null. This minimizes attack surface and avoids blocking the main JavaScript execution thread with video decoders. Resolves RFC-0007 §4.3.

### ADR-P12B-40 — userVisibleOnly Notification Handling
When a push wake returns zero new messages and no active call offer, the Service Worker displays no notification, accepting browser generic placeholder behavior rather than fabricating false alerts. Fabricating fake notification copy degrades user experience and violates push integrity contracts. Resolves RFC-0009 §8.2.

### ADR-P12B-41 — Web Lock Synchronization for Message Sync
Background Service Worker sync and active foreground tab sync serialize execution via navigator.locks.request('rootinbox-sync'). This prevents IndexedDB transaction conflicts and duplicate message ack requests between worker and window contexts. Resolves Phase 12A Amendment 3.

### ADR-P12B-42 — Root-Level Call Overlay Mounting
The call user interface is mounted as a persistent overlay at the React application root rather than inside a routed view. This prevents application navigation and route changes from unmounting the call container or tearing down RTCPeerConnection. Resolves RFC-0010 §4.1, RFC-0008 §7.1.

The frame-type byte assignments for 0x01 (invite), 0x02 (accept), 0x06 (reject), and 0x07 (end) are a client-only contract, valid only while the server remains content-blind with respect to the signaling AAD. Any future server-side awareness or validation of frame types requires an RFC-0008 amendment first.

12A Amendment 2 (MCE v1): Recorded as an amendment to the frozen Phase 12A plan. Phase 12A froze no plaintext content format, sealing opaque text strings; MCE v1 supplies a structured UTF-8 JSON envelope format ({"v":1,"t":"text"|"media",...}). The legacy raw-text decryption path is permanent and must be retained indefinitely to decode messages sent under earlier protocol versions.

12A Amendment 3 (Web Lock): The 'rootinbox-sync' Web Lock guard was added to serialize boot/sync routines against Service Worker background wake sync runs. This provides defense-in-depth against IndexedDB write contention and race conditions.

The §11.5 VAPID backend addendum represents the single authorized backend change for Phase 12B. It introduces GET /api/v1/push/vapid-public-key on the existing PushHandler, classified under RouteClassRestGeneral, returning the in-memory 65-byte 0x04-prefixed P-256 public key encoded as Base64URL-unpadded. When push is disabled, it returns 404 with error code PUSH_001. Six dedicated Go unit tests verify key encoding, idempotency, unauthenticated 401 response, disabled 404 response, and zero-database-query execution. Explicitly, no database migration, no new security event, and no new health check or metric accompanied this route.

Closed Flags:
- Flag A — CLOSED as A1: Added GET /api/v1/push/vapid-public-key to expose the server's VAPID public key without requiring client-side build-time key injection or database reads.
- Flag B — CLOSED as B2: Implemented client-side 20-second control-plane grace period (CALL_CONTROL_PLANE_GRACE_MS) and isolated the CallStateProbe port seam to handle temporary WebSocket disconnections without modifying backend call state APIs.
- Flag C — CLOSED as C1: Confirmed TURN services operate on the deployment origin's host, preserving the existing Content Security Policy (connect-src 'self') while maintaining diagnostics on blocked candidates as a safety net.

Condensed §25 Observations:
1. RFC-0008 §6 assigns frame-type bytes for only three frames (0x03, 0x04, 0x05), necessitating the client-only contract established in ADR-P12B-5 for 0x01, 0x02, 0x06, and 0x07 until an RFC amendment occurs.
2. call.busy is server-synthesized and unencrypted, functioning solely as an advisory notification that cannot drive state transitions beyond glare rollback.
3. RFC-0007 §4.4 omits a thumbnail image length field in the metadata schema, requiring ADR-P12B-35's 4-byte big-endian prefix in the padded plaintext (capping images at 32,764 bytes) which should be codified in an RFC-0007 amendment.
4. No GET /api/v1/calls/{call_id} route exists to query call state after control-plane recovery, necessitating the interim 20-second grace timer (Flag B2) until route B1 is implemented.
5. The media.chunk rate limit of 30 requests/minute per user inherently constrains maximum-size 400-chunk uploads to at least 13.3 minutes of transfer time.
6. The download route's server-side rate class was verified as falling under rest.general (60/min), which client-side token budgeting respects.
7. The browser mandate for userVisibleOnly: true in push subscriptions conflicts with zero-message wake events, requiring the worker to display no notification when N=0 and accept potential browser-generated placeholders.
8. Phase 12A omitted an internal plaintext structure, requiring MCE v1 (Amendment 2) and the permanent preservation of the legacy raw-text decoding path.
9. Ephemeral media keys reside strictly in Worker memory and are destroyed on page reload, meaning interrupted uploads cannot be resumed across reloads and must fail cleanly.
10. RFC-0008 §4.3 omits a specific HKDF salt for the call IV prefix, which was resolved by using the standard protocol-wide salt SHA256("rootinbox-hkdf-salt-v1").
11. call.invite frames do not include a call_id inside their encrypted payload, relying exclusively on the 26-byte AAD for cryptographic binding to the call session.
12. GET /api/v1/calls/pending may theoretically return multiple offers, which the client handles defensively by accepting at most one and rejecting subsequent offers.

Carried-Forward Open Flags:
1. Phase 7: Whether TxManager.WithinTransaction (deferred BeginTxx) should be refactored to BEGIN IMMEDIATE, or if ImmediateTxManager remains an additive parallel path.
2. Phase 8: Whether a formal call.error frame should be added to the WebSocket protocol specification to replace silent drops.
3. Phase 9: RFC-0009 §5.2's rs=64 padding arithmetic discrepancy (32-byte padded plaintext producing 48-byte AES-GCM output instead of 64).
4. Phase 9: Resolution of the domain.PushTrigger import cycle workaround.
5. Phase 10: Whether http.Hijacker delegation should be implemented in middleware wrappers to support WebSocket upgrade traversal across all chains.
6. Phase 10: Determination on additive admin_action column vs. dedicated audit table.
7. Phase 10: Session-version invalidation on identity deletion.
8. Phase 12B Recommended Future Fix: Implementation of Option B1 (GET /api/v1/calls/{call_id}) to provide authoritative call state inspection and replace the 20-second client grace heuristic via the established CallStateProbe seam.

## Phase 13 — Feature Expansion

This phase adds user-facing features in 5 bundles on top of the verified E2EE core. Two RFC amendments were authorized by the project owner before any code changes.

### ADR-P13-1 — Amendment RFC-0002-A: Username Registry
Added `username` column (TEXT UNIQUE, NULLABLE) to the `users` table and `User` domain entity as an opt-in public identifier for search. The Zero-Knowledge rule (no email/phone) remains intact — username is a voluntary disclosure, not a PII field. Validation: lowercase `[a-z0-9_]`, 3–32 chars. New `GET /api/v1/users/search?q=` endpoint rate-limited at 10/min per user via `RouteClassUserSearch`. New `PUT /api/v1/users/me/username` endpoint for setting/clearing. Search returns only `user_id`, `username`, `identity_hash` — never public_key, status, or session data.

### ADR-P13-2 — Amendment RFC-0007-B: Group/Channel Non-E2EE Conversations
Added `GROUP` and `CHANNEL` to `ConversationType` enum. These store messages as plaintext on the server (no E2EE), enabling server-side fan-out, search, and moderation. `group_messages` table stores plaintext content with `reply_to_id`, `edited_at`, `deleted_at`. GROUP: 2–256 participants, role-based (OWNER/ADMIN/MEMBER). CHANNEL: unlimited subscribers, only OWNER/ADMIN can post, adds SUBSCRIBER role. Strict E2EE boundary rule: DIRECT/SELF remain encrypted; GROUP/CHANNEL are plaintext. `conversations` table gains optional `name`, `description`, `created_by` columns.

## Phase 14 — Zero-Password Keyring & Active Sessions

### ADR-P14-1 — RFC-0003 §8.3: Remember Keys (Zero-Password Session Restoration)
Authorized under RFC-0003 §8.3 provision for browser-secure key persistence. In order to eliminate the password re-entry prompt upon every page refresh (matching the Telegram/WhatsApp UX), the Crypto Worker generates a fresh non-extractable WebCrypto AES-GCM wrapping key (`CryptoKey`, `extractable: false`) and stores it exclusively in a dedicated IndexedDB keyring database (`rootinbox_keyring`). The user's Identity Key and Vault Key are encrypted (wrapped) under this wrapping key and stored in the same keyring store.
On page reload: if the HTTP-only session cookie is valid, the Crypto Worker unwraps the long-lived Identity and Vault keys into memory without requiring any password input from the user. Session keys (X25519) are not persisted and are re-generated freshly for each connection.
On user logout: both the wrapped key material and the wrapping key are permanently deleted from IndexedDB, ensuring subsequent logins require the master password. If unwrapping fails (corrupted store or profile mismatch), the client falls back to the password unlock screen.

### ADR-P14-2 — Multi-Device Concurrent Sessions
Multiple simultaneous active sessions are officially supported for seamless cross-device synchronization (desktop, mobile, tablet). New logins do not revoke previous sessions; each session maintains independent lifecycle metadata (`device_label`, `ip_hash`, `last_active_at`). Sessions can be inspected and terminated individually or in bulk via `/api/v1/auth/sessions`. Terminated sessions have their server access revoked and their active WebSockets closed immediately with code 1008 ("Session terminated").

