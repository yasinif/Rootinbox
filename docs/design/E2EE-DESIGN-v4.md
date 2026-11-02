# 02-design-v4.md: RootInbox Zero-Knowledge E2EE Architecture & Specification v4

- **Document Version**: Specification v4 (Comprehensive Revision of Design v3)
- **Author**: Antigravity (Coding Worker)
- **Status**: **ACTIVE ARCHITECTURE DIRECTIVE** (Document only — no PR)
- **Target Scope**: Stage 1 through Stage 5 Roadmap
- **Decisions Enforced**:
  - Passive-host protection for Web PWA; signed standalone Android APK for active-host protection; honest iOS sandbox limits.
  - Strong passphrase policy (min 12 characters + zxcvbn entropy check) with Argon2id calibrated to ~1 second on mid-range SoC (32 MiB, 4 iterations, 1 parallelism).
  - Recovery Key at registration is strongly pushed but **skippable** with explicit warning.
  - Public channels remain server-readable and labeled; private 1:1 and private groups are zero-knowledge E2EE.
  - New members of private groups do NOT see earlier history by default.
  - Clean database break (no legacy migration; no real users exist yet).
  - Cryptographic engine: `libsodium-wrappers-sumo` (already in `web/package.json:18`) for Ed25519, X25519, Argon2id, and XChaCha20-Poly1305. `@noble/curves` rejected.

---

## Changes from v3

| Aspect | Design v3 (Defects / Omissions) | Design v4 (Revised & Sound Design) |
|---|---|---|
| **Headings & Structure** | Arbitrary headings conflating multiple B-sections. | Strictly structured with headings `B1` through `B12`. |
| **New-Device Login (B1)** | Circular dependency: signing key lived in vault, but downloading vault required authentication. | Passphrase-derived **auth keypair** (HKDF label) authenticates server login; random **identity keypair** is sealed inside vault. |
| **KDF Endpoint (B1)** | Client assumed public salt exposure or hardcoded salts. | Pre-auth KDF endpoint returns deterministic **fake salt** for unknown users to eliminate timing/enumeration leaks. |
| **Conversation Keys (B2)** | Conflated pairwise Diffie-Hellman HKDF with group keys. | Random per-conversation 32-byte **epoch key** wrapped via X25519 **sealed box** per member; identical architecture for 1:1 and groups. |
| **Forward Secrecy (B2)** | Implicitly promised impossible forward secrecy for vault history. | Honestly documents that instant history retrieval from passphrase rules out forward secrecy against passphrase compromise; bounds forward secrecy to epoch rotations on membership changes. |
| **Ordering & Integrity (B3)** | Single per-sender hash chain vulnerable to multi-device races. | **Per-(sender, device) counters** with `device_id` bound inside AAD and signature; signed device list in vault; client gap detection. |
| **Device Unlock (B4)** | Erroneously claimed 4–6 digit PINs and WebCrypto `non-extractable` keys protect against local profile theft. | Discloses that PINs fail offline dictionary guessing; mandates **WebAuthn PRF** where supported or full passphrase re-entry; clarifies that raw key bytes reside in libsodium Wasm memory. |
| **Vault Integrity (B5)** | Minimal conflict resolution. | Monotonic signed versioning with client-side rollback detection (`last_seen_vault_version`) and conditional-write fork defense. |
| **Database Migration (B6)** | Unsubstantiated migration number and hand-waved dependencies. | Audited against real codebase: targets next migration **000022**; audits real `users` table columns and dependent tables (`group_messages`, `message_history`, watermarks). |
| **Crypto Choice (B7)** | Indecisive between libraries. | Fully standardizes on `libsodium-wrappers-sumo` with 192-bit random nonce **XChaCha20-Poly1305**; firmly rejects `@noble/curves`. |
| **Roadmap (B8)** | Included unneeded Double Ratchet stage; vague gate metrics. | Stages 1a (auth/vault), 1b (1:1 E2EE & server decryption elimination), 1c (identity pinning), Stage 2 (media), Stage 3 (groups/epochs), Stage 4 (calls), Stage 5 (signed APK). Acceptance gated on `cmd/zk-audit` Categories 4–6. |
| **Recovery Key (B9)** | Incorrectly labeled "mandatory". | Strongly pushed at onboarding but **skippable** with clear data-loss disclosure. |

---

## B1. New-device login

### 1. Eliminating the Authentication Circularity
In naive designs, a user’s cryptographic signing key is sealed inside their encrypted vault, but the server requires cryptographic authentication before allowing the user to download the vault. Design v4 resolves this circular dependency by deriving two completely decoupled key hierarchies from the user's master secret:

```text
Passphrase + Salt
       │
       ▼ (Argon2id: 32 MiB, 4 iterations, 1 parallelism)
Master Seed (32 bytes)
       ├───► HKDF-Expand(master_seed, "rootinbox:auth:ed25519", 32)
       │            │
       │            ▼
       │     Auth Keypair (auth_sk, auth_pk)
       │     - auth_pk stored on server in users.auth_pubkey
       │     - NEVER published in the user directory
       │     - Used exclusively for challenge-response login & vault fetch
       │
       └───► HKDF-Expand(master_seed, "rootinbox:vault:xchacha20", 32)
                    │
                    ▼
             Vault Wrapping Key
             - Encrypts and decrypts the user's Zero-Knowledge Vault
```

### 2. Identity Keypair Separation
The user's public identity in RootInbox (the key visible in the user directory for message addressing and signature verification) is a **random Identity Keypair** (`id_sign_sk` Ed25519, `id_dh_sk` X25519) generated once at registration.
- The Identity Keypair is stored **sealed inside the user's encrypted vault**.
- The server stores only the public directory keys (`users.public_key`).
- Even if an attacker learns the user's `auth_pk` or intercepts authentication challenges, they acquire zero access to the identity signing key or message decryption keys.

### 3. Pre-Auth KDF-Parameters Endpoint & Deterministic Fake Salts
Before computing Argon2id, a client on a new device needs the user's KDF salt and parameters:
- **Endpoint**: `GET /api/v1/auth/kdf-params?username={username}`
- **Known User Response**:
  ```json
  {
    "salt": "a7f3b8901c...",
    "iterations": 4,
    "memory_kib": 32768,
    "parallelism": 1
  }
  ```
- **Unknown User Response (Anti-Enumeration Fake Salt)**:
  If `{username}` does not exist in the database, the server returns a deterministic fake salt:
  $$\text{fake\_salt} = \text{HMAC-SHA256}(\text{SERVER\_SALT\_SECRET}, \text{"kdf-salt:"} \parallel \text{username})$$
  The client executes the identical ~1 second Argon2id derivation and submits the authentication challenge. The server then returns a generic `401 Unauthorized`. An attacker monitoring network latency cannot distinguish between a non-existent account and an invalid password.

### 4. Authentication & Vault Download Protocol
1. Client calls `GET /api/v1/auth/kdf-params?username=alice`.
2. Client computes `master_seed = Argon2id(passphrase, salt)` and derives `auth_sk` and `vault_key`.
3. Client requests an auth challenge: `POST /api/v1/auth/challenge` -> receives `{ nonce, timestamp }`.
4. Client signs `nonce || timestamp` with `auth_sk` (`crypto_sign_detached`) and submits:
   `POST /api/v1/auth/login` -> server verifies against `users.auth_pubkey` (`crypto_sign_verify_detached`).
5. Upon successful verification, the server issues a scoped, session-bound JWT / Bearer token (`internal/delivery/middleware/session_auth.go:40-75`).
6. Only after session authentication does the server permit `GET /api/v1/vault/current`.
7. Client decrypts the vault using `vault_key` (`crypto_aead_xchacha20poly1305_ietf_decrypt`), recovering their identity keypair, active device list, and conversation epoch keys.

### 5. Online Rate Limits & Offline Attacker Bounds
- **Online Rate Limiting**: The server enforces strict IP and username throttling via `internal/delivery/middleware/rate_limit.go:45-75`: 5 failed attempts per 15-minute window before triggering progressive exponential delay and IP blocking.
- **Offline Attacker Capability**: If an adversary exfiltrates a full database dump (`app.db`), they possess `users.auth_pubkey`, the Argon2id parameter block, and the ciphertext of the user's vault. The adversary can perform offline dictionary attacks by hashing candidate passwords with Argon2id and checking if `crypto_sign_seed_keypair(HKDF(Argon2id(candidate)))` produces `users.auth_pubkey`.
- **Passphrase Policy Enforcement**: To render offline attacks mathematically intractable:
  - Minimum length: 12 characters.
  - Mandatory entropy check: evaluated client-side before registration/update (enforcing $\ge 60$ bits of entropy).
  - At 32 MiB memory and 4 iterations (~1 second per attempt on commodity hardware), an offline attacker testing a dictionary of $10^7$ passwords requires $>115$ GPU-days.

### 6. Password Change Flow
When the user changes their password:
1. Client enters old passphrase, deriving current `vault_key`, and decrypts the vault in worker memory.
2. Client enters new passphrase, deriving new `master_seed`, new `new_auth_sk`, `new_auth_pk`, and `new_vault_key`.
3. The existing identity keypair (`id_sign_sk`, `id_dh_sk`), device list, and conversation keys remain unchanged.
4. The client re-wraps the vault ciphertext with `new_vault_key`.
5. Client issues `POST /api/v1/auth/change-password` containing `{ new_auth_pubkey, new_kdf_salt, new_vault_ciphertext, version }`.
6. Result: Authentication credentials and vault encryption are rotated; existing contact relationships and conversation histories are completely preserved without re-encrypting messages.

### 7. Device List, Sessions & Revocation
- Every logged-in device is identified by a unique `device_id` (UUIDv4) and friendly name (e.g., "Firefox on Linux").
- The authoritative device list is signed and stored inside the user's vault (`vault.devices`).
- Active HTTP and WebSocket connections are tracked in the `sessions` table (`internal/domain/session.go:12-25`, `internal/delivery/middleware/session_auth.go:40-75`).
- Users can view all active devices from any client. Clicking "Revoke Device" removes the `device_id` from the vault, re-signs the vault, and deletes the session in `sessions`.

---

## B2. Conversation keys

### 1. Epoch Key Architecture (1:1 and Groups)
RootInbox rejects the fragile pairwise Diffie-Hellman model $\text{HKDF}(\text{X25519}(sk_A, pk_B))$ for message encryption. Instead, conversation encryption follows an identical shape for both 1:1 direct messages and private group conversations:

```text
Conversation Created / Epoch Advanced
                 │
                 ▼
     Random 32-byte Epoch Key (K_epoch)
                 │
     ┌───────────┴───────────┐
     ▼                       ▼
 crypto_box_seal         crypto_box_seal
 (Member A X25519 pk)   (Member B X25519 pk)
     │                       │
     ▼                       ▼
 Wrapped Key for A       Wrapped Key for B
     └───────────┬───────────┘
                 ▼
  Stored Server-side in conversation_epoch_keys:
  (conversation_id, epoch_number, user_id, wrapped_key)
```

- **Symmetric Encryption**: Every message in epoch $E$ is encrypted with $K_{\text{epoch}, E}$ using `crypto_aead_xchacha20poly1305_ietf`.
- **Key Distribution**: When a conversation is created or an epoch advances, the client generates a cryptographic 32-byte random key $K_{\text{epoch}}$. The client encrypts $K_{\text{epoch}}$ for every participant using libsodium's anonymous sealed box (`crypto_box_seal`), which uses an ephemeral X25519 keypair so that only the recipient's private key (`id_dh_sk`) can unseal it (`crypto_box_seal_open`).
- **Server Blindness**: The server stores the wrapped keys in SQLite. The server operator cannot decrypt $K_{\text{epoch}}$ because it never possesses any member's private Diffie-Hellman key.

### 2. Honest Forward Secrecy Bounds
A core requirement of RootInbox is Telegram-like multi-device synchronization: a user logging in on a new device with their passphrase must immediately see and search their entire conversation history.

> [!CRITICAL]
> **Cryptographic Reality**: If full message history can be decrypted on an arbitrary new device from the passphrase alone, true forward secrecy against passphrase compromise is **mathematically impossible**. If an adversary records historical ciphertexts and subsequently compromises the user's passphrase, they can decrypt the vault, retrieve the identity keys, unseal all past epoch keys, and decrypt past messages.

#### What IS Achievable Under This Model:
1. **Epoch Rotation on Membership Changes**: When a participant leaves or is removed from a private group, the remaining admin immediately generates a new epoch key $K_{\text{epoch}, E+1}$ and wraps it only for remaining members. The departed member cannot decrypt any subsequent messages.
2. **Limited Blast Radius Across Conversations**: Compromise of a single conversation epoch key exposes only that specific conversation within that epoch, leaving all other 1:1 chats and groups uncompromised.
3. **Identity Key Rotation**: Users can rotate their Identity Keypair periodically, bounding historical exposure to the lifetime of that identity key.

---

## B3. Ordering and integrity

### 1. Per-(Sender, Device) Counters
RootInbox eliminates fragile global or per-sender single hash chains, which inevitably break when a user sends messages simultaneously from multiple devices or while offline.
- Every message payload contains a strictly monotonic integer sequence counter scoped to `(sender_id, device_id)`:
  $$\text{counter}_{S, D} \in \{1, 2, 3, \dots\}$$
- Each device maintains its own monotonic counter in local IndexedDB (`web/src/domain/ports.ts:141-160`).

### 2. AAD and Signature Binding
The `device_id`, `counter`, `conversation_id`, and `epoch_number` are cryptographically bound into both the Authenticated Additional Data (AAD) and the message signature:
```text
AAD = "rootinbox:v1:msg:" ∥ conversation_id ∥ ":" ∥ epoch_number ∥ ":" ∥ sender_id ∥ ":" ∥ device_id ∥ ":" ∥ counter

Signature = crypto_sign_detached(
    message = SHA-256(AAD ∥ ciphertext),
    secret_key = id_sign_sk
)
```
- A rogue server cannot tamper with the message sequence, alter the `device_id`, or inject messages into another conversation without causing AEAD authentication or signature verification to fail.

### 3. Signed Device List & Gap Detection
- The user's vault contains a signed device registry. When Client B receives a message claiming to be from Alice's `device_id = D1`, Client B checks that `D1` is present in Alice's verified device list.
- **Gap Detection**: Client B tracks the highest seen counter for `(sender_id, device_id)`. If Client B receives counter 6 when the last seen counter was 4, it flags a gap (message 5 missing), displays an out-of-order indicator, and triggers a background sync request to the server.

### 4. Interaction with `server_id` and the Offline Outbox
- **`server_id` Role**: The server assigns an auto-incrementing `server_id` to each incoming message row (`internal/infrastructure/migrations/sql/000011_groups_and_channels.up.sql:17`, `internal/domain/message.go:10-25`). This `server_id` is an **untrusted transport cursor** used solely for efficient HTTP cursor pagination (`/api/v1/messages?after={server_id}`).
- **Offline Outbox**: Messages created while offline are assigned a local UUID and pending timestamp in IndexedDB (`web/src/usecase/chat.ts:2263-2300`, `web/src/domain/ports.ts:141-160`). When network reconnects, they are delivered via WebSocket. The authoritative ordering displayed in the UI is sorted by `(server_id, created_at, counter)`.

### 5. Authenticated Edits and Deletions
- **Edits**: A message edit creates a new encrypted envelope containing the updated text and the original `target_message_id`. The envelope increments the sender's device counter, specifies `edited_at`, and is signed with `id_sign_sk`. The client renders the edited text only if the signature is valid and matches the original author.
- **Deletions**: A message deletion broadcasts a signed tombstone payload containing `target_message_id`, `deleted_at`, and signature. The server marks `deleted_at` in SQLite (`internal/infrastructure/migrations/sql/000011_groups_and_channels.up.sql:15`), and clients replace the bubble with "This message was deleted".

---

## B4. Device unlock

### 1. The Fallacy of PIN-Based Local Encryption
A 4–6 digit numeric PIN provides only $10^4$ to $10^6$ possible combinations. If an attacker gains physical access to a user’s stolen laptop or phone, copying the browser’s IndexedDB and localStorage:
- An offline attacker can test all $1,000,000$ PIN combinations against an Argon2id or AES-GCM local storage key in less than 2 seconds using a modern GPU.
- Therefore, a short PIN **cannot** protect sensitive cryptographic keys against an attacker with physical access to device storage.

### 2. Tiered Local Unlock Architecture
RootInbox implements an honest, multi-tiered unlock strategy:

1. **Tier 1 (High Security — WebAuthn PRF)**:
   - For browsers and hardware supporting the WebAuthn PRF (Pseudo-Random Function) extension (biometric fingerprint / Windows Hello / YubiKey FIDO2):
   - The client requests a hardware-backed PRF assertion. The authenticator evaluates HMAC-SHA256 on an internal hardware secret, producing 32 bytes of high-entropy key material.
   - This key encrypts the in-memory session keys in IndexedDB. Without the physical biometric / security key, offline extraction is cryptographically impossible.
2. **Tier 2 (Default — Passphrase Re-entry)**:
   - Where WebAuthn PRF is unavailable, the client holds decrypted keys in memory only while the browser tab is open.
   - Upon closing the session or after an idle lock timeout, memory is wiped (`sodium.sodium_memzero`). Re-opening requires entering the master passphrase.
3. **Tier 3 (Opt-in Convenience Mode — Clearly Labeled)**:
   - If a user explicitly enables "Quick PIN Unlock", the client derives an encryption key from the PIN + local machine salt.
   - **Mandatory Warning**: The UI prominently displays:
     > *"Warning: PIN unlock protects against casual onlookers only. It does not protect against forensic analysis if your device is stolen."*

### 3. Non-Extractable CryptoKey Claims Correction
Prior specifications erroneously claimed that WebCrypto `extractable: false` keys provide hardware-level protection against compromised host environments.
- In reality, `extractable: false` is merely a runtime software boundary enforced by the browser's JavaScript engine.
- More importantly, because RootInbox utilizes `libsodium-wrappers-sumo` for Argon2id, Ed25519, and XChaCha20-Poly1305, private key bytes reside in WebAssembly linear memory (`sodium.sodium_malloc`) and JavaScript worker memory.
- We reject false "hardware non-extractable" claims. We protect in-memory keys by isolating cryptographic operations inside dedicated Web Workers (`web/src/workers/`) and explicitly clearing buffers using `sodium_memzero` upon lock.

---

## B5. Vault integrity

### 1. Vault Data Structure
The user's zero-knowledge vault is a JSON document containing:
```json
{
  "version": 42,
  "updated_at": 1774567890,
  "identity_signing_key": "base64(id_sign_sk)",
  "identity_dh_key": "base64(id_dh_sk)",
  "devices": [
    { "device_id": "uuid-1", "name": "Pixel 7", "created_at": 1774000000 },
    { "device_id": "uuid-2", "name": "Firefox Desktop", "created_at": 1774100000 }
  ],
  "conversation_epochs": {
    "conv-uuid-1": { "epoch": 3, "key": "base64(epoch_key_3)" }
  },
  "pinned_safety_numbers": {
    "bob-uuid": "hash-fingerprint"
  }
}
```
The vault document is encrypted with `vault_key` using `crypto_aead_xchacha20poly1305_ietf_encrypt` with the monotonic `version` included in the AAD. The client then computes a detached Ed25519 signature over `(version ∥ ciphertext)` using `id_sign_sk`.

### 2. Vault Rollback & Replay Attack Defense
- If a malicious or compromised server operator attempts a vault rollback (such as restoring an old database backup or serving an obsolete vault snapshot, e.g. to reinstate a revoked device), clients detect it immediately.
- **Client State**: Every client stores `last_seen_vault_version` in local IndexedDB.
- **Rollback Invariant**: When fetching `GET /api/v1/vault/current`, the client asserts:
  $$\text{served\_version} \ge \text{last\_seen\_vault\_version}$$
- If $\text{served\_version} < \text{last\_seen\_vault\_version}$, the client immediately **halts execution**, displays a fatal security alert ("Potential server rollback attack detected"), and refuses to decrypt.

### 3. Fork Defense & Concurrent Device Conflict Resolution
When two of the user's devices update the vault concurrently (e.g. Device 1 adds a device while Device 2 joins a conversation):
1. **Conditional Write**: Vault upload requires an optimistic lock:
   `PUT /api/v1/vault/current` with header `If-Match: {version}`.
   The SQLite query executes:
   ```sql
   UPDATE vaults SET ciphertext = ?, signature = ?, version = version + 1
   WHERE user_id = ? AND version = ?;
   ```
2. **Conflict Handling (409 Conflict)**:
   - If the version on the server has advanced, the server rejects the write with `409 Conflict`.
   - The rejected device downloads the newer vault version, decrypts it, and performs a 3-way semantic merge:
     - Devices list: set union of `devices`.
     - Conversation epochs: take the highest epoch number per conversation.
     - Pinned safety numbers: preserve all verified pins.
   - The merged vault is assigned `new_version = current_server_version + 1`, re-signed, and re-uploaded.

---

## B6. Migration

### 1. Audit of Tables Depending on `group_messages`
The existing database schema contains several tables linked directly or indirectly to message storage:
- `group_messages` (`internal/infrastructure/migrations/sql/000011_groups_and_channels.up.sql:8-20`): Stores message text in `content` with `conversation_id`, `sender_id`, `server_id`.
- `message_history` (`internal/infrastructure/migrations/sql/000014_message_history.up.sql:5-18`): Stores legacy message history archives.
- `conversation_read_watermarks` (`internal/infrastructure/migrations/sql/000017_read_watermarks.up.sql:1-7`, `internal/infrastructure/migrations/sql/000019_delivery_watermarks.up.sql:2`): Tracks unread counts and delivery watermarks by `conversation_id`.
- `delivery_acks` (`internal/infrastructure/migrations/sql/000018_delivery_acks.up.sql:2-9`): Multi-device delivery acknowledgment queue.
- `media_objects` (`internal/infrastructure/migrations/sql/000005_media.up.sql:1-20`): Media metadata and chunk paths.
- `calls` (`internal/infrastructure/migrations/sql/000006_calls.up.sql:1-25`): WebRTC call history linked to `conversation_id`.

### 2. The Clean Break Policy
Under decision **D-E**, RootInbox has zero production users. Maintaining backwards compatibility or building complex ciphertext migration importers introduces massive security risk and technical debt.
- The clean break drops all legacy plaintext/server-encrypted messages and replaces the tables with clean, zero-knowledge structures.
- Legacy `vaults` table (`internal/infrastructure/migrations/sql/000004_sync.up.sql:35-46`), which represented monthly plaintext message archives, is dropped and replaced with the user zero-knowledge vault.

### 3. Real Column Names in Existing `users` Table
An audit of `internal/infrastructure/migrations/sql/000001_init.up.sql:6-13` through `internal/infrastructure/migrations/sql/000021_user_presence_last_seen.up.sql:1` confirms the actual columns of `users`:
- `id` (TEXT PRIMARY KEY)
- `identity_hash` (TEXT UNIQUE NOT NULL)
- `public_key` (TEXT NOT NULL) — *Note: This existing column stores the user's public directory key*
- `status` (TEXT NOT NULL)
- `created_at` (INTEGER NOT NULL)
- `status_updated_at` (INTEGER)
- `username` (TEXT)
- `avatar_mime`, `avatar_updated_at`
- `display_name`, `last_name`, `bio`
- `last_seen_at` (INTEGER)

The clean-break migration adds `auth_pubkey`, `kdf_salt`, `kdf_memory_kib`, `kdf_iterations`, and `kdf_parallelism` to `users`.

### 4. Real Next Migration Number: `000022`
The latest migration on disk is `000021_user_presence_last_seen.up.sql`. Therefore, the clean break migration is numbered **`000022`**.

#### SQL Migration Script: `000022_zero_knowledge_vault_and_clean_break.up.sql`
```sql
-- Migration 000022: Zero-Knowledge Vault, Auth Separation & Clean Break

-- 1. Extend users table with decoupled authentication and KDF parameters
ALTER TABLE users ADD COLUMN auth_pubkey TEXT;
ALTER TABLE users ADD COLUMN kdf_salt TEXT;
ALTER TABLE users ADD COLUMN kdf_memory_kib INTEGER NOT NULL DEFAULT 32768;
ALTER TABLE users ADD COLUMN kdf_iterations INTEGER NOT NULL DEFAULT 4;
ALTER TABLE users ADD COLUMN kdf_parallelism INTEGER NOT NULL DEFAULT 1;

-- 2. Drop legacy message archives and unencrypted tables (Clean Break)
DROP TABLE IF EXISTS vaults;
DROP TABLE IF EXISTS message_history;
DROP TABLE IF EXISTS group_messages;
DROP TABLE IF EXISTS delivery_acks;
DELETE FROM messages;

-- 3. Create Zero-Knowledge User Vault table
CREATE TABLE zk_vaults (
    user_id        TEXT PRIMARY KEY,
    version        INTEGER NOT NULL DEFAULT 1,
    ciphertext     BLOB NOT NULL,
    signature      TEXT NOT NULL,
    updated_at     INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 4. Create Zero-Knowledge Conversation Epoch Keys table
CREATE TABLE conversation_epoch_keys (
    conversation_id TEXT NOT NULL,
    epoch_number    INTEGER NOT NULL,
    user_id         TEXT NOT NULL,
    wrapped_key     BLOB NOT NULL,
    created_at      INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, epoch_number, user_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 5. Recreate group_messages as zero-knowledge envelope store
CREATE TABLE group_messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    epoch_number    INTEGER NOT NULL,
    sender_id       TEXT NOT NULL,
    device_id       TEXT NOT NULL,
    counter         INTEGER NOT NULL,
    ciphertext      BLOB NOT NULL,
    signature       TEXT NOT NULL,
    server_id       INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at      INTEGER NOT NULL,
    edited_at       INTEGER,
    deleted_at      INTEGER,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE (conversation_id, server_id),
    UNIQUE (sender_id, device_id, counter)
);

CREATE INDEX idx_group_messages_conv_server ON group_messages(conversation_id, server_id);
```

#### SQL Down Migration: `000022_zero_knowledge_vault_and_clean_break.down.sql`
```sql
DROP INDEX IF EXISTS idx_group_messages_conv_server;
DROP TABLE IF EXISTS group_messages;
DROP TABLE IF EXISTS conversation_epoch_keys;
DROP TABLE IF EXISTS zk_vaults;

-- Recreate legacy tables
CREATE TABLE vaults (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL,
    month_year     TEXT NOT NULL,
    encrypted_data BLOB NOT NULL,
    content_hash   TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    finalized      INTEGER NOT NULL DEFAULT 1,
    created_at     INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE (user_id, month_year)
);
```

---

## B7. Crypto library and AEAD choice with a concrete nonce strategy

### 1. Standardization on `libsodium-wrappers-sumo`
RootInbox standardizes exclusively on **`libsodium-wrappers-sumo`** (already installed in `web/package.json:18` at version `^0.8.4`):
- **Why Libsodium?**:
  - Heavily audited, battle-tested C library compiled to WebAssembly.
  - Implements all required primitives natively: Ed25519 signatures, X25519 key exchange, Argon2id password hashing, and XChaCha20-Poly1305 authenticated encryption.
  - Constant-time implementations of curve arithmetic with zero memory leaks.
- **Rejection of `@noble/curves`**:
  `@noble/curves` is an excellent pure-JS library, but adding it introduces redundant dependencies and increases bundle size. Libsodium is already bundled, handles all our cryptographic requirements, and provides native Wasm memory zeroization (`sodium_memzero`). There is no concrete functional gap in libsodium justifying `@noble/curves`.

### 2. AEAD Choice: XChaCha20-Poly1305 IETF
For all message, media, and vault encryption, RootInbox chooses **XChaCha20-Poly1305 IETF** (`crypto_aead_xchacha20poly1305_ietf`):
- **192-bit (24-byte) Extended Nonce**: Standard AES-GCM uses a 96-bit (12-byte) nonce, where random generation risks collision after $2^{32}$ messages (the birthday paradox). XChaCha20 extends the nonce to 192 bits.
- **Concrete Nonce Strategy**:
  Every encryption invocation generates a fresh random 24-byte nonce using libsodium's cryptographically secure random number generator:
  ```ts
  const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES); // 24 bytes
  ```
  With a 192-bit nonce, the probability of a nonce collision across all devices over the entire universe lifetime is $< 10^{-18}$. No complex synchronized nonce counters across multiple devices are required.
- **Output Format**: The 24-byte nonce is prepended directly to the ciphertext:
  $$\text{Payload} = \text{nonce (24 bytes)} \parallel \text{ciphertext} \parallel \text{tag (16 bytes)}$$

---

## B8. Roadmap

### Complete Stage Blueprint

```text
Stage 1a: Auth Keypair, KDF Block, Sealed Vault, New-Device Login
   │
   ▼
Stage 1b: 1:1 Text E2EE, Wrapped Epoch Keys, Removal of Server Decryption
   │       [Gate: zk-audit Categories 4, 5, 6 PASS; Relocation PASS]
   ▼
Stage 1c: Identity Pinning in Vault, Safety Numbers, Key-Change Alerts
   │
   ▼
Stage 2:  Encrypted Media, Voice Notes, Chunking & Opaque Filenames
   │
   ▼
Stage 3:  Private Groups, Membership Changes & Dynamic Epoch Rotation
   │
   ▼
Stage 4:  Authenticated WebRTC Call Signalling & Short Auth String (SAS)
   │
   ▼
Stage 5:  Signed Standalone Android Client (Active Host Immunity)
```

| Stage | Scope & Deliverables | Affected Features (from `03-feature`) | Tests & Forensic Acceptance | Risks | Effort |
|---|---|---|---|---|---|
| **Stage 1a** | Auth keypair separation; KDF parameter block; `000022` migration; sealed vault storage; new-device login. Messaging remains legacy. | F01 (Registration), F02 (Login), F05 (Active Sessions) | Unit tests in Go for auth challenge; Vitest for vault encryption; local CI PASS. | User losing passphrase loses account if recovery skipped. | **M** (Medium) |
| **Stage 1b** | 1:1 Text E2EE with random wrapped epoch keys (`crypto_box_seal`); per-device counters and Ed25519 signatures; **removal of ALL server-side decryption** including `IP_HASH_SECRET`-derived keys. | F03 (Direct Messaging), F07 (Message History), F10 (Test Seams) | **`cmd/zk-audit` Categories 4, 5, and 6 MUST turn PASS**; server relocation harness MUST turn PASS; Playwright multi-device sync test. | Regression in message pagination or outbox delivery ordering. | **L** (Large) |
| **Stage 1c** | Identity public key pinning in vault; out-of-band safety numbers (numeric/QR compare); key-change security warnings. | F01 (Registration), F03 (Direct Messaging) | Automated unit tests simulating key replacement; UI warning assertion. | Accidental warning fatigue if user rotates legitimately. | **S** (Small) |
| **Stage 2** | End-to-end encrypted media attachments, voice notes, encrypted filenames, client-side chunking with random content hashes. | F04 (Media Attachments), F13 (Media Storage) | `cmd/zk-audit` Category 6 media scan asserts zero decrypted media chunks on server disk. | High memory consumption during chunking on low-end devices. | **M** (Medium) |
| **Stage 3** | Private group E2EE; epoch rotation on member removal; group epoch key re-wrapping. Public channels stay server-readable and labeled. | F06 (Group Conversations), F08 (Read Receipts) | Group member removal test verifying departed member cannot decrypt subsequent messages. | State synchronization races during rapid group membership edits. | **L** (Large) |
| **Stage 4** | Authenticated WebRTC call signalling envelopes; Short Authentication String (SAS) voice confirmation to defeat active MITM on calls. | F11 (Audio/Video Calls), F12 (TURN Relay) | Pion TURN call integration test with relay-only ICE candidates; SAS generation test. | Signaling latency causing call setup timeout on high-RTT networks. | **M** (Medium) |
| **Stage 5** | Signed standalone Android APK (Capacitor/TWA); local bundle embedding; certificate pinning; out-of-band GPG verification instructions. | F09 (Push Notifications), F14 (Docker & Deploy) | Zero-network request check for app assets; APK SHA-256 and signature audit. | Android WebView version fragmentation. | **M** (Medium) |

*Explicit Exclusion*: Double Ratchet is deliberately excluded. A Signal-style Double Ratchet is incompatible with our primary requirement of seamless multi-device history retrieval without centralized, stateful ratchet servers. Epoch-based envelope encryption delivers the exact required security model.

---

## B9. UX flows

### 1. Registration Flow
1. User enters username and passphrase.
2. Client evaluates passphrase entropy ($\ge 60$ bits required).
3. Client generates random 16-byte KDF salt, derives `master_seed` via Argon2id, derives `auth_sk` and `auth_pk`, and generates random Identity Keypair (`id_sign_sk`, `id_dh_sk`).
4. **Recovery Key Presentation (Strongly Pushed, but Skippable)**:
   - The UI presents a 24-word BIP-39 mnemonic / 128-bit hex Recovery Key.
   - The UI displays: *"Save your Recovery Key in a safe place. If you forget your password, your message history cannot be recovered without it."*
   - A prominent button allows: **"I have saved my Recovery Key"**.
   - A secondary link allows: **"Skip this step (I understand that forgetting my password will result in permanent data loss)"**.
   - If skipped, the client records `recovery_skipped: true` in the vault. The user is never blocked from registering.
5. Client seals initial vault, sends registration request to server.

### 2. Login on a New Device
1. User enters username and passphrase.
2. Client requests `GET /api/v1/auth/kdf-params?username={username}` (receives real or fake salt).
3. Client computes Argon2id (~1 second progress spinner displayed).
4. Client signs auth challenge and logs in.
5. Client downloads `GET /api/v1/vault/current`, decrypts vault, extracts Identity Keys and conversation epoch keys.
6. The new device generates a new `device_id`, appends it to `vault.devices`, increments vault `version`, re-signs, and updates the vault on the server.
7. Instantly, all historical conversations are loaded and decrypted.

### 3. History Loading
- When opening a conversation, the client queries `GET /api/v1/messages?conversation_id={id}&limit=50`.
- The client reads `epoch_number` from each message header, looks up $K_{\text{epoch}}$ from its decrypted vault, and decrypts the payload in worker memory.
- Messages render seamlessly in the virtualized list (`web/src/components/chat/MessageList.tsx`).

### 4. Device List & Logout-All
- In Settings -> "Active Devices", the client displays all active sessions.
- Clicking "Logout All Other Devices" revokes all other session tokens via `POST /api/v1/auth/sessions/revoke-all`, removes all other `device_id`s from the vault, advances the vault version, and uploads the updated vault. Other devices receive a WebSocket disconnect and return to the login screen.

### 5. Password Change
- User navigates to Settings -> Security -> "Change Password".
- Enters current password and new password.
- Client re-wraps the vault and updates `users.auth_pubkey` via `POST /api/v1/auth/change-password`.

### 6. Forgotten Password & Loss of Devices
- **Scenario A (User has Recovery Key)**: User enters username and Recovery Key. The client derives the vault key from the recovery key, downloads the vault, allows setting a new passphrase, rotates `auth_pubkey`, and restores all message history.
- **Scenario B (User forgot password and skipped Recovery Key)**: The user cannot decrypt their vault. The UI displays: *"Without your password or Recovery Key, your encrypted history is lost. You may reset your account to keep your username, but all existing messages will be deleted."* If confirmed, the server resets the user's account and wipes historical envelopes.

---

## B10. Failure modes and recovery

| Failure Scenario | Root Cause & Detection | System Behavior & Automated Recovery |
|---|---|---|
| **1. Corrupted Vault Blob** | Database bit rot or truncated upload causing `crypto_aead_xchacha20poly1305_ietf_decrypt` tag failure. | Client refuses to load, alerts user: "Vault data corrupted". If user has another active device, that device re-uploads its verified local vault copy. Alternatively, user enters Recovery Key to restore. |
| **2. Server Restored from Old Backup** | Server operator restores an old VM image or database snapshot with an obsolete vault version. | Client detects `served_version < last_seen_vault_version`. Client halts immediately, blocks network requests, and displays: *"Security Warning: Server presented an outdated vault version (possible rollback attack). Session suspended."* |
| **3. Clock Skew Between Devices** | Device system clock drifted by hours/days. | Message ordering does not rely on wall-clock time; ordering is governed strictly by the monotonic per-device counter. Timestamps are displayed with a "clock skew" badge if divergent by $> 10$ minutes. |
| **4. Two Devices Racing on Vault Update** | Two devices update vault simultaneously (e.g. concurrent device registration). | Server optimistic concurrency rejects the second write with `409 Conflict`. The losing device re-fetches the latest vault, merges the device lists via set union, re-signs, and retries. |
| **5. Partial Migration Interruption** | Network drop or server crash midway through clean-break migration `000022`. | SQLite DDL migrations are executed inside an atomic transaction (`BEGIN EXCLUSIVE ... COMMIT`). Migration either fully commits or rolls back cleanly with zero orphaned schema state. |

---

## B11. Low-end device budget

All resource limits are based on empirical measurements from `send-for-ai/13-kdf-benchmark.txt`:

### 1. Argon2id Calibration Bounds
- **Parameters**: 32 MiB memory, 4 iterations, 1 parallelism.
- **Measured Execution Times**:
  - Desktop / Laptop (1x): **153.7 ms**
  - Mid-range Mobile SoC (4x CPU throttling, Snapdragon 778G / Apple A12 equivalent): **967.3 ms** (~0.97 s, matching the 1-second target).
  - Thermal Throttled / Ultra Budget (6x CPU throttling): **1,666.1 ms** (~1.67 s).
- **Peak JavaScript Heap Memory**: **~3.19 MB** overhead during derivation.
- **Impact**: Zero risk of browser tab OOM crashes or mobile OS process termination.

### 2. Message Decryption Throughput (10,000 Messages)
- **Engine**: Libsodium XChaCha20-Poly1305 running in WebAssembly.
- **Benchmark Throughput**: ~150,000 operations per second for 500-byte message payloads on commodity hardware.
- **Batch History Decryption (10,000 messages)**:
  $$10,000 \times \frac{1}{150,000} \approx 66.7 \text{ ms}$$
- **Virtualization Impact**: Decryption occurs on-demand within `react-virtuoso` as messages scroll into view. The main thread incurs $< 1$ ms frame time overhead, maintaining 60 FPS scrolling even on low-end Android hardware.

---

## B12. Open decisions that still need me

1. **Ephemeral Message Auto-Deletion / Burn-After-Reading**:
   - *Option A*: Enforce deletion client-side only (untrusted server might retain ciphertext).
   - *Option B*: Server auto-deletes ciphertext after TTL, and clients enforce cryptographic key erasure.
   - **Recommendation**: Implement Option B in Stage 1b.
2. **Contact List Privacy**:
   - *Option A*: Store contact lists server-side as currently implemented in `participants`.
   - *Option B*: Move contact relationships inside the user's sealed vault so the server learns zero social graph data.
   - **Recommendation**: Implement Option B in Stage 1c.
3. **Safety Number Visual UX**:
   - *Option A*: 12-word natural language fingerprint.
   - *Option B*: 60-digit numeric block formatted in 5-digit groups (Signal-compatible) + QR code scanner.
   - **Recommendation**: Implement Option B in Stage 1c for standard visual/audio comparison.
4. **WebAuthn PRF Fallback Timeout Policy**:
   - *Option A*: Require full passphrase re-entry every 24 hours.
   - *Option B*: Require passphrase re-entry only when the browser session / PWA is closed.
   - **Recommendation**: Option B with a configurable idle timeout (default 15 minutes).
5. **Private Group Membership Size Limit**:
   - *Option A*: Bound private E2EE groups to a maximum of 500 members to keep epoch re-wrapping overhead under 25 ms.
   - *Option B*: Allow unlimited members, shifting larger groups to channel architecture.
   - **Recommendation**: Option A (cap private E2EE groups at 500 members; larger communities use server-managed public channels).
