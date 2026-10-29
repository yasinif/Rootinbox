package usecase

import (
	"context"
	"fmt"
	"strings"

	"rootinbox/internal/domain"
)

// ConversationUseCase implements business logic for Conversation operations.
// RFC-0001 §3: Dependencies are injected, no global singletons.
type ConversationUseCase struct {
	convRepo        domain.ConversationRepository
	participantRepo domain.ParticipantRepository
	txManager       domain.TransactionManager
	clock           domain.Clock
	uuidGen         domain.UUIDGenerator
	logger          domain.Logger
}

// NewConversationUseCase creates a new ConversationUseCase with all required dependencies.
func NewConversationUseCase(
	convRepo domain.ConversationRepository,
	participantRepo domain.ParticipantRepository,
	txManager domain.TransactionManager,
	clock domain.Clock,
	uuidGen domain.UUIDGenerator,
	logger domain.Logger,
) *ConversationUseCase {
	return &ConversationUseCase{
		convRepo:        convRepo,
		participantRepo: participantRepo,
		txManager:       txManager,
		clock:           clock,
		uuidGen:         uuidGen,
		logger:          logger,
	}
}

// withinImmediateTx executes fn inside an immediate transaction if supported by txManager,
// falling back safely to WithinTransaction to guarantee compile-time safety and mock compatibility.
func (uc *ConversationUseCase) withinImmediateTx(ctx context.Context, fn func(ctx context.Context) error) error {
	if itx, ok := uc.txManager.(interface {
		WithinImmediateTransaction(ctx context.Context, fn func(ctx context.Context) error) error
	}); ok {
		return itx.WithinImmediateTransaction(ctx, fn)
	}
	return uc.txManager.WithinTransaction(ctx, fn)
}

// SetReadWatermark records a conversation read watermark.
func (uc *ConversationUseCase) SetReadWatermark(ctx context.Context, userID, convID string, lastReadAt int64) error {
	if wmRepo, ok := uc.convRepo.(domain.ReadWatermarkRepository); ok {
		return wmRepo.SetWatermark(ctx, userID, convID, lastReadAt)
	}
	return nil
}

// SetDeliveryWatermark records a conversation delivery watermark.
func (uc *ConversationUseCase) SetDeliveryWatermark(ctx context.Context, userID, convID string, lastDeliveredAt int64) error {
	if wmRepo, ok := uc.convRepo.(domain.ReadWatermarkRepository); ok {
		return wmRepo.SetDeliveryWatermark(ctx, userID, convID, lastDeliveredAt)
	}
	return nil
}

// GetDeliveryWatermark retrieves the delivery watermark for a specific user and conversation.
func (uc *ConversationUseCase) GetDeliveryWatermark(ctx context.Context, userID, convID string) (int64, error) {
	if wmRepo, ok := uc.convRepo.(domain.ReadWatermarkRepository); ok {
		return wmRepo.GetDeliveryWatermark(ctx, userID, convID)
	}
	return 0, nil
}

// GetPeerWatermarks retrieves the highest read and delivery watermarks among other participants.
func (uc *ConversationUseCase) GetPeerWatermarks(ctx context.Context, convID, currentUserID string) (int64, int64, error) {
	if wmRepo, ok := uc.convRepo.(domain.ReadWatermarkRepository); ok {
		return wmRepo.GetPeerWatermarks(ctx, convID, currentUserID)
	}
	return 0, 0, nil
}

// GetReadWatermarks returns all conversation read watermarks for a user.
func (uc *ConversationUseCase) GetReadWatermarks(ctx context.Context, userID string) (map[string]int64, error) {
	if wmRepo, ok := uc.convRepo.(domain.ReadWatermarkRepository); ok {
		return wmRepo.GetWatermarksForUser(ctx, userID)
	}
	return make(map[string]int64), nil
}

// GetWatermark retrieves the read watermark for a specific user and conversation.
func (uc *ConversationUseCase) GetWatermark(ctx context.Context, userID, convID string) (int64, error) {
	if wmRepo, ok := uc.convRepo.(domain.ReadWatermarkRepository); ok {
		return wmRepo.GetWatermark(ctx, userID, convID)
	}
	return 0, nil
}

// SetClearedAt records the cleared watermark for a specific user and conversation.
func (uc *ConversationUseCase) SetClearedAt(ctx context.Context, userID, convID string, clearedAt int64) error {
	if wmRepo, ok := uc.convRepo.(domain.ReadWatermarkRepository); ok {
		return wmRepo.SetClearedAt(ctx, userID, convID, clearedAt)
	}
	return nil
}

// GetClearedAt retrieves the cleared watermark for a specific user and conversation.
func (uc *ConversationUseCase) GetClearedAt(ctx context.Context, userID, convID string) (int64, error) {
	if wmRepo, ok := uc.convRepo.(domain.ReadWatermarkRepository); ok {
		return wmRepo.GetClearedAt(ctx, userID, convID)
	}
	return 0, nil
}

// SetHiddenAt records the hidden watermark for a specific user and conversation.
func (uc *ConversationUseCase) SetHiddenAt(ctx context.Context, userID, convID string, hiddenAt int64) error {
	if wmRepo, ok := uc.convRepo.(domain.ReadWatermarkRepository); ok {
		return wmRepo.SetHiddenAt(ctx, userID, convID, hiddenAt)
	}
	return nil
}

// GetHiddenAt retrieves the hidden watermark for a specific user and conversation.
func (uc *ConversationUseCase) GetHiddenAt(ctx context.Context, userID, convID string) (int64, error) {
	if wmRepo, ok := uc.convRepo.(domain.ReadWatermarkRepository); ok {
		return wmRepo.GetHiddenAt(ctx, userID, convID)
	}
	return 0, nil
}

// FindDirectConversationID returns the ID of the DIRECT conversation between userA and userB, if one exists.
func (uc *ConversationUseCase) FindDirectConversationID(ctx context.Context, userA, userB string) (string, error) {
	if uc.participantRepo == nil || uc.convRepo == nil {
		return "", nil
	}
	parts, err := uc.participantRepo.ListByUserID(ctx, userA)
	if err != nil {
		return "", err
	}
	for _, p := range parts {
		peerPart, err := uc.participantRepo.GetByConversationAndUser(ctx, p.ConversationID, userB)
		if err == nil && peerPart != nil {
			conv, err := uc.convRepo.GetByID(ctx, p.ConversationID)
			if err == nil && conv != nil && conv.Type == domain.ConvTypeDirect {
				return conv.ID, nil
			}
		}
	}
	return "", nil
}

// CreateConversation creates a new conversation with the specified participants.
// The creator receives the OWNER role; other participants receive the MEMBER role.
// RFC-0001A §4.1: Uses TransactionManager for atomic creation.
func (uc *ConversationUseCase) CreateConversation(
	ctx context.Context,
	convType domain.ConversationType,
	creatorID string,
	participantIDs []string,
) (*domain.Conversation, error) {
	now := uc.clock.NowUnix()

	conv := &domain.Conversation{
		ID:        uc.uuidGen.New(),
		Type:      convType,
		CreatedAt: now,
	}

	err := uc.txManager.WithinTransaction(ctx, func(ctx context.Context) error {
		// Create conversation.
		if err := uc.convRepo.Create(ctx, conv); err != nil {
			return domain.NewDomainError(domain.ErrDB002, "creating conversation", err)
		}

		// Add creator as OWNER.
		owner := &domain.Participant{
			ConversationID: conv.ID,
			UserID:         creatorID,
			Role:           domain.RoleOwner,
			JoinedAt:       now,
		}
		if err := uc.participantRepo.Create(ctx, owner); err != nil {
			return domain.NewDomainError(domain.ErrDB002, "adding conversation owner", err)
		}

		// Add other participants as MEMBER.
		for _, uid := range participantIDs {
			if uid == creatorID {
				continue // Skip creator, already added as OWNER.
			}
			member := &domain.Participant{
				ConversationID: conv.ID,
				UserID:         uid,
				Role:           domain.RoleMember,
				JoinedAt:       now,
			}
			if err := uc.participantRepo.Create(ctx, member); err != nil {
				return domain.NewDomainError(domain.ErrDB002, "adding conversation member", err)
			}
		}

		return nil
	})
	if err != nil {
		return nil, err
	}

	uc.logger.Info("conversation created",
		"conversation_id", conv.ID,
		"type", string(conv.Type),
		"participants", len(participantIDs)+1,
	)
	return conv, nil
}

// GetConversation retrieves a conversation by ID.
func (uc *ConversationUseCase) GetConversation(ctx context.Context, id string) (*domain.Conversation, error) {
	conv, err := uc.convRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	return conv, nil
}

// ListConversationsForUser lists conversations for a user with cursor-based pagination.
// RFC-0002 §4.5: Traditional OFFSET/LIMIT pagination is FORBIDDEN.
func (uc *ConversationUseCase) ListConversationsForUser(
	ctx context.Context,
	userID string,
	cursorStr string,
	limit int,
) ([]*domain.Conversation, *domain.Cursor, error) {
	// Default limit.
	if limit <= 0 || limit > 100 {
		limit = 20
	}

	// Decode cursor if provided.
	// RFC-0002 §6 F1: Base64URL cursor MUST be decoded and structurally validated.
	var cursor *domain.Cursor
	if cursorStr != "" {
		var err error
		cursor, err = domain.DecodeCursor(cursorStr)
		if err != nil {
			return nil, nil, domain.NewDomainError(domain.ErrSys001, "invalid pagination cursor", err)
		}
	}

	convs, nextCursor, err := uc.convRepo.ListByUserID(ctx, userID, cursor, limit)
	if err != nil {
		return nil, nil, domain.NewDomainError(domain.ErrDB002, "listing conversations", err)
	}

	return convs, nextCursor, nil
}

// CreateDirectConversation creates or returns an existing DIRECT conversation
// between the caller and a peer.
// Phase 12 / Task 0.5: Idempotent — if a DIRECT conversation already exists
// between these two users, returns it instead of creating a duplicate.
// MUST run inside ONE BEGIN IMMEDIATE transaction (check-then-create split
// would allow race-condition duplicate conversations).
func (uc *ConversationUseCase) CreateDirectConversation(
	ctx context.Context,
	callerID string,
	peerID string,
) (*domain.Conversation, error) {
	if callerID == peerID {
		return nil, domain.NewDomainError(domain.ErrSys001, "cannot create conversation with self", nil)
	}

	var conv *domain.Conversation

	err := uc.withinImmediateTx(ctx, func(txCtx context.Context) error {
		now := uc.clock.NowUnix()

		// Check if a DIRECT conversation already exists between these two users.
		// List caller's participations, then check each for the peer.
		callerParts, err := uc.participantRepo.ListByUserID(txCtx, callerID)
		if err != nil {
			return domain.NewDomainError(domain.ErrDB002, "listing caller participations", err)
		}

		for _, cp := range callerParts {
			// Check if peer is also in this conversation.
			peerPart, err := uc.participantRepo.GetByConversationAndUser(txCtx, cp.ConversationID, peerID)
			if err != nil {
				continue // Not found, try next.
			}
			if peerPart != nil {
				// Found existing conversation — check if it's DIRECT.
				existing, err := uc.convRepo.GetByID(txCtx, cp.ConversationID)
				if err != nil {
					continue
				}
				if existing.Type == domain.ConvTypeDirect {
					conv = existing
					return nil // Idempotent: return existing.
				}
			}
		}

		// No existing DIRECT conversation — create one.
		conv = &domain.Conversation{
			ID:        uc.uuidGen.New(),
			Type:      domain.ConvTypeDirect,
			CreatedAt: now,
		}
		if err := uc.convRepo.Create(txCtx, conv); err != nil {
			return domain.NewDomainError(domain.ErrDB002, "creating conversation", err)
		}

		// Add caller as OWNER.
		owner := &domain.Participant{
			ConversationID: conv.ID,
			UserID:         callerID,
			Role:           domain.RoleOwner,
			JoinedAt:       now,
		}
		if err := uc.participantRepo.Create(txCtx, owner); err != nil {
			return domain.NewDomainError(domain.ErrDB002, "adding conversation owner", err)
		}

		// Add peer as MEMBER.
		member := &domain.Participant{
			ConversationID: conv.ID,
			UserID:         peerID,
			Role:           domain.RoleMember,
			JoinedAt:       now,
		}
		if err := uc.participantRepo.Create(txCtx, member); err != nil {
			return domain.NewDomainError(domain.ErrDB002, "adding conversation member", err)
		}

		return nil
	})

	if err != nil {
		return nil, err
	}

	uc.logger.Info("direct conversation ensured",
		"conversation_id", conv.ID,
		"caller_id", callerID,
		"peer_id", peerID,
	)
	return conv, nil
}

// GetOrCreateSelfConversation creates or returns an existing SELF conversation
// ("My Notes") for the caller.
// Idempotent: ensures exactly one SELF conversation per user.
func (uc *ConversationUseCase) GetOrCreateSelfConversation(
	ctx context.Context,
	userID string,
) (*domain.Conversation, error) {
	var conv *domain.Conversation

	err := uc.withinImmediateTx(ctx, func(txCtx context.Context) error {
		now := uc.clock.NowUnix()

		// Check if a SELF conversation already exists for this user.
		parts, err := uc.participantRepo.ListByUserID(txCtx, userID)
		if err != nil {
			return domain.NewDomainError(domain.ErrDB002, "listing caller participations", err)
		}

		for _, p := range parts {
			existing, err := uc.convRepo.GetByID(txCtx, p.ConversationID)
			if err != nil {
				continue
			}
			if existing.Type == domain.ConvTypeSelf {
				conv = existing
				return nil // Idempotent match found.
			}
		}

		// None found — create a new SELF conversation.
		conv = &domain.Conversation{
			ID:        uc.uuidGen.New(),
			Type:      domain.ConvTypeSelf,
			CreatedAt: now,
		}
		if err := uc.convRepo.Create(txCtx, conv); err != nil {
			return domain.NewDomainError(domain.ErrDB002, "creating self conversation", err)
		}

		// Add caller as OWNER.
		owner := &domain.Participant{
			ConversationID: conv.ID,
			UserID:         userID,
			Role:           domain.RoleOwner,
			JoinedAt:       now,
		}
		if err := uc.participantRepo.Create(txCtx, owner); err != nil {
			return domain.NewDomainError(domain.ErrDB002, "adding self conversation owner", err)
		}

		return nil
	})

	if err != nil {
		return nil, err
	}

	uc.logger.Info("self conversation ensured",
		"conversation_id", conv.ID,
		"user_id", userID,
	)
	return conv, nil
}

// CreateGroupOrChannel creates a non-E2EE GROUP or CHANNEL conversation per Amendment RFC-0007-B.
func (uc *ConversationUseCase) CreateGroupOrChannel(
	ctx context.Context,
	creatorID string,
	convType domain.ConversationType,
	name string,
	description string,
	participantIDs []string,
	isPublic bool,
	username string,
) (*domain.Conversation, error) {
	if convType != domain.ConvTypeGroup && convType != domain.ConvTypeChannel {
		return nil, domain.NewDomainError(domain.ErrSys001, "invalid conversation type for group/channel", nil)
	}
	if name == "" {
		return nil, domain.NewDomainError(domain.ErrSys001, "conversation name is required", nil)
	}

	// Filter and deduplicate participant IDs, removing creator if present
	uniqueParticipants := make(map[string]struct{})
	for _, id := range participantIDs {
		if id != "" && id != creatorID {
			uniqueParticipants[id] = struct{}{}
		}
	}
	dedupedIDs := make([]string, 0, len(uniqueParticipants))
	for id := range uniqueParticipants {
		dedupedIDs = append(dedupedIDs, id)
	}

	// For GROUP: validate 1-256 participants (including creator)
	if convType == domain.ConvTypeGroup {
		totalCount := len(dedupedIDs) + 1
		if totalCount < 1 || totalCount > 256 {
			return nil, domain.NewDomainError(domain.ErrGrp003, "group must have between 1 and 256 members", nil)
		}
	}

	now := uc.clock.NowUnix()
	var descPtr *string
	if description != "" {
		descPtr = &description
	}

	// Generate random invite code (16 hex chars)
	rawCode := strings.ReplaceAll(uc.uuidGen.New(), "-", "")
	if len(rawCode) > 16 {
		rawCode = rawCode[:16]
	}
	inviteCode := fmt.Sprintf("inv_%s", rawCode)

	var cleanUsername *string
	if isPublic && username != "" {
		u := strings.TrimPrefix(strings.TrimSpace(username), "@")
		if len(u) < 3 || len(u) > 32 {
			return nil, domain.NewDomainError(domain.ErrUsr004, "public username must be 3-32 characters", nil)
		}
		for _, r := range u {
			if !((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_') {
				return nil, domain.NewDomainError(domain.ErrUsr004, "public username contains invalid characters", nil)
			}
		}
		existing, err := uc.convRepo.GetByUsername(ctx, u)
		if err == nil && existing != nil {
			return nil, domain.NewDomainError(domain.ErrUsr005, "username already taken", nil)
		}
		uLower := strings.ToLower(u)
		cleanUsername = &uLower
	}

	conv := &domain.Conversation{
		ID:          uc.uuidGen.New(),
		Type:        convType,
		CreatedAt:   now,
		Name:        &name,
		Description: descPtr,
		CreatedBy:   &creatorID,
		IsPublic:    isPublic,
		Username:    cleanUsername,
		InviteCode:  &inviteCode,
	}

	err := uc.txManager.WithinTransaction(ctx, func(txCtx context.Context) error {
		if err := uc.convRepo.Create(txCtx, conv); err != nil {
			return domain.NewDomainError(domain.ErrDB002, "creating group/channel conversation", err)
		}

		// Add creator as OWNER
		owner := &domain.Participant{
			ConversationID: conv.ID,
			UserID:         creatorID,
			Role:           domain.RoleOwner,
			JoinedAt:       now,
		}
		if err := uc.participantRepo.Create(txCtx, owner); err != nil {
			return domain.NewDomainError(domain.ErrDB002, "adding conversation owner", err)
		}

		// Add other participants
		defaultRole := domain.RoleMember
		if convType == domain.ConvTypeChannel {
			defaultRole = domain.RoleSubscriber
		}

		for _, uid := range dedupedIDs {
			p := &domain.Participant{
				ConversationID: conv.ID,
				UserID:         uid,
				Role:           defaultRole,
				JoinedAt:       now,
			}
			if err := uc.participantRepo.Create(txCtx, p); err != nil {
				return domain.NewDomainError(domain.ErrDB002, "adding conversation participant", err)
			}
		}

		return nil
	})

	if err != nil {
		return nil, err
	}

	uc.logger.Info("group/channel created",
		"conversation_id", conv.ID,
		"type", string(conv.Type),
		"name", name,
		"participants", len(dedupedIDs)+1,
		"is_public", conv.IsPublic,
	)
	return conv, nil
}

// JoinConversationByInvite allows a user to join a group or channel using its invite code.
func (uc *ConversationUseCase) JoinConversationByInvite(
	ctx context.Context,
	userID string,
	inviteCode string,
) (*domain.Conversation, error) {
	if inviteCode == "" {
		return nil, domain.NewDomainError(domain.ErrSys001, "invite code is required", nil)
	}

	conv, err := uc.convRepo.GetByInviteCode(ctx, inviteCode)
	if err != nil {
		return nil, err
	}

	// Check if already a member
	existing, err := uc.participantRepo.GetByConversationAndUser(ctx, conv.ID, userID)
	if err == nil && existing != nil {
		return conv, nil // Already a member, idempotent success
	}

	role := domain.RoleMember
	if conv.Type == domain.ConvTypeChannel {
		role = domain.RoleSubscriber
	}

	now := uc.clock.NowUnix()
	p := &domain.Participant{
		ConversationID: conv.ID,
		UserID:         userID,
		Role:           role,
		JoinedAt:       now,
	}
	if err := uc.participantRepo.Create(ctx, p); err != nil {
		return nil, domain.NewDomainError(domain.ErrDB002, "joining conversation", err)
	}

	uc.logger.Info("user joined conversation via invite",
		"conversation_id", conv.ID,
		"user_id", userID,
		"invite_code", inviteCode,
	)
	return conv, nil
}

// JoinPublicConversation allows a user to join a public group or channel by its username.
func (uc *ConversationUseCase) JoinPublicConversation(
	ctx context.Context,
	userID string,
	username string,
) (*domain.Conversation, error) {
	clean := strings.TrimPrefix(strings.TrimSpace(username), "@")
	if clean == "" {
		return nil, domain.NewDomainError(domain.ErrSys001, "username is required", nil)
	}

	conv, err := uc.convRepo.GetByUsername(ctx, clean)
	if err != nil {
		return nil, err
	}

	// Check if already a member
	existing, err := uc.participantRepo.GetByConversationAndUser(ctx, conv.ID, userID)
	if err == nil && existing != nil {
		return conv, nil // Already a member
	}

	role := domain.RoleMember
	if conv.Type == domain.ConvTypeChannel {
		role = domain.RoleSubscriber
	}

	now := uc.clock.NowUnix()
	p := &domain.Participant{
		ConversationID: conv.ID,
		UserID:         userID,
		Role:           role,
		JoinedAt:       now,
	}
	if err := uc.participantRepo.Create(ctx, p); err != nil {
		return nil, domain.NewDomainError(domain.ErrDB002, "joining public conversation", err)
	}

	uc.logger.Info("user joined public conversation",
		"conversation_id", conv.ID,
		"user_id", userID,
		"username", clean,
	)
	return conv, nil
}

// SearchPublicConversations searches public groups and channels by username or name.
func (uc *ConversationUseCase) SearchPublicConversations(
	ctx context.Context,
	query string,
	limit int,
) ([]*domain.Conversation, error) {
	clean := strings.TrimPrefix(strings.TrimSpace(query), "@")
	if clean == "" {
		return []*domain.Conversation{}, nil
	}
	if limit <= 0 || limit > 50 {
		limit = 20
	}
	return uc.convRepo.SearchPublic(ctx, clean, limit)
}

// AddMember adds a user to a group or channel.
func (uc *ConversationUseCase) AddMember(
	ctx context.Context,
	callerID string,
	convID string,
	targetUserID string,
	role domain.ParticipantRole,
) error {
	conv, err := uc.convRepo.GetByID(ctx, convID)
	if err != nil {
		return err
	}
	if conv.Type != domain.ConvTypeGroup && conv.Type != domain.ConvTypeChannel {
		return domain.NewDomainError(domain.ErrGrp001, "cannot add members to direct/self conversations", nil)
	}

	callerPart, err := uc.participantRepo.GetByConversationAndUser(ctx, convID, callerID)
	if err != nil {
		return domain.NewDomainError(domain.ErrGrp002, "caller is not a member of this conversation", err)
	}

	// In channel, only OWNER or ADMIN can add members
	if conv.Type == domain.ConvTypeChannel && callerPart.Role != domain.RoleOwner && callerPart.Role != domain.RoleAdmin {
		return domain.NewDomainError(domain.ErrGrp002, "only channel admins can add members", nil)
	}

	// For group, verify limit <= 256
	if conv.Type == domain.ConvTypeGroup {
		parts, err := uc.participantRepo.ListByConversationID(ctx, convID)
		if err != nil {
			return err
		}
		if len(parts) >= 256 {
			return domain.NewDomainError(domain.ErrGrp003, "group has reached maximum capacity (256 members)", nil)
		}
	}

	// Check if already in conversation
	existing, _ := uc.participantRepo.GetByConversationAndUser(ctx, convID, targetUserID)
	if existing != nil {
		return nil // Already a member
	}

	targetRole := role
	if targetRole == "" {
		if conv.Type == domain.ConvTypeChannel {
			targetRole = domain.RoleSubscriber
		} else {
			targetRole = domain.RoleMember
		}
	}

	p := &domain.Participant{
		ConversationID: convID,
		UserID:         targetUserID,
		Role:           targetRole,
		JoinedAt:       uc.clock.NowUnix(),
	}
	return uc.participantRepo.Create(ctx, p)
}

// RemoveMember removes a user from a group or channel.
func (uc *ConversationUseCase) RemoveMember(
	ctx context.Context,
	callerID string,
	convID string,
	targetUserID string,
) error {
	conv, err := uc.convRepo.GetByID(ctx, convID)
	if err != nil {
		return err
	}
	if conv.Type != domain.ConvTypeGroup && conv.Type != domain.ConvTypeChannel {
		return domain.NewDomainError(domain.ErrGrp001, "invalid conversation type", nil)
	}

	callerPart, err := uc.participantRepo.GetByConversationAndUser(ctx, convID, callerID)
	if err != nil {
		return domain.NewDomainError(domain.ErrGrp002, "caller is not a member of this conversation", err)
	}

	targetPart, err := uc.participantRepo.GetByConversationAndUser(ctx, convID, targetUserID)
	if err != nil {
		return domain.NewDomainError(domain.ErrPart001, "target user is not a member", err)
	}

	if callerID != targetUserID {
		// Kicking another member requires admin/owner privileges
		if callerPart.Role != domain.RoleOwner && callerPart.Role != domain.RoleAdmin {
			return domain.NewDomainError(domain.ErrGrp002, "insufficient permissions to remove member", nil)
		}
		if callerPart.Role == domain.RoleAdmin && (targetPart.Role == domain.RoleOwner || targetPart.Role == domain.RoleAdmin) {
			return domain.NewDomainError(domain.ErrGrp002, "admins cannot remove owners or other admins", nil)
		}
	}

	return uc.participantRepo.Delete(ctx, convID, targetUserID)
}

// UpdateMemberRole updates a member's role (OWNER only).
func (uc *ConversationUseCase) UpdateMemberRole(
	ctx context.Context,
	callerID string,
	convID string,
	targetUserID string,
	newRole domain.ParticipantRole,
) error {
	callerPart, err := uc.participantRepo.GetByConversationAndUser(ctx, convID, callerID)
	if err != nil {
		return domain.NewDomainError(domain.ErrGrp002, "caller is not a member of this conversation", err)
	}
	if callerPart.Role != domain.RoleOwner {
		return domain.NewDomainError(domain.ErrGrp002, "only conversation owner can update roles", nil)
	}

	return uc.participantRepo.UpdateRole(ctx, convID, targetUserID, newRole)
}

// ListMembers returns all participants in a conversation.
func (uc *ConversationUseCase) ListMembers(ctx context.Context, convID string) ([]*domain.Participant, error) {
	return uc.participantRepo.ListByConversationID(ctx, convID)
}

// DeleteConversation deletes a conversation by ID if caller is a participant.
func (uc *ConversationUseCase) DeleteConversation(ctx context.Context, userID, convID string) error {
	part, err := uc.participantRepo.GetByConversationAndUser(ctx, convID, userID)
	if err != nil || part == nil {
		return domain.NewDomainError(domain.ErrGrp002, "caller is not a member of this conversation", err)
	}
	return uc.convRepo.Delete(ctx, convID)
}





