package domain

import "context"

// Worker represents a background process managed by Bootstrap.
// RFC-0001A Section 5.3: Background processes (Queues, Schedulers) MUST
// implement this interface and be managed by Bootstrap.
type Worker interface {
	// Start begins the worker's processing loop.
	// It MUST observe ctx.Done() for cancellation.
	Start(ctx context.Context) error
}
