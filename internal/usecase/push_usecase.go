package usecase

import (
	"context"
	"encoding/base64"
	"net/url"
	"time"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/push"
	"rootinbox/internal/infrastructure/pushdebounce"
)

type PushUseCase struct {
	subRepo         domain.PushSubscriptionRepository
	client          *push.Client
	debouncer       *pushdebounce.MemoryDebouncer
	clock           domain.Clock
	uuidGen         domain.UUIDGenerator
	logger          domain.Logger
	queue           chan pushJob
	enabled         bool
	dispatchTimeout time.Duration
}

type pushJob struct {
	UserID string
	Class  domain.PushTriggerClass
}

func NewPushUseCase(
	subRepo domain.PushSubscriptionRepository,
	client *push.Client,
	debouncer *pushdebounce.MemoryDebouncer,
	uuidGen domain.UUIDGenerator,
	clock domain.Clock,
	logger domain.Logger,
	enabled bool,
	dispatchQueueSize int,
	dispatchTimeout time.Duration,
) *PushUseCase {
	return &PushUseCase{
		subRepo:         subRepo,
		client:          client,
		debouncer:       debouncer,
		clock:           clock,
		uuidGen:         uuidGen,
		logger:          logger,
		queue:           make(chan pushJob, dispatchQueueSize),
		enabled:         enabled,
		dispatchTimeout: dispatchTimeout,
	}
}

// HasSubscriptions is a cheap existence probe for the trigger paths.
func (uc *PushUseCase) HasSubscriptions(ctx context.Context, userID string) (bool, error) {
	if !uc.enabled {
		return false, nil
	}
	count, err := uc.subRepo.CountByUserID(ctx, userID)
	return count > 0, err
}

func (uc *PushUseCase) Subscribe(ctx context.Context, userID, endpoint, p256dh, authSecret string) (*domain.PushSubscription, error) {
	if !uc.enabled {
		return nil, domain.NewDomainError(domain.ErrPush001, "push notifications are disabled", nil)
	}

	if endpoint == "" {
		return nil, domain.NewDomainError(domain.ErrPush003, "endpoint cannot be empty", nil)
	}
	u, err := url.ParseRequestURI(endpoint)
	if err != nil || u.Scheme != "https" {
		return nil, domain.NewDomainError(domain.ErrPush003, "endpoint must be a valid https URL", err)
	}
	if len(endpoint) > 2048 {
		return nil, domain.NewDomainError(domain.ErrPush003, "endpoint is too long", nil)
	}

	// Validate p256dh is exactly 65 bytes when decoded
	p256Bytes, err := base64.RawURLEncoding.DecodeString(p256dh)
	if err != nil {
		p256Bytes, err = base64.URLEncoding.DecodeString(p256dh)
		if err != nil {
			return nil, domain.NewDomainError(domain.ErrPush003, "invalid p256dh base64 encoding", err)
		}
	}
	if len(p256Bytes) != 65 {
		return nil, domain.NewDomainError(domain.ErrPush003, "p256dh must be exactly 65 bytes", nil)
	}

	// Validate auth is exactly 16 bytes when decoded
	authBytes, err := base64.RawURLEncoding.DecodeString(authSecret)
	if err != nil {
		authBytes, err = base64.URLEncoding.DecodeString(authSecret)
		if err != nil {
			return nil, domain.NewDomainError(domain.ErrPush003, "invalid auth secret base64 encoding", err)
		}
	}
	if len(authBytes) != 16 {
		return nil, domain.NewDomainError(domain.ErrPush003, "auth secret must be exactly 16 bytes", nil)
	}

	sub := &domain.PushSubscription{
		ID:         uc.uuidGen.New(),
		UserID:     userID,
		Endpoint:   endpoint,
		P256dhKey:  p256dh, // Store in the exact Base64URL form the client sent
		AuthSecret: authSecret,
		CreatedAt:  uc.clock.NowUnix(),
	}

	err = uc.subRepo.Upsert(ctx, sub)
	if err != nil {
		return nil, err
	}

	// TODO: Increment PushSubscriptionsTotal{action="subscribe"}
	return sub, nil
}

func (uc *PushUseCase) Unsubscribe(ctx context.Context, userID, endpoint string) error {
	if !uc.enabled {
		return nil
	}

	rows, err := uc.subRepo.DeleteByUserAndEndpoint(ctx, userID, endpoint)
	if err != nil {
		return err
	}
	if rows == 0 {
		uc.logger.Info("push unsubscribe: no rows affected (non-existent or foreign)", "user_id", userID)
	}

	// TODO: Increment PushSubscriptionsTotal{action="unsubscribe"}
	return nil
}

// TriggerMessage satisfies domain.PushTrigger.
func (uc *PushUseCase) TriggerMessage(userID string) {
	if !uc.enabled {
		return
	}
	select {
	case uc.queue <- pushJob{UserID: userID, Class: domain.PushClassMessage}:
		// TODO: Increment PushTriggersEnqueuedTotal{class="MESSAGE"}
	default:
		uc.logger.Info("WARN: push trigger dropped: queue full", "user_id", userID, "class", domain.PushClassMessage)
		// TODO: Increment PushTriggerDroppedTotal{reason="queue_full"}
	}
}

// TriggerCall satisfies domain.PushTrigger.
func (uc *PushUseCase) TriggerCall(userID string) {
	if !uc.enabled {
		return
	}
	select {
	case uc.queue <- pushJob{UserID: userID, Class: domain.PushClassCall}:
		// TODO: Increment PushTriggersEnqueuedTotal{class="CALL"}
	default:
		uc.logger.Info("WARN: push trigger dropped: queue full", "user_id", userID, "class", domain.PushClassCall)
		// TODO: Increment PushTriggerDroppedTotal{reason="queue_full"}
	}
}

// Dispatch is worker-invoked.
func (uc *PushUseCase) Dispatch(ctx context.Context, job pushJob) error {
	if !uc.enabled || uc.client == nil {
		return nil
	}

	// ADR-P9-8: Debounce gate
	if job.Class == domain.PushClassMessage {
		if !uc.debouncer.TryAcquire(job.UserID, uc.clock.NowUnix()) {
			uc.logger.Info("push debounced", "user_id", job.UserID)
			// TODO: Increment PushDebouncedTotal
			return nil
		}
	}

	subs, err := uc.subRepo.ListByUserID(ctx, job.UserID)
	if err != nil {
		uc.logger.Error("failed to list push subscriptions", "user_id", job.UserID, "error", err)
		return err
	}

	if len(subs) == 0 {
		// TODO: Increment PushTriggerDroppedTotal{reason="no_subscriptions"}
		return nil
	}

	for _, sub := range subs {
		// Fan-out is sequential. Do not return err mid-loop.
		func() {
			sendCtx, cancel := context.WithTimeout(ctx, uc.dispatchTimeout)
			defer cancel()

			res, err := uc.client.Send(sendCtx, sub, job.Class)
			if err != nil {
				// Defect or size guard error
				uc.logger.Error("push dispatch error", "sub_id", sub.ID, "error", err)
				// TODO: Increment PushFailedTotal{class, bucket="defect"}
				return
			}

			if res.Stale {
				_ = uc.deleteStale(ctx, sub)
				// TODO: Increment PushSubscriptionsPrunedTotal
				return
			}

			if res.Transient {
				// Transient failure. Already logged/classified in client if appropriate, or we can log here.
				uc.logger.Info("WARN: push dispatch transient failure", "sub_id", sub.ID, "status", res.StatusCode)
				// TODO: Increment PushFailedTotal{class, bucket="transient"}
				return
			}

			// Success
			// TODO: Increment PushSentTotal{class}
		}()

		if ctx.Err() != nil {
			// Shutdown in progress
			return nil
		}
	}

	return nil
}

func (uc *PushUseCase) deleteStale(ctx context.Context, sub *domain.PushSubscription) error {
	_, err := uc.subRepo.DeleteByID(ctx, sub.ID)
	if err != nil {
		uc.logger.Error("failed to delete stale push subscription", "sub_id", sub.ID, "error", err)
		return err
	}

	u, _ := url.Parse(sub.Endpoint)
	uc.logger.Info("stale push subscription pruned", "sub_id", sub.ID, "endpoint_host", u.Host)
	return nil
}

// Queue returns the channel to be drained by the worker.
func (uc *PushUseCase) Queue() <-chan pushJob {
	return uc.queue
}
