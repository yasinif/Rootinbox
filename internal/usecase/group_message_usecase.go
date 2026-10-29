package usecase

import (
	"context"
	"strings"

	"rootinbox/internal/domain"
)

// GroupMessageUseCase handles permanent unified messaging in DIRECT, SELF, GROUP, and CHANNEL conversations.
// Phase 1: Unified server-authoritative message architecture with transparent encryption-at-rest.
type GroupMessageUseCase struct {
	groupMsgRepo    domain.GroupMessageRepository
	convRepo        domain.ConversationRepository
	participantRepo domain.ParticipantRepository
	clock           domain.Clock
	uuidGen         domain.UUIDGenerator
	broadcaster     domain.GroupBroadcaster
	logger          domain.Logger
	txManager       domain.TransactionManager
	pushTrigger     domain.PushTrigger
	convUC          *ConversationUseCase
}

func NewGroupMessageUseCase(
	groupMsgRepo domain.GroupMessageRepository,
	convRepo domain.ConversationRepository,
	participantRepo domain.ParticipantRepository,
	clock domain.Clock,
	uuidGen domain.UUIDGenerator,
	broadcaster domain.GroupBroadcaster,
	logger domain.Logger,
) *GroupMessageUseCase {
	return &GroupMessageUseCase{
		groupMsgRepo:    groupMsgRepo,
		convRepo:        convRepo,
		participantRepo: participantRepo,
		clock:           clock,
		uuidGen:         uuidGen,
		broadcaster:     broadcaster,
		logger:          logger,
	}
}

// SetBroadcaster updates the group broadcaster (e.g. after WS Hub is instantiated).
func (uc *GroupMessageUseCase) SetBroadcaster(b domain.GroupBroadcaster) {
	uc.broadcaster = b
}

// SetTxManager wires transaction manager for atomic sequence allocation and saving.
func (uc *GroupMessageUseCase) SetTxManager(tx domain.TransactionManager) {
	uc.txManager = tx
}

// SetPushTrigger wires web push notification trigger for offline recipients.
func (uc *GroupMessageUseCase) SetPushTrigger(pt domain.PushTrigger) {
	uc.pushTrigger = pt
}

// SetConversationUseCase wires conversation use case for delivery watermark updates.
func (uc *GroupMessageUseCase) SetConversationUseCase(convUC *ConversationUseCase) {
	uc.convUC = convUC
}

const maxContentLen = 65536 // 64 KB

// SendMessage stores and fans out a message in any conversation (DIRECT, SELF, GROUP, CHANNEL).
// Phase 1: Unified permanent message store for all conversations with idempotency.
func (uc *GroupMessageUseCase) SendMessage(
	ctx context.Context,
	senderID string,
	convID string,
	content string,
	replyToID *string,
	clientMsgID ...string,
) (*domain.GroupMessage, error) {
	content = strings.TrimSpace(content)
	if content == "" {
		return nil, domain.NewDomainError(domain.ErrSys001, "message content cannot be empty", nil)
	}
	if len(content) > maxContentLen {
		return nil, domain.NewDomainError(domain.ErrSys001, "message content exceeds 64KB limit", nil)
	}
	if !domain.IsValidMessageContent(content) {
		return nil, domain.NewDomainError(domain.ErrSys001, "invalid message content: corrupted or binary data rejected", nil)
	}

	conv, err := uc.convRepo.GetByID(ctx, convID)
	if err != nil {
		return nil, err
	}

	part, err := uc.participantRepo.GetByConversationAndUser(ctx, convID, senderID)
	if err != nil {
		return nil, domain.NewDomainError(domain.ErrGrp002, "sender is not a participant of this conversation", err)
	}

	// Channel broadcast posting rule: Only OWNER and ADMIN can post in CHANNEL
	if conv.Type == domain.ConvTypeChannel && part.Role != domain.RoleOwner && part.Role != domain.RoleAdmin {
		return nil, domain.NewDomainError(domain.ErrGrp002, "only channel admins can post messages", nil)
	}

	var validReplyTo *string
	if replyToID != nil && *replyToID != "" {
		parent, err := uc.groupMsgRepo.GetByID(ctx, *replyToID)
		if err == nil && parent != nil && parent.ConversationID == convID {
			validReplyTo = replyToID
		}
	}

	msgID := uc.uuidGen.New()
	if len(clientMsgID) > 0 && clientMsgID[0] != "" {
		msgID = clientMsgID[0]
	}

	// Idempotency: If message with same UUID exists, return it immediately
	if existing, err := uc.groupMsgRepo.GetByID(ctx, msgID); err == nil && existing != nil {
		return existing, nil
	}

	nowNorm := domain.NormalizeTimestamp(uc.clock.NowUnix())
	msg := &domain.GroupMessage{
		ID:             msgID,
		ConversationID: convID,
		SenderID:       senderID,
		Content:        content,
		ReplyToID:      validReplyTo,
		CreatedAt:      nowNorm,
	}

	// Phase 1: Atomic sequence allocation and message persistence inside single transaction
	saveAction := func(txCtx context.Context) error {
		return uc.groupMsgRepo.Save(txCtx, msg)
	}

	if uc.txManager != nil {
		if err := uc.txManager.WithinTransaction(ctx, saveAction); err != nil {
			return nil, domain.NewDomainError(domain.ErrDB002, "saving message", err)
		}
	} else {
		if err := saveAction(ctx); err != nil {
			return nil, domain.NewDomainError(domain.ErrDB002, "saving message", err)
		}
	}

	// Fan-out to online participants via WebSocket and record delivery watermarks
	var onlineRecipients []string
	if uc.broadcaster != nil {
		parts, err := uc.participantRepo.ListByConversationID(ctx, convID)
		if err == nil {
			recipients := make([]string, len(parts))
			for i, p := range parts {
				recipients[i] = p.UserID
			}
			uc.broadcaster.BroadcastGroupMessage(recipients, msg)

			type onlineChecker interface {
				IsOnline(string) bool
			}
			type ackDeliveredSender interface {
				BroadcastAckDelivered(string, string, string, int64)
			}
			if oc, ok := uc.broadcaster.(onlineChecker); ok {
				for _, uid := range recipients {
					if uid != senderID && oc.IsOnline(uid) {
						onlineRecipients = append(onlineRecipients, uid)
						if uc.convUC != nil {
							_ = uc.convUC.SetDeliveryWatermark(ctx, uid, convID, msg.CreatedAt)
						}
						if ads, ok := uc.broadcaster.(ackDeliveredSender); ok {
							ads.BroadcastAckDelivered(senderID, convID, msg.ID, msg.CreatedAt)
						}
					}
				}
			}

			// Trigger Web Push wake notifications for offline recipients in DIRECT, GROUP, or CHANNEL conversations
			if uc.pushTrigger != nil && (conv.Type == domain.ConvTypeDirect || conv.Type == domain.ConvTypeGroup || conv.Type == domain.ConvTypeChannel) {
				for _, p := range parts {
					if p.UserID != senderID {
						isOnline := false
						for _, onID := range onlineRecipients {
							if onID == p.UserID {
								isOnline = true
								break
							}
						}
						if !isOnline {
							uc.pushTrigger.TriggerMessage(p.UserID)
						}
					}
				}
			}
		}
	}

	return msg, nil
}

// GetByID retrieves a message by its ID.
func (uc *GroupMessageUseCase) GetByID(ctx context.Context, id string) (*domain.GroupMessage, error) {
	return uc.groupMsgRepo.GetByID(ctx, id)
}

// ListMessages retrieves cursor-paginated messages for a conversation.
func (uc *GroupMessageUseCase) ListMessages(
	ctx context.Context,
	userID string,
	convID string,
	beforeServerID int64,
	limit int,
) ([]*domain.GroupMessage, error) {
	_, err := uc.participantRepo.GetByConversationAndUser(ctx, convID, userID)
	if err != nil {
		return nil, domain.NewDomainError(domain.ErrGrp002, "user is not a participant of this conversation", err)
	}

	clearedAt := int64(0)
	if uc.convUC != nil {
		clearedAt, _ = uc.convUC.GetClearedAt(ctx, userID, convID)
	}

	messages, err := uc.groupMsgRepo.ListByConversation(ctx, convID, beforeServerID, limit)
	if err != nil {
		return nil, err
	}

	if clearedAt > 0 {
		filtered := make([]*domain.GroupMessage, 0, len(messages))
		for _, m := range messages {
			if domain.NormalizeTimestamp(m.CreatedAt) > clearedAt {
				filtered = append(filtered, m)
			}
		}
		return filtered, nil
	}

	return messages, nil
}

// EditMessage edits a message (author only, within 24h).
func (uc *GroupMessageUseCase) EditMessage(
	ctx context.Context,
	userID string,
	convID string,
	msgID string,
	newContent string,
) (*domain.GroupMessage, error) {
	newContent = strings.TrimSpace(newContent)
	if newContent == "" {
		return nil, domain.NewDomainError(domain.ErrSys001, "message content cannot be empty", nil)
	}
	if len(newContent) > maxContentLen {
		return nil, domain.NewDomainError(domain.ErrSys001, "message content exceeds 64KB limit", nil)
	}

	msg, err := uc.groupMsgRepo.GetByID(ctx, msgID)
	if err != nil {
		return nil, err
	}
	if msg.ConversationID != convID {
		return nil, domain.NewDomainError(domain.ErrGrp001, "message does not belong to conversation", nil)
	}
	if msg.SenderID != userID {
		return nil, domain.NewDomainError(domain.ErrGrp002, "only the message author can edit the message", nil)
	}

	now := uc.clock.NowUnix()
	nowNorm := domain.NormalizeTimestamp(now)
	if (nowNorm - msg.CreatedAt) > 24*3600*1000 {
		return nil, domain.NewDomainError(domain.ErrGrp002, "message edit window (24h) has expired", nil)
	}

	if err := uc.groupMsgRepo.UpdateContent(ctx, msgID, newContent, nowNorm); err != nil {
		return nil, err
	}

	msg.Content = newContent
	msg.EditedAt = &nowNorm

	if uc.broadcaster != nil {
		parts, err := uc.participantRepo.ListByConversationID(ctx, convID)
		if err == nil {
			recipients := make([]string, len(parts))
			for i, p := range parts {
				recipients[i] = p.UserID
			}
			uc.broadcaster.BroadcastGroupAction(recipients, "edit", map[string]interface{}{
				"id":              msgID,
				"conversation_id": convID,
				"content":         newContent,
				"edited_at":       nowNorm,
			})
		}
	}

	return msg, nil
}

// DeleteMessage deletes a message (author deletes own; ADMIN/OWNER delete any in group/channel).
func (uc *GroupMessageUseCase) DeleteMessage(
	ctx context.Context,
	userID string,
	convID string,
	msgID string,
) error {
	msg, err := uc.groupMsgRepo.GetByID(ctx, msgID)
	if err != nil {
		return err
	}
	if msg.ConversationID != convID {
		return domain.NewDomainError(domain.ErrGrp001, "message does not belong to conversation", nil)
	}

	part, err := uc.participantRepo.GetByConversationAndUser(ctx, convID, userID)
	if err != nil {
		return domain.NewDomainError(domain.ErrGrp002, "user is not a participant of this conversation", err)
	}

	isAuthor := msg.SenderID == userID
	isAdmin := part.Role == domain.RoleOwner || part.Role == domain.RoleAdmin
	if !isAuthor && !isAdmin {
		return domain.NewDomainError(domain.ErrGrp002, "insufficient permissions to delete message", nil)
	}

	now := uc.clock.NowUnix()
	nowNorm := domain.NormalizeTimestamp(now)
	if err := uc.groupMsgRepo.SoftDelete(ctx, msgID, nowNorm); err != nil {
		return err
	}

	if uc.broadcaster != nil {
		parts, err := uc.participantRepo.ListByConversationID(ctx, convID)
		if err == nil {
			recipients := make([]string, len(parts))
			for i, p := range parts {
				recipients[i] = p.UserID
			}
			uc.broadcaster.BroadcastGroupAction(recipients, "delete", map[string]interface{}{
				"id":              msgID,
				"conversation_id": convID,
				"deleted_at":      nowNorm,
			})
		}
	}

	return nil
}
