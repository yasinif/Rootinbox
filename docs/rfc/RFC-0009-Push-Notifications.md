# 🔔 RFC-0009: Push Notifications & Offline Wake-Up (Web Push)
**Status:** Frozen (Execution Ready & Implementation Contract)
**Role:** Principal Backend & Web Platform Engineer

## 1. Objective
Establish a Zero-Knowledge-compliant Web Push wake-up mechanism for offline clients. Define the Application Server's encrypted VAPID identity, the mandatory RFC 8291 encryption envelope with a strictly frozen record size, a content-blind payload policy, and the amendment to RFC-0008's offline-callee behavior that this capability unlocks.

## 2. Scope
- Application Server VAPID Identity (generation, encrypted storage at rest, JWT construction).
- The Web Push cryptographic envelope (RFC 8291 / RFC 8292) and its explicit boundary from the platform's own X25519/Ed25519 crypto suite.
- Fixed Web Push Record Size (`rs`), exactly 1-record framing, and content-blind payload padding.
- Subscription lifecycle, domain model, and REST contracts.
- Trigger integration with the existing Offline Message Queue (RFC-0005/0006) and Call Invite flow (RFC-0008).
- Exact VAPID rotation and subscription restriction policies.

## 3. Out of Scope
- Rich, decryptable notification previews (sender identity, message content) — explicitly and permanently forbidden by §8.2, not merely deferred.
- Native mobile push (APNs/FCM SDK integration for non-PWA apps) — this RFC covers the standard Web Push API only.
- Server-initiated marketing/broadcast notifications — this system exists solely as a wake-up signal for the user's own pending data.

## 4. Application Server Identity & VAPID

### 4.1. VAPID Keypair Generation & Storage
- **Algorithm:** `ECDSA P-256` (mandated by RFC 8292 — the Web Push standard does not support Ed25519 for this role; this is an external constraint, not a project deviation from RFC-0003).
- **Scope:** A single global keypair per deployment, identifying the Application Server — NOT tied to any individual user's identity, Trust Graph, or Vault.
- **Bootstrap Integration:** Extends the Startup Lifecycle of RFC-0001 §6. On first boot, if absent, the keypair MUST be generated and persisted in a new singleton table `application_keys` (`id='vapid'` PK, `private_key_encrypted`, `public_key_uncompressed`, `created_at`). 
- **Encryption at Rest:** The VAPID private key MUST NOT be stored as plaintext in SQLite. It MUST be encrypted at rest using a deployment-provided server-side encryption key loaded from immutable configuration. The encryption key MUST NOT be stored in SQLite, logs, or the database.
- **Sequence Constraint:** VAPID key initialization MUST occur after SQLite PRAGMAs and AFTER the migration runner has successfully created the `application_keys` table.

**Updated Bootstrap Position:**
1. Load Config
2. Validate Config
3. Initialize Logger
4. Initialize Metrics
5. Open SQLite Pools
6. Apply PRAGMAs
7. Execute SQL Migrations
8. Initialize/Load VAPID Keypair
9. Verify Readiness
10. Register Routes
11. Start HTTP Server

### 4.2. VAPID JWT Construction
- **Claims:** `aud` (the Push Service's origin, e.g. `[https://fcm.googleapis.com](https://fcm.googleapis.com)`), `exp` (Unix timestamp), `sub` (`mailto:` or `https:` operator contact).
- **Expiry:** `exp` MUST be no more than `12 hours` in the future (well under the RFC 8292 hard ceiling of 24 hours), and the JWT MUST be regenerated per-audience rather than cached indefinitely.
- **Signature:** `ES256` (ECDSA P-256 + SHA-256) using the private key from §4.1.
- **Transport:** `Authorization: vapid t=<JWT>, k=<Base64URL Key Public VAPID>` header on every outbound Push request.

## 5. Web Push Cryptographic Envelope (RFC 8291)
This envelope is **dictated by the Web Push standard itself** — implementers MUST NOT deviate from it, unlike the fully custom wire formats the platform controls elsewhere (RFC-0003, RFC-0007).

### 5.1. Per-Subscription ECDH (P-256) — Crypto Suite Boundary Clarification
- The browser's `PushManager.subscribe()` call generates a **P-256** keypair (`p256dh`) and a 16-byte `auth` secret, entirely independent of the platform's X25519 Session Keys.
- **Explicit Boundary Rule:** This P-256 material MUST NEVER be conflated with, derived from, or substituted for any Identity/Session/Vault key defined in RFC-0003. It exists solely to satisfy the Push transport's own encryption requirement and carries no application-level trust.
- **Encryption:** For each Push request, the server generates a fresh ephemeral P-256 keypair, performs `ECDH(ephemeral private, subscription p256dh public)`, and combines the shared secret with the subscription's `auth` secret via `HKDF-SHA256` (per RFC 8291 §3.3) to derive a Content Encryption Key and Nonce, sealing the payload with `AES-128-GCM`.

### 5.2. Fixed Web Push Record Size & Padding Rule
- **Payload Content:** The plaintext trigger body is a single canonical value, identical for every trigger class: `{"t":"wake"}`.
- **Fixed Record Size (`rs`):** The RFC 8291 `aes128gcm` record size (`rs`) MUST be exactly `64 bytes` for all wake-up triggers.
- **Padding & Framing:** Each push MUST use exactly one RFC 8291 record. The padded plaintext length MUST be exactly `32 bytes` before encryption. Therefore, the encrypted record length is exactly `64 bytes` (including the 16-byte authentication tag and padding delimiter), with the standard RFC 8291 header carried separately.
- **Ciphertext Determinism:** The implementation MUST use RFC 8291 `aes128gcm` framing exactly. The resulting ciphertext body length MUST be deterministic and identical across all trigger classes, preventing the Push Service from distinguishing a message wake-up from a call wake-up by payload size alone. Ciphertext bytes MUST differ across identical payloads due to the fresh RFC 8291 salt and ephemeral ECDH material.
- **Urgency/TTL Differentiation:** Because these headers are necessarily plaintext to the Push Service under the standard (see T1, §9), trigger *timeliness* MAY still be differentiated at the transport level without touching payload content:
  - **Message-class trigger:** `Urgency: normal`, `TTL: 300` (5 minutes — ensures reliable offline wake-up without immediate expiration).
  - **Call-class trigger:** `Urgency: high`, `TTL: 25` (seconds — chosen to leave margin under the 45-second Ring Timeout of RFC-0008 §7.5, not a new independent constant).

## 6. Subscription Lifecycle & Domain Model

### 6.1. REST Contracts
- **`POST /api/v1/push/subscribe`** — Auth: session cookie. Request: `{ "endpoint": "...", "p256dh": "Base64URL(...)", "auth": "Base64URL(...)" }`. **Idempotency:** Upsert keyed on `(user_id, endpoint)` — re-subscribing the same endpoint MUST NOT create a duplicate row.
- **`DELETE /api/v1/push/subscribe`** — Auth: session cookie. Request: `{ "endpoint": "..." }`. Server MUST verify the subscription belongs to the authenticated user before deletion (no existence leakage, consistent with RFC-0002 §5 T1).

### 6.2. Domain Entity & SQLite Schema
    type PushSubscription struct {
        ID         string // Canonical UUIDv4
        UserID     string
        Endpoint   string
        P256dhKey  string // Base64URL
        AuthSecret string // Base64URL
        CreatedAt  int64
    }

**Table `push_subscriptions`:**
- `id` (TEXT PRIMARY KEY)
- `user_id` (TEXT, FK → users.id ON DELETE CASCADE)
- `endpoint` (TEXT) — **Constraint:** UNIQUE `(user_id, endpoint)`
- `p256dh_key` (TEXT)
- `auth_secret` (TEXT)
- `created_at` (INTEGER)

### 6.3. Domain Deletion Policy Extension
Extends the Hard Delete Cascade of RFC-0002 §4.3 with a new final step: **5. Hard delete all `push_subscriptions` for the `user_id`.**

### 6.4. Multi-Subscription / Fan-Out Policy
Unlike the real-time WebSocket connection, Push Subscriptions are explicitly **NOT** subject to the Single-Session Rule of RFC-0004 §6 — a user MAY hold multiple simultaneous subscriptions (phone, desktop, secondary browser). Every trigger (§7) MUST fan out to **all** subscriptions on file for that `user_id`, independently.

## 7. Trigger Integration & Delivery Policy

### 7.1. Offline Message Queue Trigger
When the Atomic Delivery Decision of RFC-0005 §6.2 resolves to "Enqueue" (recipient not live), and the recipient has at least one Push Subscription, the server MUST fire a Message-class trigger (§5.2) to all of that user's subscriptions.

### 7.2. Debounce & Coalescing
To prevent push storms during a burst of incoming messages while offline, triggers for a given `user_id` MUST be debounced to at most one Message-class push per rolling `60-second` window. This debounce state is in-memory only (Worker-managed), consistent with the platform's avoidance of persisting ephemeral coordination state; loss of debounce state on restart is an accepted trade-off (worst case: one extra push).

### 7.3. Amendment to RFC-0008 (Offline Callee)
This RFC extends the offline-callee behavior explicitly deferred to RFC-0009 by RFC-0008 §3:
1. If the callee has zero Push Subscriptions, the call proceeds as normal and eventually transitions to `MISSED` (per RFC-0008 §7.5).
2. If at least one subscription exists, the server MUST instead:
   - Fire a Call-class trigger (§5.2) to all subscriptions.
   - Stage the E2E-encrypted `sdp_offer` and `fingerprint_sig` in a RAM-only **Pending Ring Buffer**.
   - **PendingRingEntry Schema:**
     - `call_id`
     - `callee_identity_hash`
     - `callee_session_id`
     - `caller_session_id`
     - `encrypted_offer`
     - `fingerprint_signature`
     - `expires_at`
   - **Session Binding Rule:** The Pending Ring Buffer MUST be bound to the exact caller and callee Session IDs used when the Call Signal Keys were derived. A pending offer MUST NOT be delivered to a different Session ID. If the required Session is no longer valid upon reconnect, the pending offer MUST be discarded and the call MUST transition to `FAILED`.
   - Create the `calls` row as `RINGING` and start the standard `45-second` Ring Timeout (RFC-0008 §7.5) unchanged.
   - If the callee reconnects within the window and the Session ID matches, its client calls `GET /api/v1/calls/pending` (Auth: session cookie), which returns the buffered offer. The call then proceeds through the normal `call.accept`/`call.reject` flow.
   - If the timeout elapses first, the buffer entry is evicted and the row transitions `RINGING → MISSED`.

## 8. Service Worker Behavior & Notification Display

### 8.1. Uniform Wake Handling
Because the payload is content-blind (§5.2), the Service Worker's `push` event handler performs the **same two actions regardless of trigger class**:
1. `GET /api/v1/calls/pending` — typically empty; if a call is returned, the client surfaces a full incoming-call UI and proceeds via RFC-0008.
2. Trigger the REST Pending Sync subset of the Boot & Sync Sequence (RFC-0006 §4.2, step 2) to pull and persist any queued messages.

### 8.2. Notification Display Mandate (Zero-Content, By Policy)
- Push notifications MUST display only a generic body, e.g. `"You have {N} new message(s)"`, where `N` is the count returned by the sync pull.
- **Explicit Mandate, Not Merely a Limitation:** Even though the client possesses sufficient key material after sync to decrypt and render a rich preview, notifications MUST NOT include sender identity, conversation name, or message content. This is a deliberate lock-screen/shoulder-surfing privacy mandate — not a technical constraint imposed by the encryption itself.

## 9. Security Considerations & Threat Model
- **T1: Push Service Provider (Google/Mozilla/Apple) Traffic Metadata Leakage.** The Push Service inherently observes delivery timing, endpoint identity, and the plaintext `Urgency`/`TTL` headers — this is an unavoidable property of the Web Push standard itself, not a platform design flaw. *Mitigation:* Payload content remains fully opaque and uniform (§5.2), minimizing what is exposed to only what the standard structurally requires.
- **T2: Subscription Hijacking.** *Mitigation:* `POST /api/v1/push/subscribe` and the unsubscribe path both require the authenticated session cookie; ownership is enforced on every mutation (§6.1).
- **T3: VAPID Private Key Compromise & Rotation Policy.** An attacker could impersonate the Application Server to Push Services, but gains no ability to decrypt any subscription's payload or any E2EE content — impact is limited to spam/DoS against push endpoints. *Mitigation:* Standard secret-at-rest handling (§4.1). VAPID subscriptions MUST NOT use VAPID key restriction/binding at subscription creation time. Therefore, rotating the deployment's VAPID key does not invalidate existing subscriptions at the application layer. After rotation, new pushes MUST use the new keypair.
- **T4: Notification Content Leakage on Lock Screen.** *Mitigation:* §8.2's explicit display mandate.

## 10. Failure Modes & Edge Cases
- **F1: Stale/Expired Subscription (HTTP 404/410 from Push Service).** The server MUST treat this as authoritative and immediately hard-delete the corresponding `push_subscriptions` row — no retry.
- **F2: Multiple Devices, Partial Delivery Failure.** Fan-out (§6.4) is independent per subscription; a failure on one endpoint MUST NOT block delivery to the others.
- **F3: Race Between Push-Triggered Reconnect and Normal Sync.** No special handling is required — the client's Boot & Sync Sequence (RFC-0006 §4.2) is already fully idempotent via the `client_uuid` existence check, so a redundant wake-triggered sync racing a user-initiated app open is harmless.
- **F4: VAPID JWT Expiry Mid-Flight.** JWTs are generated per-audience and cached only for a fraction of their validity window; a request racing expiry simply regenerates before send, per §4.2.
- **F5: Pending Ring Buffer Eviction Race.** If the Ring Timeout worker evicts a buffer entry in the same instant a reconnecting client calls `GET /api/v1/calls/pending`, the request MUST return `404 Not Found` (already-terminal call) rather than a stale offer — the read and the eviction MUST be mutually exclusive via the same in-memory lock guarding the buffer.

## 11. Acceptance Criteria
- A client that goes offline and receives a queued message triggers exactly one debounced push notification showing only a count, with zero sender or content metadata visible in the OS notification tray.
- A `call.invite` to an offline-but-subscribed identity results in a high-urgency push; if the callee reconnects within 45 seconds, the call reaches `ACTIVE` exactly as if they had been online.
- Deleting a user account leaves zero rows in `push_subscriptions`.
- Two Push requests for the same logical wake event MUST produce the same ciphertext BODY LENGTH (exactly 64 bytes), but MUST NOT be expected to produce identical ciphertext bytes.

## 12. Testing Requirements
- **Padding Test:** Assert the encrypted payload length is constant across both trigger classes.
- **Debounce Test:** Fire 10 offline `chat.msg` deliveries to the same user within 10 seconds; assert exactly one push is sent.
- **Ring Buffer Race Test:** Concurrently trigger Ring Timeout eviction and a `GET /api/v1/calls/pending` read for the same call; assert exactly one of the two wins deterministically and no panic/data race occurs (`go test -race`).
- **Cascade Test:** Extend the existing RFC-0002 §8 Cascade Test to assert `push_subscriptions` rows are removed on user deletion.
- **Stale Subscription Test:** Mock a 410 response from the Push Service; assert the subscription row is deleted and no retry is attempted.

## 13. Implementation Notes
- **Backend:** A standard Go Web Push library (e.g. `webpush-go`) implementing RFC 8291/8292 is acceptable — this is the one component in the system where hand-rolling the wire format is explicitly discouraged, since §5 is an externally dictated standard rather than a platform-owned contract.
- **Frontend:** Standard `PushManager.subscribe()` / `ServiceWorkerRegistration` / `Notification` APIs. No new client-side cryptographic module is required beyond what §5.1 already delegates to the browser.
- Safari's Web Push support (16.4+, installed PWA required) is standards-compliant with this RFC as written — no vendor-specific branching is needed.

## 14. Future Compatibility
- **Native Mobile Push (APNs/FCM SDK):** Deferred; would require a distinct, non-standard delivery path per platform and is out of scope indefinitely unless a native app shell is introduced.
- **Rich Previews:** Permanently out of scope per §8.2's mandate, not merely deferred — revisiting this would require a separate, explicitly opt-in RFC re-examining the lock-screen threat model.
- **Silent Background Sync (Periodic Background Sync API):** A candidate future minor revision to reduce reliance on push-triggered wake entirely for message sync, browser support permitting.