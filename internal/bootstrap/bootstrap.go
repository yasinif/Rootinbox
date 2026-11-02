// Package bootstrap wires all dependencies and manages the application lifecycle.
// RFC-0001A Section 5.2: The bootstrap package MUST be the ONLY package allowed
// to wire dependencies. NO package may import bootstrap.
// RFC-0001 Section 3: NO global singletons. All dependencies must be explicitly
// wired in the internal/bootstrap package.
package bootstrap

import (
	"context"
	"crypto/sha256"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"rootinbox/internal/config"
	deliveryhttp "rootinbox/internal/delivery/http"
	"rootinbox/internal/delivery/ws"
	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure"
	"rootinbox/internal/infrastructure/auditor"
	"rootinbox/internal/infrastructure/authfailcoalesce"
	"rootinbox/internal/infrastructure/avatarstorage"
	"rootinbox/internal/infrastructure/confirmstore"
	"rootinbox/internal/infrastructure/database"
	"rootinbox/internal/infrastructure/filelock"
	"rootinbox/internal/infrastructure/ipblock"
	"rootinbox/internal/infrastructure/logger"
	"rootinbox/internal/infrastructure/mediastorage"
	"rootinbox/internal/infrastructure/metrics"
	"rootinbox/internal/infrastructure/migrations"
	"rootinbox/internal/infrastructure/noncestore"
	"rootinbox/internal/infrastructure/pendingring"
	"rootinbox/internal/infrastructure/push"
	"rootinbox/internal/infrastructure/pushdebounce"
	"rootinbox/internal/infrastructure/ratelimit"
	"rootinbox/internal/infrastructure/repository"
	"rootinbox/internal/infrastructure/ticketstore"
	"rootinbox/internal/infrastructure/tlsman"
	"rootinbox/internal/infrastructure/turnserver"
	"rootinbox/internal/usecase"
)

// App holds all initialized application components for lifecycle management.
type App struct {
	Config           *config.Config
	Logger           *slog.Logger
	DB               *database.DB
	TxManager        *database.TxManager
	MigRunner        *migrations.Runner
	Registry         *prometheus.Registry
	Metrics          *metrics.Metrics
	HTTPServer       *http.Server
	OnboardingServer *http.Server
	TLSManager       *tlsman.Manager
	Workers          []domain.Worker
	ErrCh            chan error

	// Phase 2: Repositories and Use Cases.
	UserRepo        domain.UserRepository
	ConvRepo        domain.ConversationRepository
	ParticipantRepo domain.ParticipantRepository
	SessionRepo     domain.SessionRepository
	MessageRepo     domain.MessageRepository
	VaultRepo       domain.VaultRepository
	ZKVaultRepo     domain.ZKVaultRepository
	MediaFileRepo   domain.MediaFileRepository
	MediaChunkRepo  domain.MediaChunkRepository
	QuotaRepo       domain.QuotaRepository
	CallRepo        domain.CallRepository
	AppKeyRepo      domain.ApplicationKeyRepository
	PushSubRepo     domain.PushSubscriptionRepository
	UserUC          *usecase.UserUseCase
	ConvUC          *usecase.ConversationUseCase
	AuthUC          *usecase.AuthUseCase
	MessageUC       *usecase.MessageUseCase
	SyncUC          *usecase.SyncUseCase
	VaultUC         *usecase.VaultUseCase
	MediaUC         *usecase.MediaUseCase
	CallUC          *usecase.CallUseCase
	PushUC          *usecase.PushUseCase
	AdminUC         *usecase.AdminUseCase
	GroupMsgUC      *usecase.GroupMessageUseCase
	GroupMsgRepo    domain.GroupMessageRepository

	// Phase 10: Security & Admin
	SecurityEventRepo domain.SecurityEventRepository
	IPBlockRepo       domain.IPBlockRepository
	AsyncAuditor      domain.SecurityAuditor
	IPBlockCache      *ipblock.Cache
	ConfirmStore      *confirmstore.Store
	AuthFailCoalesce  *authfailcoalesce.Store
	RateLimiter       *ratelimit.Limiter

	// Phase 4: Ephemeral stores.
	NonceStore  *noncestore.MemoryNonceStore
	TicketStore *ticketstore.MemoryTicketStore

	// Phase 5: WebSocket Hub.
	WSHub *ws.Hub

	// Phase 9: Push infrastructure.
	WebPushClient    *push.Client
	PushDebouncer    *pushdebounce.MemoryDebouncer
	PendingRingStore domain.PendingRingStore

	workerCancel context.CancelFunc
	workerWg     sync.WaitGroup
	shutdownOnce sync.Once
}

// Run executes the bootstrap lifecycle in strict sequential order.
// RFC-0001 Section 6: Bootstrap Sequence steps 1-10.
// RFC-0001A Section 5.2: Any startup failure MUST abort (Fail Fast).
func Run(ctx context.Context, version, buildHash, buildTime string) (*App, error) {
	app := &App{
		ErrCh: make(chan error, 1),
	}

	// Step 1: Load configuration.
	// RFC-0001 Section 6 Step 1.
	cfg := config.Load(version, buildHash, buildTime)

	// Step 2: Validate configuration.
	// RFC-0001 Section 6 Step 2.
	if err := config.Validate(cfg); err != nil {
		return nil, fmt.Errorf("configuration validation: %w", err)
	}
	app.Config = cfg

	// Step 3: Initialize logger.
	// RFC-0001 Section 6 Step 3.
	log := logger.New(cfg)
	app.Logger = log

	// RFC-0001A Section 6: Log startup metadata.
	logger.LogStartupMetadata(log, cfg)

	// Step 3b: Initialize TLS Manager if TLS is enabled (Stage 2).
	if cfg.TLS.Mode == "selfsigned" || cfg.TLS.Mode == "files" {
		tlsMgr, err := tlsman.NewManager(cfg, log)
		if err != nil {
			return nil, fmt.Errorf("initializing TLS manager: %w", err)
		}
		app.TLSManager = tlsMgr
		if cfg.TLS.Mode == "selfsigned" && tlsMgr.CACert() != nil {
			log.Info("TLS CA fingerprint ready", "sha256_fingerprint", tlsMgr.CAFingerprint())
		}
	}

	// Step 4: Initialize Prometheus registry.
	// RFC-0001 Section 6 Step 4.
	reg, m := metrics.NewRegistry()
	app.Registry = reg
	app.Metrics = m
	log.Info("prometheus registry initialized")

	// Steps 5-6: Open SQLite reader/writer pools with PRAGMAs.
	// RFC-0001 Section 6 Steps 5-6.
	// PRAGMAs are embedded in the DSN to ensure they apply to every connection
	// in the pool, as required by SQLite semantics.
	db, err := database.Open(ctx, cfg.Database.Path, cfg.Database.ReaderMaxConns)
	if err != nil {
		return nil, fmt.Errorf("opening database: %w", err)
	}
	app.DB = db
	log.Info("database pools opened",
		"writer_max_conns", 1,
		"reader_max_conns", cfg.Database.ReaderMaxConns,
	)

	// Create TransactionManager.
	// RFC-0001A Section 4.1.
	app.TxManager = database.NewTxManager(db.Writer)

	// Step 7: Execute pending SQL migrations.
	// RFC-0001 Section 6 Step 7.
	migRunner := migrations.NewRunner(db.Writer, migrations.All(), log)
	app.MigRunner = migRunner
	if err := migRunner.Run(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("running migrations: %w", err)
	}
	log.Info("migrations complete")

	// Phase 2: Wire production infrastructure implementations.
	// RFC-0001A §2.1: UseCases MUST NOT call time.Now() or uuid.New() directly.
	clock := infrastructure.RealClock{}
	uuidGen := infrastructure.RealUUIDGenerator{}
	domainLogger := logger.NewDomainLogger(log)

	// Phase 2: Wire repositories.
	// RFC-0001 §3: Dependency Injection — all dependencies explicitly wired here.
	userRepo := repository.NewUserRepository(db.Writer, db.Reader)
	convRepo := repository.NewConversationRepository(db.Writer, db.Reader)
	participantRepo := repository.NewParticipantRepository(db.Writer, db.Reader)
	sessionRepo := repository.NewSessionRepository(db.Writer, db.Reader)
	messageRepo := repository.NewMessageRepository(db.Writer, db.Reader)
	vaultRepo := repository.NewVaultRepository(db.Writer, db.Reader)
	appKeyRepo := repository.NewApplicationKeyRepository(db.Writer, db.Reader)
	pushSubRepo := repository.NewPushSubscriptionRepository(db.Writer, db.Reader)
	secEventRepo := repository.NewSecurityEventRepository(db.Writer, db.Reader)
	ipBlockRepo := repository.NewIPBlockRepository(db.Writer, db.Reader)
	// Level-2 Security: Transparent Server-Side AES-256-GCM Encryption-at-Rest key
	msgEncKey := sha256.Sum256(append([]byte("rootinbox:message_encryption_at_rest:"), cfg.Security.IPHashSecret.Reveal()...))
	groupMsgRepo := repository.NewGroupMessageRepository(db.Writer, db.Reader, msgEncKey)
	messageHistoryRepo := repository.NewMessageHistoryRepository(db.Writer, db.Reader)
	app.UserRepo = userRepo
	app.ConvRepo = convRepo
	app.ParticipantRepo = participantRepo
	app.SessionRepo = sessionRepo
	app.MessageRepo = messageRepo
	app.VaultRepo = vaultRepo
	app.AppKeyRepo = appKeyRepo
	app.PushSubRepo = pushSubRepo
	app.SecurityEventRepo = secEventRepo
	app.IPBlockRepo = ipBlockRepo
	zkVaultRepo := repository.NewZKVaultRepository(db.Writer, db.Reader)
	app.ZKVaultRepo = zkVaultRepo
	app.GroupMsgRepo = groupMsgRepo

	// Phase 10: Infrastructure Caches and Stores
	app.IPBlockCache = ipblock.NewCache(ipBlockRepo)
	app.ConfirmStore = confirmstore.NewStore(cfg.Admin.ConfirmationTTL)
	app.AuthFailCoalesce = authfailcoalesce.NewStore()
	app.RateLimiter = ratelimit.NewLimiter(cfg.Security.RateLimitStateMax)

	asyncAuditor := auditor.NewAsyncAuditor(secEventRepo, log)
	app.AsyncAuditor = asyncAuditor

	auditWorker := auditor.NewAuditRetentionWorker(secEventRepo, 90, log)
	app.Workers = append(app.Workers, auditWorker)

	metricsWorker := metrics.NewMetricsCacheWorker(m, log)
	app.Workers = append(app.Workers, metricsWorker)

	// Phase 4: Wire ephemeral stores.
	// RFC-0004 §4.2: Nonces in ephemeral, memory-backed store.
	// RFC-0004 §7.3: WS tickets in memory ONLY.
	ns := noncestore.New()
	ts := ticketstore.New()
	app.NonceStore = ns
	app.TicketStore = ts

	// Phase 5: Wire WebSocket Hub.
	// RFC-0005 §6.2: Hub implements domain.MessageRouter for atomic routing.
	wsHub := ws.NewHub(log)
	app.WSHub = wsHub

	// Phase 9: Push infrastructure setup.
	pushDebouncer := pushdebounce.New(cfg.Push.DebounceWindow)
	pendingRingStore := pendingring.New(cfg.Push.PendingRingCap, log)
	app.PushDebouncer = pushDebouncer
	app.PendingRingStore = pendingRingStore

	var vapidIdentity domain.VAPIDKeyProvider
	var webPushClient *push.Client

	if cfg.Push.Enabled {
		// RFC-0009 §5.1: Initialize VAPID Keys.
		var err error
		vapidIdentity, err = push.InitOrLoad(ctx, appKeyRepo, cfg.Push.VAPIDEncryptionKey, clock, log)
		if err != nil {
			db.Close()
			return nil, fmt.Errorf("initializing VAPID keys: %w", err)
		}

		webPushClient = push.NewClient(
			vapidIdentity,
			cfg.Push.VAPIDSubject,
			cfg.Push.DispatchTimeout,
			log,
		)
		app.WebPushClient = webPushClient
	} else {
		log.Info("push notifications disabled; skipping VAPID key initialization")
	}

	app.PushUC = usecase.NewPushUseCase(
		pushSubRepo, webPushClient, pushDebouncer,
		uuidGen, clock, log,
		cfg.Push.Enabled, cfg.Push.DispatchQueueSize, cfg.Push.DispatchTimeout,
	)
	pushHandler := deliveryhttp.NewPushHandler(app.PushUC, vapidIdentity, cfg.Push.Enabled)

	// Phase 9: Workers (unconditionally registered; push dispatch is a no-op if disabled).
	pushDispatchWorker := usecase.NewPushDispatchWorker(app.PushUC, log)
	app.Workers = append(app.Workers, pushDispatchWorker)

	pendingRingSweeper := usecase.NewPendingRingSweeper(pendingRingStore, clock, log)
	app.Workers = append(app.Workers, pendingRingSweeper)

	// Bundle 4: Avatar storage.
	avatarStore, err := avatarstorage.New(filepath.Join(filepath.Dir(cfg.Media.BasePath), "avatars"))
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("initializing avatar storage: %w", err)
	}

	// Phase 2: Wire use cases.
	app.UserUC = usecase.NewUserUseCase(userRepo, convRepo, sessionRepo, vaultRepo, pushSubRepo, app.TxManager, clock, uuidGen, domainLogger, avatarStore)
	app.ConvUC = usecase.NewConversationUseCase(convRepo, participantRepo, app.TxManager, clock, uuidGen, domainLogger)
	app.GroupMsgUC = usecase.NewGroupMessageUseCase(groupMsgRepo, convRepo, participantRepo, clock, uuidGen, wsHub, domainLogger)
	app.GroupMsgUC.SetTxManager(app.TxManager)
	app.GroupMsgUC.SetPushTrigger(app.PushUC)
	app.GroupMsgUC.SetConversationUseCase(app.ConvUC)

	// Phase 4: Wire auth use case.
	app.AuthUC = usecase.NewAuthUseCase(userRepo, sessionRepo, ns, ts, app.TxManager, clock, uuidGen, domainLogger, asyncAuditor)
	app.AuthUC.SetSessionTerminator(wsHub)
	app.AuthUC.SetServerSaltSecret(cfg.Security.IPHashSecret.Reveal())
	authHandler := deliveryhttp.NewAuthHandler(app.AuthUC)

	// Phase 5: Wire message use case and WS handler.
	app.MessageUC = usecase.NewMessageUseCase(messageRepo, wsHub, app.PushUC, clock, domainLogger, cfg, asyncAuditor)

	// Phase 6: Wire sync and vault use cases + handlers.
	app.SyncUC = usecase.NewSyncUseCase(messageRepo, wsHub, clock, domainLogger)
	app.VaultUC = usecase.NewVaultUseCase(vaultRepo, clock, uuidGen, domainLogger)
	app.VaultUC.SetZKVaultRepo(zkVaultRepo)
	syncHandler := deliveryhttp.NewSyncHandler(app.SyncUC)
	vaultHandler := deliveryhttp.NewVaultHandler(app.VaultUC)

	// Background worker: Periodic cleanup of expired delivery acks (>14 days old)
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for range ticker.C {
			fourteenDaysAgo := clock.NowUnix() - 14*24*3600
			_ = messageRepo.DeleteExpiredDeliveryAcks(context.Background(), fourteenDaysAgo)
		}
	}()

	// Phase 7: Wire media infrastructure.
	// RFC-0007 §8.4: Per-File I/O Lock.
	fileLockMgr := filelock.New()

	// RFC-0007 §8.1: Local filesystem media storage.
	mediaStorage, err := mediastorage.New(cfg.Media.BasePath)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("initializing media storage: %w", err)
	}

	// Phase 7: Wire media repositories.
	mediaFileRepo := repository.NewMediaFileRepository(db.Writer, db.Reader)
	mediaChunkRepo := repository.NewMediaChunkRepository(db.Writer, db.Reader)
	quotaRepo := repository.NewQuotaRepository(db.Writer, db.Reader)
	app.MediaFileRepo = mediaFileRepo
	app.MediaChunkRepo = mediaChunkRepo
	app.QuotaRepo = quotaRepo

	// Phase 7: Wire media use case.
	app.MediaUC = usecase.NewMediaUseCase(
		mediaFileRepo, mediaChunkRepo, quotaRepo,
		app.TxManager, fileLockMgr, mediaStorage,
		clock, domainLogger, cfg.Media.DefaultQuotaBytes,
	)
	mediaHandler := deliveryhttp.NewMediaHandler(app.MediaUC)

	// Phase 7: Wire GC worker.
	gcWorker := usecase.NewMediaGCWorker(
		mediaFileRepo, app.MediaUC, clock, domainLogger, cfg.Media.GCInterval,
	)
	app.Workers = append(app.Workers, gcWorker)

	// Phase 8: Wire call infrastructure.
	callRepo := repository.NewCallRepository(db.Writer, db.Reader)
	app.CallRepo = callRepo

	// Phase 8: Wire call use case.
	turnHost := cfg.TLS.PublicHost
	if turnHost == "" && cfg.TURN.RelayIP != nil {
		turnHost = cfg.TURN.RelayIP.String()
	}
	if turnHost == "" {
		turnHost = cfg.Server.Host
	}
	if turnHost == "" || turnHost == "0.0.0.0" {
		turnHost = "127.0.0.1"
	}
	turnPort := 3478
	if _, portStr, err := net.SplitHostPort(cfg.TURN.ListenAddr); err == nil {
		if p, err := strconv.Atoi(portStr); err == nil && p > 0 {
			turnPort = p
		}
	}

	app.CallUC = usecase.NewCallUseCase(
		userRepo, callRepo, convRepo, participantRepo, sessionRepo,
		app.TxManager, clock, domainLogger,
		cfg.TURN.ActiveSecret, cfg.TURN.PreviousSecret,
		cfg.TURN.CredentialTTL, cfg.TURN.Realm, turnHost, turnPort,
		app.PushUC, pendingRingStore,
	)

	// Phase 8: Crash recovery MUST run synchronously BEFORE the HTTP listener.
	// RFC-0008 §10.2: RINGING→FAILED, ACTIVE→ENDED.
	if err := app.CallUC.RecoverCrashState(ctx); err != nil {
		db.Close()
		return nil, fmt.Errorf("call crash recovery failed: %w", err)
	}
	log.Info("call crash recovery complete")

	callHandler := deliveryhttp.NewCallHandler(app.CallUC)

	// Phase 8: Wire call timeout worker.
	callTimeoutWorker := usecase.NewCallTimeoutWorker(
		callRepo, pendingRingStore, clock, domainLogger, 10*time.Second,
	)
	app.Workers = append(app.Workers, callTimeoutWorker)

	// Phase 8: Wire embedded TURN server (if enabled).
	// RFC-0008 §5.1: Single-Binary STUN/TURN Embedding.
	if cfg.TURN.Enabled {
		turnWorker := turnserver.New(
			cfg.TURN.ListenAddr, cfg.TURN.Realm,
			cfg.TURN.ActiveSecret, cfg.TURN.PreviousSecret,
			cfg.TURN.RelayIP, cfg.TURN.MinPort, cfg.TURN.MaxPort, log,
		)
		app.Workers = append(app.Workers, turnWorker)
		log.Info("turn server enabled", "addr", cfg.TURN.ListenAddr, "relay_ip", cfg.TURN.RelayIP)
	}

	// Phase 10: Admin use case.
	app.AdminUC = usecase.NewAdminUseCase(userRepo, ipBlockRepo, secEventRepo, sessionRepo, callRepo, mediaFileRepo, app.ConfirmStore, asyncAuditor, app.IPBlockCache)
	adminHandler := deliveryhttp.NewAdminHandler(app.AdminUC)

	// Phase 12 / Task 0.5: Wire directory and conversation handlers.
	directoryHandler := deliveryhttp.NewDirectoryHandler(userRepo, sessionRepo)
	conversationHandler := deliveryhttp.NewConversationHandler(app.ConvUC, userRepo, participantRepo)
	conversationHandler.SetGroupMessageUseCase(app.GroupMsgUC)
	conversationHandler.SetGroupMessageRepository(groupMsgRepo)
	conversationHandler.SetHistoryRepository(messageHistoryRepo)
	conversationHandler.SetMessageRouter(wsHub)
	conversationHandler.SetPresenceChecker(wsHub)
	userHandler := deliveryhttp.NewUserHandler(app.UserUC)
	userHandler.SetPresenceChecker(wsHub)

	// Phase 5 (continued): Wire WS handler with all use cases.
	wsHandler := ws.NewHandler(wsHub, ts, app.MessageUC, app.CallUC, log, cfg, asyncAuditor)
	wsHandler.SetGroupMessageUseCase(app.GroupMsgUC)
	wsHandler.SetUserRepository(userRepo)
	wsHandler.SetConversationUseCase(app.ConvUC)

	// Wire syncHandler conversation usecase for direct conversation ID resolution.
	syncHandler.SetConversationUseCase(app.ConvUC)

	// Step 8: Verify health readiness.
	// RFC-0001 Section 6 Step 8.
	// RFC-0001A Section 5.2: Health probes MUST be verified BEFORE the HTTP
	// listener begins accepting traffic.
	healthChecker := deliveryhttp.NewHealthChecker(db, migRunner, cfg)
	if err := verifyHealth(ctx, healthChecker); err != nil {
		db.Close()
		return nil, fmt.Errorf("health readiness verification: %w", err)
	}
	log.Info("health readiness verified")

	// Step 9: Register HTTP routes & middlewares.
	// RFC-0001 Section 6 Step 9.
	router := deliveryhttp.NewRouter(deliveryhttp.RouterDeps{
		Logger:              log,
		HealthChecker:       healthChecker,
		Registry:            reg,
		Metrics:             m,
		AuthHandler:         authHandler,
		SyncHandler:         syncHandler,
		VaultHandler:        vaultHandler,
		MediaHandler:        mediaHandler,
		CallHandler:         callHandler,
		PushHandler:         pushHandler,
		AdminHandler:        adminHandler,
		DirectoryHandler:    directoryHandler,
		ConversationHandler: conversationHandler,
		UserHandler:         userHandler,
		SessionRepo:         sessionRepo,
		WSHandler:           wsHandler,
		Cfg:                 cfg,
		RateLimiter:         app.RateLimiter,
		IPBlocks:            app.IPBlockCache,
		Auditor:             asyncAuditor,
		AuthFailCoalesce:    app.AuthFailCoalesce,
	})

	// Create HTTP server with RFC-0001A Section 5.4 timeouts.
	srv := deliveryhttp.NewServer(cfg, router)
	app.HTTPServer = srv

	// Step 10: Start HTTP/HTTPS server gracefully.
	// RFC-0001 Section 6 Step 10.
	if app.TLSManager != nil {
		srv.TLSConfig = app.TLSManager.TLSConfig()
		go func() {
			log.Info("https server starting", "addr", cfg.Server.Addr(), "mode", cfg.TLS.Mode)
			if err := srv.ListenAndServeTLS("", ""); err != nil && err != http.ErrServerClosed {
				app.ErrCh <- fmt.Errorf("https server error: %w", err)
			}
		}()

		if cfg.TLS.Mode == "selfsigned" {
			onboardingSrv := &http.Server{
				Addr:              cfg.TLS.OnboardingAddr(),
				Handler:           app.TLSManager.OnboardingHandler(),
				ReadHeaderTimeout: 5 * time.Second,
				ReadTimeout:       15 * time.Second,
				WriteTimeout:      15 * time.Second,
				IdleTimeout:       60 * time.Second,
			}
			app.OnboardingServer = onboardingSrv
			go func() {
				log.Info("tls onboarding server starting", "addr", cfg.TLS.OnboardingAddr())
				if err := onboardingSrv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
					app.ErrCh <- fmt.Errorf("tls onboarding server error: %w", err)
				}
			}()
			app.TLSManager.StartRenewalWorker(ctx, 24*time.Hour)
		}
	} else {
		go func() {
			log.Info("http server starting", "addr", cfg.Server.Addr())
			if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				app.ErrCh <- fmt.Errorf("http server error: %w", err)
			}
		}()
	}

	// Start background workers (none in Phase 1/2).
	workerCtx, workerCancel := context.WithCancel(ctx)
	app.workerCancel = workerCancel
	for _, w := range app.Workers {
		app.workerWg.Add(1)
		go func(worker domain.Worker) {
			defer app.workerWg.Done()
			if err := worker.Start(workerCtx); err != nil {
				log.Error("worker error", "error", err)
			}
		}(w)
	}

	return app, nil
}

// Shutdown performs the graceful shutdown sequence.
// RFC-0001A Section 5.5: Stop HTTP -> Cancel Background Workers (ctx.Cancel &
// WaitGroup.Wait()) -> Close Writer DB -> Close Reader DB -> Flush Logger/Metrics -> Exit(0).
// 30s total timeout.
func (app *App) Shutdown() error {
	var err error
	app.shutdownOnce.Do(func() {
		err = app.shutdownInternal()
	})
	return err
}

func (app *App) shutdownInternal() error {
	ctx, cancel := context.WithTimeout(context.Background(), deliveryhttp.GracefulShutdownTimeout)
	defer cancel()

	app.Logger.Info("graceful shutdown starting")

	// Step 1: Stop HTTP/HTTPS server and onboarding server.
	// RFC-0001A Section 5.5: Stop HTTP.
	if app.HTTPServer != nil {
		if err := app.HTTPServer.Shutdown(ctx); err != nil {
			app.Logger.Error("http server shutdown error", "error", err)
		} else {
			app.Logger.Info("http server stopped")
		}
	}

	if app.OnboardingServer != nil {
		if err := app.OnboardingServer.Shutdown(ctx); err != nil {
			app.Logger.Error("onboarding server shutdown error", "error", err)
		} else {
			app.Logger.Info("onboarding server stopped")
		}
	}

	if app.TLSManager != nil {
		app.TLSManager.Stop()
	}

	// Step 2: Cancel background workers and wait.
	// RFC-0001A Section 5.5: Cancel Background Workers (ctx.Cancel & WaitGroup.Wait()).
	if app.workerCancel != nil {
		app.workerCancel()
	}

	workerDone := make(chan struct{})
	go func() {
		app.workerWg.Wait()
		close(workerDone)
	}()

	select {
	case <-workerDone:
		app.Logger.Info("background workers stopped")
	case <-ctx.Done():
		app.Logger.Error("timeout waiting for background workers")
	}

	// Steps 3-4: Close Writer DB -> Close Reader DB.
	// RFC-0001A Section 5.5: Close Writer DB -> Close Reader DB.
	if app.DB != nil {
		if err := app.DB.Close(); err != nil {
			app.Logger.Error("database close error", "error", err)
		} else {
			app.Logger.Info("database pools closed")
		}
	}

	// Step 5: Close ephemeral stores.
	if app.NonceStore != nil {
		app.NonceStore.Close()
		app.NonceStore = nil
	}
	if app.TicketStore != nil {
		app.TicketStore.Close()
		app.TicketStore = nil
	}

	// Step 6: Close WebSocket Hub (disconnect all clients).
	if app.WSHub != nil {
		app.WSHub.CloseAll()
	}

	// Step 7: Flush Logger/Metrics.
	// RFC-0001A Section 5.5: Flush Logger/Metrics.
	app.Logger.Info("graceful shutdown complete")

	return nil
}

// verifyHealth runs the health checker and fails if any check does not pass.
// RFC-0001A Section 5.2: Warmup Phase — Health probes MUST be verified BEFORE
// the HTTP listener begins accepting traffic.
func verifyHealth(ctx context.Context, hc *deliveryhttp.HealthChecker) error {
	// Create a synthetic request to invoke the health checker.
	r, err := http.NewRequestWithContext(ctx, http.MethodGet, "/health/ready", nil)
	if err != nil {
		return fmt.Errorf("creating health check request: %w", err)
	}

	w := &statusRecorder{code: http.StatusOK}
	hc.HandleReady()(w, r)

	if w.code != http.StatusOK {
		return fmt.Errorf("health check returned status %d", w.code)
	}
	return nil
}

// statusRecorder captures the HTTP status code from a handler.
type statusRecorder struct {
	code int
}

func (sr *statusRecorder) Header() http.Header         { return http.Header{} }
func (sr *statusRecorder) Write(b []byte) (int, error) { return len(b), nil }
func (sr *statusRecorder) WriteHeader(code int)        { sr.code = code }

// Compile-time interface satisfaction checks.

// Ensure DomainLogger satisfies domain.Logger.
var _ domain.Logger = (*logger.DomainLogger)(nil)

// Ensure TxManager satisfies domain.TransactionManager.
var _ domain.TransactionManager = (*database.TxManager)(nil)

// Ensure statusRecorder satisfies http.ResponseWriter.
var _ http.ResponseWriter = (*statusRecorder)(nil)

// Ensure RealClock satisfies domain.Clock.
var _ domain.Clock = infrastructure.RealClock{}

// Ensure RealUUIDGenerator satisfies domain.UUIDGenerator.
var _ domain.UUIDGenerator = infrastructure.RealUUIDGenerator{}

// Ensure SQLite repositories satisfy domain repository interfaces.
var _ domain.UserRepository = (*repository.SQLiteUserRepository)(nil)
var _ domain.ConversationRepository = (*repository.SQLiteConversationRepository)(nil)
var _ domain.ParticipantRepository = (*repository.SQLiteParticipantRepository)(nil)
var _ domain.SessionRepository = (*repository.SQLiteSessionRepository)(nil)
var _ domain.MessageRepository = (*repository.SQLiteMessageRepository)(nil)
var _ domain.VaultRepository = (*repository.SQLiteVaultRepository)(nil)
var _ domain.MediaFileRepository = (*repository.SQLiteMediaFileRepository)(nil)
var _ domain.MediaChunkRepository = (*repository.SQLiteMediaChunkRepository)(nil)
var _ domain.QuotaRepository = (*repository.SQLiteQuotaRepository)(nil)
var _ domain.CallRepository = (*repository.SQLiteCallRepository)(nil)

// Ensure ephemeral stores satisfy domain interfaces.
var _ domain.NonceStore = (*noncestore.MemoryNonceStore)(nil)
var _ domain.TicketStore = (*ticketstore.MemoryTicketStore)(nil)

// Ensure Hub satisfies domain.MessageRouter.
var _ domain.MessageRouter = (*ws.Hub)(nil)

// Ensure MediaGCWorker satisfies domain.Worker.
var _ domain.Worker = (*usecase.MediaGCWorker)(nil)

// Ensure CallTimeoutWorker satisfies domain.Worker.
var _ domain.Worker = (*usecase.CallTimeoutWorker)(nil)
