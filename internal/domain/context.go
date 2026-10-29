package domain

import (
	"context"
	"net"
)

// traceIDKey is a private type for context value collision protection.
// RFC-0001A Section 3: Context keys MUST use dedicated private custom types.
type traceIDKey struct{}

// WithTraceID stores a TraceID in the context.
// RFC-0001A Section 3: ONLY request-scoped metadata may be stored in context.
func WithTraceID(ctx context.Context, traceID string) context.Context {
	return context.WithValue(ctx, traceIDKey{}, traceID)
}

// TraceIDFromContext retrieves the TraceID from the context.
// Returns an empty string if no TraceID is present.
func TraceIDFromContext(ctx context.Context) string {
	if v, ok := ctx.Value(traceIDKey{}).(string); ok {
		return v
	}
	return ""
}

// userIDKey is a private type for UserID context value collision protection.
// RFC-0001A §3: Context keys MUST use dedicated private custom types.
type userIDKey struct{}

// WithUserID stores a UserID in the context.
// RFC-0001A §3: ONLY request-scoped metadata may be stored in context.
func WithUserID(ctx context.Context, userID string) context.Context {
	return context.WithValue(ctx, userIDKey{}, userID)
}

// UserIDFromContext retrieves the authenticated UserID from the context.
func UserIDFromContext(ctx context.Context) (string, bool) {
	id, ok := ctx.Value(userIDKey{}).(string)
	return id, ok
}

// sessionIDKey is a private type for SessionID context value collision protection.
type sessionIDKey struct{}

// WithSessionID stores a SessionID in the context.
func WithSessionID(ctx context.Context, sessionID string) context.Context {
	return context.WithValue(ctx, sessionIDKey{}, sessionID)
}

// SessionIDFromContext retrieves the authenticated SessionID from the context.
func SessionIDFromContext(ctx context.Context) (string, bool) {
	id, ok := ctx.Value(sessionIDKey{}).(string)
	return id, ok
}

type clientIPKey struct{}

func WithClientIP(ctx context.Context, ip net.IP) context.Context {
	return context.WithValue(ctx, clientIPKey{}, ip)
}

func ClientIPFromContext(ctx context.Context) (net.IP, bool) {
	ip, ok := ctx.Value(clientIPKey{}).(net.IP)
	return ip, ok
}

type ipHashKey struct{}

func WithIPHash(ctx context.Context, h string) context.Context {
	return context.WithValue(ctx, ipHashKey{}, h)
}

func IPHashFromContext(ctx context.Context) (string, bool) {
	h, ok := ctx.Value(ipHashKey{}).(string)
	return h, ok
}

type routeClassKey struct{}

func WithRouteClass(ctx context.Context, c RouteClass) context.Context {
	return context.WithValue(ctx, routeClassKey{}, c)
}

func RouteClassFromContext(ctx context.Context) (RouteClass, bool) {
	c, ok := ctx.Value(routeClassKey{}).(RouteClass)
	return c, ok
}

type bodyLimitAppliedKey struct{}

func WithBodyLimitApplied(ctx context.Context) context.Context {
	return context.WithValue(ctx, bodyLimitAppliedKey{}, true)
}

func BodyLimitAppliedFromContext(ctx context.Context) bool {
	v, ok := ctx.Value(bodyLimitAppliedKey{}).(bool)
	return ok && v
}

type deviceLabelKey struct{}

func WithDeviceLabel(ctx context.Context, label string) context.Context {
	return context.WithValue(ctx, deviceLabelKey{}, label)
}

func DeviceLabelFromContext(ctx context.Context) (string, bool) {
	label, ok := ctx.Value(deviceLabelKey{}).(string)
	return label, ok
}
