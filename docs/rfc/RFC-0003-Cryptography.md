# 🔐 RFC-0003: Cryptography, Key Lifecycle & Cipher Formats
**Status:** Frozen (Execution Ready & Implementation Contract)
**Role:** Principal Cryptography Engineer

## 1. Objective
Establish a deterministic, Zero-Knowledge cryptographic foundation. Define explicit cryptographic primitives, exact byte-level wire formats, strict Key Lifecycle, robust replay protection, and precise threat model boundaries.

## 2. Scope
- Cryptographic Primitives and Frozen Parameters.
- Exact Ciphertext, Header, IV, and AAD byte layouts.
- Key Lifecycle (Generation, Rotation, Signatures, Destruction).
- Replay Protection via strictly defined Bitmap Sliding Windows.
- Performance (Shared Secret Caching), Security Mandates, and Test Vectors.

## 3. Out of Scope
- Authentication Transport / Challenge-Response (Deferred to RFC-0004).
- Offline Key Exchange / PreKeys / Double Ratchet (Deferred to RFC-0007).

## 4. Cryptographic Primitives & Frozen Parameters

### 4.1. Identity Key (Ed25519)
- **Algorithm:** Ed25519 (for Proof of Possession & Session Signing).
- **Architecture Note:** Tied deterministically to user credentials for ZK account recovery without server trust.
- **Username Normalization:** `NormalizedUsername = lowercase(Unicode_NFC(Username))`.
- **Derivation:** `Argon2id` (Version: `0x13`). Parameters: Memory Cost `65536` (64 MB), Time Cost `3` iterations, Parallelism `4` threads.
- **Output Length:** `32` bytes (used directly as Ed25519 Seed).
- **Salt:** `SHA256(NormalizedUsername || "IDENTITY")`.

### 4.2. Vault Key (AES-256-GCM)
- **Derivation:** Identical `Argon2id` parameters as Identity Key.
- **Salt:** `SHA256(NormalizedUsername || "VAULT")`.

### 4.3. Message Key (AES-256-GCM) - Per-Message Derivation
- **Key Agreement:** `X25519` ECDH. MUST use `ECDH(Sender Session Private Key, Receiver Session Public Key)`.
- **Shared Secret Caching Policy:** The 32-byte ECDH shared secret MUST be cached in memory per active session to prevent expensive recalculations.
- **Caching Restriction:** Derived *Message Keys* MUST NOT be cached under any circumstances.
- **KDF:** `HKDF-SHA256`. A new derivation MUST be performed for EVERY message.
- **IKM:** The cached 32-byte ECDH shared secret.
- **Salt:** `SHA256("rootinbox-hkdf-salt-v1")`.
- **Info:** `[]byte("rootinbox/v1/e2ee-message-key") || Sender Identity Hash || Receiver Identity Hash || Conversation ID Hash || 8-byte Sequence Number (BigEndian)`.

### 4.4. HKDF Domain Separation Policy
- Every HKDF usage across the protocol MUST define a strict, unique `Info` string prefix (e.g., `rootinbox/v1/vault-key`).

### 4.5. AES-GCM Specifications
- **Authentication Tag:** The AES-GCM authentication tag length MUST be strictly exactly `128 bits` (16 bytes).

## 5. Key Lifecycle, Destruction & Validation

### 5.1. Session Signature Format & Registration Wire Format
- **Signature Payload:** The exact payload for the `Ed25519` signature is: `Crypto Suite Version Byte (1 byte) || SessionPublicKey (32 bytes) || ExpirationUnix (8 bytes, BigEndian) || IdentityPublicKeyHash (32 bytes)`.
- **Registration Wire Format:** `[Identity Public Key (32 bytes)] [Session Public Key (32 bytes)] [Signature (64 bytes)] [Crypto Suite Version (1 byte)] [Expires At (8 bytes, BigEndian)]`.

### 5.2. Strict Verification Order
Clients and Servers MUST process incoming Session Keys sequentially:
1. Validate key length exactly 32 bytes and strictly reject low-order points according to RFC7748 implementation requirements.
2. Verify `Ed25519` Signature against the Identity Public Key.
3. Perform ECDH (cache result) -> HKDF -> AES-256-GCM Decryption (Clients only).

### 5.3. Server-Side Validation Rules
- The Server MUST reject Session Key registration if the `Ed25519` signature is invalid, malformed, or the Identity is unknown.
- **Duplicate Active Session Policy:** The server MUST strictly enforce the Single-Session rule. Registering a new Session Public Key instantly transitions any existing active session into a Grace Period state.

### 5.4. Rotation, Grace Periods & Explicit Destruction
- **Session Key Rotation:** Rotated automatically every 7 days.
- **Identity Migration Event:** Password Change is considered a cryptographic identity migration event. This purges all Session and Identity Keys. Users MUST explicitly re-verify contacts, as the Trust Graph is reset.
- **Grace Period (DECRYPT-ONLY):** The previous Session Public Key remains discoverable for a 24-hour grace period STRICTLY for decrypting delayed offline messages. Clients MUST NOT use Grace Period keys to encrypt new messages.

### 5.5. Shared Secret Cache Binding
- **Storage Rule:** The Shared Secret Cache MUST reside in RAM only and MUST NEVER be persisted to disk/IndexedDB.
- **Cache Key:** The cache key MUST explicitly include the peer Session Identifier (e.g., `ReceiverSessionID_SenderSessionID`) to prevent cross-conversation leakage.
- **Destruction Triggers:** The cache MUST be destroyed instantly upon browser tab close, crash, session expiration, explicit logout, session key rotation, or reaching the authentication failure threshold.

## 6. Wire Formats & Data Structures

### 6.1. Identifiers & Hashes
- **UUID:** strictly `RFC 4122 Version 4`, encoded as **16 raw binary bytes** (NOT ASCII strings).
- **Identity Public Key Hash:** `SHA-256(Raw 32-byte RFC8032 encoded Ed25519 Public Key)`.
- **Conversation ID Hash:** `SHA-256(Conversation UUID)`.
- **Session Identifier:** The first 8 bytes of `SHA-256(Session Public Key)`.

### 6.2. Ciphertext Layout & Future Version Registry
- **Version Registry (0x01):** `X25519 + HKDF-SHA256 + AES-256-GCM`.
- **Ciphertext Layout (BigEndian):** `[Version Byte (1 byte)] [Sender Session ID (8 bytes)] [IV (12 bytes)] [Sealed Ciphertext (Variable)]`.
- **Sealed Ciphertext Note:** Explictly incorporates the 16-byte Authentication Tag appended by standard AES-GCM implementations.

### 6.3. Future Version Negotiation & Downgrade Policy
- **Downgrade Rejection:** The client MUST reject and discard payloads with unknown/legacy version bytes silently before any decryption attempt.

### 6.4. Ciphertext Size Limits
- Maximum encrypted message payload is capped at `5MB` per WebSocket frame.

### 6.5. AAD (Additional Authenticated Data) Encoding
- **Encoding Rule:** AAD fields are fixed-width in `v1`. Future versions MUST introduce length-prefix encoding.
- **v1 Structure:** `[8-byte Sequence Number] [16-byte Client raw UUID] [32-byte Sender Identity Hash] [32-byte Receiver Identity Hash] [32-byte Conversation ID Hash] [8-byte Sender Session ID]`.

## 7. Replay Protection & Sequence Tracking
- **Sequence Ownership:** Strictly monotonic per Sender Session.
- **Replay Window Bitmap:** Clients MUST NOT use simple integer storage. The window MUST be persisted in `IndexedDB` using two exact 64-bit unsigned integers: `uint64 highest_sequence` and `uint64 bitmap`.
- **Window Logic:** The `bitmap` tracks the presence of the last 64 messages relative to `highest_sequence`. Messages falling outside this 64-bit window, or where the corresponding bit is already set to `1`, MUST be dropped silently.
- **Exhaustion Rule:** Sequence number exhaustion MUST trigger a mandatory Session Key rotation before the 64-bit integer overflows.
- **Storage Key:** `ReplayWindow_[SenderIdentityHash]_[SenderSessionID]`.

## 8. Security & Implementation Mandates

### 8.1. RNG, Constant-Time Execution & IV Hybrid Generation
- ONLY `window.crypto.getRandomValues` (or secure equivalent) is permitted.
- **Constant-Time Requirement:** All security-sensitive comparisons MUST utilize constant-time comparison functions.
- **IV Generation (Hybrid):** The 12-byte IV MUST be constructed as: `[4-byte Random Session Prefix] [8-byte Monotonic Message Counter]`.
- **Crash Recovery Rule:** After unexpected application restart or tab eviction, the client MUST NOT reuse any previous IV prefix; a fresh 4-byte Session Prefix MUST be generated immediately.

### 8.2. Cryptographic Failure Policy
- Authentication failures MUST NOT reveal specific error details. 
- **DoS Protection:** If failures exceed 50 consecutive attempts, the client MUST stop processing incoming frames from that sender, zeroize the Shared Secret cache, and log a critical local security event.

### 8.3. Memory Hygiene & Persistence Limits
- **Memory Zeroization:** Best-effort attempt to overwrite sensitive buffers with zeros before releasing references.
- **Key Storage:** Identity Private Keys MUST NEVER be persisted unencrypted. If local persistence is required, it MUST be encrypted using a hardware-backed or browser-provided secure enclave key where available.

### 8.4. Threat Model Clarification: Forward Secrecy
- **Boundary:** This protocol guarantees *Session-Level Forward Secrecy*. If a Session Private Key is compromised, only messages within that 7-day session window are affected. It does NOT provide Signal-grade *Message-Level Forward Secrecy* (Double Ratchet), which is a deliberate architectural trade-off to simplify offline sync.

## 9. WebCrypto Implementation & Fallback Priority
1. **Preferred:** Native WebCrypto API via rigorous Capability Detection. The detection test MUST verify the full lifecycle: `generateKey`, `sign`, and `verify`.
2. **Fallback:** `libsodium-wrappers` (WASM) MUST be utilized if native capability detection fails at any stage.

## 10. Cryptographic Test Vectors
Before production release, the implementation MUST strictly include hardcoded test vectors in the test suite (Go, React, WASM) to ensure cross-platform compatibility. 
- All test vectors MUST be encoded as deterministic lowercase HEX fixtures.
- Each vector MUST explicitly declare: Input bytes, Expected output bytes, Version byte, and associated cryptographic parameters.
- Required coverage: Identity Seed, Public Key extraction, X25519 Secret generation, HKDF Output, and the final AES Sealed Ciphertext generation.