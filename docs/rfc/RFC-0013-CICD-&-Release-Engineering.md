# 🚀 RFC-0013: CI/CD, Release Engineering & Migration Safety
**Status:** Frozen & Active Execution Directive
**Role:** Principal Release Engineer

## 1. Objective
Wire the test suites, scan gates, and build artifacts already frozen by previously Frozen RFCs into one deterministic pipeline, and resolve the one release-safety question no prior RFC answers: given RFC-0001A §5.6's monotonic-migration rule and RFC-0012 §9's rolling-restart-in-place-only deployment model, what does a *safe rollback* actually mean when the binary can move backward but the schema structurally cannot?

## 2. Scope
- Pipeline stage ordering and a consolidated, 1-to-1 canonical test matrix for all previously Frozen RFCs.
- Cross-platform cryptographic test vector conformance (Go/React/WASM).
- The build artifact contract: deterministic `BuildHash`, immutable Image Digest, and signature verification.
- The deployment trigger contract, pipeline-level concurrency locks, and out-of-band migration prohibition.
- Migration safety via the strict Expand/Contract discipline and Rollback Eligibility rules.
- The rollback procedure and runtime verification against the current schema.
- Secrets injection at deploy time, adhering to RFC-0012 §5's mount layout.

## 3. Out of Scope
- The content or coverage of any *new* test suite (Deferred to RFC-0016).
- Admin-facing release/rollback tooling UI (Deferred to RFC-0014).
- Load and performance benchmark thresholds (Deferred to RFC-0015).

## 4. Pipeline Stages & Consolidated Test Execution

### 4.1. Stage Order
1. Lint & Boundary Check (includes the migration linter of §11 F2)
2. Unit Tests
3. Integration Tests
4. Cross-Platform Crypto Test Vector Conformance (§5)
5. Source, Dependency & Secret Security Scan
6. Build & Tag (§6)
7. Container Provenance, Image Vulnerability Scan & Signing (§6.2)
8. Deploy Trigger & Release Verification (§7) — gated, single-flight

**Internal Stage 7 Verification Flow:**
`Verify produced image` ➔ `Resolve immutable digest` ➔ `Verify base-image digest` ➔ `Generate provenance/SBOM` ➔ `Container vulnerability scan` ➔ `Sign image` ➔ `Verify image signature and digest`

**Internal Stage 8 Execution Flow:**
`Execute Single-Flight Lock` ➔ `Pre-Production Compatibility Verification (Rollback Drill)` ➔ `Deploy Immutable Digest` ➔ `Start Candidate` ➔ `/health/ready Polling` ➔ `Route Traffic` ➔ `Release Lock (on success or terminal failure)`

### 4.2. Consolidated Canonical Test Matrix
Every testing requirement from previously Frozen RFCs MUST be explicitly mapped 1-to-1 to a CI gate. Testing requirements introduced by this RFC are mapped in the same canonical matrix.

*Note: The canonical matrix maps explicit testing requirements only. Non-test release gates such as Build, Provenance, Scanning, Signing, and Deployment are governed directly by §§5–7 and do not inherently map to legacy `Testing Requirements` sections.*

| Stage | Exact Test Name from Owning RFC | Owning RFC & Section | Gate |
|---|---|---|---|
| 1 | Boundary Lint Test (zero cross-layer imports) | RFC-0010 §14 | Blocking |
| 1 | Migration Linter Violation & Override Test | RFC-0013 §13 | Blocking |
| 2 | Domain/UseCase Interface-Mock Unit Tests | RFC-0001 §7 | Blocking |
| 2 | Concurrency Safety (`go test -race`) | RFC-0001 §7 | Blocking |
| 2 | Test Order Independence (`go test -shuffle=on`) | RFC-0001 §7 | Blocking |
| 3 | SQLite Repository Integration Tests (`t.TempDir()`) | RFC-0001 §7 | Blocking |
| 3 | Database Cascade Deletion Test | RFC-0001 §6 | Blocking |
| 3 | Envelope JSON Structure Test | RFC-0004 §5.1 | Blocking |
| 3 | Cursor Pagination Stability Test | RFC-0005 §4.2 | Blocking |
| 3 | Offline Sync Loop Pagination Test | RFC-0005 §4.1 / §8 | Blocking |
| 3 | Vault Integrity & Atomicity Upload Test | RFC-0005 §6 / §8 | Blocking |
| 3 | Hash Rejection Test | RFC-0005 §6 / §8 | Blocking |
| 3 | Proxy Spoofing Test | RFC-0012 §16 | Blocking |
| 3 | WebSocket Longevity Test | RFC-0012 §16 | Blocking |
| 3 | Backup/Restore Integration Test | RFC-0012 §16 | Blocking |
| 3 | Read-Only Filesystem Test | RFC-0012 §16 | Blocking |
| 3 | WAL Backup State Consistency Test | RFC-0012 §16 | Blocking |
| 4 | Cryptographic Test Vectors | RFC-0002 §10 | Blocking |
| 4 | Vault Test Vector | RFC-0005 §8 | Blocking |
| 4 | Fixture Drift Test | RFC-0013 §13 | Blocking |
| 5 | Dependency Supply-Chain Vulnerability Scan | RFC-0011 §9 | Blocking |
| 5 | Base Image Digest Update Check | RFC-0011 §9 | Blocking |
| 7 | Signature Verification Test | RFC-0013 §13 | Blocking |
| 8 | Rollback Drill | RFC-0013 §13 | Blocking |
| 8 | Single-Flight Deployment Test | RFC-0013 §13 | Blocking |

*(Note: Testing requirements from RFCs that are not yet Frozen are intentionally excluded and MUST be incorporated when those RFCs reach Frozen status).*

### 4.3. Blocking vs. Advisory Rule & Caching
- All CI correctness and security gates (Stages 1-5) MUST run on every PR and every merge to the release branch, preventing artifact production on any failure.
- Caching MAY accelerate dependency installation and build preparation, but MUST NOT bypass execution or result validation of any mandatory test gate.
- Release and Deployment gates (Stages 6-8) MUST NOT execute on ordinary pull requests unless explicitly configured as a staging deployment.
- Release-specific gates such as the Rollback Drill MUST execute only for release candidates whose migration set requires rollback-compatibility validation.
- No Advisory-tier test is currently defined by the Frozen RFC set. When an Advisory test is introduced by a later Frozen RFC, it MUST be added to the canonical matrix with an explicit Advisory classification.

## 5. Cross-Platform Crypto Test Vector Conformance
- Vectors MUST live in exactly one canonical, version-controlled fixture (e.g. `crypto/test-vectors.json`), consumed by Go, React, and WASM test suites.
- The fixture MUST be content-addressed or otherwise integrity-pinned so that all three suites consume exactly the same fixture bytes.
- Stage 4 MUST run all three suites against the same fixture bytes. A two-out-of-three pass is a failure, not a majority result.

## 6. Build Artifact Contract

### 6.1. Deterministic Tagging & Ultimate Artifact Identity
- `BuildHash` MUST be the immutable, full Git commit SHA of the exact source commit.
- The image tag MUST use the short Git commit SHA for deployment brevity.
- **Ultimate Identity Rule:** The image tag MUST NOT be the sole artifact identity. The immutable image digest MUST be the deployment identity (`Git SHA ➔ BuildHash ➔ Image ➔ Immutable Digest ➔ Sign Digest ➔ Deploy Digest`).
- `BuildTime` MUST be derived from the author/committer timestamp of the exact Git commit and normalized to UTC. CI MUST NOT use the current wall-clock time. The selected timestamp source MUST be documented and used consistently across all builds.
- **CI is the sole producer of these values.** The application MUST NOT compute them independently at runtime.

### 6.2. Provenance, Verification & Digest Pinning
- The runtime base image MUST be pinned by digest, never a floating tag.
- The built container image MUST be signed (e.g. `cosign`) as a mandatory Stage 7 step.
- Deployments MUST NOT solely rely on the existence of a signature; the deployment orchestrator MUST explicitly verify the artifact's signature and digest before executing the rollout.

## 7. Deployment Trigger Contract
- **Single-Flight Lock:** The deployment Single-Flight Lock MUST be provided by the CI/CD platform or deployment orchestrator and MUST NOT depend on the application SQLite database.
- **Deploy by Pinned Digest:** The deployment controller MUST resolve and pin the exact image digest before starting the candidate deployment, and the digest MUST remain unchanged for the entire deployment operation. It MUST deploy by digest (e.g., `image@sha256:...`), never by mutable tag.
- **Lock Release on Failure:** The Single-Flight Lock MUST be released or safely transitioned to an error/cleanup state on every terminal deployment outcome, including startup failure, readiness timeout, signature rejection, deployment abort, and rollback failure.
- **No Out-of-Band Migrations:** The pipeline MUST NOT execute database migrations as a distinct CD step. Migrations run automatically and idempotently at Bootstrap (RFC-0001A §5.6).
- **Secret Configuration:** For every `*_FILE` variable defined by RFC-0012, the deployment environment MUST provide:
  1. A read-only secret file.
  2. At the path referenced by the corresponding environment variable (e.g., `/run/secrets/`).
  3. With the secret value never exposed to the CI runner, image layers, build arguments, or logs.

## 8. Migration Safety & the Expand/Contract Discipline
RFC-0001A §5.6 freezes migrations as strictly monotonic — there is no "migrate down" path anywhere in this architecture.

- **Expand-Phase Rule:** Expand-phase migrations MUST be backward-compatible with the immediately preceding release and MUST NOT remove or rename schema elements still used by that release. Expand-phase changes SHOULD be additive.
- **Rollback Eligibility Rule:** A release MUST be considered rollback-eligible only while its binary remains compatible with the current database schema and while its rollback compatibility window has not expired.
- The deployment system MUST NOT select an arbitrary historical "last known-good" artifact for rollback unless that artifact is explicitly verified as compatible with the current schema.
- **Contract-Phase Rule:** Contract-phase destructive changes MAY remove obsolete schema elements, but ONLY in a later release after the previous release has permanently stopped depending on those elements and the rollback compatibility window has expired.
- After a Contract-phase migration is deployed, rollback to any binary that depends on the removed schema elements MUST be considered UNSAFE and MUST be blocked.

## 9. Rollback Procedure
1. Identify a rollback-eligible `BuildHash` (§8). The `BuildHash` identifies the eligible release; the immutable image digest is the sole artifact identifier used for the actual rollback deployment.
2. **Compatibility Verification:** Verify that the target binary is compatible with the current schema. Every release containing an Expand migration MUST pass the rollback compatibility drill against the exact database schema state that target would encounter in production.
3. Only after successful compatibility verification may the rollback deploy proceed. Re-trigger the Deployment Trigger Contract (§7) with the previously verified immutable image digest corresponding to the rollback-eligible `BuildHash`.
4. If schema compatibility was violated, rollback is unsafe and MUST be blocked. 

## 10. Security Considerations & Threat Model
- **T1: CI Runner Compromise Leaking Secrets.** *Mitigation:* §7's strict secret configuration ensures the pipeline only handles references/mounts, never values.
- **T2: Tampered Image Deployed.** *Mitigation:* §6.2 and §7 mandate image signing and deployment strictly by immutable digest BEFORE traffic routing.

## 11. Failure Modes & Edge Cases
- **F1: Deploy Lock Held by a Stuck Pipeline Run.** *Mitigation:* The Single-Flight Lock MUST carry a hard TTL (e.g. 15 minutes) and MUST be released on terminal failures (§7).
- **F2: A Migration Silently Violates Expand/Contract.** The migration linter MUST reject or require explicit human-reviewed override for schema operations that may violate Expand/Contract compatibility (e.g., `DROP`, `RENAME`, destructive type changes, adding `NOT NULL` without defaults).
  - *Override Contract:* An override does not make the migration automatically safe or exempt it from CI gates. It only permits the migration to proceed to the mandatory rollback-safety review and compatibility testing. It MUST require an explicit approved review associated with the referenced change (e.g., `-- migration-override: EXPAND_CONTRACT_EXCEPTION, reason: ..., review: PR-1234`).
- **F3: Crypto Fixture Updated Without a Full Sync.** Stage 4 MUST fail closed — a missing vector is a failure.

## 12. Acceptance Criteria
- All mandatory gates MUST execute for every PR. Caching MUST NOT bypass execution or result validation of any mandatory test gate.
- The deployment controller MUST verify the image signature and immutable digest BEFORE starting or routing traffic to the candidate deployment. Readiness MUST NOT be used as a substitute for artifact verification.
- Two simultaneous deploy triggers result in exactly one rollout proceeding.
- Every release containing an Expand migration MUST pass the rollback compatibility drill before production deployment. A rollback MUST never execute a schema downgrade. A rollback MUST be blocked when the target binary is incompatible with the current schema.
- Deployment stages MUST be release-triggered only and MUST NOT execute for ordinary pull requests unless explicitly configured as a staging deployment.

## 13. Testing Requirements (Meta: Testing the Pipeline Itself)
- **Rollback Drill:** The rollback compatibility drill MUST execute against a staging database whose schema has been advanced by the exact migration set included in the candidate release. The drill MUST verify the intended rollback target against this exact database schema state. The drill MUST verify that the previous binary can: start successfully, complete bootstrap, pass readiness, read and write all schema elements it depends upon, process representative authenticated requests, and operate against the expanded schema without migration downgrade.
- **Migration Linter Test:** Assert Stage 1 blocks forbidden statements without an approved override comment, and passes with a correctly formatted one.
- **Fixture Drift Test:** Modify the crypto test vector fixture (§5) in only one language's local copy, simulating a missed sync; assert Stage 4 fails rather than passing on 2-of-3 agreement.
- **Signature Verification Test:** Attempt to deploy an unsigned or tampered image directly to the Deployment Trigger; assert §7/§10 T2 rejects it before `/health/ready` is ever polled.
- **Single-Flight Deployment Test:** Assert that two simultaneous deploy triggers result in exactly one rollout proceeding, while the other queues or safely aborts, releasing locks correctly on terminal failure.

## 14. Implementation Notes
- The migration linter (§11 F2) can be a standalone static-analysis script scanning `.up.sql` files.

## 15. Future Compatibility
- **Automated Semantic Migration Checking:** A candidate future replacement for §11 F2's syntactic linter.

## 16. Deployment Profile: Railway
The canonical RFC remains platform-agnostic to preserve core architectural integrity. The initial production deployment profile is **Railway**.

Railway-specific implementation MUST satisfy:
- **Persistent Storage:** `/data` volume configuration.
- **Runtime Replica Count:** Exactly one application replica MUST be active. Horizontal scaling and multiple replicas MUST be disabled.
- **CI/CD Concurrency:** Deployment concurrency MUST independently enforce single-flight rollout execution.
- **Application Readiness:** Signaled via `/health/ready` API polling.
- **Secret File Contract:** The Railway deployment MUST provide file-backed secrets for every `*_FILE` configuration variable required by RFC-0012, strictly satisfying §7.
- **Immutable Deployment:** Build once, promote the exact immutable artifact digest to Railway; avoid abstracting the build process to the runtime platform.