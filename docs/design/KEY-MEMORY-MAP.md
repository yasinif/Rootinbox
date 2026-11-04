# RootInbox Cryptographic Key Memory Map & Custody Architecture

- **Document Version**: 1.0.0
- **Status**: **APPROVED ARCHITECTURAL SPECIFICATION**
- **Security Standard**: RFC-0010 §5.1, RFC-0003 §8.3, E2EE-1A-SPEC §2
- **Scope**: Stage 1a Key Hierarchy, Custody Boundaries, Lifetimes, and Zeroization Invariants

---

## 1. Architectural Principles & Custody Boundaries

RootInbox implements a strict **Zero-Knowledge Multi-Tier Key Custody Model** to defend against memory exfiltration, side-channel attacks, cross-site scripting (XSS) blast radius, and accidental persistence.

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                              BROWSER RUNTIME                                │
│                                                                             │
│  ┌─────────────────────────┐             ┌───────────────────────────────┐  │
│  │   UI / Main Thread      │             │  Crypto Dedicated Worker      │  │
│  │   (React / Presentation)│             │  (Exclusive Key Custodian)    │  │
│  │                         │             │                               │  │
│  │  - Zero raw private keys│             │  - id_sign_sk (RAM-only)      │  │
│  │  - Password wiped after │             │  - id_sign_pk (RAM-only)      │  │
│  │    derivation           │             │  - session_sk (RAM-only)      │  │
│  │  - Cached authKeypair & │             │  - ECDH shared secrets (RAM)  │  │
│  │    vaultKey during auth │             │  - Call & media keys (RAM)    │  │
│  │    zeroized on logout   │             │  - Zeroization on destroy()   │  │
│  └───────────┬─────────────┘             └───────────────▲───────────────┘  │
│              │                                           │                  │
│              │ postMessage (CryptoWorkerBridge)          │                  │
│              └───────────────────────────────────────────┘                  │
│                                                                             │
│  ┌──────────────────────────────────────┐  ┌─────────────────────────────┐  │
│  │  Service Worker (Background SW)      │  │  Storage Subsystems         │  │
│  │                                      │  │                             │  │
│  │  - NEVER receives private keys       │  │  - IndexedDB (Dexie):       │  │
│  │  - NEVER receives decrypted plaintext│  │    Encrypted offline msgs   │  │
│  │  - Wakes window with routing signals │  │    Encrypted keyring (AES)  │  │
│  │  - Proves 0-key isolation in tests   │  │  - RAM: All active secrets  │  │
│  └──────────────────────────────────────┘  └─────────────────────────────┘  │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       │ HTTPS / WSS
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            ROOTINBOX SERVER                                 │
│                                                                             │
│  - Receives: auth_pubkey, kdf_salt, session_pk, signatures, ciphertext      │
│  - NEVER sees: passphrase, master_seed, auth_sk, id_sign_sk, plaintext      │
│  - Zero-Knowledge Vault: Stored as unreadable XChaCha20-Poly1305 ciphertext │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Core Custody Invariants
1. **Exclusive Custody**: The dedicated `crypto.worker.ts` is the exclusive logical custodian of long-term identity keys, active session keys, and shared secret caches.
2. **RAM-Only Constraint**: Raw private keys (`id_sign_sk`, `id_dh_sk`, `auth_sk`, `session_sk`, ECDH shared secrets, per-message keys) MUST NEVER be written to `localStorage`, cookies, or unencrypted persistent storage.
3. **SW Zero-Knowledge Isolation**: The Service Worker operates strictly as an untrusted notification/wake broker. As proven by `tests/integration/sw-no-keys.test.ts`, the SW receives zero key material and zero decrypted plaintext.
4. **Deterministic Destruction**: Every active session termination (`logout`) triggers synchronous zeroization across both Worker RAM and Adapter memory via `cryptoPort.destroy()`.

---

## 2. Key Inventory, Lifetimes, and Storage Matrix

| Key / Secret | Type / Algorithm | Size | Custody Boundary | Lifetime | Persistence Policy | Zeroization Mechanism |
|---|---|---|---|---|---|---|
| **Passphrase** | Human input string | >= 12 chars | UI Component State | Form submission only | **NEVER** persisted | Cleared from React state immediately after KDF |
| **Master Seed** | Argon2id output | 32 bytes | Ephemeral RAM | During auth derivation (< 2s) | **NEVER** persisted | Overwritten after HKDF expansions |
| **Auth Keypair** (`auth_pk`, `auth_sk`) | Ed25519 keypair | 32B pk / 64B sk | Infrastructure Adapter / RAM | Active session | Memory-only | `authPrivateKeyBytes.fill(0)` on `destroy()` |
| **Vault Key** | HKDF-SHA256 (`rootinbox:vault:xchacha20`) | 32 bytes | Infrastructure Adapter / RAM | Active session | Memory-only | `vaultKey.fill(0)` on `destroy()` |
| **Recovery Key** | HKDF-SHA256 (`rootinbox:recovery:xchacha20`) | 32 bytes | UI Modal / IndexedDB (temp) | Registration display | Deleted once saved/skipped | `metadataPort.delete('pending_recovery_key')` |
| **Identity Keypair** (`id_sign_pk`, `id_sign_sk`) | Ed25519 keypair | 32B pk / 64B sk | Crypto Worker RAM | Active session | Sealed inside ZK Vault | `_identityPrivateKey.fill(0)` on `destroy()` |
| **Identity DH Keypair** (`id_dh_pk`, `id_dh_sk`) | X25519 keypair (converted) | 32B pk / 32B sk | Derived on demand | Active session | Sealed inside ZK Vault | Derived in Worker / sealed in memory |
| **Session Keypair** (`session_pk`, `session_sk`) | X25519 keypair | 32B pk / 32B sk | Crypto Worker RAM | 24 hours (daily rotation) | IndexedDB keyring (AES-GCM wrapped if rememberMe) | `_sessionPrivateKey.fill(0)` on `destroy()` |
| **ECDH Shared Secrets** | X25519 shared point | 32 bytes | Crypto Worker RAM cache | Local session | Memory-only cache | `secret.fill(0)` for all entries on `destroy()` |
| **Per-Message Keys** | HKDF-SHA256 info-bound | 32 bytes | Ephemeral Worker stack | Single message encrypt/decrypt | **NEVER** cached or stored | Zeroized immediately after AES-GCM call |
| **Call Signaling Keys** (`sendKey`, `recvKey`) | HKDF-SHA256 | 32 bytes each | Crypto Worker RAM | Active WebRTC call | Memory-only map | `.fill(0)` on `dropCall()` or `destroy()` |
| **Media Chunk Keys** | AES-256-GCM | 32 bytes | Crypto Worker RAM | File upload/download | Memory-only map | `.fill(0)` on completion or `destroy()` |

---

## 3. Cryptographic Derivation Flow & Decoupling

Stage 1a eliminates the circular dependency of the legacy architecture by establishing a decoupled key hierarchy:

```text
User Passphrase + Salt (from GET /api/v1/auth/kdf-params)
                       │
                       ▼
          Argon2id (t=4, m=32768, p=1, out=32B)
                       │
                       ▼
              Master Seed (32 bytes)
                       │
       ┌───────────────┼───────────────┐
       ▼               ▼               ▼
  HKDF-Expand     HKDF-Expand     HKDF-Expand
("rootinbox:    ("rootinbox:    ("rootinbox:
auth:ed25519")  vault:xchacha") recovery:xchacha")
       │               │               │
       ▼               ▼               ▼
  Auth Keypair     Vault Key      Recovery Key
(auth_sk, auth_pk)  (32 bytes)     (32 bytes)
       │               │
       │               ▼
       │      Seals & Unseals Vault:
       │      XChaCha20-Poly1305 with AAD:
       │      "rootinbox:zk_vault:v1:" || userId || ":" || version
       │      Payload contains:
       │        - id_sign_pk, id_sign_sk (Ed25519)
       │        - id_dh_pk, id_dh_sk (X25519)
       │        - device roster, epochs, pinned identities
       ▼
Signs Auth Payload & Detached Vault Signature:
  - Challenge verification on POST /api/v1/auth/verify
  - Session key binding signature (73 bytes)
  - Detached Ed25519 signature over sealed vault wire bytes
```

---

## 4. Memory Hygiene & Zeroization Protocol

### 4.1 Logout Sequence (`AuthUseCase.logout`)

When the user logs out, the system executes an exhaustive teardown:

```typescript
// 1. Invoke onBeforeLogout hooks (push unsubscribe, sync flush) with a 3s timeout
await Promise.race([hookPromise, timeoutPromise]);

// 2. Terminate active server session via REST
await this.authPort.terminateSession(sessionId);

// 3. Clear wrapped keys in IndexedDB (if rememberMe was false or clearing keyring)
await this.cryptoPort.clearKeys();

// 4. Zeroize and destroy all in-memory keys
await this.cryptoPort.destroy();

// 5. Purge Dexie metadata tokens
await this.metadataPort.delete('session_token');
await this.metadataPort.delete('identity_hash');
await this.metadataPort.delete('user_id');
await this.metadataPort.delete('active_session_keypair');

// 6. Purge sessionStorage
sessionStorage.clear();
```

### 4.2 Worker RAM Zeroization (`handleDestroy`)

In `crypto.worker.ts`, `handleDestroy()` executes buffer zeroization before reference cleanup:

```typescript
// Explicit zeroization of all cryptographic byte buffers
if (_identityPrivateKey) _identityPrivateKey.fill(0);
if (_identityPublicKey) _identityPublicKey.fill(0);
if (_identityHashBytes) _identityHashBytes.fill(0);
if (_vaultKey) _vaultKey.fill(0);
if (_sessionPrivateKey) _sessionPrivateKey.fill(0);
if (_sessionPublicKey) _sessionPublicKey.fill(0);
if (_sessionIdBytes) _sessionIdBytes.fill(0);
if (_ivPrefix) _ivPrefix.fill(0);

// Clear shared secret caches
for (const [, secret] of _sharedSecretCache) secret.fill(0);
_sharedSecretCache.clear();

// Clear session keyrings
for (const [, entry] of _sessionKeyring) {
  entry.publicKey.fill(0);
  entry.privateKey.fill(0);
}
_sessionKeyring.clear();

// Clear call keys
for (const [, call] of _callKeys) {
  call.c2c.fill(0);
  call.c2r.fill(0);
  call.sendKey.fill(0);
  call.recvKey.fill(0);
  call.sendIVPrefix.fill(0);
  call.recvIVPrefix.fill(0);
}
_callKeys.clear();

// Clear media keys
for (const [, mk] of _mediaKeys) {
  mk.key.fill(0);
  mk.fileIvPrefix.fill(0);
}
_mediaKeys.clear();
```

### 4.3 Adapter Memory Zeroization

In `adapters.ts`, `createCryptoPort.destroy()` ensures cached authentication and vault keys do not linger on the main thread heap:

```typescript
if (cachedAuthKeypair) {
  cachedAuthKeypair.authPrivateKeyBytes.fill(0);
  cachedAuthKeypair.authPublicKeyBytes.fill(0);
  cachedAuthKeypair = null;
}
if (cachedVaultKey) {
  cachedVaultKey.fill(0);
  cachedVaultKey = null;
}
await bridge.call('destroy');
```

---

## 5. Security & Isolation Invariants

1. **Window-to-Worker Separation**: The UI thread never holds or manipulates the long-term identity private key `id_sign_sk`. All message signatures, challenge responses, and decrypt operations are executed via structured clone message passing across the worker boundary.
2. **Timing-Safe Pre-Auth**: `GET /api/v1/auth/kdf-params` returns indistinguishable timing for valid and invalid usernames via HKDF fake-salt expansion, preventing username enumeration.
3. **Cryptographic Domain Separation**: Distinct ASCII context labels for HKDF prevent key reuse across authentication, vault encryption, and recovery.
4. **AAD Binding**: Vault ciphertexts bind `rootinbox:zk_vault:v1:{user_id}:{version}` in the Poly1305 tag, ensuring that ciphertexts cannot be transposed across user accounts or replayed under previous versions.
5. **Rollback Defense**: The client tracks `last_seen_vault_version`. Any server attempt to serve a version lower than the recorded version triggers immediate rollback detection and aborts decryption.
