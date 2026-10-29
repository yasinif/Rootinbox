package usecase

import (
	"context"
	"time"

	"github.com/google/uuid"

	"rootinbox/internal/domain"
)

type ConfirmStore interface {
	Set(ctx context.Context, token string, actionPayload string) error
	Get(ctx context.Context, token string) (string, bool)
	Delete(ctx context.Context, token string) error
}

type AdminUseCase struct {
	userRepo      domain.UserRepository
	ipRepo        domain.IPBlockRepository
	auditRepo     domain.SecurityEventRepository
	sessionRepo   domain.SessionRepository
	callRepo      domain.CallRepository
	mediaRepo     domain.MediaFileRepository
	confirmStore  ConfirmStore
	auditor       domain.SecurityAuditor
	ipBlocksCache interface {
		Block(ctx context.Context, ipHash string) error
		Unblock(ctx context.Context, ipHash string) error
	}
}

func NewAdminUseCase(
	userRepo domain.UserRepository,
	ipRepo domain.IPBlockRepository,
	auditRepo domain.SecurityEventRepository,
	sessionRepo domain.SessionRepository,
	callRepo domain.CallRepository,
	mediaRepo domain.MediaFileRepository,
	confirmStore ConfirmStore,
	auditor domain.SecurityAuditor,
	ipBlocksCache interface {
		Block(ctx context.Context, ipHash string) error
		Unblock(ctx context.Context, ipHash string) error
	},
) *AdminUseCase {
	return &AdminUseCase{
		userRepo:      userRepo,
		ipRepo:        ipRepo,
		auditRepo:     auditRepo,
		sessionRepo:   sessionRepo,
		callRepo:      callRepo,
		mediaRepo:     mediaRepo,
		confirmStore:  confirmStore,
		auditor:       auditor,
		ipBlocksCache: ipBlocksCache,
	}
}

// executeAndAudit runs an action and emits an audit event.
func (uc *AdminUseCase) executeAndAudit(ctx context.Context, action domain.AdminAction, targetUser, targetIP *string, fn func() error) error {
	err := fn()
	
	// Wait, the plan says ADR-P10-18: Admin action events are synchronous.
	// Let's use the repo directly instead of auditor channel.
	traceID := domain.TraceIDFromContext(ctx)
	var tid *string
	if traceID != "" {
		tid = &traceID
	}

	event := domain.SecurityEvent{
		ID:           uuid.New().String(),
		EventType:    domain.EventAdminAction,
		IdentityHash: targetUser,
		IPHash:       targetIP,
		TraceID:      tid,
		AdminAction:  &action,
		CreatedAt:    time.Now().Unix(),
	}
	if err == nil {
		_ = uc.auditRepo.Create(ctx, &event)
	}

	return err
}

func (uc *AdminUseCase) SuspendUser(ctx context.Context, userID string) error {
	return uc.executeAndAudit(ctx, domain.AdminActionSuspend, &userID, nil, func() error {
		now := time.Now().Unix()
		err := uc.userRepo.UpdateStatus(ctx, userID, domain.UserStatusSuspended, now)
		if err != nil {
			return err
		}
		// Invalidate sessions inside the transaction. (Since it's in a use case, the caller MUST wrap it in a transaction via WithTransaction).
		_ = uc.sessionRepo.RevokeByUserID(ctx, userID, now)
		_ = uc.sessionRepo.DeleteByUserID(ctx, userID)
		return nil
	})
}

func (uc *AdminUseCase) ResumeUser(ctx context.Context, userID string) error {
	return uc.executeAndAudit(ctx, domain.AdminActionResume, &userID, nil, func() error {
		now := time.Now().Unix()
		return uc.userRepo.UpdateStatus(ctx, userID, domain.UserStatusActive, now)
	})
}

func (uc *AdminUseCase) TombstoneUser(ctx context.Context, userID string, token string) error {
	// Validate token
	payload, ok := uc.confirmStore.Get(ctx, token)
	if !ok || payload != "tombstone:"+userID {
		return domain.NewDomainError(domain.ErrAdm001, "Unauthorized / Invalid token", nil)
	}
	uc.confirmStore.Delete(ctx, token)

	return uc.executeAndAudit(ctx, domain.AdminActionTombstone, &userID, nil, func() error {
		now := time.Now().Unix()
		err := uc.userRepo.UpdateStatus(ctx, userID, domain.UserStatusDeleted, now)
		if err != nil {
			return err
		}
		_ = uc.sessionRepo.DeleteByUserID(ctx, userID)
		return nil
	})
}

func (uc *AdminUseCase) BanIP(ctx context.Context, targetIPHash string) error {
	return uc.executeAndAudit(ctx, domain.AdminActionIPBan, nil, &targetIPHash, func() error {
		return uc.ipBlocksCache.Block(ctx, targetIPHash)
	})
}

func (uc *AdminUseCase) UnbanIP(ctx context.Context, targetIPHash string) error {
	return uc.executeAndAudit(ctx, domain.AdminActionIPUnban, nil, &targetIPHash, func() error {
		return uc.ipBlocksCache.Unblock(ctx, targetIPHash)
	})
}

func (uc *AdminUseCase) QueryAuditLogs(ctx context.Context, filter domain.SecurityEventFilter) ([]*domain.SecurityEvent, *string, error) {
	return uc.auditRepo.Query(ctx, filter)
}

func (uc *AdminUseCase) ListBlockedIPs(ctx context.Context) ([]*domain.IPBlock, error) {
	return uc.ipRepo.ListBlocked(ctx)
}

func (uc *AdminUseCase) GenerateConfirmation(ctx context.Context, action string, target string) (string, error) {
	token := uuid.New().String()
	payload := action + ":" + target
	err := uc.confirmStore.Set(ctx, token, payload)
	if err != nil {
		return "", err
	}
	return token, nil
}

func (uc *AdminUseCase) TriggerWorker(ctx context.Context, workerName string) (string, error) {
	// For now, just generate an operation ID. In a real scenario, this would post to a channel or DB queue.
	opID := uuid.New().String()
	// Optionally emit an audit event here if required, though not explicitly asked.
	return opID, nil
}
