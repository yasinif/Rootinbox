# ⚡ RFC-0015: Performance, Capacity Planning & Scalability Boundaries
**Status:** Frozen & Active Execution Directive
**Role:** Principal Performance Engineer

## 1. Objective
Define concrete performance budgets, admission control, and capacity-planning guidance for the single-instance architecture. This RFC optimizes *vertical* capacity and defines load-shedding behaviors to protect the system under duress. It explicitly defines *Benchmark Acceptance Targets* separate from *Production Capacity Guarantees*, ensuring the system degrades gracefully when approaching its physical limits.

## 2. Scope
- Performance budgets (SLOs) per protocol class: REST, WebSocket, Media, WebRTC Signaling.
- SQLite tuning: `cache_size` budgets, WAL hysteresis, and query-plan regression gating.
- Write-path backpressure: Admission Control queueing, reserved security lanes, scheduling fairness, and load-shedding.
- Vertical sizing profiles, runtime ceilings, and capacity envelope validation methodology.
- Observability and Prometheus metrics specific to performance degradation.

## 3. Out of Scope
- Horizontal scaling, clustering, or Sharding (Explicitly forbidden by RFC-0012).
- Application-level product rate limits (Deferred to RFC-0003/RFC-0011).
- TURN server capacity enforcement and telemetry (Delegated to external TURN service layer).

## 4. Hardware Profiles & Capacity Envelopes
The architecture MUST support distinct hardware tiers with defined evaluation boundaries:
- **Minimum Deployment Target:** 1 vCPU, 512MB RAM. The application MUST boot, pass readiness, and serve traffic without OOM kills.
- **Performance Reference Tier:** 2 vCPUs, 4GB RAM.
- **Benchmark Target Ceiling:** At the Performance Reference Tier, the initial validation target is **10,000 concurrent WebSocket connections**.
- **Runtime Configured Ceiling:** The maximum concurrent connection limit MUST be a deployment-configured value. This configured ceiling MUST NOT exceed the last validated benchmark ceiling unless a new benchmark validation is successfully performed.
- **Registered Identities:** The validated capacity envelope for registered identities MUST be reported directly from benchmark results and MUST NOT be inferred solely from concurrent connection capacity.

## 5. Performance Budgets (SLOs)

| Class | p50 | p95 | p99 | Throughput Benchmark Target (At Reference Tier) |
|---|---|---|---|---|
| REST general (`rest.general`) | 30ms | 100ms | 250ms | Instance-level: 500 RPS (Independent of per-user Rate Limits) |
| Auth challenge/verify | 50ms | 150ms | 300ms | Benchmark maximum sustainable authentication throughput under configured RFC-0003 rate limits. |
| WebSocket delivery latency | 50ms | 150ms | 400ms | Measured strictly from *server receipt of valid frame* to *successful enqueue into recipient Write Queue*. |
| Media chunk upload | 400ms | 1,200ms | 2,500ms | Benchmark target: 50 concurrent encrypted chunk writes/sec at 5 MiB per chunk. (This is a benchmark target, not a production guarantee). |
| Push fan-out (N=5 recipients) | 300ms | 800ms | 1,500ms | Fan-out is per-*recipient*. The benchmark MUST NOT assume multiple active sessions per identity (RFC-0003 Single-Session Rule). |
| WebRTC Signaling Latency | 20ms | 80ms | 200ms | Server-side routing delay only. Explicitly excludes ICE-gathering and client setup time. |

## 6. SQLite Performance Tuning

### 6.1. Memory & PRAGMA Budgets
- `cache_size` MUST be deterministically derived from the immutable startup memory limit and MUST NOT change during runtime. SQLite page-cache memory MUST be bounded by an explicit byte budget with a hard upper ceiling (e.g., `min(10% of memory limit, 256 MiB)`).
- `mmap_size` MAY be enabled on Reader connections if validated by the selected SQLite driver. It MUST NOT be enabled on Writer connections unless explicitly benchmarked and approved.
- **WAL Hysteresis:** WAL checkpointing MUST run as a dedicated background worker (`PRAGMA wal_checkpoint(PASSIVE)`). Checkpoint interval and WAL size thresholds MUST be configurable within the frozen configuration contract.

### 6.2. Query Plan Regression Test
- Every repository query over a table classified as unbounded-growing MUST have an execution-plan regression assertion (using `EXPLAIN QUERY PLAN`) preventing unintended full table `SCAN`s where an appropriate selective index exists.
- Trivial queries (e.g., single primary-key lookups) on bounded tables are exempt.
- **RFC-0013 Amendment A-0015-01:** This explicitly amends the RFC-0013 §4.2 Consolidated Canonical Test Matrix by adding: `Query Plan Regression Test | RFC-0015 §6.2 | Stage 3 | Blocking`. *(This record is formally mirrored in the RFC-0013 master document).*

## 7. Write-Path Admission Control & Backpressure
To prevent memory exhaustion or unbounded latency under heavy write demand, the system MUST enforce strict Admission Control *before* executing the Domain UseCase.

- **General Admission Queue:** Incoming normal write requests MUST enter a bounded Admission Control queue (Default capacity: `500` slots) before acquiring the SQLite single-writer transaction. 
- **Reserved Security Lane:** Security-critical state-changing operations (e.g., Admin Suspensions, Session Revocations) MUST use an independent, reserved admission lane (Default capacity: `16` slots). This reserved lane MUST NOT consume slots from the general admission queue. Both lanes ultimately contend for the same SQLite Writer and therefore remain subject to the Writer's physical transaction capacity.
- **Queue Immutability:** Both queues MUST use immutable startup configuration values and MUST NOT dynamically resize at runtime.
- **Writer Scheduling Fairness:** The Reserved Security Lane MUST receive priority over the General Admission Queue when both are non-empty. However, the scheduler MUST enforce a bounded fairness rule so that sustained security-lane traffic cannot indefinitely starve ordinary application writes. The bounded fairness parameter MUST be an immutable startup configuration value (Default: maximum `8` consecutive security operations while general writes are pending).
- **Admission Timeout:** The maximum wait time in the admission queue MUST be a configurable, immutable startup value (Default: `3000ms`).
- **Graceful Load Shedding:** Once the general queue is full or the strict timeout is reached, new requests MUST be rejected immediately with `HTTP 503 Service Unavailable`, Error Code `PERF_001`, and an explicit RFC-compliant `Retry-After` header (in seconds). Client backoff MUST align with RFC-0005.

## 8. Health Readiness Hysteresis
To prevent deployment flapping, `/health/ready` (RFC-0012) MUST implement strict hysteresis based on the General Admission Queue depth:
- Flip to `NOT READY`: Queue depth `> 80%` sustained for **30 seconds**.
- Flip back to `READY`: Queue depth `< 50%` sustained for **60 seconds**.

*Note: The queue-depth hysteresis is an additional readiness input and MUST NOT replace or bypass the existing RFC-0001/RFC-0012 readiness checks (e.g., database connectivity, disk space).*

## 9. Concurrency & Media Boundaries
- **WebSocket Ceiling:** The global connection counter MUST cleanly reject new upgrades past the *Runtime Configured Ceiling* with `HTTP 503`, incurring zero measurable latency degradation on already-established connections.
- **Media Strict Limits (Zero-Knowledge Constraint):** The maximum allowed *encrypted media chunk payload* is strictly **5 MiB (5,242,880 bytes)**. The HTTP request-body limit MUST be configured strictly above this value to accommodate multipart/protocol overhead. The server MUST NEVER process or evaluate decrypted plaintext chunk sizes, preserving the Zero-Knowledge constraint. 
- **Out of Memory (OOM) Prevention:** `GOMEMLIMIT` MUST be configured below the cgroup memory limit with an explicit safety reserve. The exact fraction (e.g., 80–85%) MUST be validated per deployment tier to account for OS overhead, goroutine stacks, and file buffers, triggering aggressive Go GC before OS-level OOM killers intervene.

## 10. Observability: Performance Metrics
The system MUST expose low-cardinality performance metrics using driver-neutral APIs (or PRAGMA introspection) to diagnose backpressure:
- `sqlite_writer_wait_seconds` (Histogram: time spent in Admission Queues)
- `sqlite_write_duration_seconds` (Histogram: actual transaction execution time)
- `sqlite_wal_size_bytes` (Gauge)
- `sqlite_checkpoint_total` / `sqlite_checkpoint_busy_total` (Counters)
- `ws_active_connections` (Gauge)
- `ws_rejected_total` (Counter)
- `write_load_shed_total` (Counter: count of 503 PERF_001 responses)
- `media_write_bytes_total` (Counter: strictly measuring *encrypted* bytes successfully committed to storage)
- `media_write_duration_seconds` (Histogram)

## 11. Acceptance Criteria
- A sustained synthetic write load exceeding the Writer's serialized throughput results in `503 PERF_001` responses with `Retry-After`, never unbounded memory growth.
- Admin Suspension requests MUST succeed through the reserved security-critical admission lane even when the general write queue is saturated, subject only to the SQLite Writer's physical transaction capacity and the bounded fairness rule.
- `/health/ready` demonstrates correct hysteresis, flipping states only after sustained queue depth breaches, and operates alongside standard DB checks.
- The `cache_size` byte budget respects the hard ceiling and is invariant at runtime.

## 12. Testing Requirements (Load Validation)
- **SLO Regression Test (Nightly):** The load test asserts against every row of §5's table. Latency SLOs MUST be evaluated *only* against successfully admitted requests. The test MUST separately assert the successful request rate, `PERF_001` load-shed rate, unexpected error rate, and memory/CPU saturation. A p99 regression alerts without blocking merges (per RFC-0013).
- **Backpressure Shed Test:** Drive sustained write load past the general admission bound; assert clean `503` responses, valid `Retry-After` formats, and verify operations in the reserved security lane still succeed.
- **WebSocket Spike Test:** Sustain 5,000 upgrade attempts/sec for **10 seconds**. This spike test MUST be executed both:
  1. From an idle baseline.
  2. While the instance is operating at its configured connection ceiling.
  It must successfully establish up to the ceiling and reject the rest cleanly without crashing.