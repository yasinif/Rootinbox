package ratelimit_test

import (
	"context"
	"testing"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/ratelimit"
)

// T-SEC-3: RateLimit (Token Bucket).
func TestLimiter(t *testing.T) {
	limiter := ratelimit.NewLimiter(1000)
	ctx := context.Background()
	ipHash := "ip1"
	routeClass := domain.RouteClass{
		Dimension: domain.DimensionIP,
		PerMinuteIP: 300, // 5 per second = 300 per minute
	}

	// 1st request should pass
	if !limiter.Allow(ctx, routeClass, ipHash, "") {
		t.Fatalf("expected 1st request to be allowed")
	}

	// 2nd request should pass
	if !limiter.Allow(ctx, routeClass, ipHash, "") {
		t.Fatalf("expected 2nd request to be allowed")
	}

	// Loop to exhaust the burst (which is PerMinuteIP = 300)
	for i := 0; i < 300; i++ {
		limiter.Allow(ctx, routeClass, ipHash, "")
	}

	// Now it should fail
	if limiter.Allow(ctx, routeClass, ipHash, "") {
		t.Fatalf("expected request to be blocked")
	}
}

func TestLimiter_RouteScopedIsolation(t *testing.T) {
	limiter := ratelimit.NewLimiter(1000)
	ctx := context.Background()
	userID := "user123"

	lowLimitClass := domain.RouteClass{
		Name:          "user.search",
		Dimension:     domain.DimensionUser,
		PerMinuteUser: 2,
	}
	generalClass := domain.RouteClass{
		Name:          "rest.general",
		Dimension:     domain.DimensionUser,
		PerMinuteUser: 600,
	}

	// Exhaust lowLimitClass
	limiter.Allow(ctx, lowLimitClass, "", userID)
	limiter.Allow(ctx, lowLimitClass, "", userID)
	if limiter.Allow(ctx, lowLimitClass, "", userID) {
		t.Fatalf("expected low-limit route to be blocked after burst")
	}

	// General class should still be allowed (not starved)
	if !limiter.Allow(ctx, generalClass, "", userID) {
		t.Fatalf("expected general route to be allowed and not starved by low-limit route")
	}
}

