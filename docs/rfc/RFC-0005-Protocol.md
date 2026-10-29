# 📡 RFC-0005: WebSocket Protocol, Envelope Routing & Delivery Guarantees
**Status:** Frozen (Execution Ready & Implementation Contract)
**Role:** Principal Network Engineer & Distributed Systems Architect

## 1. Objective
Establish a highly concurrent, idempotent WebSocket protocol for real-time E2EE message delivery. Define strict JSON envelope structures, precise Ping/Pong keep-alive cycles, At-Least-Once delivery guarantees via 2-Step ACK, and backend concurrency mandates for a Single-Binary architecture.

## 2. Scope
- Connection State Machine and Auth Ticket verification.
- JSON Envelope Schema and 7.5MB Size Limits.
- Upstream and Downstream ACK flows with cryptographic sequence validation.
- Idempotency handling strictly via SQLite constraints (No external dependencies).
- Atomic Routing Decisions (Live Delivery vs. Queueing).
- Keep-Alive parameters and Concurrent Write protection in Go.

## 3. Out of Scope
- WebRTC signaling payloads (Deferred to RFC-0008).
- End-to-End Cryptographic definitions (Strictly inherit from RFC-0003).

## 4. Connection Lifecycle & Authentication Bridge

### 4.1. Handshake & Ticket Consumption
1. **Connection Establishment:** The client opens a `wss://` connection.
2. **Auth Window:** The server strictly waits a maximum of `5000ms` for the first frame.
3. **Frame 0 (Auth):** The client MUST send the ticket obtained via RFC-0004:

        {
          "v": 1,
          "type": "auth",
          "ticket": "Base64URL(Ticket_String)",
          "request_id": "UUIDv4_String"
        }

4. **Validation:** The server consumes the ticket. If valid, the connection state transitions to `AUTHENTICATED`. If invalid or the timer expires, the server MUST instantly close the socket with status `1008 Policy Violation`.

### 4.2. Post-Auth Flush (Offline Queue Delivery)
- Immediately upon transitioning to `AUTHENTICATED`, the server MUST query the SQLite `messages` table for any pending messages for this user and begin pushing them Downstream.

## 5. Wire Format & Envelope Schema

### 5.1. The JSON Envelope
All frames MUST conform to this exact JSON schema. The envelope acts solely as a routing mechanism; the server has zero knowledge of the encrypted payload contents.
- **Routing Note:** The recipient identifier is explicitly named `routing_id` (rather than recipient_hash) to decouple transport metadata from the underlying cryptographic identity layer.

        {
          "v": 1,
          "type": "chat.msg",
          "request_id": "UUIDv4_String",
          "routing_id": "Base64URL(RoutingIdentifier)",
          "payload": "Base64(Ciphertext_From_RFC0003)"
        }

### 5.2. Sizing Constraints
- **Server Read Limit:** The backend WebSocket reader MUST explicitly enforce a strict maximum frame size limit of `7,500,000 bytes` (7.5 MB). This safely accommodates the 5MB binary ciphertext limit from RFC-0003, plus Base64 expansion overhead (~33%), plus envelope JSON growth, preventing memory exhaustion attacks.

## 6. Delivery Guarantees (At-Least-Once & Idempotency)

### 6.1. Upstream Flow & SQLite Idempotency
- **Single-Binary Rule:** The architecture MUST NOT depend on external infrastructure like Redis for idempotency.
1. **Push:** Client sends `chat.msg` with a unique `request_id` (`client_uuid`).
2. **Primary Idempotency (Source of Truth):** The server relies on the SQLite `PRIMARY KEY (client_uuid)` constraint.
3. **Secondary Idempotency (Optimization):** An in-memory concurrent LRU TTL map MAY be used strictly as a fast-path optimization to drop duplicates before hitting the database.
4. **Server ACK:** Server replies to the sender:

        {
          "v": 1,
          "type": "ack.server",
          "request_id": "UUIDv4_String"
        }

### 6.2. Atomic Delivery Decision (Live Routing Race Condition)
To prevent race conditions where a recipient disconnects exactly as a message arrives:
- **Rule:** The Delivery Decision MUST be atomic.
- The server MUST either:
  1. Successfully push the message to the authenticated recipient's Write Queue (Live Delivery).
  2. Successfully enqueue the message into the SQLite `messages` table.
- A message MUST NEVER exist in both states simultaneously, and MUST NEVER be dropped.

### 6.3. Downstream Flow & 2-Step ACK
1. **Push:** Server pushes a message to the recipient.
2. **Client Persistence:** The recipient client decrypts the payload, persists it to `IndexedDB`, and ONLY THEN generates the ACK.
3. **Secure Client ACK:** The client MUST include the cryptographic sequence number to prove processing.

        {
          "v": 1,
          "type": "ack.client",
          "request_id": "UUIDv4_String",
          "sequence_number": 42
        }

4. **Server Validation & Hard Delete:** The server MUST validate that the `request_id` belongs to a message pending delivery for that specific authenticated session. Upon validation, the server executes a `HARD DELETE` of that specific row from the SQLite database.

## 7. Transient Queue Database Contract (Sync with RFC-0001)
The server MUST store only the absolute minimum routing metadata required for delivery.
- **Zero-Knowledge Mandate:** The server MUST NOT persist plaintext JSON envelopes, filenames, MIME types, or cryptographic headers outside the encrypted payload.
- **Storage Target:** Storage MUST use the exact `messages` table defined in RFC-0001.

**Schema (`messages` table):**
- `client_uuid` (TEXT PRIMARY KEY - UUIDv4)
- `sender_id` (INTEGER)
- `receiver_id` (INTEGER)
- `encrypted_payload` (BLOB - strictly opaque ciphertext)
- `sequence_number` (INTEGER)
- `created_at` (INTEGER)

## 8. Keep-Alive & Dead Connection Detection
1. **Ping Interval:** The server MUST send a standard `Ping` frame exactly every `30 seconds`.
2. **Pong Deadline:** The server MUST set a read deadline of `45 seconds`. If no Pong/data is received, the server MUST forcefully close the TCP connection and mark the user offline.
3. **Client-Side Timeout:** If the client receives no Ping/data for `45 seconds`, it MUST consider the connection dead, close the socket, and initiate a reconnect backoff loop.

## 9. Backend Implementation Mandates (Concurrency Safety)
- **Goroutine Isolation (The Pump Pattern):** WebSocket libraries (e.g., `gorilla/websocket`) panic on concurrent writes. The server MUST enforce strict separation:
  - **Read Pump:** A single dedicated Goroutine per connection that only reads frames.
  - **Write Pump:** A single dedicated Goroutine per connection that reads from a buffered Go `channel` and writes to the socket.
- The system MUST NEVER directly invoke the socket's write method from HTTP handlers or event buses; all outbound data MUST be passed to the Write Pump channel.