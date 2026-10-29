# 🛡️ RFC-0014: Admin, Operations & Zero-Knowledge Intervention
**Status:** Frozen & Active Execution Directive
**Role:** Principal SRE & Security Engineer

## 1. Objective
Define the administrative and operational boundaries of the platform. Establish strict mechanisms for system monitoring, audit log inspection, and user intervention (suspension/tombstoning/IP banning) without compromising the core Zero-Knowledge guarantees, violating the Single-Binary architecture, or introducing race conditions or DoS vulnerabilities via the audit layer.

## 2. Scope
- Admin Authentication, Key Rotation, and Network Boundary.
- The Single Administrative Principal model (No complex RBAC).
- The Zero-Knowledge Operational Boundary (Strictly metadata, no content).
- Identity State Machine, Tombstone Side-Effects, and Transactional Intervention.
- IP Blocklist lifecycle, idempotency, and middleware ordering.
- Observability (Cached Low-cardinality Metrics) and Cursor-based Audit API.
- Destructive Action protections and Asynchronous Operations Lifecycle.
- The Standard Administrative Execution Flow and Atomic Auditing.

## 3. Out of Scope
- Performance scaling and load balancing strategies (Deferred to RFC-0015).
- Direct database schema manipulation or manual SQL execution via UI.
- General-purpose search functionality over user profiles or encrypted data.

## 4. The Zero-Knowledge Operational Boundary
The admin interface MUST strictly inherit the platform's Zero-Knowledge constraints.
- **FORBIDDEN Visibility:** The administrator MUST NOT receive or access any plaintext message, media, vault contents, private keys, or decryption keys. Administrative visibility is limited exclusively to server-side operational metadata explicitly defined as non-content by the frozen RFC set.
- **No Search Functionality:** The Admin API MUST NOT introduce general-purpose search over user content or encrypted history. User lookup MAY be performed only by exact administrative identifiers (e.g., `IdentityHash`, `IP_Hash`).
- **No Backdoors:** The admin role MUST NOT possess a "master key" or escrow key to bypass endpoint encryption.

## 5. Admin Authentication & Key Management
The system implements a **Single Administrative Principal** identified in audit logs as `admin_principal="primary"`. Possession of a valid active admin credential grants full administrative access.

### 5.1. Credential Contract
- The Admin credential MUST be a cryptographically random secret of at least 256 bits.
- The raw credential MUST NEVER be stored in SQLite, logs, environment variables, image layers, or ambient browser storage.
- The runtime MUST receive only the paths to read-only secret files (`ADMIN_API_KEY_HASH_ACTIVE_FILE` and optionally `ADMIN_API_KEY_HASH_PREVIOUS_FILE`). These files MUST contain a non-reversible verification value (e.g., SHA-256 hash), never the raw credential.
- Verification MUST use constant-time comparison.
- **CSRF Protection:** Admin authentication MUST NOT rely on ambient browser cookies. Using an explicit `Authorization: Bearer <Key>` header prevents traditional ambient-cookie CSRF attacks. Credentials MUST NOT be accepted via URL query parameters, path segments, or fragments.

### 5.2. Rotation & Revocation
- The deployment MUST support explicit Admin credential rotation.
- If no previous credential is configured, only the active credential is valid.
- The rotation grace period MUST NOT exceed **24 hours**. The previous credential MUST automatically expire at the end of this grace period.
- A compromised credential MUST be revocable by a deployment configuration change.
- **Runtime Application:** Admin credential rotation MUST take effect only through a controlled deployment or configuration reload mechanism defined by the deployment environment. If hot reload is not implemented, credential rotation MUST require an application restart.

## 6. Admin API Network & Middleware Boundary
Admin routes (`/api/v1/admin/*`) MUST use a dedicated middleware chain executing in this strict order:
1. **TraceID/RequestID Injection**
2. **Admin Security Headers & CORS Policy:** Default to NO CORS; MAY enable CORS only for an explicitly allowlisted administrative origin. MUST inject `Cache-Control: no-store` on all admin responses.
3. **Request Size Limits**
4. **Real Client IP Resolution** (RFC-0012 §7)
5. **IP Blocklist Enforcement** (See §7.2)
6. **Admin Authentication** (§5.1)
7. **Admin Rate Limiting & Brute-Force Protection** (Dedicated strict buckets separate from public API).
8. **Admin Route Handler / UseCase**

*Network Exposure:* Admin routes MUST NOT be exposed directly to the public internet unless restricted by an approved secure boundary (e.g., VPN, private internal network, or strict Reverse Proxy IP allowlisting) that preserves RFC-0012 trusted-proxy rules.

## 7. User Intervention & State Machines

### 7.1. Identity State Machine
Administrative identity management follows a strict, idempotent state machine:
*   `ACTIVE ↔ SUSPENDED`
*   `ACTIVE → DELETED` (Terminal)
*   `SUSPENDED → DELETED` (Terminal)

#### 7.1.1. Suspension Transactionality
Suspension MUST execute atomically. The system MUST:
1. Mark the identity as `SUSPENDED` in the database.
2. Revoke all active sessions and invalidate the currently active session version strictly according to RFC-0003's Session Version Atomic Check contract.
3. Prevent new session creation.
4. **Commit the database transaction.**
5. Only *after* the DB commit, actively instruct the WebSocket multiplexer to terminate current connections. Post-commit WebSocket termination is a best-effort, non-transactional side effect. Failure to terminate an existing socket MUST NOT roll back the committed suspension; subsequent session validation MUST reject it.

#### 7.1.2. Administrative Deletion (Tombstoning) Side-Effects
Deletion (`status = DELETED`) is an irreversible terminal state. The user record MUST NOT be physically hard-deleted if doing so breaks auditability or referential integrity. 
Upon marking an identity as `DELETED`:
- `DELETED` MUST be terminal and MUST NOT transition back to `ACTIVE` or `SUSPENDED`.
- A `DELETED` identity MUST permanently reserve its `IdentityHash` to prevent identity resurrection. It MUST NOT be re-registered as a new user.
- **Session Revocation:** Tombstoning MUST revoke all active sessions and invalidate the current session version according to RFC-0003 before the transaction commits.
- New authentication and new message routing are strictly FORBIDDEN.
- Already queued (pending) messages MUST follow the existing RFC-0004 transient-queue retention/ACK policy and MUST NOT be decrypted or rewritten.
- Encrypted historical blobs and vaults remain subject to their existing retention lifecycle.
- Existing security audit records associated with the identity MUST remain retained.

### 7.2. IP Banning (IP_Hash)
- **Lifecycle:** An `IP_Hash` can be toggled between `UNBLOCKED ↔ BLOCKED`. Bans are indefinite by default.
- **Idempotency:** Repeating `BAN` on an already blocked `IP_Hash` and repeating `UNBAN` on an unblocked `IP_Hash` MUST be idempotent and MUST NOT create duplicate block records.
- **Middleware Ordering:** A blocked `IP_Hash` MUST be rejected *after* Real Client IP Resolution and `IP_Hash` derivation, but *before* Admin Authentication and Admin Rate Limiting.
- **Transactionality:** `BAN` and `UNBAN` actions MUST be transactional and explicitly logged.

## 8. Destructive Actions & Asynchronous Operations
- **Server-Side Confirmation:** Destructive admin actions (e.g., Tombstoning, Purging logs) MUST require an explicit server-side confirmation field/token in the POST body. 
- **Async GC Trigger Lifecycle:** The admin MAY trigger the Crash Recovery Worker's GC pass (RFC-0007). This trigger MUST enqueue an in-process worker task and return an operation identifier. This operation's lifecycle is best-effort, is NOT required to survive process restarts, and introduces NO persistent job queue.

## 9. Observability & Auditing

### 9.1. The Standard Administrative Execution Flow & Atomic Auditing
All state-changing administrative operations MUST follow this strict execution flow:
Request
↓
... Middleware Chain (TraceID, CORS, ClientIP, Blocklist, Auth, Rate Limit) ...
↓
Audited UseCase
↓
DB Transaction
├── State Change (e.g., Suspension, Tombstoning)
└── Audit Event Emission
↓
COMMIT
↓
Post-Commit Side Effects (e.g., WS Termination / Async Worker Trigger)
↓
Response

- **Atomicity Constraint:** Every state-changing administrative UseCase MUST emit its audit event atomically with the corresponding database transaction. If the mandatory audit event cannot be persisted, the corresponding state-changing operation MUST NOT commit (Rollback).
- Transaction failures MUST be returned as a generic admin operation error and MUST be observable through internal logs/metrics without leaking sensitive data.

### 9.2. Admin Auth Failure Auditing (DoS Prevention)
To prevent attacker-controlled unbounded growth of the Audit Log via brute-force:
- Authentication failures MAY be sampled or coalesced after the configured rate-limit threshold to prevent audit amplification.
- Rate-limited authentication failures MUST NOT generate one persistent audit row per rejected request. 
- At most one aggregated authentication-failure audit event per `{IP_Hash, time_bucket}` MAY be persisted.

### 9.3. Cursor-Based Audit API
The Admin API MUST provide a read-only endpoint (`GET` only) to query the Security Audit Log.
- Pagination MUST be cursor-based (e.g., `created_at` + `unique_event_id`).
- Queries MUST enforce a maximum page size and maximum date range.
- Permitted Exact Filters: `event_type`, `identity_hash`, `ip_hash`, `start_time`, `end_time`, `cursor`, `limit`. No full-text search is permitted.

### 9.4. Operational Metrics & Caching
- Machine-readable Prometheus metrics exposed at `/api/v1/metrics`. The Admin API MUST NOT act as a raw Prometheus proxy.
- **Performance Constraint:** Expensive filesystem/storage measurements (e.g., SQLite database size, Media directory size) MUST be sampled periodically by an in-process worker and exported as cached metrics.
- **Privacy Constraint:** Operational metrics MUST NOT contain identity-level labels, IP-level labels, message-content, or other high-cardinality sensitive data (e.g., `ws_connections{identity_hash="..."}` is strictly FORBIDDEN).

## 10. Data Retention Enforcement
Automatic retention enforcement MUST be performed by an in-process background Worker managed by Bootstrap. The Admin API MAY trigger this exact same idempotent UseCase on-demand. Best-effort async operation state does not affect the mandatory administrative audit of the trigger request itself ("TRIGGER_ACCEPTED").

## 11. Acceptance Criteria
- Admin authentication without explicit `Authorization: Bearer <Key>` is structurally rejected.
- Suspending an active user reliably drops their established WebSocket connection *only after* the DB transaction commits and session validation rules are updated.
- A banned `IP_Hash` MUST be rejected after Real Client IP Resolution and `IP_Hash` derivation, but before Admin Authentication and Admin Rate Limiting.
- Destructive operations (Tombstoning) fail unless an explicit confirmation token is included in the request body.
- A state-changing operation fails entirely (Rollback) if its corresponding Audit Event insertion fails.