# Phase 12B — Contract Verification Report

**Date:** 2026-09-11
**Verified by:** Executing agent (Phase 12B)
**Method:** Direct reading of Go source code in `internal/delivery/http/`, `internal/usecase/`, and `internal/domain/`.

---

## V-1: `token_hash` encoding in `/media/init`

**Status: DEVIATION FOUND — RESOLVED**

- **Plan assumed:** Base64(SHA256(Media_Token)) per RFC-0007 §7.1
- **Actual implementation:** `hex.EncodeToString(sha256.Sum256([]byte(mediaToken)))` — **lowercase hex**
  - Storage: `media_usecase.go:57` stores `tokenHash` as-is from JSON request body
  - Download auth: `media_usecase.go:390-391` computes `hex.EncodeToString(sha256.Sum256([]byte(mediaToken)))` and compares via `strings.EqualFold`
  - Domain comment: `domain/media.go:45` says "SHA-256(Media_Token), Base64-encoded" — **this comment is STALE**
- **Client action:** Use lowercase hex for `token_hash` in `/init` requests and `media_token` in `buildMediaMetadata`
- **Audit note:** RFC-0007 §7.1 says "Base64" but the implementation uses hex. The client follows the server (the server is the authority). This discrepancy is on the audit list for the RFC amendment window.

---

## V-2: `X-Chunk-Hash` header name and encoding

**Status: PASS**

- **Header name:** `X-Chunk-Hash` — confirmed at `media_handler.go:94`
- **Encoding:** Lowercase hex — `hex.EncodeToString(hash[:])` at `media_usecase.go:159`
- **Comparison:** Case-insensitive via `strings.EqualFold` at `media_usecase.go:160`
- **Body size enforcement:** Exactly `domain.ChunkCiphertextSize` (5,242,896) bytes — `media_usecase.go:147-150`

---

## V-3: Finalize endpoint field name and encoding

**Status: PASS**

- **Field name:** `file_manifest_hash` — `media_handler.go:120` struct tag `json:"file_manifest_hash"`
- **Encoding:** Lowercase hex — server recomputes `hex.EncodeToString(manifestHasher.Sum(nil))` at `media_usecase.go:343`
- **Comparison:** Case-insensitive via `strings.EqualFold` at `media_usecase.go:344`
- **Manifest computation:** `SHA256(concat of raw chunk hashes in index order)` — `media_usecase.go:290-337`, hashes decoded from hex via `hex.DecodeString` before feeding to hasher

---

## V-4: Download auth mechanism

**Status: PASS**

- **Auth:** MCT-only via `Authorization: Bearer <raw_token>` — `media_handler.go:159-164`
- **Token validation:** Server computes `SHA256(token)` as hex and compares against stored `TokenHash` — `media_usecase.go:390-399`
- **Response:** Raw `application/octet-stream` with `Content-Length` — `media_handler.go:185-188`
- **No session auth** on the download route (not wrapped in `sessionAuth`) — `router.go:100-101`

---

## V-5: Call signal envelope type strings

**Status: PASS**

- **Observed types:** `call.invite`, `call.accept`, `call.reject`, `call.ice`, `call.end`, `call.busy`, `call.renegotiate`
- **Envelope fields:** `call_id` (string), `signal_seq` (*uint64, omitempty) — `ws/handler.go:37-38`
- **`call.busy`:** `sender_id: ""`, `signal_seq: &0` (advisory, plaintext JSON payload) — `ws/call_handler.go:130-136`
- **Relay:** `sender_id` is set to `client.userID` on relay — `ws/call_handler.go:105`

---

## V-6: Server negative-acknowledgement behavior

**Status: PASS**

- **Observed:** Silent drop on error — `ws/call_handler.go:66-72` logs a warning and returns, never sends a `call.error` frame
- **Confirmed:** No `call.error` envelope type exists anywhere in the codebase
- **ADR-P8-3 stands:** Client depends entirely on timers

---

## V-7: TURN credential response shape

**Status: PASS**

- **Route:** `GET /api/v1/calls/turn-credentials` — `router.go:107-109`
- **Requires:** `identity_hash` query parameter — `call_handler.go:30-33`
- **Response:** Via `WriteSuccess(w, http.StatusOK, creds, nil)` — standard envelope `{"data":{...},"meta":null}`
- **Credential fields:** Determined by `callUC.GetTURNCredentials()` return — includes URLs, username, credential, TTL

---

## V-8: Pending call response shape

**Status: DEVIATION FOUND — RESOLVED**

- **Route:** `GET /api/v1/calls/pending` — `router.go:111-113`
- **Requires:** `identity_hash` query parameter — `call_handler.go:57-61`
- **Response:** `200` with `{call_id, caller_session_id, encrypted_offer, fingerprint_signature, expires_at}` — `call_handler.go:76-82`
- **Go `json` encoding:** `[]byte` fields (`encrypted_offer`, `fingerprint_signature`) are Base64 standard padded
- **No `204`:** On error or no pending call, a domain error is returned (not `204`). Client must treat errors gracefully as "no pending call"
- **Client action:** `getPendingCall()` returns `null` on any non-200 status

---

## V-9: Push subscribe request field names

**Status: DEVIATION FOUND — RESOLVED**

- **Plan assumed:** `p256dh` and `auth`
- **Actual struct:** `SubscribeRequest` at `push_handler.go:21-25`:
  - `endpoint` → `json:"endpoint"`
  - `p256dh_key` → `json:"p256dh_key"`
  - `auth_secret` → `json:"auth_secret"`
- **Unsubscribe:** Uses `endpoint` query parameter — `push_handler.go:69`
- **Client action:** Send `p256dh_key` and `auth_secret` (not `p256dh`/`auth`)

---

## V-10: Download route rate class

**Status: DEVIATION FOUND — NOTED (backend gap)**

- **`RouteClassMediaChunk`** is defined in `domain/route_class.go:21` with 30/min/user limit
- **`WithRouteClass`** is defined in `domain/context.go:81` but **NEVER CALLED** anywhere in the codebase
- **No route-class middleware** is applied to any media endpoint — `router.go:90-104` shows no class annotation
- **Fallback:** The rate limiter middleware (`rate_limit.go:26`) defaults to `RouteClassRestGeneral` (60/min) when no context class is present
- **Consequence:** ALL routes (including media upload, download, calls, push) share the same 60/min per-user limit
- **Client action:** Keep the 30/min client-side upload bucket as defense-in-depth, but the actual server limit is 60/min
- **Backend gap:** This is an unimplemented Phase 10 feature — the route classes were defined but never wired. NOT in scope for Phase 12B (out of authorization). Recorded for the final audit.

---

## V-11: Frontend embed path

**Status: PASS**

- **Embed path:** `web/dist` via `fs.Sub(web.DistFS, "dist")` — `frontend.go:16`
- **SPA fallback:** Non-API, non-asset paths serve `index.html` — `frontend.go:46-51`
- **`sw.js` caching:** `no-cache` — `frontend.go:55-57`
- **No impact** on Phase 12B frontend additions

---

## Summary

| Item | Status | Notes |
|------|--------|-------|
| V-1 | **DEVIATION** | `token_hash` is hex, not Base64. Client uses hex. RFC audit item. |
| V-2 | PASS | `X-Chunk-Hash`, lowercase hex |
| V-3 | PASS | `file_manifest_hash`, lowercase hex |
| V-4 | PASS | MCT-only Bearer auth |
| V-5 | PASS | Envelope types and fields confirmed |
| V-6 | PASS | Silent drops, no negative ack |
| V-7 | PASS | Standard response envelope, `identity_hash` required |
| V-8 | **DEVIATION** | No `204`, errors treated as null |
| V-9 | **DEVIATION** | Fields are `p256dh_key`/`auth_secret` |
| V-10 | **DEVIATION** | `media.chunk` class unused; all routes default to `rest.general` |
| V-11 | PASS | Embed path unchanged |

**Result: All 11 items RESOLVED. 4 deviations found, all with confirmed client-side mitigations. No blocking gaps.**
