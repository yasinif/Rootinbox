# 📂 RFC-0007: Zero-Knowledge Media & Attachment Streaming
**Status:** Frozen (Execution Ready & Implementation Contract)
**Role:** Principal Architecture & Cryptography Engineer

## 1. Objective
Establish a Zero-Knowledge, memory-efficient media handling pipeline. Define cryptographic chunking with strict padding, Capability-based Download Authorization (Media Capability Token), deterministic File-Level Integrity, explicit Garbage Collection, and race-condition-free state transitions using Optimistic Concurrency Control, Atomic Filesystem I/O, unified File I/O locking, strict Crash Recovery rules, and an Atomic Quota Lifecycle.

## 2. Scope
- Fixed-size Cryptographic Chunking & Zero-Byte Padding Rules.
- Media Capability Token (MCT) for Zero-Knowledge Authorization.
- Encrypted Thumbnail Wire Format, Key, & AAD Binding.
- Chunk AAD Binding & File Manifest Integrity Verification (Disk-Verified).
- Resumable Upload (Per-File I/O Lock, Atomic Write-Sync-Rename-DirSync), 2-Phase Idempotent Finalization, and Download APIs.
- Strict Local Filesystem Storage (v1), Crash Recovery Rules, Explicit State Machine, and exact `user_quotas` Repository Contract.

## 3. Out of Scope
- Voice/Video real-time calling (Deferred to RFC-0008).
- Cloud Object Storage / S3 Adapters (Strictly Local FS for v1 Single-Binary).

## 4. Cryptographic Media Architecture & Privacy

### 4.1. Constant-Size Chunking & Size Obfuscation
To completely hide the exact original file size from the server, all chunks MUST be strictly uniform in size.
- **Plaintext Chunk Size:** Exactly `5,242,880 bytes` (5MB).
- **Padding Rule:** The final chunk MUST be padded with zero-bytes (`0x00`) to reach exactly 5MB before encryption. If the original file size is an exact multiple of 5MB, an additional padded chunk MUST NOT be created. 
- **Un-padding Rule:** The decrypted final chunk MUST NEVER be interpreted by algorithmic padding markers. The `original_size` field securely transmitted in the E2EE Metadata is the SOLE authoritative source for truncation.
- **Ciphertext Size Enforcement:** Every stored chunk will be exactly `5,242,896 bytes` (5MB + 16 bytes AES-GCM Tag). The server MUST reject any partial chunk. 
- **Privacy Boundary:** The server can determine the padded storage size and chunk count, but MUST NOT be able to determine the exact original unpadded file size.

### 4.2. File Key, Nonce & AAD Strategy
- **Media Key:** 32-byte random `Media_Key`.
- **File Prefix:** 4-byte random `File_IV_Prefix`.
- **Chunk Nonce:** `[4-byte File_IV_Prefix] [8-byte Chunk_Index (BigEndian)]`.
- **Chunk AAD:** `[1-byte Version (0x01)] || [16-byte File_ID (Raw UUID)] || [4-byte Chunk_Index] || [4-byte Total_Chunks]`
- **Retry & Nonce Reuse Rule:** For a given `File_ID` and `Chunk_Index`, the client MUST reuse the exact previously generated ciphertext during retries. A chunk MUST NEVER be re-encrypted with the same `Media_Key` and `Chunk_Index` using a different plaintext.

### 4.3. Encrypted Thumbnail Wire Format
Thumbnails are embedded in the WebSocket message. To prevent metadata leakage and reuse, they MUST be padded and strongly bound.
- **Encryption Key:** The Thumbnail MUST be encrypted using the file's `Media_Key`.
- **IV Generation:** The 12-byte Thumbnail IV MUST be freshly generated using a secure cryptographic RNG and MUST NEVER be reused.
- **Padded Size:** Plaintext thumbnail MUST be padded to exactly `32,768 bytes` (32KB).
- **Wire Format (Base64):** `[Version Byte (0x01)] [IV (12 bytes)] [Sealed Ciphertext (32,768 bytes + 16 byte Tag)]`
- **AAD Binding:** `[1-byte Version (0x01)] || [16-byte File_ID (Raw UUID)]`

### 4.4. E2EE Metadata Payload & File Manifest
The client encrypts the media metadata using the standard Message Key and sends it via the WebSocket.
- **Manifest Definition:** `File_Manifest_Hash = SHA256(ServerVerifiedChunkHash[0] || ServerVerifiedChunkHash[1] || ... || ServerVerifiedChunkHash[N-1])`. The manifest MUST be constructed explicitly from the true, server-verified hashes.
- **Payload Schema:** Contains `file_id`, `media_key`, `file_iv_prefix`, `media_token`, `file_name`, `mime_type`, `original_size`, `file_manifest_hash`, and `inline_thumbnail`.

## 5. Zero-Knowledge Access Control (MCT)

### 5.1. Media Capability Token (MCT) & Lifecycle
- **Generation:** Uploader generates a 32-byte random `Media_Token`.
- **Storage:** Server stores `SHA256(Media_Token)` during `/init`.
- **Authorization Scope:** The `Media_Token` authorization grants ONLY `Download` and `Delete` capabilities. It MUST NOT grant `Upload`, `Finalize`, metadata mutation, or ownership transfer.
- **Lifecycle:** Token hash lifetime is strictly bound to the physical file lifecycle. Upon file deletion (explicit or GC), the token hash MUST be permanently destroyed.

## 6. Media State Machine

### 6.1. Explicit MediaStatus Enum
The `media_files.status` column MUST strictly adhere to this Enum:
- `PENDING`: Initial state upon `/init`.
- `FINALIZED`: Verified and complete.
- `DELETING`: Intermediate state during 3-Phase deletion.

**Valid State Transitions:**
- `PENDING` -> `FINALIZED`
- `PENDING` -> `DELETING`
- `FINALIZED` -> `DELETING`
- `DELETING` -> Physical Cleanup -> Row Deletion (Logical Terminal State)

## 7. REST API Contracts

### 7.1. Initialization (Upload Auth)
- **Endpoint:** `POST /api/v1/media/init`
- **Auth:** Requires Uploader's Session Cookie.
- **Request:** `{ "file_id": "UUIDv4", "total_chunks": 20, "token_hash": "Base64(SHA256(Media_Token))" }`
- **Constraint Enforcement:** `1 <= total_chunks <= 400` (Max 2GB).
- **Idempotency & State Rules:** For an existing `file_id` in `PENDING` state:
  - The authenticated owner MUST match.
  - The requested `total_chunks` MUST equal the stored `total_chunks`.
  - The requested `token_hash` MUST equal the stored `token_hash`.
  - If all match: return the existing upload state idempotently. Quota MUST NOT be reserved again.
  - If any parameter differs: return `409 Conflict`.
  - If owned by another user: return `404 Not Found` (no existence leakage).
  - If status is `FINALIZED` or `DELETING`: return `409 Conflict`.
- **Quota Action:** Applies the `INIT` Quota Lifecycle rule. Returns `413 Payload Too Large` if Quota is exceeded.

### 7.2. Chunk Upload (Resumable, Atomic & Conflict Safe)
- **Endpoint:** `PUT /api/v1/media/upload/{file_id}/{chunk_index}`
- **Auth & Ownership:** Server MUST verify that `authenticated_user_id == uploader_user_id`, the `file_id` belongs to that uploader, and the file `status == PENDING`.
- **Strict Size:** The payload MUST be exactly `5,242,896 bytes`.
- **Server-Computed Hash:** The server MUST compute `SHA-256` over the exact ciphertext bytes received. If it differs from `X-Chunk-Hash`, reject with `400 Bad Request`.
- **Explicit Conflict & Idempotency Policy:** For a given `(file_id, chunk_index)`:
  - If no chunk record exists: accept the upload.
  - If the existing `chunk_hash` equals the computed hash: verify physical chunk size is exactly `5,242,896 bytes`. If true, return `200 OK` idempotently.
  - If the existing `chunk_hash` differs from the computed hash: return `409 Conflict`.
  - **Integrity Rule:** The existing physical chunk MUST NOT be overwritten.
- **Filesystem Concurrency:** Server MUST acquire the `Per-File I/O Lock` (See 8.4) before entering the atomic write sequence.
- **Atomic Filesystem I/O:** 
  1. Write the payload to a temporary file.
  2. Durably sync the temporary file (`fsync`/`file.Sync()`).
  3. Execute an atomic `rename()` to the final chunk path.
  4. Durably sync the parent directory (where supported).
- **Database Mutation (Race Condition Prevention):** 
  - Inside a `BEGIN IMMEDIATE` transaction, execute:
    `UPDATE media_files SET generation = generation + 1 WHERE file_id = ? AND status = 'PENDING'`
  - The implementation MUST verify `RowsAffected == 1`. 
  - **ABORT PATH:** If `RowsAffected == 0`, ABORT the transaction, return `410 Gone` or `409 Conflict`, and safely delete the renamed physical chunk.
  - **SUCCESS PATH:** If `1`, insert/update the `chunk_hash` in `media_chunks` and `COMMIT`.
- **Unlock:** Release the `Per-File I/O Lock`.

### 7.3. Finalization (2-Phase Compliant with RFC-0001A)
- **Endpoint:** `POST /api/v1/media/finalize/{file_id}`
- **Auth & Ownership:** MUST enforce the same Uploader checks.
- **Idempotency Rule:** If `file.status == FINALIZED`, return `200 OK` idempotently.
- **Phase A (Outside DB Transaction):**
  1. Read the current `generation = G` from the database.
  2. Verify chunks `0` through `N-1` exist on disk with exact expected sizes.
  3. Read each chunk from disk, recompute its `SHA-256` hash, and verify it matches the persisted `chunk_hash`.
  4. Compute the manifest hash `SHA256(Concat(ServerVerifiedChunkHashes))`.
  5. If it DOES NOT match the client-supplied `file_manifest_hash`, return `400 Bad Request` and abort.
- **Phase B (Short DB Transaction):**
  1. Acquire `BEGIN IMMEDIATE`.
  2. Verify `file.status == PENDING` and `generation == G`. If `generation != G`, ABORT and return `409 Conflict`.
  3. Apply the `FINALIZE` Quota Lifecycle rule.
  4. Transition state: `PENDING` -> `FINALIZED`. 

### 7.4. Streaming Download (Capability Authorized)
- **Endpoint:** `GET /api/v1/media/download/{file_id}/{chunk_index}`
- **Auth:** Requires `Authorization: Bearer {Media_Token}`.
- **Delivery Constraints:** MUST strictly enforce `status == FINALIZED` and `0 <= chunk_index < total_chunks`.
- **Filesystem Concurrency:** MUST acquire the `Per-File I/O Lock` during the read operation to ensure isolation from concurrent deletion.
- **Action:** Server computes `SHA256(Media_Token)`, matches it against DB, and returns the ciphertext block.

## 8. Storage Backend, GC & Quota Management

### 8.1. Strict Local Storage & SQLite Schema
Media files MUST be stored directly on the local File System (`./data/media/`).
- **Table `media_files`:** `file_id (PK)`, `uploader_user_id`, `token_hash`, `total_chunks`, `generation`, `created_at`, `status`.
- **Table `media_chunks`:** `file_id (FK -> media_files(file_id) ON DELETE CASCADE)`, `chunk_index`, `chunk_hash`, `created_at`. (Composite PK: `file_id, chunk_index`).

### 8.2. Quota Repository Contract & Arithmetic
User quota state MUST be maintained in the strictly named `user_quotas` table consisting of:
- `user_id (PK)`
- `quota_limit_bytes (INTEGER)` (The definitive source of truth for the user's maximum capacity).
- `reserved_bytes (INTEGER)`
- `committed_bytes (INTEGER)`

**Strict Quota Arithmetic:** All quota mutations MUST execute atomically within their respective database state-locking transactions (`BEGIN IMMEDIATE`). A request is rejected (`413 Payload Too Large`) if `(reserved_bytes + committed_bytes + padded_size) > quota_limit_bytes`.
- **INIT (`PENDING`):** `reserved_bytes += padded_size`
- **FINALIZE (`FINALIZED`):** `reserved_bytes -= padded_size` AND `committed_bytes += padded_size`
- **DELETE (`DELETING` from `PENDING`):** `reserved_bytes -= padded_size`
- **DELETE (`DELETING` from `FINALIZED`):** `committed_bytes -= padded_size`

### 8.3. Global State-Locking Protocol (Database)
All media state mutations (Upload DB commit, Finalize Phase B, Quota mutations, and Deletion Phase A/C) MUST participate in the SAME database state-locking protocol (`BEGIN IMMEDIATE` in SQLite).

### 8.4. Filesystem Concurrency (Per-File I/O Lock)
To prevent race conditions at the filesystem level between uploads, downloads, and garbage collection, the infrastructure MUST implement an in-memory `Per-File I/O Lock` (Mutex) keyed to the `file_id`. 
- **Rule:** All physical filesystem operations (Upload Rename, Download Read, Deletion Phase B) MUST acquire this lock before touching the disk.

### 8.5. 3-Phase State-Based Deletion (Crash-Proof GC)
To prevent Database-Filesystem inconsistencies:
- **Phase A (Short DB Transaction):** Acquire DB global state-lock, update `status = DELETING`, apply the `DELETE` Quota Lifecycle rule, and `COMMIT`.
- **Phase B (Filesystem I/O):** Acquire the `Per-File I/O Lock`. Physically delete all associated chunks from the disk. Release the lock.
- **Phase C (Short DB Transaction):** Acquire DB global state-lock, execute `DELETE FROM media_files WHERE file_id = ?`, revoke the token hash, and `COMMIT`.

### 8.6. Garbage Collection Triggers & Recovery
- **Timeout GC:** Hard-delete any file stuck in `PENDING` status for more than `48 hours` via 3-Phase Deletion.
- **Explicit Delete:** A client CAN send `DELETE /api/v1/media/{file_id}`.
  - **Auth:** Requires EITHER a valid `Media_Token` OR the Uploader's Session Cookie.
  - **Action:** Executes the 3-Phase State-Based Deletion.
- **Crash Recovery (Recovery Worker):** If a file is in the `DELETING` state during startup, immediately resume Phase B and C.
- **Missing Physical Files:** Any row in `media_chunks` lacking the corresponding physical chunk on disk MUST mark the upload state as inconsistent. The `/finalize` endpoint (Phase A) MUST fail.
- **Orphan Reconciliation Grace Rule:** Any chunk file present on disk without a corresponding matching row in `media_chunks` MUST ONLY be treated as an orphan and safely removed by the GC worker IF it is older than the strictly frozen safety threshold of exactly `10 minutes`.

## 9. Amendment RFC-0007-B: Group & Channel Conversation Types (Non-E2EE)

**Status:** Authorized Amendment — Added by project owner.

### 9.1. Purpose
Define GROUP and CHANNEL conversation types that store messages WITHOUT end-to-end encryption on the server. This enables multi-party messaging with server-side fan-out, search, and moderation capabilities that are impossible under the E2EE model.

### 9.2. Conversation Types Extended

    type ConversationType string
    const (
        ConvTypeDirect  ConversationType = "DIRECT"   // E2EE, 1:1
        ConvTypeGroup   ConversationType = "GROUP"     // Non-E2EE, multi-party
        ConvTypeSelf    ConversationType = "SELF"      // E2EE, single-user
        ConvTypeChannel ConversationType = "CHANNEL"   // Non-E2EE, broadcast
    )

### 9.3. Security Model
- **DIRECT** and **SELF** conversations: Messages are end-to-end encrypted using the existing RFC-0003/RFC-0005 crypto pipeline. The server is content-blind.
- **GROUP** and **CHANNEL** conversations: Messages are stored as **plaintext on the server**. The server can read, index, and moderate content. TLS protects messages in transit.

### 9.4. GROUP Conversation Rules
- **Membership:** 2–256 participants. Minimum 1 OWNER.
- **Roles:** OWNER (full control), ADMIN (can add/remove MEMBER, pin messages), MEMBER (can send messages).
- **Message Storage:** Plaintext in a `group_messages` table, keyed by `(conversation_id, server_id)`.
- **Fan-out:** Server distributes messages to all participants via WebSocket push. Offline participants receive messages via REST pending sync.
- **Features:** Reply, edit (author within 24h), delete (author deletes own; ADMIN/OWNER delete any), forward.

### 9.5. CHANNEL Conversation Rules
- **Membership:** Unlimited subscribers. Only OWNER and ADMIN can post.
- **Roles:** OWNER (full control), ADMIN (can post, pin, delete), SUBSCRIBER (read-only).
- **Message Storage:** Same `group_messages` table as GROUP.
- **Fan-out:** Same as GROUP.
- **Features:** Same as GROUP but only OWNER/ADMIN can create messages.

### 9.6. Group Messages Schema

    CREATE TABLE group_messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        sender_id       TEXT NOT NULL,
        content         TEXT NOT NULL,
        reply_to_id     TEXT,
        edited_at       INTEGER,
        deleted_at      INTEGER,
        created_at      INTEGER NOT NULL,
        server_id       INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE INDEX idx_group_messages_conv_server ON group_messages(conversation_id, server_id);

### 9.7. Conversation Metadata Extension

The `conversations` table gains optional columns for GROUP/CHANNEL:

    ALTER TABLE conversations ADD COLUMN name TEXT;
    ALTER TABLE conversations ADD COLUMN description TEXT;
    ALTER TABLE conversations ADD COLUMN created_by TEXT;

### 9.8. API Contracts

- **Create Group/Channel:** `POST /api/v1/conversations` with `{ "type": "GROUP"|"CHANNEL", "name": "...", "participant_ids": [...] }`
- **Send Group Message:** Messages flow through WebSocket using `group.msg` envelope type (plaintext, not E2EE).
- **List Group Messages:** `GET /api/v1/conversations/{id}/messages?cursor=...&limit=20`
- **Edit Message:** `PUT /api/v1/conversations/{id}/messages/{msg_id}` — author only, within 24h.
- **Delete Message:** `DELETE /api/v1/conversations/{id}/messages/{msg_id}` — author deletes own; ADMIN/OWNER delete any.
- **Manage Members:** `POST/DELETE /api/v1/conversations/{id}/members`

### 9.9. E2EE Boundary Rule
The server MUST enforce strict separation: if `conversation.type` is `DIRECT` or `SELF`, the server MUST NOT attempt to read, parse, or store message content — it remains an opaque ciphertext blob. If `conversation.type` is `GROUP` or `CHANNEL`, the server stores and processes plaintext. A message sent to the wrong type is rejected.

### 9.10. Acceptance Criteria
- GROUP conversations support 2–256 participants with role-based permissions.
- CHANNEL conversations support unlimited subscribers with post-restricted roles.
- Messages in GROUP/CHANNEL are stored as plaintext and searchable server-side.
- The E2EE boundary is enforced: DIRECT/SELF messages remain encrypted.