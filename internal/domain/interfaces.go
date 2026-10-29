package domain

// Clock provides deterministic time access.
// RFC-0001A Section 2.1: UseCases MUST NOT call time.Now() directly.
type Clock interface {
	// NowUnix MUST always return UTC UNIX Epoch seconds.
	NowUnix() int64
}

// UUIDGenerator provides deterministic UUID generation.
// RFC-0001A Section 2.1: UseCases MUST NOT call uuid.New() directly.
type UUIDGenerator interface {
	// New MUST strictly conform to RFC 4122 Version 4.
	New() string
}

// Logger provides domain-layer logging.
// RFC-0001A Section 2.1: UseCases MUST NOT depend on slog.Logger directly.
// Inject a domain Logger interface if logging is strictly required for business logic.
type Logger interface {
	Info(msg string, args ...any)
	Error(msg string, args ...any)
}
