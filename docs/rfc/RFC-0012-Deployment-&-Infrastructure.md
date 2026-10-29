# 🐳 RFC-0012: Deployment, Infrastructure & Reverse Proxy Boundary
**Status:** Frozen & Active Execution Directive
**Role:** Principal Infrastructure & Site Reliability Engineer

## 1. Objective
Define the container image, persistent volume layout, reverse-proxy contract, and network/secrets provisioning required to run the platform in production as a self-hosted or PaaS-native deployment. 

The application backend MUST remain a single self-contained Go binary. External infrastructure components such as the mandatory reverse proxy and self-hosted STUN/TURN service are deployment dependencies and MUST NOT be embedded into the Go application binary.

## 2. Scope
- Multi-stage container image build.
- Persistent volume layout and secrets mounting.
- Reverse proxy contract: TLS termination, WebSocket upgrade semantics, Origin passthrough.
- The Trusted Proxy & Real Client IP Resolution Algorithm (Strict XFF Parsing).
- Deterministic Middleware Execution Ordering.
- Process supervision, graceful drain, and deployment semantics.
- Backup & restore procedure with Internal Quiescence, Manifests, Generation Atomicity, and Restore Validation.
- The Canonical Environment Variable Reference.

## 3. Out of Scope
- CI pipeline mechanics (Deferred to RFC-0013).
- Admin operational tooling (Deferred to RFC-0014).

## 4. Container Image

### 4.1. Multi-Stage Build
1. **Frontend Stage:** Node build producing `dist/`.
2. **Backend Build Stage:** Go build embedding `dist/`. MUST use a pure-Go SQLite driver (e.g., `modernc.org/sqlite`) with `CGO_ENABLED=0`.
3. **Runtime Stage:** A minimal, non-shell base image (e.g., `distroless/static`).

### 4.2. Runtime User & Filesystem
- The container MUST run as a non-root, non-privileged UID with no shell.
- The root filesystem MUST be mounted read-only; only `/data` is writable. The application MUST NOT require writable paths outside `/data` at runtime.
- **Image Provenance:** The base image MUST be pinned by digest.

## 5. Persistent Volume Layout
Exactly one writable volume, mounted at `/data`, MUST back the application:

| Path | Contents | Notes |
|---|---|---|
| `/data/db/app.db` (+ `-wal`, `-shm`) | The SQLite database | WAL mode. Sidecars MUST live on the same filesystem. |
| `/data/media/` | Encrypted media chunks | Co-located for backup atomicity (§11). |

- **Non-tmpfs Requirement:** `/data` MUST NOT be backed by ephemeral storage.
- **Secrets Mount:** Files referenced by `_FILE`-suffixed config MUST be mounted from a distinct, read-only path (e.g., `/run/secrets/`), separate from `/data`.

## 6. Reverse Proxy Contract
Production topology MUST use exactly one directly trusted reverse-proxy hop. The application MAY receive a multi-hop `X-Forwarded-For` chain, but only addresses within `TRUSTED_PROXIES_CIDR` may be treated as trusted infrastructure hops.

- **TLS Termination:** TLS 1.2 minimum, 1.3 preferred.
- **WebSocket Upgrade Semantics:** The reverse proxy MUST explicitly support WebSocket Upgrade and MUST generate/forward the required `Upgrade` and `Connection` semantics to the upstream application. It MUST NOT blindly forward arbitrary hop-by-hop headers supplied by the client.
- **Timeout Floor:** MUST set its own idle/read timeout to **at least 60 seconds**.
- **Header Non-Interference:** MUST pass through the application's response headers unmodified.
- **Origin Passthrough:** The proxy MUST NOT rewrite or synthesize the HTTP `Origin` header.

## 7. Trusted Proxy & Real Client IP Resolution Contract

- **Reverse Proxy Header Sanitization:** The trusted proxy MUST strip any client-supplied `X-Forwarded-For` header and construct the forwarded chain itself.
- **Deterministic Resolution Algorithm:**
  1. **Immediate Peer Check:** If the immediate TCP peer ∉ `TRUSTED_PROXIES_CIDR`, then `resolved_client_ip = TCP peer`. Ignore `X-Forwarded-For` entirely.
  2. **Right-to-Left Parse:** Otherwise, parse `X-Forwarded-For` from right to left. Skip addresses belonging to `TRUSTED_PROXIES_CIDR`. The first non-trusted address = `resolved_client_ip`.
  3. **Fallback:** If no non-trusted address exists (e.g., internal proxy-to-proxy traffic), use the immediate TCP peer as the resolved client IP.
  4. **Invalid Entry Fallback:** Any syntactically invalid `X-Forwarded-For` entry MUST cause the header to be rejected entirely and the application MUST fall back to the immediate TCP peer.
- **Syntax Validation:** `X-Forwarded-For` entries MUST be parsed as IP addresses according to standard IPv4/IPv6 syntax. Port-qualified values MUST be rejected unless explicitly supported by the implementation contract.
- **Deployment Fail-Fast:** `TRUSTED_PROXIES_CIDR` MUST be non-empty in production. Startup validation MUST reject `0.0.0.0/0`, `::/0`, and unrestricted wildcard ranges.

## 8. Deterministic Middleware Execution Ordering
Middleware MUST execute in this exact sequence. Panic Recovery MUST wrap the entire chain.

1. **Request ID / Trace ID Injection**
2. **Security Headers & CORS** policy enforcement as defined by RFC-0011.
3. **Request Size Limit Enforcement**
4. **Real Client IP Resolution** (Algorithm from §7)
5. **Authentication Context Resolution**
6. **Rate Limit Classification:** 
   - Unauthenticated routes MUST use IP-based classification only.
   - Authenticated routes MAY use both IP and authenticated identity/session classification.
7. **Route Handler / Application Logic**

## 9. Network & Firewall Exposure
- **Application Port (e.g., `8080`):** MUST be bound to a private network interface or loopback. Direct public reachability is a critical misconfiguration.
- **STUN/TURN Service:** Configured externally as a deployment dependency.

## 10. Process Supervision & Deployment Constraints
- **Single-Writer Constraint:** Exactly one instance may access `/data`. Multi-instance scaling is FORBIDDEN.
- **Graceful Drain & Readiness Gating:** 
  - The application MUST transition `/health/ready` to `NOT READY` before beginning graceful shutdown. The application MUST remain in `NOT READY` state until shutdown is complete.
  - The deployment supervisor/proxy MUST stop routing new traffic after readiness becomes `NOT READY`.
  - The graceful drain MUST respect the 30-second shutdown deadline defined by RFC-0001A.
  - After the deadline expires, remaining HTTP/WebSocket connections MAY be terminated.
- **Restart Backoff Separation:**
  - **Crash Restart Backoff:** MUST be at least 30 seconds to prevent race conditions on the DB lock.
  - **Planned Deployment:** MUST NOT be subject to the crash restart backoff.

## 11. Backup & Restore (Atomicity & WAL Consistency)
- **Internal Quiescence Mechanism:** The application MUST expose an internal backup/quiescence mechanism that prevents new write transactions, waits for in-flight DB/media mutations to complete, signals readiness for backup, and releases the quiescence state after backup completion or failure. The quiescence control interface MUST NOT be publicly reachable.
- **SQLite Backup Mechanism:** The implementation MUST use SQLite's supported online backup mechanism through the selected Go SQLite driver. Raw filesystem copying of the live database MUST NOT be used.
- **Atomic Backup Generation & Lifecycle:** 
  - The `backup_id` MUST be generated before the backup operation begins and MUST be globally unique within the backup storage namespace.
  - Both the SQLite backup artifact and media snapshot MUST be associated with the same `backup_id`.
  - A backup generation MUST NOT be published as restorable until a finalization record confirms that both artifacts are durably stored and addressable by the same immutable `backup_id`.
  - The backup generation MUST be marked COMPLETE only after both artifacts have been successfully committed. Any failure MUST mark the generation INVALID. INVALID generations MUST NOT be eligible for restore.
- **Backup Manifest:** The backup manifest MUST contain the immutable `backup_id`, database artifact reference, media snapshot reference, creation timestamp, application version, and backup status.
- **SQLite WAL Consistency:** A valid backup MUST represent a transactionally consistent SQLite state including all committed transactions present in the WAL.
- **Restore Validation:** Before the restored instance may transition to `READY`, the implementation MUST validate the backup manifest, verify that the database and media artifacts belong to the same immutable `backup_id`, verify artifact integrity, and execute the RFC-0007 media reconciliation procedure.

## 12. Canonical Environment Variable Reference
This table is the canonical deployment-level environment variable reference. Any variable removed from this table MUST be explicitly deprecated or removed by the RFC that previously defined it.

| Variable | Purpose |
|---|---|
| `PORT` | Application listen port. |
| `DB_PATH` | Path to `/data/db/app.db` |
| `MEDIA_STORAGE_PATH` | Path to `/data/media/` |
| `LOG_LEVEL` | `slog` verbosity |
| `APP_ORIGIN` | Canonical deployment origin used for strict WebSocket Origin validation and same-origin policy |
| `IP_HASH_SECRET` | Secret key for deterministic, irreversible IP hashing |
| `VAPID_ENCRYPTION_KEY_FILE` | At-rest encryption key for the VAPID private key |
| `VAPID_SUBJECT` | Admin contact (mailto/URL) for Web Push |
| `TURN_KEYRING_ACTIVE_FILE` | The active TURN credential secret (Used by the Go App to issue REST tickets) |
| `TURN_KEYRING_PREVIOUS_FILE` | The previous TURN credential secret (grace period) |
| `TRUSTED_PROXIES_CIDR` | Allowlist for `X-Forwarded-For` trust |
| `INSECURE_DEV_MODE` | Defaults `false`; refused outside loopback |
| `SECURITY_EVENTS_RETENTION_DAYS`| Audit log retention (default `90`) |
| `RATE_LIMIT_AUTH_CHALLENGE` | Override for Challenge endpoint |
| `RATE_LIMIT_AUTH_VERIFY` | Override for Verify endpoint |
| `RATE_LIMIT_GLOBAL_API` | Override for generic API limits |

*(Note: STUN/TURN service network configuration ports are external to the application and are explicitly NOT part of the application's environment variable contract).*

## 13. Failure Modes & Edge Cases
- **F1: Disk Full (`ENOSPC`).** `/health/ready` MUST perform a configurable free-space threshold check as an early warning. However, runtime write operations MUST independently handle `ENOSPC`. `ENOSPC` MUST NOT be converted into a successful write or silently dropped. The operation MUST return a domain/infrastructure error and be observable.

## 14. Acceptance Criteria
- Container runs as non-root with a read-only root filesystem.
- The XFF resolution algorithm MUST ignore forged `X-Forwarded-For` headers from untrusted TCP peers and resolve the client IP correctly for legitimate trusted-proxy chains.
- `ENOSPC` explicitly fails write transactions and generates alertable domain errors.

## 15. Implementation Notes
- **PaaS Deployments:** The deployment platform MUST provide a persistent volume mounted at `/data` or an equivalent mechanism satisfying the persistence guarantees defined in §5. Platform-provided reverse proxies MAY terminate TLS, provided they satisfy the reverse-proxy contracts defined in §6.
- `modernc.org/sqlite` for the CGO-free driver. Use its specific API for online backups (`*sqlite.Conn.Backup`).