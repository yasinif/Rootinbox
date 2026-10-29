package usecase

import (
	"context"
	"encoding/json"
	"fmt"

	"rootinbox/internal/domain"
)

// SyncUseCase implements business logic for REST-based message sync.
// RFC-0006 §4.2: REST Pending Sync (Idempotent & Cursor-Based).
type SyncUseCase struct {
	messageRepo domain.MessageRepository
	router      domain.MessageRouter
	clock       domain.Clock
	logger      domain.Logger
}

// NewSyncUseCase creates a new SyncUseCase.
func NewSyncUseCase(
	messageRepo domain.MessageRepository,
	router domain.MessageRouter,
	clock domain.Clock,
	logger domain.Logger,
) *SyncUseCase {
	return &SyncUseCase{
		messageRepo: messageRepo,
		router:      router,
		clock:       clock,
		logger:      logger,
	}
}

// GetPendingPaginated retrieves pending messages with cursor-based pagination.
// RFC-0006 §4.2: GET /api/v1/messages/pending?limit=100&cursor=<last_server_message_id>.
func (uc *SyncUseCase) GetPendingPaginated(ctx context.Context, userID string, cursor int64, limit int) ([]*domain.Message, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}

	messages, err := uc.messageRepo.GetPendingPaginated(ctx, userID, cursor, limit)
	if err != nil {
		return nil, fmt.Errorf("getting pending messages: %w", err)
	}
	return messages, nil
}

// AcknowledgeMessages batch validates recipient ownership, hard-deletes messages, and routes delivery receipts.
// RFC-0006 §4.2: POST /api/v1/messages/ack with array of client_uuids.
func (uc *SyncUseCase) AcknowledgeMessages(ctx context.Context, userID string, clientUUIDs []string) (int64, error) {
	if len(clientUUIDs) == 0 {
		return 0, nil
	}

	// Cap batch size to prevent abuse.
	if len(clientUUIDs) > 500 {
		return 0, domain.NewDomainError(domain.ErrSys001, "batch size exceeds maximum (500)", nil)
	}

	// 1. Resolve senders ONLY for messages where receiver_id == userID
	senders, err := uc.messageRepo.GetSendersByClientUUIDsAndReceiver(ctx, clientUUIDs, userID)
	if err != nil {
		uc.logger.Error("failed to resolve senders for delivery acks", "error", err)
	}

	// 2. Hard delete acknowledged messages from pending queue strictly matching receiver_id
	deleted, err := uc.messageRepo.DeleteByClientUUIDsAndReceiver(ctx, clientUUIDs, userID)
	if err != nil {
		return 0, fmt.Errorf("acknowledging messages: %w", err)
	}

	// 3. Dispatch and persist ack.delivered for senders
	var now int64
	if uc.clock != nil {
		now = uc.clock.NowUnix()
	}
	for clientUUID, senderID := range senders {
		if senderID == "" {
			continue
		}
		// Persist for offline sender and multi-device catchup
		_ = uc.messageRepo.QueueDeliveryAck(ctx, senderID, clientUUID, now)

		// Route live to any currently connected sessions of the sender
		if uc.router != nil {
			ackEnv := map[string]interface{}{
				"v":          1,
				"type":       domain.EnvelopeTypeAckDelivered,
				"request_id": clientUUID,
			}
			if ackData, err := json.Marshal(ackEnv); err == nil {
				uc.router.Route(senderID, ackData)
			}
		}
	}

	uc.logger.Info("messages acknowledged and delivery acks processed",
		"user_id", userID,
		"requested", len(clientUUIDs),
		"deleted", deleted,
		"senders_notified", len(senders),
	)
	return deleted, nil
}

// GetDeliveryAcks retrieves delivery confirmations for a sender using cursor pagination.
func (uc *SyncUseCase) GetDeliveryAcks(ctx context.Context, userID string, cursor int64, limit int) ([]*domain.DeliveryAck, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	return uc.messageRepo.GetDeliveryAcks(ctx, userID, cursor, limit)
}
