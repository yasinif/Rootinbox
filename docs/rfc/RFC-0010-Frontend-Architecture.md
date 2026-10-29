# 🖥️ RFC-0010: Frontend Architecture, Crypto Isolation & Rendering Security
**Status:** Frozen (Execution Ready & Implementation Contract)
**Role:** Principal Frontend Architect

## 1. Objective
Establish the frontend's structural architecture as a direct mirror of the backend's Clean Architecture boundaries, isolate all key custody inside a dedicated Web Worker, define the Service Worker's strictly limited responsibilities, and codify the rendering-security mandates required because E2EE guarantees confidentiality from the server — not trustworthiness of content from a peer.

## 2. Scope
- Layered directory structure and CI-enforced dependency boundaries (Domain / UseCase / Infrastructure / Presentation).
- The Crypto Worker: exclusive logical key custody, WebCrypto IndexedDB ownership, and Crash Rehydration protocol with strict credential handling.
- Plaintext Lifecycle Contract (excluding Service Worker and persistent storage) and message-passing bridge.
- Service Worker scope: precaching, Cache Storage restrictions, and the Push handoff.
- Single-Binary frontend delivery via Go `embed.FS` and caching policies.
- Content Security Policy (Media, SVG explicit limits, and strict origin rules) and the No Third-Party CDN Rule.
- Rendering-security mandates against peer-injected content and bounded windowed virtualization.

## 3. Out of Scope
- Server-Side Rendering / React Server Components (see §16 — explicitly incompatible, not deferred).
- Visual design system, component library choice, accessibility audit criteria.
- Native mobile shells (Capacitor/React Native) — this RFC governs the PWA only.

## 4. Layered Frontend Architecture (Clean Architecture Mirror)

### 4.1. Directory Structure & Dependency Rules
    src/
      domain/            # TS interfaces & types. Zero framework dependencies.
      usecase/           # Business logic. MUST NOT import React or transport-specific types.
      infrastructure/
        crypto/          # Crypto Worker CLIENT (postMessage bridge) — not the Worker itself.
        persistence/     # Dexie repositories implementing domain interfaces.
        transport/
          rest/
          websocket/     # WS client, reconnect/backoff.
          webrtc/        # RTCPeerConnection wrapper.
          push/          # PushManager subscription wrapper.
      presentation/
        components/
        hooks/
        routes/
      workers/
        crypto.worker.ts
        sw.ts            # Service Worker entry (built separately).

- **Dependency Rule:** `domain` has zero external dependencies. `usecase` MUST NOT know about React, IndexedDB, or WebSocket types. `infrastructure` implements `domain` interfaces and MUST NOT be imported directly by `presentation`.
- **Enforcement:** The boundary MUST be enforced explicitly via `eslint-plugin-boundaries` (or equivalent) in CI, encoding the dependency graph as a lint rule rather than relying on convention.

### 4.2. Layer Responsibilities
- **Domain:** Mirrors the backend's Domain Entities as TypeScript types kept structurally identical where shapes overlap.
- **UseCase:** Orchestrates Infrastructure interfaces. Framework-agnostic and independently unit-testable.
- **Infrastructure:** The ONLY layer permitted to touch Dexie, `fetch`, `WebSocket`, `RTCPeerConnection`, or the Crypto Worker bridge.
- **Presentation:** React components and hooks. MUST access application state exclusively through UseCase-layer hooks — direct instantiation of an Infrastructure class inside a component is FORBIDDEN.

## 5. Crypto Isolation & Plaintext Lifecycle

### 5.1. Crypto Worker Boundary & Key Custody
- **Logical Custodian:** The Crypto Worker is the exclusive logical custodian of all application cryptographic keys.
- **IndexedDB Ownership:** Persisted non-extractable `CryptoKey`s required by RFC-0003 MAY reside in IndexedDB, but they MUST only be opened, referenced, and used by the Crypto Worker. The main thread MUST never receive raw key material or `CryptoKey` handles.
- **RAM Custody:** The ECDH Shared Secret Cache MUST be instantiated and retained exclusively inside the dedicated Crypto Worker's RAM.
- **Implementation:** The Worker MUST implement the identical WebCrypto-preferred, `libsodium-wrappers`-fallback priority order defined in RFC-0003.

### 5.2. Message-Passing Protocol
- All Worker calls MUST be correlated via a `request_id` (UUIDv4), reusing the identifier convention pervasive across REST idempotency and WS envelopes.
- Large buffers (notably fixed 5MB media chunks) MUST be passed as `Transferable` `ArrayBuffer`s, not structured-cloned, to avoid expensive memory copies across the thread boundary.

### 5.3. Plaintext Lifecycle Contract & Boundary Exclusions
- Decrypted plaintext MUST cross the Worker boundary only as the minimum data required for rendering or application logic.
- Decrypted application plaintext MUST NOT be persisted by any application layer in IndexedDB, Cache Storage, LocalStorage, session persistence, or any other persistent browser storage mechanism.
- Plaintext buffers MUST NOT be persisted by the Crypto Worker or logged.
- **Explicit Service Worker Exclusion:** The Service Worker MUST NEVER receive decrypted application plaintext, Identity Keys, Vault Keys, Session Private Keys, Shared Secrets, or Crypto Worker key handles.

### 5.4. Residual XSS Risk Acknowledgement
Worker isolation prevents an XSS attacker from directly reading raw key bytes, but it does **not** prevent a "confused deputy" attack: an attacker with script execution on the page can message the live Worker and request encryption/decryption using the victim's unlocked session. Worker isolation is defense-in-depth — the primary XSS defenses remain the CSP (§8) and rendering mandates (§9).

## 6. Service Worker Scope & Cache Policy

### 6.1. Precaching (App Shell Only)
The Service Worker's precache manifest is scoped exclusively to the built static assets — JS, CSS, fonts, manifest, icons.

### 6.2. Cache Storage Scope Restriction
- API responses (REST or WebSocket-derived data) MUST NEVER be intercepted or cached by the Service Worker's `fetch` handler.
- **Rule:** All `/api/*` routes MUST use a `NetworkOnly` runtime strategy. IndexedDB is the single source of truth for application data; a second SW cache layer for data is FORBIDDEN.

### 6.3. Push Event Handling
The Service Worker's `push` handler implements exactly the uniform wake behavior specified in RFC-0009 (`GET /api/v1/calls/pending` + REST Pending Sync trigger) — no additional logic is introduced here.

## 7. Single-Binary Frontend Delivery

### 7.1. Go `embed.FS` Integration
The Vite production build output (`dist/`) MUST be embedded into the Go binary via a `//go:embed dist` directive and served by a static file handler inside `delivery/http`, with an explicit SPA fallback. Deployment remains exactly one executable.

### 7.2. Build-Version Handoff & No-Store Policy
The Service Worker's precache manifest is versioned by build hash. The backend's `BuildHash` MUST be exposed via `GET /api/v1/version`. 
- **Strict Caching Rule:** `GET /api/v1/version` MUST explicitly return `Cache-Control: no-store`. This ensures the client can accurately detect a stale Service Worker against the live server and prompt a reload rather than silently running outdated code.

## 8. Content Security Policy

### 8.1. Directive Table
    default-src 'self'
    script-src 'self' 'wasm-unsafe-eval'
    style-src 'self'
    connect-src 'self'
    worker-src 'self'
    media-src 'self' blob:
    img-src 'self' blob: data:
    font-src 'self'
    object-src 'none'
    base-uri 'none'
    frame-ancestors 'none'
    form-action 'self'

- `'wasm-unsafe-eval'` is required solely to support the `libsodium-wrappers` WASM Fallback Priority path of RFC-0003.
- `connect-src` is strictly frozen to `'self'`. WebSocket and REST traffic MUST both utilize the same application origin, enforcing the single-binary deployment constraint.
- `media-src` is strictly frozen to `'self' blob:` for locally generated media/blob resources and decrypted media playback.

### 8.2. No Third-Party CDN Rule
All JavaScript, CSS, WASM, and font assets MUST be self-hosted and bundled at build time — no third-party `<script src>`, no Google Fonts links, no third-party analytics. This prevents leaking the user's IP/timing metadata on every page load.

## 9. Rendering Security Mandates

### 9.1. Peer-Injected Content Threat
End-to-end encryption guarantees confidentiality and integrity **from the server** — it says nothing about the trustworthiness of the plaintext itself. A malicious contact can craft message content intended to execute in the recipient's browser once decrypted.

### 9.2. Strict Rendering & SVG Restriction Rule
- `dangerouslySetInnerHTML` is FORBIDDEN anywhere in the message-rendering path. Default JSX text interpolation is the baseline.
- **Markdown / Rich Text:** The pipeline MUST either parse to a restricted AST rendered through explicit allowlisted React components, or sanitize via `DOMPurify` with a strict allowlist applied **after** decryption and **before** DOM insertion.
- Rendered links MUST carry `rel="noopener noreferrer"` and MUST NOT auto-navigate.
- **SVG Restriction:** SVG uploads MUST NEVER be rendered as active documents. They MUST be rendered strictly as passive `<img src="blob:...">`. SVG content MUST be served with an image-only MIME policy and MUST NOT be inserted as HTML, DOM nodes, documents, object URLs for navigation, or iframe/object content.

### 9.3. Message List Virtualization
Because Vault Recovery can reconstruct months of history into IndexedDB, conversation views MUST use bounded windowed virtualization. The specific virtualization library is an implementation detail. Rendering the full, unbounded message array into the DOM at once is FORBIDDEN.

## 10. State Management & Reactive Bindings
The Presentation layer subscribes to the UseCase layer through thin reactive hooks wrapping a store or observable. The specific state library is an implementation detail; the fixed RULE is the boundary itself — components consume UseCase-layer hooks only.

## 11. Security Considerations & Threat Model
- **T1: XSS-Based Key Exfiltration Attempt.** *Mitigation:* Crypto Worker isolation (§5) preventing direct raw key access.
- **T2: Peer-Injected Content XSS.** *Mitigation:* §9's strict rendering rule and passive SVG enforcement.
- **T3: Third-Party Script / Supply-Chain Compromise.** *Mitigation:* §8.2 self-hosting plus `script-src 'self'`.
- **T4: Stale Service Worker Vulnerability.** *Mitigation:* §7.2's `no-store` version check driving a forced-update prompt.

## 12. Failure Modes & Edge Cases
- **F1: Crypto Worker Crash & Rehydration.** The UseCase layer MUST treat a `request_id` correlation that neither resolves nor rejects within `10 seconds` as a Worker loss and re-instantiate a fresh Worker. 
  After Worker loss, the newly created Crypto Worker MUST rehydrate only the cryptographic state permitted by RFC-0003:
  1. Re-derive the Identity Key strictly from the canonical user credential material defined by RFC-0003. The credential material MUST be supplied to the Crypto Worker only through an authenticated initialization flow and MUST NOT be persisted by the application, Service Worker, or main-thread application state.
  2. Re-open the persisted non-extractable Session `CryptoKey` from IndexedDB.
  3. Reconstruct the Vault Key only when Vault access is required.
  4. Re-establish the Shared Secret Cache only after successful session validation.
  *Rule:* Vault Recovery MUST NOT be repeated unless the local IndexedDB state is missing, invalid, or explicitly requires recovery.
- **F2: IndexedDB Quota Exceeded.** The UseCase layer MUST catch `QuotaExceededError` explicitly and surface a storage-management prompt to the user — writes MUST NOT fail silently.
- **F3: Lint Boundary Violation.** A component directly importing an Infrastructure class MUST fail the CI gate outright.

## 13. Acceptance Criteria
- The entire compiled frontend is served by the single Go binary with zero external static hosting.
- A component that directly imports an Infrastructure class fails the CI lint gate.
- No `dangerouslySetInnerHTML` usage exists anywhere in the shipped bundle.
- Terminating the Crypto Worker mid-session triggers automatic Worker restart and cryptographic state rehydration without a full page reload or redundant Vault Recovery.
- A 10,000-message conversation scrolls without dropped frames under the virtualized list.
- Plaintext buffers are demonstrably isolated from persistent storage APIs.

## 14. Testing Requirements
- **Boundary Lint Test:** CI job asserting zero cross-layer import violations.
- **Worker Rehydration Test:** Force-kill the Worker thread mid-session; assert state rehydrates successfully from IDB without triggering a full network Vault Recovery sync.
- **Sanitization Fuzz Test:** Feed a corpus of known XSS payloads (including active SVGs) as decrypted message content in a headless browser; assert none execute.
- **Offline/IndexedDB Integration Test:** Re-run the Idempotency Rule tests mandated in RFC-0006 against the Dexie repository layer.

## 15. Implementation Notes
- React 18+, TypeScript in strict mode, Vite + `vite-plugin-pwa` (Workbox).
- `eslint-plugin-boundaries` configured to encode the dependency graph.
- Bounded windowed virtualization (e.g., `react-window` or `react-virtuoso`); `DOMPurify` if markdown rendering is enabled.

## 16. Future Compatibility
- **Hardware-Backed Key Custody (WebAuthn/Secure Enclave):** A candidate future replacement or supplement for the software Crypto Worker. Deferred due to non-trivial UX and account-recovery implications.
- **Server-Side Rendering / React Server Components:** NOT a future direction for this project — any server-rendered content would require server-side access to decryption keys, which is categorically incompatible with the Zero-Knowledge architecture.