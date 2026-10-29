# 🏛️ RFC-0001A: Cross-Cutting Contracts & Core Interfaces (FROZEN & APPROVED)
**Status:** Frozen & Active Execution Directive
**Role:** Principal Go Backend Engineer

## 1. Objective
Establish foundational contracts, cross-cutting interfaces, and server lifecycle hooks. Ensures deterministic testing, strict infrastructure isolation, idiomatic Go patterns, and production-grade resilience.

## 2. Deterministic Interfaces & Ownership (Domain Layer)
- **Interface Ownership Rule:** Interfaces belong to the consumer, not the implementation. All core interfaces MUST be defined in the Domain layer.
- **No Global Clocks/Generators:** UseCases MUST NOT call global functions like `time.Now()` or `uuid.New()`. 
- **Logger Interface:** UseCases MUST NOT depend on `slog.Logger` directly. Inject a domain `Logger` interface if logging is strictly required for business logic.

### 2.1. Domain Interfaces
type Clock interface {
    NowUnix() int64 // MUST always return UTC UNIX Epoch seconds
}

type UUIDGenerator interface {
    New() string // MUST strictly conform to RFC 4122 Version 4
}

type Logger interface {
    Info(msg string, args ...any)
    Error(msg string, args ...any)
}

## 3. The Context & TraceID Contract
- **Context Value Collision Protection:** Context keys MUST use dedicated private custom types (e.g., `type traceIDKey struct{}`).
- **Context Values Rule:** ONLY request-scoped metadata (TraceID, RequestID, UserID, Deadline) may be stored in `context.Context`. NEVER inject Config, Repositories, DB, Loggers, or Business Objects.
- **TraceID Propagation:** Outgoing HTTP requests to external services MUST propagate the `TraceID` via HTTP Headers.
- **Cancellation Propagation Contract:** EVERY blocking operation MUST observe `ctx.Done()`. Repositories MUST pass `context.Context` unchanged to every database operation.

## 4. Transaction, Repository & Error Wrapping Contracts
### 4.1. The Unit of Work (TransactionManager)
type TransactionManager interface {
    WithinTransaction(ctx context.Context, fn func(ctx context.Context) error) error
}

### 4.2. Repository Return Rule
Repositories MUST return ONLY Domain Entities. They MUST NOT leak DTOs, SQL Models, or Infrastructure Rows.

### 4.3. Error Wrapping Policy
- `infrastructure` MAY wrap low-level errors using `fmt.Errorf("...: %w", err)`.
- `usecase` MUST inspect and return ONLY standard Domain errors.
- `delivery` maps Domain errors to transport-specific responses.

## 5. Server Hardening & Lifecycle
### 5.1. Configuration Immutability Flow
- Load -> Default -> Validate -> **Freeze Contract** (No setters, no mutable pointers after initialization).

### 5.2. Bootstrap Rule & Failure Policy
- **Strict Dependency Rule:** The `bootstrap` package MUST be the ONLY package allowed to wire dependencies. **NO package may import `bootstrap`.**
- **Startup Failure Policy:** Any startup failure MUST abort the process immediately (Fail Fast). No partial states allowed.
- **Warmup Phase:** Health probes MUST be verified BEFORE the HTTP listener begins accepting traffic.

### 5.3. Background Worker Contract
Background processes (Queues, Schedulers) MUST implement a standard interface and be managed by Bootstrap:
type Worker interface {
    Start(ctx context.Context) error
}

### 5.4. HTTP Server Timeouts
Explicitly define: `ReadTimeout`, `WriteTimeout`, `IdleTimeout`, and `MaxHeaderBytes`.

### 5.5. Graceful Shutdown Sequence (30s Timeout)
Sequence: Stop HTTP -> Cancel Background Workers (`ctx.Cancel` & `WaitGroup.Wait()`) -> Close Writer DB -> Close Reader DB -> Flush Logger/Metrics -> Exit(0).

### 5.6. Migration Runner Idempotency
- Schema versions MUST be monotonic.
- MUST use `BEGIN EXCLUSIVE` (or `BEGIN IMMEDIATE`) in SQLite to strictly lock the database and prevent concurrent migration race conditions.

## 6. Observability & Error Hardening
- **Panic Boundary Rule:** Panics MUST NOT cross package boundaries. Infrastructure layer panics MUST be recovered and returned as standard errors.
- **Health Contract:** `/health/ready` MUST verify DB, Migrations, Config, Dependencies, AND that the **Application Version is successfully loaded**.
- **Logger Metadata:** The structured logger (`slog`) MUST include `Version`, `BuildHash`, `BuildTime`, `GoVersion`, and `ConfigSchemaVersion` at startup.