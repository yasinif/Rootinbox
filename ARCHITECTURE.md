# Project Architecture Directive
This project is a Zero-Knowledge E2EE Messaging PWA named RootInbox.
All implementation MUST strictly follow the RFCs located in `docs/rfc/`.
Core constraints:
1. Single-Binary Go backend (CGO_ENABLED=0, pure Go SQLite `modernc.org/sqlite`). Module name: `rootinbox`.
2. No external DB (No Postgres/Redis). 
3. Clean Architecture (Domain -> UseCase -> Infrastructure -> Delivery).
4. Frontend is React PWA built with Vite and embedded in Go binary.
DO NOT deviate from RFC contracts. Treat RFCs as Frozen law.

## Source-of-Truth Precedence
When two project documents appear to conflict, the following precedence MUST apply:
1. Frozen RFC text
2. RFC-0001A cross-cutting contracts
3. ARCHITECTURE.md execution rules
4. Agent-generated implementation decisions

The Agent MUST NEVER resolve an RFC conflict by inventing behavior.
It MUST STOP and report the conflict to the user.

If two Frozen RFCs conflict, the Agent MUST NOT infer priority from RFC number,
creation order, or implementation phase. It MUST STOP and report the exact conflicting
sections to the user for resolution.

## RFC Integrity Rule
The Agent MUST NOT modify, rewrite, weaken, reorder, or silently normalize
any Frozen RFC.

If implementation requires an RFC change:
STOP and report the exact conflict.
Only the user may authorize an RFC revision.

## Ambiguity / Conflict Rule
If the Agent encounters:
- an RFC contradiction,
- an unspecified security-sensitive behavior,
- a missing required dependency contract,
- or an implementation decision that could alter a Frozen RFC,

the Agent MUST STOP and ask for explicit human resolution.

The Agent MUST NOT silently choose or invent a contract.

## Phase Scope Integrity
During a phase, the Agent MUST NOT create implementation code belonging to a later phase,
except for minimal compile-time interfaces, stubs, or contracts explicitly required by the current phase.

Any required forward interface MUST be reported before implementation and MUST NOT contain future business logic.

## Execution Master Plan (Phases)
The project MUST be built sequentially in the following phases. 
Forward references to later RFCs are normative constraints only. The Agent MUST NOT implement or partially implement a later RFC before its assigned phase. Such references MUST be respected when implementing the current phase, but execution remains phase-locked.
STRICT RULE FOR AI AGENT: You MUST only execute ONE phase at a time when explicitly prompted. After completing a phase and ensuring it compiles/builds successfully, STOP and report completion. DO NOT start the next phase until the user explicitly says "next phase" or "فاز بعدی".

Phase 1: Backend Foundation
- Read RFC-0001, RFC-0001A. Create dir structure, go.mod, Bootstrap lifecycle, SQLite pools, Migration runner, Domain interfaces, Graceful shutdown, basic HTTP server with Panic Recovery and Health Probe.

Phase 2: Database & Domain
- Read RFC-0002. Create Domain entities, SQL migration files, SQLite repositories, Hard Delete Cascade policy.

Phase 3: Backend Cryptography
- Read RFC-0003. Implement Argon2id, ECDH, HKDF, AES-GCM, AAD/IV encoding, Replay Window, Test Vectors.

Phase 4: Authentication & Sessions
- Read RFC-0004. Ed25519 Challenge-Response login, cookies, session management, WS ticket generation.

Phase 5: WebSocket Protocol
- Read RFC-0005. WS server, Read/Write Pumps, ACK flows, Offline queue, At-Least-Once delivery.

Phase 6: Sync & Vaults
- Read RFC-0006. REST pending sync APIs, Vault upload/atomicity, outbox logic.

Phase 7: Media Processing
- Read RFC-0007. Chunked upload/download, Quota management, GC, MCT tokens.

Phase 8: Voice & Video Calls
- Read RFC-0008. Call state machine, WS signaling, embedded STUN/TURN, glare arbitration.

Phase 9: Push Notifications
- Read RFC-0009. VAPID, Web Push, offline wake-up, ring buffer.

Phase 10: Security & Admin
- Read RFC-0011, RFC-0014. Rate limiting, security headers, Audit log, Admin API.

Phase 11: Frontend Foundation
- Read RFC-0010. React Vite setup, Crypto Web Worker, Service Worker, ESLint boundaries.

Phase 12: Frontend Integration
- Connect frontend to backend (Auth, WS chat, offline sync, media).

Phase 13: Deployment & CI/CD
- Read RFC-0012, RFC-0013. Dockerfile, embed frontend in Go, CI/CD pipeline, migration safety.

Phase 14: Testing & QA
- Read RFC-0015, RFC-0016. Load tests, Chaos tests, Security regression, Test vectors parity.

## Completion Rule
A phase is considered complete ONLY when:
1. All artifacts required by that phase are implemented.
2. All relevant tests/checks defined by the governing RFCs for that phase pass.
3. The project builds successfully with no errors.
4. No known RFC conflict, ambiguity, or unresolved implementation deviation remains.
5. The Agent reports exactly what was implemented, what was verified, and any non-blocking observations.
6. The Agent MUST then STOP and wait for explicit user authorization before continuing.

A successful compilation alone MUST NOT be treated as proof of phase completion.