package usecase

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"

	"rootinbox/internal/config"
	"rootinbox/internal/domain"
)

type pendingMeta struct {
	senderID   string
	receiverID string
}

// MessageUseCase implements business logic for message delivery.
// RFC-0005: WebSocket Protocol, Envelope Routing & Delivery Guarantees.
type MessageUseCase struct {
	messageRepo domain.MessageRepository
	router      domain.MessageRouter
	pushUC      domain.PushTrigger
	clock       domain.Clock
	logger      domain.Logger
	cfg         *config.Config
	auditor     domain.SecurityAuditor
	inFlight    sync.Map // clientUUID -> pendingMeta
}

// NewMessageUseCase creates a new MessageUseCase.
func NewMessageUseCase(
	messageRepo domain.MessageRepository,
	router domain.MessageRouter,
	pushUC domain.PushTrigger,
	clock domain.Clock,
	logger domain.Logger,
	cfg *config.Config,
	auditor domain.SecurityAuditor,
) *MessageUseCase {
	return &MessageUseCase{
		messageRepo: messageRepo,
		router:      router,
		pushUC:      pushUC,
		clock:       clock,
		logger:      logger,
		cfg:         cfg,
		auditor:     auditor,
	}
}

// downstreamEnvelope is a helper struct for building downstream JSON.
type downstreamEnvelope struct {
	V              int    `json:"v"`
	Type           string `json:"type"`
	RequestID      string `json:"request_id"`
	SenderID       string `json:"sender_id"`
	Payload        string `json:"payload"`
	SequenceNumber int64  `json:"sequence_number"`
	ConversationID string `json:"conversation_id,omitempty"`
	CreatedAt      int64  `json:"created_at"`
}

// SendMessage persists a message and attempts live delivery.
// RFC-0005 §6.1: Upstream Flow — persist with SQLite idempotency, then route.
// RFC-0005 §6.2: Atomic Delivery Decision — persist first, then attempt live push.
func (uc *MessageUseCase) SendMessage(ctx context.Context, senderID, clientUUID, receiverID string, encryptedPayload []byte, seqNum int64, conversationID string) error {
	// Quota Check
	since := uc.clock.NowUnix() - 3600
	count, err := uc.messageRepo.CountRecentBySenderID(ctx, senderID, since)
	if err != nil {
		return fmt.Errorf("checking message quota: %w", err)
	}
	if count >= uc.cfg.Quota.MaxMessagesPerHour {
		if uc.auditor != nil {
			ipHash, _ := domain.IPHashFromContext(ctx)
			traceID := domain.TraceIDFromContext(ctx)
			var iph, tid *string
			if ipHash != "" {
				iph = &ipHash
			}
			if traceID != "" {
				tid = &traceID
			}
			uc.auditor.Emit(domain.SecurityEvent{
				ID:           uuid.New().String(),
				EventType:    domain.EventQuotaExceeded,
				IdentityHash: &senderID,
				IPHash:       iph,
				TraceID:      tid,
				CreatedAt:    time.Now().Unix(),
			})
		}
		return domain.NewDomainError(domain.ErrSec003, "message quota exceeded", nil)
	}

	// Step 1: Persist message (INSERT OR IGNORE for idempotency).
	msg := &domain.Message{
		ClientUUID:       clientUUID,
		SenderID:         senderID,
		ReceiverID:       receiverID,
		EncryptedPayload: encryptedPayload,
		SequenceNumber:   seqNum,
		CreatedAt:        uc.clock.NowUnix(),
	}

	// Store in flight for ACK resolution
	uc.inFlight.Store(clientUUID, pendingMeta{senderID: senderID, receiverID: receiverID})

	err = uc.messageRepo.Create(ctx, msg)
	if err != nil {
		// Check for duplicate — idempotent success.
		if err == domain.ErrMessageDuplicate || err.Error() == "message already exists (idempotent)" {
			uc.logger.Info("duplicate message ignored", "client_uuid", clientUUID)
			return domain.ErrMessageDuplicate
		}
		return fmt.Errorf("persisting message: %w", err)
	}

	// Step 2: Attempt live delivery.
	// RFC-0005 §6.2: Either push live or leave in queue (already persisted).
	env := downstreamEnvelope{
		V:              1,
		Type:           domain.EnvelopeTypeChatMsg,
		RequestID:      clientUUID,
		SenderID:       senderID,
		Payload:        base64.StdEncoding.EncodeToString(encryptedPayload),
		SequenceNumber: seqNum,
		ConversationID: conversationID,
		CreatedAt:      domain.NormalizeTimestamp(msg.CreatedAt),
	}

	data, err := json.Marshal(env)
	if err != nil {
		uc.logger.Error("marshal downstream envelope failed", "error", err)
		return nil // Message is persisted, delivery will happen on next connect.
	}

	if uc.router.Route(receiverID, data) {
		uc.logger.Info("message delivered live",
			"client_uuid", clientUUID,
			"receiver_id", receiverID,
		)
	} else {
		uc.logger.Info("message queued for offline delivery",
			"client_uuid", clientUUID,
			"receiver_id", receiverID,
		)
		uc.pushUC.TriggerMessage(receiverID)
	}

	return nil
}

// AcknowledgeMessage validates that the acknowledging user is the genuine recipient,
// hard-deletes the pending message, and returns the senderID for delivery ACK routing.
// RFC-0005 §6.3: Server MUST validate that request_id belongs to a message
// pending delivery for that specific authenticated session. Then HARD DELETE.
func (uc *MessageUseCase) AcknowledgeMessage(ctx context.Context, userID, clientUUID string, seqNum int64) (string, error) {
	// Recipient Validation Guard (Self-Fanout Protection)
	msg, err := uc.messageRepo.GetPendingByClientUUIDAndReceiver(ctx, clientUUID, userID)
	if err != nil {
		return "", fmt.Errorf("validating message recipient: %w", err)
	}

	var senderID string
	if msg != nil {
		senderID = msg.SenderID
		// Hard delete message from pending queue
		_, err = uc.messageRepo.DeleteByClientUUIDAndReceiver(ctx, clientUUID, userID)
		if err != nil {
			return "", fmt.Errorf("acknowledging message: %w", err)
		}
	} else if metaRaw, ok := uc.inFlight.Load(clientUUID); ok {
		meta := metaRaw.(pendingMeta)
		if meta.receiverID == userID {
			senderID = meta.senderID
		}
	}
	uc.inFlight.Delete(clientUUID)

	if senderID == "" {
		// Attempted ACK by non-recipient (e.g. self-fanout) or already deleted - ignore safely
		return "", nil
	}

	uc.logger.Info("message acknowledged and deleted",
		"user_id", userID,
		"client_uuid", clientUUID,
	)
	return senderID, nil
}

// QueueDeliveryAck records a delivery confirmation for a sender.
func (uc *MessageUseCase) QueueDeliveryAck(ctx context.Context, senderID, requestID string) error {
	return uc.messageRepo.QueueDeliveryAck(ctx, senderID, requestID, uc.clock.NowUnix())
}

// GetDeliveryAcks returns delivery confirmations for a sender using cursor pagination.
func (uc *MessageUseCase) GetDeliveryAcks(ctx context.Context, senderID string, cursor int64, limit int) ([]*domain.DeliveryAck, error) {
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	return uc.messageRepo.GetDeliveryAcks(ctx, senderID, cursor, limit)
}

// GetPendingMessages retrieves all queued messages for a user.
// RFC-0005 §4.2: Post-Auth Flush — push pending messages on connect.
func (uc *MessageUseCase) GetPendingMessages(ctx context.Context, userID string) ([]*domain.Message, error) {
	messages, err := uc.messageRepo.GetPendingByReceiverID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("getting pending messages: %w", err)
	}
	return messages, nil
}

