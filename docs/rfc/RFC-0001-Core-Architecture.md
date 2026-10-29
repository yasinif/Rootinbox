# 🏛️ RFC-0001: Core Architecture, Infrastructure, and Database (Final Execution Directive)
**Status:** Active Execution Directive
**Role:** Principal Go Backend Engineer

## 1. Objective
Scaffold the foundational Go backend for a Production-Grade, Self-Hosted, Zero-Knowledge E2EE Messaging PWA. This phase ONLY covers the robust directory structure, pure SQLite configuration, Observability, Bootstrap sequence, and Domain/Usecase abstractions. (Do NOT implement WebSocket, Cryptography, or Auth in this phase).

## 2. Directory Structure (Standard Go Layout)
Follow this strict structure:
cmd/
internal/
    bootstrap/       # Dependency Injection and Startup Lifecycle
    config/          # Config loading, validation, and defaults
    domain/          # Interfaces, Entities, and Error Models
    usecase/         # Business logic (No HTTP/DB knowledge)
    infrastructure/
        database/    # Connection pooling and setup
        repository/  # Implementations of Domain interfaces
        migrations/  # .sql up/down files & migration runner
        metrics/     # Prometheus registry setup
        logger/      # slog configuration
    delivery/
        http/        # REST Handlers
        middleware/  # Panic Recovery, Request Logger, etc.
pkg/                 # Publicly importable utilities (if any)

## 3. Core Architectural Constraints
- **The Context Rule:** EVERY public method in UseCases and Repositories MUST accept `context.Context` as its first parameter.
- **Dependency Injection:** NO global singletons. All dependencies must be explicitly wired in the `internal/bootstrap` package.
- **Configuration:** Configuration (`config.go`) is loaded once at startup and is **IMMUTABLE** during runtime.
- **Strict Boundaries:** `domain` has 0 external dependencies. `usecase` MUST NOT return HTTP types or know about `sqlx`. `infrastructure` MUST NOT call `usecase`.

## 4. Error Model & Observability
- **Standard Error Contract:** Define base errors in Domain (e.g., `SYS_500`, `SYS_001`, `DB_001`, `DB_002`, `CFG_001`). UseCases return these, Delivery maps them to HTTP statuses.
- **Panic Recovery Middleware:** MUST capture panics, preserve `TraceID`, log the stack trace internally, and return a sanitized `SYS_500` JSON. Never leak internals.
- **Structured Logging (`slog`):** Standardize fields: `TraceID`, `Method`, `Path`, `Status`, `Latency`, `RequestSize`, `ResponseSize`, `UserID`, `IPHash`.
- **Prometheus Metrics (`/api/v1/metrics`):**
  - `http_requests_total` & `http_request_in_flight`
  - `request_duration_seconds`
  - `db_wait_time_seconds` & `sqlite_busy_count`
- **Health Probes (`/health/ready`):** Must explicitly verify: Migrations Complete, Writer DB ping, Reader DB ping, and Disk Writable.

## 5. Database, Transactions & Migrations
- **Connection Pools (`sqlx`):**
  - `Writer DB`: `MaxOpenConns=1` (Strict single-writer).
  - `Reader DB`: `MaxOpenConns=4` to `8`.
- **PRAGMAs:** `WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `temp_store=MEMORY`, `busy_timeout=5000`.
- **Unit of Work Pattern:** Repositories MUST NOT manage transactions. Inject a `TransactionManager` or `UnitOfWork` interface into UseCases. ONLY atomic state transitions require a transaction.
- **Migrations:** Use explicit `000001_init.up.sql` and `.down.sql`. Build a dedicated Migration Runner.
- **Timestamps:** All dates/timestamps MUST be stored as `INTEGER` (UNIX Epoch Time).

## 6. Startup Lifecycle (Bootstrap Sequence)
The `main.go` / `bootstrap` must strictly follow this sequential order:
1. Load configuration
2. Validate configuration
3. Initialize logger
4. Initialize Prometheus registry
5. Open SQLite reader/writer pools
6. Apply SQLite PRAGMAs
7. Execute pending SQL migrations
8. Verify health readiness
9. Register HTTP routes & middlewares
10. Start HTTP server gracefully

## 7. Testing Strategy
- **Unit Tests:** For Domain and UseCases using interface mocks.
- **Integration Tests:** For Infrastructure (SQLite repositories). MUST NOT touch the production DB. Use `t.TempDir()`, initialize a fresh SQLite DB, run tests, and discard.
- **Execution Flags:** All code MUST pass `go test -race` (Concurrency safety) and `go test -shuffle=on` (Test order independence).