# 🏛️ RFC-0002: Domain Models & REST API Contracts
**Status:** Frozen & Active Execution Directive
**Role:** Principal Software Architect / API Designer

## 1. Objective
Define the core Domain Entities (Go structs), SQLite database schema contracts, standard JSON API envelopes, and deterministic cursor-based pagination. This ensures a strict Zero-Knowledge data model, consistent API responses, and prevents PII leakage and Identity Enumeration.

## 2. Scope
- Core Domain Entities & Structs: `User`, `Conversation`, `Participant`.
- SQLite Schema & Foreign Key cascading policies.
- Standard REST API Request/Response JSON wrappers.
- Deterministic Cursor-based Pagination API contracts.
- Strict Domain Deletion Policy.

## 3. Out of Scope
- Ephemeral objects (`Session`, `Vault`, `Transient Message`) defined in RFCs 0004, 0005, and 0006.

## 4. Requirements & Specifications

### 4.1. Domain Entities (Go Struct Contracts)
The Domain layer MUST define the following structs exactly. No database/SQL tags are allowed here (Clean Architecture).

    type UserStatus string
    const (
        UserStatusActive    UserStatus = "ACTIVE"
        UserStatusSuspended UserStatus = "SUSPENDED"
        UserStatusDeleted   UserStatus = "DELETED"
    )

    type ConversationType string
    const (
        ConvTypeDirect ConversationType = "DIRECT"
        ConvTypeGroup  ConversationType = "GROUP"
        ConvTypeSelf   ConversationType = "SELF"
    )

    type ParticipantRole string
    const (
        RoleOwner  ParticipantRole = "OWNER"
        RoleAdmin  ParticipantRole = "ADMIN"
        RoleMember ParticipantRole = "MEMBER"
    )

    type User struct {
        ID           string     // Canonical UUIDv4
        IdentityHash string     // Deterministic Public-Key Hash (SHA-256) for discovery
        PublicKey    string     // Ed25519 PK
        Status       UserStatus
        CreatedAt    int64      // Unix Epoch UTC
    }

    type Conversation struct {
        ID        string // Canonical UUIDv4
        Type      ConversationType
        CreatedAt int64
    }

    type Participant struct {
        ConversationID string
        UserID         string
        Role           ParticipantRole
        JoinedAt       int64
    }

### 4.2. Core Database Schema (SQLite Contracts)
- **UUID Format Rule:** All UUIDs MUST be stored as canonical lowercase strings (RFC4122 Version 4), e.g., `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`.
- **Zero-Knowledge Rule:** NO columns for `email` or `phone`. The `username` column (Amendment RFC-0002-A) is an explicit opt-in public identifier and does NOT violate this rule.

- **Table `users`**
  - `id` (TEXT PRIMARY KEY)
  - `identity_hash` (TEXT UNIQUE)
  - `public_key` (TEXT)
  - `username` (TEXT UNIQUE, NULLABLE) — Amendment RFC-0002-A: Opt-in public identifier. Lowercase, alphanumeric + underscore, 3–32 chars.
  - `status` (TEXT) - Default 'ACTIVE'
  - `created_at` (INTEGER)

- **Table `conversations`**
  - `id` (TEXT PRIMARY KEY)
  - `type` (TEXT)
  - `created_at` (INTEGER)

- **Table `participants`**
  - `conversation_id` (TEXT, FK -> conversations.id ON DELETE CASCADE)
  - `user_id` (TEXT, FK -> users.id ON DELETE CASCADE)
  - `role` (TEXT)
  - `joined_at` (INTEGER)
  - **Constraint:** PRIMARY KEY (conversation_id, user_id)

### 4.3. Domain Deletion Policy (Hard Delete Cascade)
Upon a user requesting account deletion, the system MUST execute the following transaction strictly in this order:
1. `DELETE FROM users WHERE id = ?` (Triggers cascade for `participants`).
2. Delete all orphaned `conversations` where `count(participants) == 0`.
3. Hard delete all `sessions` for the `user_id`.
4. Hard delete all `vaults` for the `user_id`.

### 4.4. API Response Envelopes (JSON Contracts)
All REST endpoints MUST wrap responses. The `meta` object is MANDATORY (returns `{}` if empty).

**Success Response Envelope (2xx):**
    {
      "data": { ... }, 
      "meta": { ... }
    }

**Error Response Envelope (4xx, 5xx):**
    {
      "error": {
        "code": "ERR_CODE",
        "message": "Localized client-safe message. Internal states/logs MUST NOT be exposed."
      }
    }

### 4.5. Cursor-Based Pagination Contract
Traditional `OFFSET` / `LIMIT` pagination is FORBIDDEN.
- **Cursor Format:** `Base64URL(last_created_at + "_" + last_uuid)` to guarantee stable temporal sorting.
- **Response `meta` object:**
    "meta": {
      "pagination": {
        "next_cursor": "Base64URL(...)", // Null if end of list
        "has_more": true
      }
    }

## 5. Security Considerations & Threat Model
- **T1: Identity Enumeration via Discovery:** Attackers iterating `/users/:hash` to map the userbase. 
  - *Mitigation:* The Discovery endpoint MUST require strict Authentication (Valid Session). It is subjected to a strict Rate Limit (e.g., max 10 lookups per minute).
- **T2: Data Leakage via Error Messages:** DB stack traces leaking.
  - *Mitigation:* The `Error Wrapping Policy` strictly sanitizes all errors into the localized `Error Response Envelope`.
- **T3: Username Enumeration via Search (Amendment RFC-0002-A):** Attackers brute-forcing `/api/v1/users/search` to discover registered usernames.
  - *Mitigation:* The Search endpoint MUST require strict Authentication (Valid Session). Rate-limited at 10 requests per minute per user. Results return ONLY `user_id`, `username`, and `identity_hash` — never status, public key, or session data.

## 6. Failure Modes & Edge Cases
- **F1: Malformed Cursor Injection:** Attacker injects SQL syntax into `cursor`.
  - *Mitigation:* The `Base64URL` cursor MUST be explicitly decoded and structurally validated (Splitting by `_`, checking integer and UUID regex) before querying.

## 7. Acceptance Criteria
- A user account can be created and queried using ONLY cryptographic hashes.
- Deleting a user perfectly cleans up the entire database footprint via Cascades and explicit deletes.
- The Domain Structs contain zero JSON or DB tags (Clean Architecture compliance).

## 7A. Amendment RFC-0002-A: Username Registry

**Status:** Authorized Amendment — Added by project owner.

### 7A.1. Purpose
Allow users to set an opt-in public `username` for discoverability via search. The Zero-Knowledge rule (no email, no phone) remains fully intact — a username is a voluntary, explicit public identifier chosen by the user.

### 7A.2. Domain Entity Extension

    type User struct {
        ID           string      // Canonical UUIDv4
        IdentityHash string      // Deterministic Public-Key Hash (SHA-256) for discovery
        PublicKey    string      // Ed25519 PK
        Username     *string     // Amendment RFC-0002-A: Opt-in public identifier (nullable)
        Status       UserStatus
        CreatedAt    int64       // Unix Epoch UTC
    }

### 7A.3. Schema Extension
- **Column `username`** on table `users`: `TEXT UNIQUE` (nullable). Migration adds the column with a UNIQUE index.
- **Validation Rules:**
  - Lowercase only (stored and compared as lowercase).
  - Allowed characters: `[a-z0-9_]`.
  - Length: 3–32 characters.
  - Server-side validation MUST reject any username failing these rules.

### 7A.4. Search Endpoint

    GET /api/v1/users/search?q={query}

- **Authentication:** Required (Valid Session).
- **Rate Limit:** 10 requests per minute per user (`RouteClassUserSearch`).
- **Query:** Minimum 2 characters. Performs prefix match on `username` column (`LIKE query%`).
- **Response (200):**

      {
        "data": [
          { "user_id": "...", "username": "...", "identity_hash": "..." }
        ],
        "meta": {}
      }

- **Max Results:** 20 per request. No cursor pagination for search (simple limit).
- **Privacy:** Results include ONLY `user_id`, `username`, and `identity_hash`. NEVER include `public_key`, `status`, or session information.

### 7A.5. Username Update Endpoint

    PUT /api/v1/users/me/username

- **Authentication:** Required (Valid Session).
- **Request Body:** `{ "username": "desired_username" }` or `{ "username": null }` to clear.
- **Response (200):** `{ "data": { "username": "confirmed_username" }, "meta": {} }`
- **Conflict (409):** Username already taken.
- **Validation Error (400):** Invalid format (length, characters).

### 7A.6. Acceptance Criteria
- A user can set, change, and clear their username.
- Usernames are globally unique and case-insensitive (stored lowercase).
- Search returns only active users with matching usernames.
- The search endpoint is rate-limited at 10/min per user.

## 8. Testing Requirements
- **Envelope Test:** E2E HTTP tests MUST fail if `meta` is missing or `data` is not wrapped.
- **Cascade Test:** Integration tests MUST assert that orphaned conversations are successfully deleted when a user is deleted.
- **Cursor Stability Test:** Inserting a new record concurrently MUST NOT cause skipped items during cursor pagination.
- **Username Uniqueness Test (RFC-0002-A):** Concurrent username claims MUST result in exactly one winner; the loser receives 409.
- **Username Search Test (RFC-0002-A):** Search MUST return only active users with matching username prefix, limited to 20 results.