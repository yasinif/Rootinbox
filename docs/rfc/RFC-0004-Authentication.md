# 🛡️ RFC-0004: Authentication, Challenge-Response & Session Management
**Status:** Frozen (Execution Ready & Implementation Contract)
**Role:** Principal Security Engineer

## 1. Objective
Establish a Zero-Knowledge, passwordless authentication protocol using Ed25519 Challenge-Response. Define strict API contracts, secure session transport mechanisms (HTTP-Only Cookies), WebSocket ticket bridging, and transactional state enforcement for the Single-Session rule.

## 2. Scope
- User Registration and Challenge-Response Login flows.
- Nonce lifecycle, atomic consumption, and concurrent login protection via Challenge IDs.
- API Endpoint definitions, payloads, and uniform failure responses.
- Session Transport (Strict Opaque Cookies) and Rotation Policies.
- WebSocket Authentication Bridging (Short-lived Tickets).
- SQLite Transactional Integrity, Database Schema, and Runtime Middleware Checks.

## 3. Out of Scope
- OAuth, SSO, or third-party Identity Providers.
- Password reset/recovery functionality (Mathematically impossible in this model).
- Cryptographic primitive definitions (Strictly inherit from RFC-0003).

## 4. Challenge-Response Primitives & Nonce Lifecycle

### 4.1. Challenge ID & Nonce Generation
- The server MUST generate a cryptographically secure `32-byte Nonce` and a unique `16-byte Challenge ID` (UUID v4) for every login attempt.
- Both values MUST be encoded as `Base64URL` strings before transmission.

### 4.2. Storage & Concurrency Binding
- **Storage Key:** Nonces MUST be keyed uniquely to prevent concurrent attempt overwrites. The cache key MUST be `AuthNonce:{IdentityPublicKeyHash}:{ChallengeID}`.
- **TTL & Store:** MUST have a strict validity window of `120 seconds` and MUST reside exclusively in an ephemeral, memory-backed store (e.g., Redis or in-memory TTL map).
- **Atomic Consumption (Replay Protection):** The Nonce MUST be atomically deleted from the store the exact millisecond it is accessed/verified, regardless of success or failure. The implementation MUST use a `COMPARE-AND-DELETE` atomic operation (e.g., `GETDEL` in Redis or `lock + delete` in memory).

## 5. API Contracts & Protocol Flow

### 5.1. Registration Flow (Establishing the Trust Graph)
- **Endpoint:** `POST /api/v1/auth/register`
- **Request Body:** The `Registration Wire Format` blob precisely as defined in RFC-0003.
- **Server Action:**
  1. Validates the Ed25519 signature.
  2. Executes a strict SQLite `BEGIN IMMEDIATE` transaction to lock the state.
  3. Creates the User record.
  4. Creates the Session record and increments the session version.
  5. Generates the Opaque Session Token and issues the HTTP-Only Cookie.
  6. Commits the transaction.

### 5.2. Login Flow: Phase 1 (Challenge)
- **Endpoint:** `POST /api/v1/auth/challenge`
- **Request Body:** `{ "identity_hash": "Base64URL(IdentityPublicKeyHash)" }`
- **Server Action:** Generates and stores the Nonce mapped to the new Challenge ID.
- **Response:** 
  ```json
  { 
    "challenge_id": "Base64URL(ChallengeID)",
    "nonce": "Base64URL(Nonce)", 
    "expires_in": 120 
  }
  ```

### 5.3. Login Flow: Phase 2 (Response & Device Binding)
- **Client-Side Signature Construction:** The Auth Payload MUST explicitly bind the protocol, nonce, session key, and challenge ID to prevent cross-protocol and cross-device chosen-plaintext attacks.
  - **Auth Payload:** `[]byte("rootinbox/v1/login") || Raw Nonce (32 bytes) || Session Public Key (32 bytes) || Raw Challenge ID (16 bytes)`
  - Signed using the `Identity Private Key` (Ed25519).
- **Endpoint:** `POST /api/v1/auth/verify`
- **Request Body:**
  ```json
  {
    "identity_hash": "Base64URL(IdentityPublicKeyHash)",
    "challenge_id": "Base64URL(ChallengeID)",
    "session_public_key": "Base64URL(SessionPublicKey)",
    "signature": "Base64URL(Ed25519_Signature)"
  }
  ```
- **Server Action:** Retrieves Nonce atomically, reconstructs Auth Payload, verifies signature, executes `BEGIN IMMEDIATE` session rotation (handling grace periods), and issues the Session Token.

## 6. Single-Session Enforcement & Database Contract

### 6.1. Transactional Integrity
- Both `/register` and `/verify` MUST execute an exclusive database transaction (`BEGIN IMMEDIATE` in SQLite) to prevent concurrent login race conditions and guarantee the strict Single-Session rule.

### 6.2. Session Database Schema Contract (Sync with RFC-0001)
The `sessions` table MUST include the following fields:
- `id` (Primary Key)
- `user_id` (Foreign Key)
- `x25519_public_key` (The exact Crypto Session PK from RFC-0003)
- `session_version` (Integer, incremented sequentially per new session)
- `expires_at` (Timestamp)
- `created_at` (Timestamp)
- `revoked_at` (Timestamp, NULL if active. Used for audit and tracking 24-hour Grace Periods).

### 6.3. Session Invalidation & Grace Period
- Upon new session creation, the transaction MUST locate the currently active session, set its `revoked_at` to `NOW()`, and transition it to a `GRACE_PERIOD` state (valid for exactly 24 hours strictly for decryption, per RFC-0003). 
- The new session is then created with an incremented `session_version`.

## 7. Transport, Tokens & WebSocket Bridging

### 7.1. Strict Cookie Contract & Token Hashing
- **Token Generation:** The server MUST generate a cryptographically secure, random 256-bit opaque token. The token MUST NOT contain any user ID or session ID.
- **Database Storage:** The database MUST NEVER store the raw token. It MUST store `SHA256(cookie_token)`.
- **Cookie Attributes:**
  - Name: `ps_session`
  - Flags: `HttpOnly=true`, `Secure=true`, `SameSite=Strict`
  - Path: `/`
  - MaxAge: `604800` (7 Days)

### 7.2. Session Token Rotation Policy
- A new opaque token MUST be generated and the old one invalidated immediately upon:
  1. Successful login.
  2. Privilege elevation or security state change.
  3. Explicit session refresh.

### 7.3. WebSocket Ticket Protocol
WebSockets cannot reliably use cross-origin cookies. A short-lived ticket bridge MUST be implemented:
1. **Request:** Authenticated client calls `GET /api/v1/auth/ws-ticket` (HTTP request, includes `ps_session` cookie).
2. **Issue:** Server verifies cookie, generates a 256-bit random Ticket, and stores it in memory ONLY (No DB).
   - **Ticket Rules:** TTL `<= 30 seconds`, strictly Single-Use.
3. **Upgrade:** Client opens the WSS connection and sends the ticket in the initial frame: `{ "type": "auth", "ticket": "..." }`.
4. **Consume:** Server validates, immediately deletes the ticket from memory, and upgrades the WS connection to an authenticated state.

## 8. Operational Security & Rate Limiting

### 8.1. Explicit Rate Limits
To prevent brute-force and resource exhaustion, the following strict limits MUST be applied:
- `POST /api/v1/auth/challenge`: Max `10 requests / minute` per IP, AND Max `5 requests / minute` per Identity Hash.
- `POST /api/v1/auth/verify`: Max `10 requests / minute` per Identity Hash.

### 8.2. Uniform Failure Response
To prevent identity enumeration and information leakage, all authentication failures (unknown identity, invalid signature, expired challenge, consumed nonce, invalid ticket) MUST delay response via a constant-time comparison approach and return an identical, generic error payload:
  ```json
  {
    "error": {
      "code": "AUTH_001",
      "message": "Authentication failed. Invalid identity, signature, or expired challenge."
    }
  }
  ```

### 8.3. Session Version Atomic Check (Runtime Middleware)
The Single Session Rule MUST be enforced continuously at runtime, not just during login. 
- Every protected HTTP request or active WebSocket connection MUST pass through a middleware that:
  1. Hashes the incoming opaque cookie/token.
  2. Looks up the session in the database.
  3. Validates that `revoked_at IS NULL` (unless accessing a strictly decrypt-only route during a grace period).
  4. Validates that the `session_version` matches the currently active version for that user.
- Connections failing this check MUST be dropped instantly with a `401 Unauthorized`.