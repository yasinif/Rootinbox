# 🔒 RFC-0011: Security Hardening, Abuse Prevention & Defense-in-Depth
**Status:** Frozen (Execution Ready & Implementation Contract)
**Role:** Principal Platform Security Engineer

## 1. Objective
Close the cross-cutting security gaps that no single prior RFC owns[cite: 4]. RFC-0002 through RFC-0010 each define a domain-scoped `Security Considerations & Threat Model` section (identity enumeration, key compromise, auth brute-force, vault replay, media tampering, call signaling replay, push metadata, rendering XSS)[cite: 4]. This RFC does not restate those[cite: 4]. It establishes the perimeter, abuse-prevention, secrets, and audit-logging layer that sits *underneath* all of them, and it freezes one project-wide policy — constant-time comparison and enumeration resistance — that every future RFC inherits without needing to restate it[cite: 4].

## 2. Scope
- Global HTTP rate limiting and request-size ceilings, extending the narrowly-scoped per-endpoint limits already frozen in RFC-0002 §5 T1 and RFC-0004 §8.1[cite: 4].
- The full security response header set, extending RFC-0010 §8's CSP with HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, and Cross-Origin isolation headers[cite: 4].
- An explicit CORS denial policy and WebSocket `Origin` validation, layered on top of RFC-0005 §4.1's ticket handshake[cite: 4].
- A unified Server-Side Secret Loading Contract, generalizing the ad-hoc patterns already used by RFC-0009 §4.1 (VAPID) and RFC-0008 §5.2 (TURN Keyring)[cite: 4].
- A project-wide constant-time comparison and enumeration-resistance policy[cite: 4].
- A dedicated Security Audit Log, distinct from RFC-0001 §4's operational request log[cite: 4].
- Dependency and supply-chain integrity gates[cite: 4].
- A minimum transport security baseline (contract only — provisioning is out of scope)[cite: 4].
- An explicit, honest acknowledgement of the one threat this architecture structurally cannot mitigate[cite: 4].

## 3. Out of Scope
- Reverse-proxy TLS termination, certificate issuance/renewal, container isolation, and OS-level hardening — these are deployment topology concerns (Deferred to RFC-0012)[cite: 4].
- The CI pipeline mechanics that execute the scans mandated by §9 — the pass/fail *policy* is frozen here; the workflow YAML is not (Deferred to RFC-0013)[cite: 4].
- Admin panel RBAC, operator tooling, and the console that would read the Security Audit Log defined in §8 (Deferred to RFC-0014)[cite: 4].
- Load testing and performance benchmark targets for the rate limiter defined in §4.1 (Deferred to RFC-0015)[cite: 4].
- Fuzzing harness *execution infrastructure* beyond the specific corpus mandated in §14 (Deferred to RFC-0016)[cite: 4].

## 4. HTTP Perimeter Hardening

### 4.1. Global Rate Limiting Framework
- **Placement:** Implemented as `delivery/middleware` (RFC-0001 §2), registered globally in the Bootstrap route-registration step (RFC-0001 §6, step 9)[cite: 4].
- **Single-Binary Rule:** Rate limiter state MUST be an in-process token bucket (`golang.org/x/time/rate` or equivalent)[cite: 4]. No Redis or external dependency — consistent with the Single-Binary Rule already frozen in RFC-0005 §6.1[cite: 4].
- **Keying:** Buckets MUST be keyed on the tuple `(IP, RouteClass)` for unauthenticated routes and `(UserID, RouteClass)` for authenticated routes, so one abusive account cannot exhaust the budget of another user sharing a NAT'd IP[cite: 4].
- **Route Classes & Defaults:**
  - `auth.unauthenticated`: 20 req / min / IP (Backstop *above* RFC-0004 §8.1's tighter per-identity limits, which remain authoritative)[cite: 4].
  - `rest.general`: 60 req / min / user (Applies to all `/api/v1/*` REST routes not otherwise listed)[cite: 4].
  - `media.chunk`: 30 req / min / user (Distinct from the physical 5,242,896-byte size cap of RFC-0007 §7.2 — bounds *request frequency*, not payload size)[cite: 4].
  - `push.subscribe`: 5 req / min / user (RFC-0009 §6.1)[cite: 4].
  - `discovery`: 
    - 10 req / min / user
    - 10 req / min / IP
    - The tighter effective limit is authoritative[cite: 4].
- **State-Table Bound (Anti-Exhaustion):** The bucket map MUST be bounded by an LRU eviction policy (max 100,000 live entries) to prevent an attacker with a large IP pool from causing unbounded memory growth in the rate limiter itself[cite: 4].
- **Exceeded-Limit Response:** `429 Too Many Requests`, using the standard Error Envelope from RFC-0002 §4.4 with code `SEC_001`, and a `Retry-After` header expressing the bucket's refill time in seconds[cite: 4].
- **WebSocket Data-Plane Exemption:** This HTTP middleware does NOT govern the WebSocket data plane (its own framing already bounds abuse via RFC-0005 §5.2's 7.5MB frame cap)[cite: 4]. Instead, an independent per-connection ceiling applies: **max 30 `chat.msg` upstream frames per rolling 10-second window.**[cite: 4] Frames beyond this MUST be silently dropped; a connection that trips this ceiling 3 times MUST be closed with `1008 Policy Violation` (reusing the exact close code already established for ticket failure in RFC-0005 §4.1)[cite: 4].

### 4.2. Request Body & Payload Ceilings
- **Default Ceiling:** Every REST handler not covered by a domain-specific exact size contract MUST wrap its request body reader in `http.MaxBytesReader` with a default cap of `1 MiB`[cite: 4].
- **Documented Exceptions:** The `media.chunk` endpoint (exactly `5,242,896` bytes per RFC-0007 §7.2) and the Vault upload endpoint (RFC-0006 §4.3) are explicit, pre-frozen exceptions to the default[cite: 4]. The Vault upload MUST have an explicit maximum compressed ciphertext size of exactly `52,428,800 bytes` (50 MiB)[cite: 4]. They MUST NOT inherit the 1 MiB default[cite: 4].
- **Enforcement Point:** This is enforced at the `delivery/middleware` layer as a blanket default, with route-specific overrides registered per-handler — not left to each handler to remember individually[cite: 4].

### 4.3. Explicit CORS Denial Policy
- The backend MUST NEVER emit an `Access-Control-Allow-Origin` header, under any code path, for any route[cite: 4]. No future middleware, handler, reverse-proxy integration, or error path may emit any `Access-Control-Allow-*` header.
- This is a structural guarantee, not a suggestion: combined with RFC-0010 §8.1's `connect-src 'self'`, it makes cross-origin credentialed access to the API impossible at the browser level regardless of any future client misconfiguration[cite: 4].
- **No Preflight Handling:** Because no cross-origin access is ever granted, `OPTIONS` requests MUST return `404 Not Found` rather than a CORS preflight response — there is no preflight to answer[cite: 4].

### 4.4. WebSocket Origin Validation (Defense-in-Depth)
- Before consuming the Frame-0 auth ticket (RFC-0004 §7.3, RFC-0005 §4.1), the server MUST inspect the `Origin` header of the WebSocket upgrade request and reject with `1008 Policy Violation` if it does not exactly match the deployment's single configured origin[cite: 4].
- **Explicit Boundary:** This is defense-in-depth layered on top of ticket possession, not a replacement for it[cite: 4]. The ticket (single-use, 30-second TTL, obtained only via an authenticated same-origin `SameSite=Strict` cookie flow) remains the primary control against Cross-Site WebSocket Hijacking[cite: 4]. Origin validation exists to reject malformed/non-browser clients earlier and cheaper, before touching the ticket store[cite: 4].

## 5. Full Security Header Set (Extends RFC-0010 §8)
Every HTTP response MUST include, in addition to the `Content-Security-Policy` already frozen in RFC-0010 §8.1[cite: 4]:

- `Strict-Transport-Security`: `max-age=63072000; includeSubDomains; preload` (Enforces the TLS baseline of §10 at the browser level)[cite: 4].
- `X-Content-Type-Options`: `nosniff` (Prevents MIME-sniffing around the strict SVG-as-passive-image rule (RFC-0010 §9.2))[cite: 4].
- `Referrer-Policy`: `no-referrer` (No URL/token fragments leak to any third party)[cite: 4].
- `X-Frame-Options`: `DENY` (Legacy-browser redundant enforcement of `frame-ancestors 'none'`)[cite: 4].
- `Permissions-Policy`: `camera=(self), microphone=(self), geolocation=(), payment=(), usb=()` (`camera`/`microphone` scoped to `self` only, required by RFC-0008's WebRTC calling; every other sensitive API explicitly denied)[cite: 4].
- `Cross-Origin-Opener-Policy`: `same-origin` (Isolates the browsing context group)[cite: 4].
- `Cross-Origin-Embedder-Policy`: `require-corp` (Safe only because RFC-0010 §8.2's No Third-Party CDN Rule already guarantees every subresource is same-origin)[cite: 4]. All application-owned media, worker scripts, WASM, and static assets MUST be same-origin or explicitly CORP-compatible.
- `Cache-Control`: `no-store` (Extends the exact policy already mandated for `/api/v1/version` to every `/api/v1/*` API route)[cite: 4].

- **Verification Requirement:** Because `Cross-Origin-Embedder-Policy: require-corp` is only safe under the No-Third-Party-CDN invariant, the CI boundary-lint test of RFC-0010 §14 MUST be extended to fail the build if any `<script src>`, `<link>`, `@import`, or `fetch()` target resolves to a non-same-origin host at build time[cite: 4].

## 6. Server-Side Secret Loading Contract
Two prior RFCs each independently invented an ad-hoc secret-loading shape: RFC-0009 §4.1's VAPID encryption key ("a deployment-provided server-side encryption key loaded from immutable configuration") and RFC-0008 §5.2's TURN Keyring (`[Active_Secret, Previous_Secret]`, loaded at startup, immutable during runtime)[cite: 4]. This RFC generalizes both into one reusable contract so no future RFC needs to reinvent it[cite: 4].

### 6.1. The `Secret` Type & Serialization Redaction
- A dedicated `Secret` wrapper type MUST be used for every credential value in `internal/config`[cite: 4].
- Its `String()` and `GoString()` methods MUST unconditionally return the literal `"[REDACTED]"`.
- The `Secret` type MUST NOT expose the underlying secret through any formatting verb.
- The `Secret` type MUST implement `json.Marshaler`, and `MarshalJSON` MUST return the JSON string `"[REDACTED]"`.
- If `Secret` can appear in any map key or other JSON-bearing type, equivalent custom serialization MUST prevent raw secret disclosure.
- `Secret` MUST NOT be used as a map key, database key, URL parameter, HTTP header value, metric label, or log field except through its redacted representation.
- This ensures that accidental inclusion in `%v`/`%+v` formatting, `slog` attributes, JSON payloads, or panic stack traces (RFC-0001 §4) can never leak raw key material[cite: 4].

### 6.2. Loading Rules
- Secrets MUST be loaded exclusively from environment variables or a mounted file path referenced by an environment variable (`_FILE` suffix convention, e.g. `VAPID_ENCRYPTION_KEY_FILE`)[cite: 4].
- Secrets MUST NEVER be loaded from SQLite, from CLI flags (visible via `/proc/<pid>/cmdline` or `ps`), or committed to the repository in any form, including as migration seed data[cite: 4].
- Secret loading occurs during the existing `Load configuration` → `Validate configuration` steps of the Bootstrap Sequence (RFC-0001 §6, steps 1–2) and is subject to the same `Freeze Contract` (RFC-0001A §5.1) — no secret may be re-read or hot-reloaded during process lifetime[cite: 4].

### 6.3. Rotation Shape
- Any secret requiring zero-downtime rotation MUST follow the exact two-slot `[Active, Previous]` shape already frozen for the TURN Keyring (RFC-0008 §5.2): both slots loaded at boot, rotation performed via a controlled process restart, the `Previous` slot honored for a bounded overlap window and then dropped on the next rotation[cite: 4]. This RFC does not introduce a new rotation mechanism — it declares the TURN pattern the canonical one for the whole project[cite: 4].

## 7. Project-Wide Constant-Time & Enumeration-Resistance Policy
RFC-0003 §8.1 already mandates constant-time comparison for cryptographic authentication failures[cite: 4]. This section generalizes that into a standing rule binding on every current and future RFC, so it does not need to be re-derived per domain[cite: 4].

- **Rule 1 (Constant-Time Secret Comparison):** Every comparison of a server-held hash against a client-supplied credential MUST use `crypto/subtle.ConstantTimeCompare` or an equivalent constant-time primitive[cite: 4]. This applies retroactively in spirit to every such comparison already specified: the Media Token hash check (RFC-0007 §7.4), the session cookie hash lookup (RFC-0004 §6.1/§8.3), and the chunk hash verification (RFC-0007 §7.2) — implementers MUST treat those sections as if this rule were already inline in them[cite: 4].
- **Rule 2 (Uniform Not-Found/Not-Owned Response):** Every code path that branches on "resource does not exist" versus "resource exists but is not owned by the caller" MUST return an identical response[cite: 4]. This rule is already instantiated three times independently (RFC-0002 §5 T1's Discovery endpoint, RFC-0007 §7.1's `404` for other-owner `file_id`, RFC-0009 §6.1's subscription-ownership check) — this RFC promotes it from a repeated pattern to a standing project rule so RFC-0012 onward do not need to restate it per endpoint[cite: 4].

## 8. Security Audit Log
Distinct from RFC-0001 §4's `slog`-based operational request log (`TraceID`, `Method`, `Path`, `Status`, `Latency`)[cite: 4].

### 8.1. Event Taxonomy
A fixed, closed enum — no free-text event types are permitted[cite: 4]:
`AUTH_SUCCESS`, `AUTH_FAILURE`, `SESSION_REVOKED`, `IDENTITY_MIGRATION` (RFC-0003 §5.4), `RATE_LIMIT_TRIPPED` (§4.1), `WS_ORIGIN_REJECTED` (§4.4), `QUOTA_EXCEEDED` (RFC-0007 §8.2), `MEDIA_TOKEN_ISSUED`[cite: 4].

### 8.2. Zero-Knowledge-Compliant Fields
- Permitted fields: `event_type`, `identity_hash` (never a raw identity), `ip_hash`, `trace_id`, `created_at`[cite: 4].
- **IPHash Algorithm:** `IPHash` MUST be computed as: `HMAC-SHA256(IP_Hash_Secret, canonical_ip_bytes)` and encoded as lowercase hexadecimal[cite: 4]. `IP_Hash_Secret` MUST be loaded through the global Secret Loading Contract (§6) and MUST be distinct from all authentication, encryption, VAPID, and TURN secrets[cite: 4].
- **Forbidden, absolutely:** plaintext message content, key material of any kind, raw IP addresses, and raw session tokens[cite: 4]. Audit events MUST NOT contain `file_id`, `conversation_id`, media filename, request payload, or capability token[cite: 4]. A field that cannot be constructed from the permitted list MUST NOT be added to this log — it must instead be represented as one of the fixed enum values above[cite: 4].

### 8.3. Storage, Retention & Deletion Policy
- Table `security_events`, append-only (no `UPDATE` path — only `INSERT` and the retention-driven `DELETE` below)[cite: 4].
- Default retention: `90 days`, configurable via immutable startup configuration[cite: 4].
- Expiry enforcement follows the same periodic-worker shape already established for media garbage collection (RFC-0007 §8.6): a `Worker` (RFC-0001A §5.3 interface) that hard-deletes rows older than the retention window on a fixed interval[cite: 4].
- **User Deletion Impact & Privacy Trade-Off:** When a user is hard-deleted (RFC-0002 §4.3), their associated `security_events` MAY be retained for the remainder of their natural 90-day window[cite: 4]. 
  - Retained security events do not contain reversible identity data, message content, credentials, session identifiers, or raw IP addresses.
  - The retained `identity_hash` remains a stable pseudonymous audit identifier and MUST be treated as privacy-sensitive metadata.
  - This retention is an explicit audit/privacy trade-off and does not constitute deletion of all pseudonymous historical metadata.

## 9. Dependency & Supply-Chain Integrity
- **Backend:** `go.sum` verification MUST be enforced at build time (`GOFLAGS=-mod=readonly`)[cite: 4]. `govulncheck` MUST report zero known-exploitable vulnerabilities as a release gate[cite: 4]. *(The workflow that runs this check is RFC-0013's concern; the pass/fail policy is frozen here.)*[cite: 4]
- **Frontend:** Installs MUST use `npm ci` against a committed `package-lock.json` — no floating semver ranges[cite: 4]. A vulnerability scan (`npm audit --omit=dev` or OSV-Scanner) MUST report zero critical/high findings as a release gate[cite: 4].
- **No Silent Egress:** No dependency may be added that performs runtime network egress beyond the two explicit, already-frozen outbound calls the platform makes by design: the Push Service (RFC-0009) and self-hosted STUN/TURN (RFC-0008)[cite: 4]. This extends the No Third-Party CDN Rule (RFC-0010 §8.2) from "bundled assets" to "the dependency tree as a whole."[cite: 4]

## 10. Transport Security Baseline (Contract, Not Provisioning)
- Minimum negotiable protocol version: **TLS 1.2**[cite: 4]. TLS 1.3 MUST be preferred when the terminating layer supports it[cite: 4].
- The `Secure` cookie flag (RFC-0004 §7.1 Strict Cookie Contract) and the `wss://` scheme are both predicated on this baseline holding true in production[cite: 4].
- **Local Development Exception:** An `insecure_dev_mode` configuration flag MAY relax this to plaintext HTTP[cite: 4]. It MUST default to `false`, and the Bootstrap Sequence's Validate step (RFC-0001 §6, step 2) MUST refuse to start (Fail Fast, per RFC-0001A §5.2) if this flag is `true` while the configured bind address is not loopback (`127.0.0.1`/`::1`)[cite: 4].
- Certificate issuance, renewal, and the reverse-proxy/TLS-termination topology itself are explicitly deferred to RFC-0012 — this section fixes the *floor* the rest of the system already assumes, not how that floor gets built[cite: 4].

## 11. Inherent Threat Acknowledgement: The Zero-Knowledge Media Scanning Boundary
Because media chunks are opaque AES-256-GCM ciphertext to the server by design (RFC-0007 §4.1), the server **structurally cannot** perform malware or abusive-content scanning on uploaded files — not as an oversight, but as the direct, unavoidable consequence of the Zero-Knowledge architecture this entire RFC series builds toward[cite: 4]. This RFC does not attempt to solve that; it names it explicitly, in the same honest-trade-off spirit already established elsewhere in the series (RFC-0006 §6 F1's accepted data-loss window; RFC-0003 §8.4's Session-Level-only forward secrecy boundary), so that an operator's threat model is never silently incomplete on this point[cite: 4]. No server-side mitigation exists or is planned[cite: 4]. The only available lever is client-side, user-facing risk framing at file-open time — a Presentation-layer UX concern, non-normative here[cite: 4].

## 12. Consolidated Threat Model & Failure Modes

### 12.1. Threats Not Owned by Any Prior RFC
- **T1: Volumetric Abuse of Unauthenticated Endpoints.** An attacker distributes requests to `/auth/challenge` or `/auth/register` across many IPs, beyond what RFC-0004 §8.1's per-identity limits alone catch[cite: 4]. *Mitigation:* §4.1's global per-IP `auth.unauthenticated` ceiling as a backstop layer[cite: 4].
- **T2: Cross-Site WebSocket Hijacking.** *Mitigation:* §4.4 Origin validation, layered defense-in-depth on RFC-0004's ticket auth[cite: 4].
- **T3: Secret Leakage via Structured Logs/JSON.** A future engineer accidentally logs a config struct containing a raw secret via `%+v` or JSON payload[cite: 4]. *Mitigation:* §6.1's `Secret` type makes this leak syntactically impossible across formatters, serialization, and marshaling interfaces[cite: 4].
- **T4: Dependency Supply-Chain Compromise.** *Mitigation:* §9's scan-gate policy[cite: 4].
- **T5: Malicious/Abusive Media Content.** *Mitigation:* None at the server layer — see §11's explicit acknowledgement[cite: 4].

### 12.2. Failure Modes & Edge Cases
- **F1: Rate Limiter Memory Growth Under Distributed Attack.** A wide-IP-pool attacker could otherwise grow the bucket table unboundedly[cite: 4]. *Mitigation:* §4.1's 100,000-entry LRU-bounded state table[cite: 4].
- **F2: Secret Rotation Misconfiguration at Boot.** Both TURN Keyring slots or the VAPID encryption key fail to load or fail signature self-test[cite: 4]. *Mitigation:* Fail Fast per RFC-0001A §5.2 — the process MUST NOT start in a partially-secured state[cite: 4].
- **F3: Security Audit Log Write Failure.** A `security_events` insert fails (e.g., disk pressure) mid-request[cite: 4]. *Rule:* This MUST NOT block or fail the underlying user-facing request — the audit write is best-effort and asynchronous relative to the request path, logged as a `SYS_500`-class internal warning via the ordinary RFC-0001 §4 operational log if it fails, never surfaced to the client[cite: 4].

## 13. Acceptance Criteria
- A burst of 1,000 requests/second from a single IP against `/api/v1/auth/challenge` is throttled to the configured `auth.unauthenticated` ceiling with `429`/`SEC_001` responses, without the legitimate per-identity flow (RFC-0004 §8.1) being affected for other identities[cite: 4].
- Every HTTP response, including error responses, carries the full header set of §5[cite: 4].
- A WebSocket upgrade attempt with a spoofed `Origin` header is rejected with `1008` before ticket consumption is attempted[cite: 4].
- Grepping and serialization tests MUST demonstrate that `Secret` values are rendered only as `[REDACTED]` across `fmt` formatting, `GoString()`, JSON serialization, and panic/error rendering.
- `govulncheck` and the frontend vulnerability scan both report zero release-blocking findings on a clean build[cite: 4].
- The `security_events` table contains zero plaintext content, key material, or raw IP addresses under fuzz testing (§14)[cite: 4].

## 14. Testing Requirements
- **Rate Limiter Load Test:** Simulate 10,000 distinct source IPs each issuing requests at 2x their allotted rate; assert exactly the expected fraction is throttled and the bucket table stays within its LRU bound[cite: 4].
- **Header Presence Test:** E2E HTTP test asserting the full §5 header set is present on a representative sample of routes, including error (4xx/5xx) responses[cite: 4].
- **Secret Redaction Fuzz Test:** Construct a `config` struct populated with every `Secret`-typed field, serialize it via `%v`, `%+v`, `json.Marshal`, and a forced panic/stack-trace path; assert no raw secret bytes appear in any output[cite: 4].
- **CORS Negative Test:** Issue a cross-origin `fetch()` with credentials from a headless browser against every route class; assert no `Access-Control-Allow-Origin` header is ever present and the browser reports the request as blocked[cite: 4].
- **Audit Log Compliance Fuzz Test:** Feed a corpus of adversarial inputs (including embedded plaintext-like strings, key-shaped byte sequences, and raw IPv4/IPv6 literals) through every code path that writes to `security_events`; assert none of the forbidden field categories in §8.2 ever appear in the resulting rows[cite: 4].

## 15. Implementation Notes
- `golang.org/x/time/rate` for the token-bucket rate limiter (§4.1); pair with an LRU eviction wrapper (e.g. `hashicorp/golang-lru`) for the bounded state table[cite: 4].
- `crypto/subtle` for all constant-time comparisons mandated by §7[cite: 4].
- `govulncheck` (Go's official vulnerability scanner) for §9's backend gate; OSV-Scanner or `npm audit` for the frontend gate[cite: 4].
- Security headers are best applied as a single `delivery/middleware.SecurityHeaders` middleware registered once, ahead of route-specific handlers, rather than duplicated per-handler[cite: 4].

## 16. Future Compatibility
- **Edge/WAF Rate Limiting:** A future complement to, not a replacement for, §4.1's application-layer limiter — the in-process limiter remains the authoritative last line of defense regardless of what sits in front of it[cite: 4].
- **Hardware-Backed Secret Management (Vault/KMS):** A candidate future replacement for the environment-variable secret loading of §6.2 in larger deployments; the `Secret` type's interface is intentionally storage-agnostic to make this swap non-breaking later[cite: 4].
- **mTLS Between Reverse Proxy and Application:** A candidate hardening addition once RFC-0012 defines the deployment topology; out of scope until that topology exists[cite: 4].