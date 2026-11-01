# RootInbox E2EE Stage 1a Technical Specification: Decoupled Auth, KDF & Sealed Vault

- **Document Version**: 1.0.0
- **Status**: **APPROVED IMPLEMENTATION SPECIFICATION**
- **Architecture Reference**: [E2EE-DESIGN-v4.md](file:///D:/rootinbox-public/docs/design/E2EE-DESIGN-v4.md)
- **Scope**: Stage 1a (Decoupled Authentication Keypair, Pre-Auth KDF Parameters, Clean-Break Migration 000022, Sealed Zero-Knowledge Vault Storage, and New-Device Onboarding)

---

## 1. Overview & Architectural Goals

In the original RootInbox prototype, the user's single Ed25519 identity keypair was directly used for both directory identity (message signing) and server authentication. Furthermore, accessing client-side state across devices lacked an encrypted server-backed vault mechanism.

Stage 1a introduces the foundation for true Zero-Knowledge End-to-End Encryption (ZKE2EE) by delivering:
1. **Key Hierarchy Decoupling**: Eliminates the authentication circularity by separating the passphrase-derived **Authentication Keypair** (`auth_sk`, `auth_pk`) from the random **Identity Keypair** (`id_sign_sk`, `id_dh_sk`), which remains permanently sealed inside the user's Zero-Knowledge Vault.
2. **Pre-Auth KDF Parameters Endpoint**: Provides a timing-safe, anti-enumeration `GET /api/v1/auth/kdf-params` endpoint returning real user parameters or deterministic fake salts computed via `HMAC-SHA256(SERVER_SALT_SECRET, "kdf-salt:" || username)`.
3. **Clean-Break Database Migration (`000022`)**: Extends `users` with `auth_pubkey` and KDF configuration, purges legacy plaintext archives (`vaults`, `message_history`, `delivery_acks`), and creates `zk_vaults`, `conversation_epoch_keys`, and envelope-ready `group_messages`.
4. **Zero-Knowledge Vault Storage**: Authenticated REST endpoints (`GET` and `PUT` `/api/v1/vault/current`) with optimistic concurrency version checking (`If-Match` header) preventing state rollback and concurrent device overwrite.
5. **Deterministic Cryptographic Derivation**: Calibrated Argon2id parameters (32 MiB memory, 4 iterations, 1 parallelism) and HKDF-SHA256 key expansion with standardized context labels.

---

## 2. Cryptographic Architecture & Derivation Flow

### 2.1 Master Seed & Subkey Derivation

The user's master secret is never transmitted over the network and never stored on disk in plaintext:

```text
User Passphrase (min 12 chars, >= 60 bits entropy) + Salt (16 bytes random)
                         │
                         ▼
             Argon2id (t=4, m=32768 KiB, p=1, out=32 bytes)
                         │
                         ▼
                Master Seed (32 bytes)
                         │
      ┌──────────────────┴──────────────────┐
      │                                     │
      ▼                                     ▼
HKDF-Expand(seed,                     HKDF-Expand(seed,
  "rootinbox:auth:ed25519", 32)         "rootinbox:vault:xchacha20", 32)
      │                                     │
      ▼                                     ▼
Auth Seed (32 bytes)                  Vault Wrapping Key (32 bytes)
      │                                     │
      ▼                                     ▼
crypto_sign_seed_keypair              crypto_aead_xchacha20poly1305_ietf
Auth Keypair (auth_sk, auth_pk)       Encrypts / Decrypts User Vault
```

### 2.2 Domain Separation Context Labels
All HKDF expansions use SHA-256 (`crypto_kdf_hkdf_sha256_expand`) with strictly enforced ASCII info strings:
- **Auth Keypair Seed**: `"rootinbox:auth:ed25519"` (32 bytes output)
- **Vault Wrapping Key**: `"rootinbox:vault:xchacha20"` (32 bytes output)
- **Recovery Key Wrapping**: `"rootinbox:recovery:xchacha20"` (32 bytes output)

### 2.3 AEAD Payload Format
All vault payloads and envelope ciphertexts use **XChaCha20-Poly1305 IETF** (`crypto_aead_xchacha20poly1305_ietf`):
- **Nonce**: 24 cryptographically random bytes (`crypto_aead_xchacha20poly1305_ietf_NPUBBYTES`).
- **Binary Wire Format**:
  $$\text{Binary Blob} = \text{Nonce (24 bytes)} \parallel \text{Ciphertext} \parallel \text{Poly1305 Tag (16 bytes)}$$
- **Additional Authenticated Data (AAD)**:
  $$\text{AAD} = \text{"rootinbox:zk_vault:v1:"} \parallel \text{user\_id} \parallel \text{":"} \parallel \text{version}$$
  Binding `user_id` and `version` inside the AEAD tag guarantees that ciphertext cannot be copied to another user's vault or replayed under a different version number.

---

## 3. Database Schema: Migration `000022_zero_knowledge_vault_and_clean_break`

### 3.1 Migration File Locations
- Up: `internal/infrastructure/migrations/sql/000022_zero_knowledge_vault_and_clean_break.up.sql`
- Down: `internal/infrastructure/migrations/sql/000022_zero_knowledge_vault_and_clean_break.down.sql`

### 3.2 Schema Definition (Up)
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
DROP TABLE IF EXISTS delivery_acks;
DELETE FROM group_messages;
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
DROP TABLE IF EXISTS group_messages;
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

### 3.3 Schema Definition (Down)
```sql
DROP INDEX IF EXISTS idx_group_messages_conv_server;
DROP TABLE IF EXISTS group_messages;
DROP TABLE IF EXISTS conversation_epoch_keys;
DROP TABLE IF EXISTS zk_vaults;

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

## 4. Server API Specifications

### 4.1 Pre-Auth KDF Parameters Endpoint
- **Route**: `GET /api/v1/auth/kdf-params`
- **Query Parameter**: `username` (string, required)
- **Authentication**: None (Public Pre-Auth)
- **Response Status**: `200 OK`
- **Known User Response**:
  ```json
  {
    "status": "success",
    "data": {
      "salt": "4a7bc901e23f...",
      "iterations": 4,
      "memory_kib": 32768,
      "parallelism": 1
    }
  }
  ```
- **Unknown User Response (Anti-Enumeration Fake Salt)**:
  ```json
  {
    "status": "success",
    "data": {
      "salt": "<deterministic_hex_fake_salt>",
      "iterations": 4,
      "memory_kib": 32768,
      "parallelism": 1
    }
  }
  ```
  *Derivation*: `fake_salt = hex(HMAC-SHA256(SERVER_SALT_SECRET, "kdf-salt:" || canonical(username))[:16])`.
  The timing and status code are indistinguishable between existing and non-existing accounts.

### 4.2 Authentication Challenge
- **Route**: `POST /api/v1/auth/challenge`
- **Request Body**:
  ```json
  {
    "username": "alice"
  }
  ```
  *(Backwards-compatible support for `identity_hash` is maintained).*
- **Response Status**: `200 OK`
- **Response Data**:
  ```json
  {
    "status": "success",
    "data": {
      "challenge_id": "c7a8b9d0-...",
      "nonce": "e4f1a23c...",
      "expires_in": 120
    }
  }
  ```

### 4.3 Authentication Login / Verify (Decoupled Auth Keypair)
- **Route**: `POST /api/v1/auth/verify` (or `POST /api/v1/auth/login`)
- **Request Body**:
  ```json
  {
    "username": "alice",
    "challenge_id": "c7a8b9d0-...",
    "signature": "<hex_signature_over_nonce_and_timestamp>",
    "remember_me": true
  }
  ```
- **Verification Logic**:
  1. Look up user by `username`.
  2. If user has `auth_pubkey`, verify `signature` over `nonce || timestamp` using `crypto_sign_verify_detached(signature, message, auth_pubkey)`.
  3. If user is legacy (no `auth_pubkey`), fallback to existing RFC-0004 identity verification.
  4. Create session and return `ps_session` cookie + bearer token.

### 4.4 Zero-Knowledge Vault: Fetch Current
- **Route**: `GET /api/v1/vault/current`
- **Authentication**: Required (`ps_session` cookie or `Authorization: Bearer <token>`)
- **Response Headers**:
  - `ETag: "<version>"`
- **Response Status**: `200 OK` (or `404 Not Found` if user has not uploaded initial vault)
- **Response Body**:
  ```json
  {
    "status": "success",
    "data": {
      "version": 1,
      "ciphertext": "<base64_or_hex_nonce_and_ciphertext>",
      "signature": "<hex_signature_by_auth_sk>",
      "updated_at": 1714567890
    }
  }
  ```

### 4.5 Zero-Knowledge Vault: Update Current (Optimistic Locking)
- **Route**: `PUT /api/v1/vault/current`
- **Authentication**: Required
- **Request Headers**:
  - `If-Match: "<expected_current_version>"` (or supplied in JSON body)
- **Request Body**:
  ```json
  {
    "expected_version": 1,
    "ciphertext": "<base64_or_hex_nonce_and_ciphertext>",
    "signature": "<hex_signature_by_auth_sk>"
  }
  ```
- **Concurrency & Validation Rules**:
  1. Assert caller's `user_id`.
  2. In an atomic transaction:
     - Check current vault version in `zk_vaults`.
     - If current version does not match `expected_version`, abort transaction and respond with `409 Conflict`:
       ```json
       {
         "status": "error",
         "code": "VAULT_409",
         "message": "Vault version conflict. Download latest vault and merge before retrying."
       }
       ```
     - If matched or initial upload (version 0 -> 1), write new ciphertext and signature, increment version:
       `version = expected_version + 1`.
  3. Respond with `200 OK` and new `ETag: "<new_version>"`.

---

## 5. Client Vault Schema (Plaintext Inner Payload)

When decrypted in client Web Worker memory, the vault JSON adheres strictly to:

```typescript
export interface ZeroKnowledgeVaultPayload {
  schema_version: 1;
  user_id: string;
  username: string;
  identity_keys: {
    id_sign_pk: string; // Hex Ed25519 public identity key
    id_sign_sk: string; // Hex Ed25519 secret identity key
    id_dh_pk: string;   // Hex X25519 public DH key
    id_dh_sk: string;   // Hex X25519 secret DH key
  };
  devices: Array<{
    device_id: string;
    label: string;
    created_at: number;
    last_seen_at: number;
  }>;
  conversation_epochs: Record<string, {
    epoch_number: number;
    epoch_key: string;  // Hex 32-byte conversation symmetric key
  }>;
  pinned_identities: Record<string, {
    pinned_pubkey: string;
    pinned_at: number;
    verified: boolean;
  }>;
  recovery_skipped: boolean;
}
```

---

## 6. Security Guarantees & Threat Mitigation

| Threat Vector | Mitigation in Stage 1a |
|---|---|
| **Server Database Dump (Exfiltration)** | Attacker gains `auth_pubkey`, KDF salt, and encrypted vault blob. Attacker CANNOT decrypt messages, cannot decrypt contacts, and cannot read the user's identity keys without cracking Argon2id (32 MiB, 4 iterations). |
| **User Enumeration via Timing** | Pre-auth KDF endpoint returns deterministic fake salts using `HMAC-SHA256(SERVER_SALT_SECRET, ...)`. The client always runs Argon2id, presenting zero timing delta. |
| **Replay & Cross-User Vault Swapping** | AEAD additional authenticated data (AAD) binds `"rootinbox:zk_vault:v1:" || user_id || ":" || version` directly to the Poly1305 MAC tag. Tampering with version or transferring blobs between users fails MAC verification. |
| **Server Rollback Attack** | Clients persist `last_seen_vault_version` locally in IndexedDB. If the server ever returns `served_version < last_seen_vault_version`, the client terminates the session and raises a critical security banner. |
| **Concurrent Device Race** | Server enforces strict optimistic concurrency (`If-Match`). Losing devices receive `409 Conflict`, fetch the winner's vault, perform a union merge of device lists and epoch keys, and re-commit. |

---

## 7. Quality Assurance & Forensic Verification Gates

1. **Unit Tests (Go)**:
   - Migration `000022` test: clean up, apply, verify schema integrity, rollback, re-apply.
   - Pre-auth KDF endpoint: real user salt matching, unknown user determinism, timing consistency.
   - Vault CRUD & Optimistic Concurrency: successful upload, fetch verification, version collision yielding `409 Conflict`.
2. **Unit Tests (Vitest / TypeScript)**:
   - Libsodium KDF derivation against static test vectors.
   - Vault payload encryption, decryption, AAD validation, and tampered ciphertext rejection.
3. **Forensic Gate Integration**:
   - `cmd/zk-audit` baseline runs cleanly with no regression.
   - Server relocation test harness succeeds.
