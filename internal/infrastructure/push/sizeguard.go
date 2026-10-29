package push

import (
	"bytes"
	"fmt"
	"io"
	"net/http"

	"rootinbox/internal/domain"
)

// SizeGuardRoundTripper enforces RFC-0009 §5.2 Ciphertext Determinism.
// This is a correctness invariant, not defense-in-depth. If a library upgrade
// changes the framing, this guard fails loudly instead of silently reopening
// the traffic-analysis channel.
type SizeGuardRoundTripper struct {
	Base http.RoundTripper
}

func (rt *SizeGuardRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Body == nil {
		return nil, domain.NewDomainError(domain.ErrPush005, "web push request has no body", nil)
	}

	// Read the entire body to measure it.
	bodyBytes, err := io.ReadAll(req.Body)
	if err != nil {
		return nil, err
	}
	_ = req.Body.Close()

	expectedLen := domain.WebPushRecordSize + 86
	if len(bodyBytes) != expectedLen {
		return nil, domain.NewDomainError(domain.ErrPush005, fmt.Sprintf("web push body length %d != %d", len(bodyBytes), expectedLen), nil)
	}

	// Restore the body for the actual transport.
	req.Body = io.NopCloser(bytes.NewReader(bodyBytes))

	base := rt.Base
	if base == nil {
		base = http.DefaultTransport
	}

	return base.RoundTrip(req)
}
