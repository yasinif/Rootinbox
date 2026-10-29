# 🧪 RFC-0016: Testing & Quality Assurance
**Status:** Frozen & Active Execution Directive
**Role:** Principal Quality Engineering Architect

## 1. Objective
Establish the system-wide Test Pyramid, close the explicit testing-requirement gaps identified in the previously Frozen RFC set, and consolidate the scattered crash-recovery guarantees, security regression suites, and cryptographic test vectors into one coherent Quality Gate. This section defines the QA test execution model only. Release eligibility, artifact generation, signing, deployment, and release gating remain strictly governed by RFC-0013. The results of the Load and Chaos stages defined here serve as mandatory inputs to RFC-0013's release eligibility. This RFC does not weaken or redefine any prior execution requirements.

## 2. Scope
- The Test Pyramid, measurement tooling, and line-coverage exclusion policies.
- A formal audit and gap-closure of per-RFC test coverage (specifically closing RFC-0003 and RFC-0004 gaps).
- A Cross-RFC Acceptance Criteria Traceability Matrix with executable test paths.
- CI QA Stage ordering and merge- vs. release-blocking criteria.
- A consolidated Chaos & Fault-Injection Test Harness with strict environment isolation and unique semantic hooks.
- Contract testing between the Go backend and TypeScript frontend validating structural and semantic parity.

## 3. Out of Scope
- Visual regression / pixel-diff UI testing.
- Manual QA / exploratory testing process and staffing.
- CI/CD pipeline infrastructure, release triggers, and artifacts — Deferred to RFC-0013.

## 4. Test Pyramid & Layer-Specific Strategy

### 4.1. Backend
- **Unit Tests:** Domain and UseCase layers, using interface mocks.
- **Integration Tests:** Infrastructure/SQLite repositories, using `t.TempDir()` with a fresh on-disk database per test — never the production DB.
- **Execution Syntax:** The explicit execution commands (e.g., `go test -race -shuffle=on ./...`) standardized in RFC-0001 and orchestrated by RFC-0013 remain authoritative.

### 4.2. Frontend
- **Unit Tests:** UseCase layer via Vitest, framework-agnostic (RFC-0010 §4.1).
- **Integration Tests:** Dexie repositories against `fake-indexeddb`.
- **E2E Tests:** Playwright for browser-level security and behavioral flows.
- **Fuzz Tests:** Sanitization and security fuzz suites MUST execute independently under the security regression stage, completely segregated from standard E2E flows.

### 4.3. Coverage Thresholds — A Deliberately Narrow Mandate
- Domain and UseCase layers (both stacks) MUST maintain a minimum `80%` line coverage, enforced in CI.
- **Measurement Policy:** Coverage MUST be measured using the standard coverage tooling of each stack (e.g., `go test -cover`, Vitest coverage). Generated code, test code, build artifacts, and vendored/generated bindings MUST be consistently excluded from the denominator.
- The mandatory threshold applies to line coverage only. Coverage MUST NOT be treated as a security or correctness proof. Mutation testing remains future work.
- **Explicit Non-Mandate:** Infrastructure layers (SQLite repositories, WS transport) carry NO blanket coverage percentage, relying instead on Integration and Chaos suites.

## 5. Closing Testing Gaps in RFC-0003 and RFC-0004

### 5.1. RFC-0003 Test Requirements (New)
- **Nonce Atomicity Test:** Fire concurrent requests racing to consume the same Challenge ID; assert exactly one succeeds, validating the `COMPARE-AND-DELETE` rule of RFC-0003 §4.2.
- **Single-Session Grace Period Test:** Assert a second login correctly revokes the first session into `GRACE_PERIOD`. A Grace-Period Session Key MUST be accepted only for decryption of delayed messages and MUST NOT be used for encryption, new message routing, or new session establishment. Assertions: `decrypt = PASS`, `encrypt new message = FAIL`, `new routing = FAIL`.
- **Ticket Single-Use Test:** Assert a WS ticket, once consumed, is rejected on any second use attempt.
- **Uniform Failure Timing Test:** The test MUST use a statistically bounded equivalence criterion. The tolerance MUST be a version-controlled test-harness parameter and MUST NOT be dynamically relaxed by CI after a failure. It MUST fail only when the observed timing distributions exceed the configured tolerance.

### 5.2. RFC-0004 Test Requirements (New)
- **Idempotency Race Test:** Submit the same `client_uuid` from two concurrent connections. Exactly one logical message MUST be persisted (storage invariant). All duplicate submissions MUST receive idempotent success behavior (protocol invariant).
- **Atomic Delivery Decision Test:** A deterministic delivery-decision fault-injection hook MUST exist immediately before the Live-Delivery commit point. Force a recipient disconnect at this semantic hook. Assert the message lands in exactly one of {Live Delivery, Queue} — never both, never neither.
- **Write Pump Isolation Test:** `go test -race` MUST catch any direct socket write attempted from outside the dedicated Write Pump goroutine.
- **Frame Size Rejection Test:** The WebSocket implementation MUST enforce the configured maximum frame size (`7,500,000` bytes) before allocating memory proportional to the full oversized payload. The connection/session MUST transition to the mandated failure state, and the server MUST NOT persist or partially route the oversized payload.

## 6. Cross-RFC Acceptance Criteria Traceability Matrix

| RFC | Domain | Native Testing Section | Existing Test Path | Gate |
|---|---|---|---|---|
| 0001 | Core Architecture | §7 | `backend/core/...` | Blocking |
| 0001A | Cross-Cutting Contracts | (via 0001 §7) | `backend/core/...` | Blocking |
| 0002 | Cryptography | §10 (Test Vectors) | `shared/crypto/...` | Blocking |
| 0003 | Authentication | §10 + RFC-0016 §5.1 | `backend/auth/...` | Blocking |
| 0004 | WebSocket Protocol | RFC-0016 §5.2 | `backend/ws/...` | Blocking |
| 0005 | Offline Storage & Sync | §8 | `backend/sync/...` | Blocking |
| 0006 | Media & Attachments | §8 | `backend/media/...` | Blocking |
| 0007 | Voice & Video Calling | §14 | `backend/rtc/...` | Blocking |
| 0008 | Push Notifications | §12 | `backend/push/...` | Blocking |
| 0009 | Push Fan-Out / Delivery | §12 | `backend/push/...` | Blocking |
| 0010 | Frontend Architecture | §14 | `frontend/core/...` | Blocking |
| 0011 | Security Hardening | §15 | `backend/security/...` | Blocking |

*Note: Where an RFC (e.g., RFC-0010, RFC-0011) specifies multiple distinct testing requirements, every individual requirement MUST map strictly 1-to-1 to an explicit assertion within the listed test path.*

## 7. QA Test Execution Model (Stage Ordering)
This section defines parallelizable testing tracks, subject to the CI orchestration defined in RFC-0013.

1. **Lint & Format** — Static analysis, boundary rules.
2. **Unit Tests** — `go test -race -shuffle=on ./...`; Vitest.
3. **Deterministic Cross-Platform Tests** — Cryptographic Test Vectors (RFC-0002 §10) executed across Go, React, and WASM.
4. **Integration Tests** — `t.TempDir()` SQLite; `fake-indexeddb`.
5. **Security Regression & Fuzz Suites** — Independent sanitization fuzzing.
6. **Contract Tests** — Wire parity semantic validation (§10).
7. **E2E Tests** — Playwright behavioral flows.
8. **Load & Capacity** — Assertion against RFC-0015 thresholds.
9. **Chaos Tests** — Injection harness (§9).

*Blocking Status:* For a release candidate, all defined QA suites (including Stages 8–9 Load and Chaos) MUST pass outright and their results fed as eligibility inputs to RFC-0013.

## 8. Load & Performance Validation
- Validates the RFC-0015 capacity limits (e.g., `MaxOpenConns=1` SQLite bottleneck, admission control, reserved lanes, WebSocket connection ceilings, and OOM prevention).
- Enforces success rates, load-shed metrics (`PERF_001`), and memory stability alongside raw latency SLOs.

## 9. Chaos & Fault-Injection Testing

### 9.1. Harness, Hooks, and Isolation Contract
The Chaos Test Harness deterministically halts execution at named, semantic injection points.
- **Hook Uniqueness:** Every semantic fault-injection hook MUST have a globally unique identifier. The Chaos suite MUST fail if a required hook is duplicated, renamed unexpectedly, or maps to more than one runtime injection point.
- **Crash Type Distinction:** The harness MUST differentiate crash types: `SIGKILL` scenarios validate crash/restart recovery from abrupt process death, while `controlled panic` scenarios validate panic-boundary isolation and recovery behavior. The suite MUST explicitly declare which invariant is being tested.
- **Isolation Constraint:** Each chaos scenario MUST execute against an isolated ephemeral environment, database volume, and media volume. A failed or killed scenario MUST NOT reuse state from another scenario.

### 9.2. Injection Points
| Injection Point | Expected Post-Restart Invariant | Source |
|---|---|---|
| Mid media chunk write | Temp file orphaned; chunk row absent; GC reconciles per 10-minute Grace Rule. | RFC-0006 |
| File stuck in `DELETING` | Recovery Worker resumes Phase B and C cleanly. | RFC-0006 |
| Call row in `RINGING`/`ACTIVE`| Both transition to terminal states (`FAILED`/`ENDED`). | RFC-0007 |
| Mid Vault upload | Partial/incomplete upload MUST NOT create a finalized Vault record. A complete retry with valid SHA-256 hash MUST succeed. | RFC-0005 |
| Mid WS message ACK | If the client persisted the message before ACK and the ACK is lost: re-delivery MUST be idempotently absorbed by `client_uuid` without message loss or duplicate logical state. | RFC-0004 |

## 10. Contract Testing (Frontend/Backend Wire Parity)
- **Canonical Source:** The versioned JSON Schema fixtures are the canonical wire-contract artifacts for REST/WS envelope validation. The contract schemas MUST be version-controlled and integrity-pinned to prevent localized or silent tampering. Generated types MAY be derived from them but MUST NOT silently diverge.
- **Semantic Validation:** Contract tests MUST validate both structural schema and protocol-level semantic constraints (e.g., UUIDv4, Base64URL, payload size limits, enum values) that cannot be expressed safely through JSON Schema alone.

## 11. Security Considerations & Threat Model
- **T1: The Test Harness Itself as an Attack Surface.** *Mitigation:* The Production build MUST be built without the `chaos` build tag, and CI MUST assert both: 1) chaos-specific packages are not compiled; 2) chaos entrypoints/hooks are unreachable from production build artifacts.
- **T2: Test Fixtures Mistaken for Production Secrets.** *Mitigation:* Test vectors MUST be clearly namespaced as test-only and MUST NOT be structurally indistinguishable from real production keys.
- **T3: Binary Fuzzing Gaps.** Critical binary parser and cryptographic boundary fuzzing MUST be required before production hardening. This RFC intentionally does not make broader general parser fuzzing a release-blocking gate at this stage.

## 12. Failure Modes & Edge Cases
- **F1: Flaky Test Masking a Real Concurrency Bug.** A race condition failure MUST NOT be silenced by retrying until green.
- **F2: Chaos Injection Point Drift After Refactor.** A refactor that removes a semantic hook MUST fail the chaos suite loudly (missing hook = test error), never silently skip the assertion.

## 13. Acceptance Criteria
- RFC-0003 and RFC-0004 each have an executed test suite resolving their coverage gaps.
- Any structural or semantic mismatch between the canonical, integrity-pinned wire schema and the Go/TypeScript implementations MUST fail CI.
- The Chaos Test Harness exercises every injection point in §9.2 under strict isolation and passes on every release candidate.
- A CI script parses the Traceability Matrix (§6) and fails if any listed RFC lacks a linked, existing test suite path.
- Production binary builds strictly fail if chaos-specific code paths are reachable or compiled.