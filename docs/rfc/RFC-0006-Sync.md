# 💾 RFC-0006: Offline Storage, Vaults & Sync Engine
**Status:** Frozen & Active Execution Directive
**Role:** Principal Frontend/Backend Architect

## 1. Objective
Establish a robust, offline-first client architecture using IndexedDB. Define the deterministic sequence for state recovery (Vaults), pending message synchronization (Pagination), and the secure, immutable lifecycle of offline history archival.

## 2. Scope
- Client-side IndexedDB schema definition (via Dexie.js).
- Deterministic Boot & Sync Sequence (Vaults -> REST Pending -> WebSocket).
- Cryptographic packaging, transmission, and staging of Monthly Vaults.
- Outbound message queue (Offline sending) with Exponential Backoff.

## 3. Out of Scope
- Media blob caching mechanisms (deferred to RFC-0007).
- Background Sync API / Service Workers (deferred to prioritize architectural simplicity).

## 4. Requirements & Specifications

### 4.1. Client-Side Database Schema (IndexedDB / Dexie)
The frontend MUST implement the following cryptographic-aware stores:
- `messages`: `client_uuid` (PK), `conversation_id`, `sender_identity_hash`, `receiver_identity_hash`, `sender_session_id`, `sequence_number`, `encrypted_payload`, `decrypted_state`, `created_at`, `status`.
- `outbox`: `client_uuid` (PK), `receiver_id`, `encrypted_payload`, `sequence_number`, `retry_count`, `created_at`, `status`.
  - **Constraint:** `sequence_number` MUST be allocated BEFORE encryption, as it strictly binds to the AES-GCM AAD defined in RFC-0003.
- `metadata`: `key`, `value` (For storing sync cursors, e.g., `last_server_message_id`).

### 4.2. The Strict Boot & Sync Sequence
Upon application load or returning from an offline state, the client MUST execute this exact sequence BEFORE opening the WebSocket:

1. **Vault Recovery (Login ≠ Vault Unlock):** 
   - Authentication alone does not grant Vault decryption capability.
   - The client MUST reconstruct `Vault_Key` strictly according to RFC-0003. No alternative derivation path is permitted.
   - If `IndexedDB` is empty (e.g., new device), fetch encrypted Vaults from the server, decrypt using the reconstructed `Vault_Key`, and populate `IndexedDB`.
2. **REST Pending Sync (Idempotent & Cursor-Based):** 
   - Call `GET /api/v1/messages/pending?limit=100&cursor=<last_server_message_id>`. (Server routes transient messages via auto-incrementing integer IDs).
   - **Idempotency Rule:** Before persisting an incoming message, check `IF client_uuid exists`. If true, ignore the duplicate. Else, insert.
   - Call `POST /api/v1/messages/ack` with the array of successfully persisted `client_uuid`s to hard-delete them from the server's Transient Queue.
   - Update `last_server_message_id` in local metadata. Loop until the server returns an empty array.
3. **Outbox Flush:** 
   - Attempt to send any pending messages in the local `outbox`.
   - Apply an Exponential Backoff retry policy (e.g., 1s, 5s, 30s, 5m) based on the `retry_count`.
4. **Real-time Connection:** 
   - ONLY after steps 1-3 are complete, upgrade to WSS (WebSocket Secure).

### 4.3. Vault Archival Lifecycle
- **Trigger:** On the first day of a new month, the client gathers all messages from the previous month.
- **Packaging:** Serialize to JSON -> Compress via GZIP.
- **Encryption:** `Ciphertext = AES-256-GCM(Vault_Key, IV, GZIP_Blob)`. 
  - *IV Rule:* The IV MUST be generated using `window.crypto.getRandomValues()`.
  - *AAD Rule:* `AAD = concat(user_id, month_year, vault_schema_version)` to prevent Vault swapping and schema parsing errors.
- **Upload Integrity:** Client calculates `SHA-256(Ciphertext)` and attaches it via the `X-Vault-Hash` HTTP header.
- **Immutability Contract:** Each `month_year` Vault object is strictly immutable. The server MUST reject (HTTP 409 Conflict) overwriting an existing finalized Vault to prevent accidental overwrites or malicious rollbacks.

## 5. Security Considerations & Threat Model
- **T1: Cross-Site Scripting (XSS):** An attacker executing JS can read `IndexedDB`.
  - *Mitigation:* Strict Content Security Policy (CSP). `Identity_Key` and `Vault_Key` MUST reside only in closure memory/RAM, never in `IndexedDB`.
- **T2: Vault Replay/Swapping:** Attacker replaces user's May Vault with their April Vault.
  - *Mitigation:* AES-GCM AAD statically binds the ciphertext to the explicit `month_year`, `user_id`, and `schema_version`. Decryption will strictly fail.

## 6. Failure Modes & Edge Cases
- **F1: The Data Loss Window (Trade-off):** Since the server deletes messages immediately upon ACK, clearing browser storage mid-month *before* the Vault is created results in permanent history loss for that month. *Resolution:* Accepted Zero-Knowledge architectural trade-off. No server plaintext = no server backup.
- **F2: Interrupted Vault Upload & Atomicity:** If the client drops connection mid-upload, the server might store a corrupted blob. 
  - *Mitigation:* Vault uploads MUST use temporary staging storage on the server. The final vault record MUST become visible/persisted ONLY after:
    1. Complete byte reception.
    2. Content-Length validation.
    3. SHA-256 hash verification against `X-Vault-Hash`.
    4. Atomic commit to the final database record.

## 7. Acceptance Criteria
- Client successfully reconstructs full chat history on a completely new browser strictly requiring the user's password to derive the Vault Key.
- Connecting after prolonged offline periods utilizes temporal cursor-based pagination (`server_message_id`) without memory spikes.
- Duplicate messages received during network instability are silently dropped via Idempotency checks.

## 8. Testing Requirements
- **Sync Loop Test:** Verify that 5,000 pending messages are successfully synced in batches of 100 via cursor pagination.
- **Vault Integrity & Atomicity Test:** Server MUST return HTTP 400 if `X-Vault-Hash` does not match, and partial uploads MUST NOT finalize.
- **Vault Test Vector:** MUST include `Vault Key`, `JSON input`, `schema_version`, `gzip output hash`, `IV`, `AES ciphertext`, and `Authentication Tag` for deterministic testing.

## 9. Implementation Notes
- Use `Dexie.js` for IndexedDB interactions.
- Use `pako` for lightweight, client-side GZIP compression.

## 10. Future Compatibility
- The unencrypted JSON structure inside the GZIP MUST include a `schema_version` key matching the AAD binding to seamlessly handle local DB format changes in future client updates.