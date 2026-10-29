package http

import (
	"context"
	"log/slog"
	"net/http"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"rootinbox/internal/config"
	"rootinbox/internal/delivery/middleware"
	"rootinbox/internal/delivery/ws"
	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/metrics"
)

// RouterDeps holds all dependencies needed to register HTTP routes.
type RouterDeps struct {
	Logger              *slog.Logger
	HealthChecker       *HealthChecker
	Registry            *prometheus.Registry
	Metrics             *metrics.Metrics
	AuthHandler         *AuthHandler
	SyncHandler         *SyncHandler
	VaultHandler        *VaultHandler
	MediaHandler        *MediaHandler
	CallHandler         *CallHandler
	PushHandler         *PushHandler
	AdminHandler        *AdminHandler
	DirectoryHandler    *DirectoryHandler
	ConversationHandler *ConversationHandler
	UserHandler         *UserHandler
	SessionRepo         domain.SessionRepository
	WSHandler           *ws.Handler
	Cfg                 *config.Config
	RateLimiter         middleware.RateLimiter
	IPBlocks            middleware.IPBlockCache
	Auditor             domain.SecurityAuditor
	AuthFailCoalesce    interface {
		ShouldEmit(context.Context, string) bool
	}
}

// NewRouter creates and configures the HTTP router with all routes and middleware.
// RFC-0001 Section 6 Step 9: Register HTTP routes & middlewares.
func NewRouter(deps RouterDeps) http.Handler {
	mux := http.NewServeMux()

	// RFC-0001 Section 4: Health Probes (/health/ready).
	mux.HandleFunc("GET /health/ready", deps.HealthChecker.HandleReady())

	// RFC-0001 Section 4: Prometheus Metrics (/api/v1/metrics).
	mux.Handle("GET /api/v1/metrics", promhttp.HandlerFor(deps.Registry, promhttp.HandlerOpts{}))

	// RFC-0004 §5.1: Registration endpoint (public).
	mux.HandleFunc("POST /api/v1/auth/register", deps.AuthHandler.HandleRegister())

	// RFC-0004 §5.2: Challenge endpoint (public).
	mux.HandleFunc("POST /api/v1/auth/challenge", deps.AuthHandler.HandleChallenge())

	// RFC-0004 §5.3: Verify endpoint (public).
	mux.HandleFunc("POST /api/v1/auth/verify", deps.AuthHandler.HandleVerify())

	// --- Authenticated endpoints (SessionAuth middleware) ---
	sessionAuth := middleware.SessionAuth(deps.SessionRepo, deps.Logger)
	optionalSessionAuth := middleware.OptionalSessionAuth(deps.SessionRepo, deps.Logger)

	// RFC-0004 §7.3: WebSocket ticket endpoint.
	mux.Handle("GET /api/v1/auth/ws-ticket", sessionAuth(
		http.HandlerFunc(deps.AuthHandler.HandleWSTicket()),
	))

	// Active Sessions management.
	mux.Handle("GET /api/v1/auth/sessions", sessionAuth(
		http.HandlerFunc(deps.AuthHandler.HandleListSessions()),
	))
	mux.Handle("DELETE /api/v1/auth/sessions/{id}", sessionAuth(
		http.HandlerFunc(deps.AuthHandler.HandleTerminateSession()),
	))
	mux.Handle("POST /api/v1/auth/sessions/terminate-others", sessionAuth(
		http.HandlerFunc(deps.AuthHandler.HandleTerminateOtherSessions()),
	))

	// RFC-0006 §4.2: REST pending sync.
	mux.Handle("GET /api/v1/messages/pending", sessionAuth(
		http.HandlerFunc(deps.SyncHandler.HandleGetPending()),
	))
	mux.Handle("POST /api/v1/messages/ack", sessionAuth(
		http.HandlerFunc(deps.SyncHandler.HandleAcknowledge()),
	))

	// Delivery ACK catch-up endpoint for offline senders & multi-device synchronization
	mux.Handle("GET /api/v1/messages/delivery-acks", sessionAuth(
		http.HandlerFunc(deps.SyncHandler.HandleGetDeliveryAcks()),
	))

	// RFC-0006 §4.3: Vault endpoints.
	mux.Handle("PUT /api/v1/vaults/{month_year}", sessionAuth(
		http.HandlerFunc(deps.VaultHandler.HandleUpload()),
	))
	mux.Handle("GET /api/v1/vaults/{month_year}", sessionAuth(
		http.HandlerFunc(deps.VaultHandler.HandleDownload()),
	))
	mux.Handle("GET /api/v1/vaults", sessionAuth(
		http.HandlerFunc(deps.VaultHandler.HandleList()),
	))

	// RFC-0007: Media endpoints.
	mux.Handle("POST /api/v1/media/init", sessionAuth(
		http.HandlerFunc(deps.MediaHandler.HandleInit()),
	))
	mux.Handle("PUT /api/v1/media/upload/{file_id}/{chunk_index}", sessionAuth(
		http.HandlerFunc(deps.MediaHandler.HandleUploadChunk()),
	))
	mux.Handle("POST /api/v1/media/finalize/{file_id}", sessionAuth(
		http.HandlerFunc(deps.MediaHandler.HandleFinalize()),
	))
	// Download uses MCT Bearer auth (not session middleware).
	mux.HandleFunc("GET /api/v1/media/download/{file_id}/{chunk_index}",
		deps.MediaHandler.HandleDownloadChunk())
	// Delete supports both session and MCT auth.
	mux.Handle("DELETE /api/v1/media/{file_id}", optionalSessionAuth(
		http.HandlerFunc(deps.MediaHandler.HandleDelete()),
	))

	// RFC-0008 §5.2: TURN credential issuance.
	mux.Handle("GET /api/v1/calls/turn-credentials", sessionAuth(
		http.HandlerFunc(deps.CallHandler.HandleTURNCredentials()),
	))
	// RFC-0009 §7.3: Fetch pending call invite
	mux.Handle("GET /api/v1/calls/pending", sessionAuth(
		http.HandlerFunc(deps.CallHandler.HandlePendingCall()),
	))
	// Fetch missed calls that occurred while offline
	mux.Handle("GET /api/v1/calls/missed", sessionAuth(
		http.HandlerFunc(deps.CallHandler.HandleMissedCalls()),
	))

	// RFC-0009 §6.2: Web Push registration endpoints.
	mux.Handle("POST /api/v1/push/subscribe", sessionAuth(
		http.HandlerFunc(deps.PushHandler.HandleSubscribe()),
	))
	mux.Handle("DELETE /api/v1/push/subscribe", sessionAuth(
		http.HandlerFunc(deps.PushHandler.HandleUnsubscribe()),
	))
	// Phase 12B §11.5: VAPID public key endpoint (Flag A / Option A1).
	mux.Handle("GET /api/v1/push/vapid-public-key", sessionAuth(
		http.HandlerFunc(deps.PushHandler.HandleVapidPublicKey()),
	))

	// RFC-0005 §4.1: WebSocket upgrade endpoint.
	// Auth is handled inside the WS handler via ticket consumption, not middleware.
	mux.Handle("GET /api/v1/ws", deps.WSHandler)

	// Phase 12 / Task 0.5: Directory lookup endpoint.
	// GET /api/v1/directory/{identity_hash} — peer discovery (RouteClassDiscovery 10/min).
	mux.Handle("GET /api/v1/directory/{identity_hash}", sessionAuth(
		middleware.WithRouteClass(domain.RouteClassDiscovery)(
			middleware.RateLimit(deps.RateLimiter, deps.Auditor)(
				http.HandlerFunc(deps.DirectoryHandler.HandleLookup()),
			),
		),
	))

	// Phase 12 / Task 0.5: Conversation endpoints.
	mux.Handle("POST /api/v1/conversations", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleCreateConversation()),
	))
	mux.Handle("POST /api/v1/conversations/self", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleGetOrCreateSelfConversation()),
	))
	mux.Handle("GET /api/v1/conversations", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleListConversations()),
	))
	mux.Handle("DELETE /api/v1/conversations/{id}", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleDeleteConversation()),
	))

	// Read Watermark endpoints
	mux.Handle("POST /api/v1/conversations/{id}/read", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleMarkConversationRead()),
	))
	mux.Handle("GET /api/v1/conversations/read-watermarks", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleGetReadWatermarks()),
	))

	// History endpoints (Part A: E2EE Vault History Archive)
	mux.Handle("GET /api/v1/conversations/{id}/history", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleGetHistory()),
	))
	mux.Handle("POST /api/v1/conversations/{id}/history", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandlePostHistory()),
	))
	mux.Handle("DELETE /api/v1/conversations/{id}/history/{message_id}", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleDeleteHistoryMessage()),
	))
	mux.Handle("DELETE /api/v1/conversations/{id}/history", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleClearHistory()),
	))

	// Amendment RFC-0007-B: Group & Channel messages and member management
	mux.Handle("GET /api/v1/conversations/{id}/messages", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleListGroupMessages()),
	))
	mux.Handle("POST /api/v1/conversations/{id}/messages", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleSendGroupMessage()),
	))
	mux.Handle("PATCH /api/v1/conversations/{id}/messages/{msg_id}", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleEditGroupMessage()),
	))
	mux.Handle("PUT /api/v1/conversations/{id}/messages/{msg_id}", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleEditGroupMessage()),
	))
	mux.Handle("DELETE /api/v1/conversations/{id}/messages/{msg_id}", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleDeleteGroupMessage()),
	))
	mux.Handle("GET /api/v1/conversations/{id}/members", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleListMembers()),
	))
	mux.Handle("POST /api/v1/conversations/{id}/members", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleAddMember()),
	))
	mux.Handle("DELETE /api/v1/conversations/{id}/members/{user_id}", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleRemoveMember()),
	))
	mux.Handle("PUT /api/v1/conversations/{id}/members/{user_id}", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleUpdateMemberRole()),
	))

	// Group and Channel Privacy: public search & join endpoints
	mux.Handle("GET /api/v1/public-conversations/search", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleSearchPublic()),
	))
	mux.Handle("POST /api/v1/invites/{code}/join", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleJoinByInvite()),
	))
	mux.Handle("POST /api/v1/public-conversations/{username}/join", sessionAuth(
		http.HandlerFunc(deps.ConversationHandler.HandleJoinPublic()),
	))

	// Amendment RFC-0002-A: User profile and search endpoints.
	// GET /api/v1/users/search — rate-limited at 10/min per user (RouteClassUserSearch).
	mux.Handle("GET /api/v1/users/search", sessionAuth(
		middleware.WithRouteClass(domain.RouteClassUserSearch)(
			middleware.RateLimit(deps.RateLimiter, deps.Auditor)(
				http.HandlerFunc(deps.UserHandler.HandleSearch()),
			),
		),
	))
	mux.Handle("PUT /api/v1/users/me/username", sessionAuth(
		http.HandlerFunc(deps.UserHandler.HandleUpdateUsername()),
	))
	mux.Handle("GET /api/v1/users/me", sessionAuth(
		http.HandlerFunc(deps.UserHandler.HandleGetMe()),
	))
	mux.Handle("GET /api/v1/users/{id}/profile", sessionAuth(
		http.HandlerFunc(deps.UserHandler.HandleGetProfile()),
	))
	mux.Handle("PUT /api/v1/users/me/profile", sessionAuth(
		http.HandlerFunc(deps.UserHandler.HandleUpdateProfile()),
	))

	// Bundle 4: User avatar endpoints.
	mux.Handle("POST /api/v1/users/me/avatar", sessionAuth(
		http.HandlerFunc(deps.UserHandler.HandleUploadAvatar()),
	))
	mux.Handle("DELETE /api/v1/users/me/avatar", sessionAuth(
		http.HandlerFunc(deps.UserHandler.HandleDeleteAvatar()),
	))
	mux.Handle("GET /api/v1/users/{id}/avatar", sessionAuth(
		http.HandlerFunc(deps.UserHandler.HandleGetAvatar()),
	))

	// Admin endpoints (AdminAuth middleware)
	// IPBlocklist is enforced BEFORE AdminAuth (Task 9.2)
	adminChain := func(h http.Handler) http.Handler {
		return middleware.IPBlocklist(deps.IPBlocks, deps.Auditor)(
			middleware.AdminAuth(deps.Cfg, deps.AuthFailCoalesce, deps.Auditor)(h),
		)
	}

	mux.Handle("POST /api/v1/admin/users/{identity_hash}/suspend", adminChain(
		http.HandlerFunc(deps.AdminHandler.HandleSuspendUser()),
	))
	mux.Handle("POST /api/v1/admin/users/{identity_hash}/resume", adminChain(
		http.HandlerFunc(deps.AdminHandler.HandleResumeUser()),
	))
	mux.Handle("POST /api/v1/admin/users/{identity_hash}/tombstone", adminChain(
		http.HandlerFunc(deps.AdminHandler.HandleTombstoneUser()),
	))
	mux.Handle("POST /api/v1/admin/ip-blocks/{ip_hash}/ban", adminChain(
		http.HandlerFunc(deps.AdminHandler.HandleBanIP()),
	))
	mux.Handle("POST /api/v1/admin/ip-blocks/{ip_hash}/unban", adminChain(
		http.HandlerFunc(deps.AdminHandler.HandleUnbanIP()),
	))
	mux.Handle("GET /api/v1/admin/ip/blocks", adminChain(
		http.HandlerFunc(deps.AdminHandler.HandleListBlockedIPs()),
	))
	mux.Handle("GET /api/v1/admin/audit-events", adminChain(
		http.HandlerFunc(deps.AdminHandler.HandleQueryAuditLogs()),
	))
	mux.Handle("POST /api/v1/admin/confirmations", adminChain(
		http.HandlerFunc(deps.AdminHandler.HandleGenerateConfirmation()),
	))
	mux.Handle("POST /api/v1/admin/workers/{name}/trigger", adminChain(
		http.HandlerFunc(deps.AdminHandler.HandleTriggerWorker()),
	))
	mux.Handle("GET /api/v1/admin/warnings", adminChain(
		http.HandlerFunc(deps.AdminHandler.HandleGetWarnings(deps.Cfg)),
	))

	// OPTIONS catch-all returning 404 (ADR-P10-14)
	mux.HandleFunc("OPTIONS /", func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	})

	// RFC-0010 §7.2: Version endpoint for Service Worker staleness detection.
	mux.HandleFunc("GET /api/v1/version", HandleVersion(deps.Cfg))

	// RFC-0010 §7.1: SPA fallback — serve embedded frontend for non-API routes.
	// This MUST be registered AFTER all /api/ routes so they take priority.
	if deps.Cfg.WaitingForDomain {
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte(`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>RootInbox - Waiting for Domain</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0f172a; color: #f8fafc; }
        .card { background: #1e293b; padding: 2.5rem; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.5); max-width: 500px; text-align: center; border: 1px solid #334155; }
        h1 { font-size: 1.5rem; margin-bottom: 1rem; color: #38bdf8; }
        p { font-size: 0.95rem; line-height: 1.6; color: #94a3b8; }
        .badge { display: inline-block; padding: 0.25rem 0.75rem; background: #0369a1; color: #e0f2fe; border-radius: 9999px; font-size: 0.8rem; margin-top: 1rem; font-weight: 500; }
    </style>
</head>
<body>
    <div class="card">
        <h1>RootInbox Server is Running</h1>
        <p>The backend is healthy and listening, but no public domain has been configured yet.</p>
        <p>If you are on Railway, click <strong>Generate Domain</strong> in your service Networking settings and then <strong>Redeploy</strong> (or restart the service), or set the <code>APP_ORIGIN</code> environment variable.</p>
        <div class="badge">Safe Read-Only Mode (/health/ready: 200 OK)</div>
    </div>
</body>
</html>`))
		})
	} else {
		mux.Handle("/", ServeFrontend())
	}

	// Apply middleware chain.
	// Order (Outer to Inner):
	// PanicRecovery -> RequestLogger -> SecurityHeaders -> BodyLimit -> CORSStripper -> RealIP -> RateLimit
	var handler http.Handler = mux

	// Global rate limiting and Real IP Extraction (excluding /api/v1/ws)
	rateLimiter := middleware.RateLimit(deps.RateLimiter, deps.Auditor)
	realIP := middleware.RealIP(deps.Cfg)

	// Create a conditional middleware to skip WS
	skipWS := func(mw func(http.Handler) http.Handler) func(http.Handler) http.Handler {
		return func(next http.Handler) http.Handler {
			wrapped := mw(next)
			return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/v1/ws" {
					next.ServeHTTP(w, r)
					return
				}
				wrapped.ServeHTTP(w, r)
			})
		}
	}

	handler = skipWS(rateLimiter)(handler)
	handler = skipWS(realIP)(handler)

	// CORS Stripper
	handler = middleware.CORSStripper()(handler)

	// Body Limit (1MB global limit)
	handler = skipWS(middleware.BodyLimit(1048576))(handler) // WS has its own limit inside upgrader

	// Security Headers
	handler = middleware.SecurityHeaders()(handler)

	// TraceID
	handler = middleware.TraceID()(handler)

	// Logger and Panic Recovery
	handler = middleware.RequestLogger(deps.Logger)(handler)
	handler = middleware.PanicRecovery(deps.Logger)(handler)

	return handler
}
