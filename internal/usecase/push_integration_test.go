package usecase

import (
	"context"
	"encoding/base64"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"
	"rootinbox/internal/infrastructure/migrations"
	"rootinbox/internal/infrastructure/push"
	"rootinbox/internal/infrastructure/pushdebounce"
	"rootinbox/internal/infrastructure/repository"

	webpush "github.com/SherClockHolmes/webpush-go"
)

type fixedUUIDGen struct {
	val string
}

func (f fixedUUIDGen) New() string { return f.val }

type fixedClock struct {
	now int64
}

func (c fixedClock) NowUnix() int64 { return c.now }

type mockVAPIDKeyProvider struct {
	pub  string
	priv string
}

func (m *mockVAPIDKeyProvider) PublicKeyBase64URL() string {
	return m.pub
}

func (m *mockVAPIDKeyProvider) PrivateKeyBase64URL() string {
	return m.priv
}

func setupPushTestDB(t *testing.T) (domain.PushSubscriptionRepository, func(string)) {
	t.Helper()
	ctx := context.Background()
	dbPath := filepath.Join(t.TempDir(), "test_push.db")
	db, err := database.Open(ctx, dbPath, 1)
	if err != nil {
		t.Fatalf("failed to open test db: %v", err)
	}
	t.Cleanup(func() { db.Close() })

	migRunner := migrations.NewRunner(db.Writer, migrations.All(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := migRunner.Run(ctx); err != nil {
		t.Fatalf("failed to run migrations: %v", err)
	}

	userRepo := repository.NewUserRepository(db.Writer, db.Reader)
	createUser := func(uid string) {
		u := &domain.User{
			ID:           uid,
			IdentityHash: "hash-" + uid,
			PublicKey:    "pk-" + uid,
			Status:       domain.UserStatusActive,
			CreatedAt:    1700000000,
		}
		if err := userRepo.Create(ctx, u); err != nil {
			t.Fatalf("failed to create user %s: %v", uid, err)
		}
	}

	return repository.NewPushSubscriptionRepository(db.Writer, db.Reader), createUser
}

func TestServerPushPath_OfflineRecipient_410RemovesSubscription(t *testing.T) {
	ctx := context.Background()
	subRepo, createUser := setupPushTestDB(t)

	var requestCount int32
	var lastMethod string
	var lastBodyLen int
	var mu sync.Mutex

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&requestCount, 1)
		body, _ := io.ReadAll(r.Body)
		mu.Lock()
		lastMethod = r.Method
		lastBodyLen = len(body)
		mu.Unlock()
		w.WriteHeader(http.StatusGone) // 410 Gone
	}))
	defer ts.Close()

	vapidPriv, vapidPub, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		t.Fatalf("failed to generate vapid keys: %v", err)
	}
	provider := &mockVAPIDKeyProvider{pub: vapidPub, priv: vapidPriv}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client := push.NewClient(provider, "mailto:test@example.com", 5*time.Second, logger)
	debouncer := pushdebounce.New(1 * time.Second)
	clock := fixedClock{now: 1700000000}
	uuidGen := fixedUUIDGen{val: "sub-uuid-1"}

	pushUC := NewPushUseCase(
		subRepo,
		client,
		debouncer,
		uuidGen,
		clock,
		logger,
		true, // enabled
		100,
		5*time.Second,
	)

	// Receiver has a subscription
	userID := "receiver-user-1"
	createUser(userID)
	sub := &domain.PushSubscription{
		ID:         "sub-1",
		UserID:     userID,
		Endpoint:   ts.URL,
		P256dhKey:  vapidPub,
		AuthSecret: base64.RawURLEncoding.EncodeToString(make([]byte, 16)),
		CreatedAt:  clock.NowUnix(),
	}
	if err := subRepo.Upsert(ctx, sub); err != nil {
		t.Fatalf("failed to insert subscription: %v", err)
	}

	// Verify subscription exists
	countBefore, err := subRepo.CountByUserID(ctx, userID)
	if err != nil || countBefore != 1 {
		t.Fatalf("expected 1 subscription before push, got %d (err: %v)", countBefore, err)
	}

	// Receiver has no live WebSocket -> trigger message enqueues push job
	pushUC.TriggerMessage(userID)

	// Drain job from queue and dispatch
	select {
	case job := <-pushUC.Queue():
		if err := pushUC.Dispatch(ctx, job); err != nil {
			t.Fatalf("dispatch returned error: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for push job in queue")
	}

	// Verify mock push server received push attempt
	if atomic.LoadInt32(&requestCount) != 1 {
		t.Fatalf("expected exactly 1 push send attempt, got %d", atomic.LoadInt32(&requestCount))
	}
	mu.Lock()
	if lastMethod != http.MethodPost {
		t.Fatalf("expected POST push method, got %s", lastMethod)
	}
	if lastBodyLen != 150 {
		t.Fatalf("expected 150 bytes encrypted payload, got %d", lastBodyLen)
	}
	mu.Unlock()

	// Verify 410 response pruned subscription from DB
	countAfter, err := subRepo.CountByUserID(ctx, userID)
	if err != nil {
		t.Fatalf("failed to count subscriptions: %v", err)
	}
	if countAfter != 0 {
		t.Fatalf("expected 0 subscriptions after 410 Gone, got %d (stale subscription was not removed)", countAfter)
	}
}

func TestServerPushPath_OfflineRecipient_404RemovesSubscription(t *testing.T) {
	ctx := context.Background()
	subRepo, createUser := setupPushTestDB(t)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNotFound) // 404 Not Found
	}))
	defer ts.Close()

	vapidPriv, vapidPub, _ := webpush.GenerateVAPIDKeys()
	provider := &mockVAPIDKeyProvider{pub: vapidPub, priv: vapidPriv}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client := push.NewClient(provider, "mailto:test@example.com", 5*time.Second, logger)
	debouncer := pushdebounce.New(1 * time.Second)
	clock := fixedClock{now: 1700000000}
	uuidGen := fixedUUIDGen{val: "sub-uuid-2"}

	pushUC := NewPushUseCase(subRepo, client, debouncer, uuidGen, clock, logger, true, 100, 5*time.Second)

	userID := "receiver-user-2"
	createUser(userID)
	sub := &domain.PushSubscription{
		ID:         "sub-2",
		UserID:     userID,
		Endpoint:   ts.URL,
		P256dhKey:  vapidPub,
		AuthSecret: base64.RawURLEncoding.EncodeToString(make([]byte, 16)),
		CreatedAt:  clock.NowUnix(),
	}
	_ = subRepo.Upsert(ctx, sub)

	pushUC.TriggerMessage(userID)
	job := <-pushUC.Queue()
	_ = pushUC.Dispatch(ctx, job)

	countAfter, _ := subRepo.CountByUserID(ctx, userID)
	if countAfter != 0 {
		t.Fatalf("expected 0 subscriptions after 404 Not Found, got %d", countAfter)
	}
}

func TestServerPushPath_OfflineRecipient_201KeepsSubscription(t *testing.T) {
	ctx := context.Background()
	subRepo, createUser := setupPushTestDB(t)

	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusCreated) // 201 Created
	}))
	defer ts.Close()

	vapidPriv, vapidPub, _ := webpush.GenerateVAPIDKeys()
	provider := &mockVAPIDKeyProvider{pub: vapidPub, priv: vapidPriv}

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	client := push.NewClient(provider, "mailto:test@example.com", 5*time.Second, logger)
	debouncer := pushdebounce.New(1 * time.Second)
	clock := fixedClock{now: 1700000000}
	uuidGen := fixedUUIDGen{val: "sub-uuid-3"}

	pushUC := NewPushUseCase(subRepo, client, debouncer, uuidGen, clock, logger, true, 100, 5*time.Second)

	userID := "receiver-user-3"
	createUser(userID)
	sub := &domain.PushSubscription{
		ID:         "sub-3",
		UserID:     userID,
		Endpoint:   ts.URL,
		P256dhKey:  vapidPub,
		AuthSecret: base64.RawURLEncoding.EncodeToString(make([]byte, 16)),
		CreatedAt:  clock.NowUnix(),
	}
	_ = subRepo.Upsert(ctx, sub)

	pushUC.TriggerMessage(userID)
	job := <-pushUC.Queue()
	_ = pushUC.Dispatch(ctx, job)

	countAfter, _ := subRepo.CountByUserID(ctx, userID)
	if countAfter != 1 {
		t.Fatalf("expected subscription to be kept after 201 Created, got count %d", countAfter)
	}
}
