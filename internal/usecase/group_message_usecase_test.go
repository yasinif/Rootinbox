package usecase

import (
	"context"
	"testing"
	"time"

	"rootinbox/internal/domain"
)

type mockGroupMsgRepo struct {
	messages map[string]*domain.GroupMessage
}

func newMockGroupMsgRepo() *mockGroupMsgRepo {
	return &mockGroupMsgRepo{messages: make(map[string]*domain.GroupMessage)}
}

func (m *mockGroupMsgRepo) Save(ctx context.Context, msg *domain.GroupMessage) error {
	msg.ServerID = int64(len(m.messages) + 1)
	m.messages[msg.ID] = msg
	return nil
}

func (m *mockGroupMsgRepo) GetByID(ctx context.Context, id string) (*domain.GroupMessage, error) {
	msg, ok := m.messages[id]
	if !ok {
		return nil, domain.NewDomainError(domain.ErrMsg001, "message not found", nil)
	}
	return msg, nil
}

func (m *mockGroupMsgRepo) ListByConversation(ctx context.Context, convID string, beforeServerID int64, limit int) ([]*domain.GroupMessage, error) {
	var res []*domain.GroupMessage
	for _, msg := range m.messages {
		if msg.ConversationID == convID {
			if beforeServerID == 0 || msg.ServerID < beforeServerID {
				res = append(res, msg)
			}
		}
	}
	return res, nil
}

func (m *mockGroupMsgRepo) UpdateContent(ctx context.Context, id string, content string, editedAt int64) error {
	msg, ok := m.messages[id]
	if !ok {
		return domain.NewDomainError(domain.ErrMsg001, "message not found", nil)
	}
	msg.Content = content
	msg.EditedAt = &editedAt
	return nil
}

func (m *mockGroupMsgRepo) SoftDelete(ctx context.Context, id string, deletedAt int64) error {
	msg, ok := m.messages[id]
	if !ok {
		return domain.NewDomainError(domain.ErrMsg001, "message not found", nil)
	}
	msg.DeletedAt = &deletedAt
	msg.Content = "[deleted]"
	return nil
}

func (m *mockGroupMsgRepo) GetUnreadCount(ctx context.Context, convID, currentUserID string, myLastReadAt int64) (int, error) {
	count := 0
	for _, msg := range m.messages {
		if msg.ConversationID == convID && msg.SenderID != currentUserID && msg.DeletedAt == nil && msg.CreatedAt > myLastReadAt {
			count++
		}
	}
	return count, nil
}

func (m *mockGroupMsgRepo) HardDeleteByConversation(ctx context.Context, convID string) error {
	for id, msg := range m.messages {
		if msg.ConversationID == convID {
			delete(m.messages, id)
		}
	}
	return nil
}

func (m *mockGroupMsgRepo) GetLastMessage(ctx context.Context, convID string, minCreatedAt ...int64) (*domain.GroupMessage, error) {
	minTime := int64(0)
	if len(minCreatedAt) > 0 && minCreatedAt[0] > 0 {
		minTime = domain.NormalizeTimestamp(minCreatedAt[0])
	}
	var newest *domain.GroupMessage
	for _, msg := range m.messages {
		if msg.ConversationID == convID && msg.DeletedAt == nil && (minTime == 0 || domain.NormalizeTimestamp(msg.CreatedAt) > minTime) {
			if newest == nil || msg.ServerID > newest.ServerID {
				newest = msg
			}
		}
	}
	return newest, nil
}

func (m *mockGroupMsgRepo) GetLastUnreadMessage(ctx context.Context, convID, currentUserID string, myLastReadAt int64) (*domain.GroupMessage, error) {
	var newest *domain.GroupMessage
	for _, msg := range m.messages {
		if msg.ConversationID == convID && msg.SenderID != currentUserID && msg.DeletedAt == nil && msg.CreatedAt > myLastReadAt {
			if newest == nil || msg.ServerID > newest.ServerID {
				newest = msg
			}
		}
	}
	return newest, nil
}

type mockBroadcaster struct {
	sentMessages []*domain.GroupMessage
	actions      []string
}

func (b *mockBroadcaster) BroadcastGroupMessage(recipientUserIDs []string, msg *domain.GroupMessage) {
	b.sentMessages = append(b.sentMessages, msg)
}

func (b *mockBroadcaster) BroadcastGroupAction(recipientUserIDs []string, action string, payload map[string]interface{}) {
	b.actions = append(b.actions, action)
}

type mockConvRepo struct {
	convs map[string]*domain.Conversation
}

func (m *mockConvRepo) Create(ctx context.Context, conv *domain.Conversation) error {
	m.convs[conv.ID] = conv
	return nil
}
func (m *mockConvRepo) GetByID(ctx context.Context, id string) (*domain.Conversation, error) {
	conv, ok := m.convs[id]
	if !ok {
		return nil, domain.NewDomainError(domain.ErrConv001, "conversation not found", nil)
	}
	return conv, nil
}
func (m *mockConvRepo) ListByUserID(ctx context.Context, userID string, cursor *domain.Cursor, limit int) ([]*domain.Conversation, *domain.Cursor, error) {
	return nil, nil, nil
}
func (m *mockConvRepo) Delete(ctx context.Context, id string) error {
	delete(m.convs, id)
	return nil
}
func (m *mockConvRepo) DeleteOrphaned(ctx context.Context) (int64, error) {
	return 0, nil
}
func (m *mockConvRepo) GetByInviteCode(ctx context.Context, code string) (*domain.Conversation, error) {
	for _, c := range m.convs {
		if c.InviteCode != nil && *c.InviteCode == code {
			return c, nil
		}
	}
	return nil, domain.NewDomainError(domain.ErrConv001, "conversation not found", nil)
}
func (m *mockConvRepo) GetByUsername(ctx context.Context, username string) (*domain.Conversation, error) {
	for _, c := range m.convs {
		if c.Username != nil && *c.Username == username {
			return c, nil
		}
	}
	return nil, domain.NewDomainError(domain.ErrConv001, "conversation not found", nil)
}
func (m *mockConvRepo) SearchPublic(ctx context.Context, query string, limit int) ([]*domain.Conversation, error) {
	var res []*domain.Conversation
	for _, c := range m.convs {
		if c.IsPublic {
			res = append(res, c)
		}
	}
	return res, nil
}

type mockPartRepo struct {
	parts map[string][]*domain.Participant
}

func (m *mockPartRepo) Create(ctx context.Context, p *domain.Participant) error {
	m.parts[p.ConversationID] = append(m.parts[p.ConversationID], p)
	return nil
}
func (m *mockPartRepo) GetByConversationAndUser(ctx context.Context, convID, userID string) (*domain.Participant, error) {
	for _, p := range m.parts[convID] {
		if p.UserID == userID {
			return p, nil
		}
	}
	return nil, domain.NewDomainError(domain.ErrPart001, "participant not found", nil)
}
func (m *mockPartRepo) ListByConversationID(ctx context.Context, convID string) ([]*domain.Participant, error) {
	return m.parts[convID], nil
}
func (m *mockPartRepo) ListByUserID(ctx context.Context, userID string) ([]*domain.Participant, error) {
	var res []*domain.Participant
	for _, list := range m.parts {
		for _, p := range list {
			if p.UserID == userID {
				res = append(res, p)
			}
		}
	}
	return res, nil
}
func (m *mockPartRepo) Delete(ctx context.Context, convID, userID string) error {
	list := m.parts[convID]
	for i, p := range list {
		if p.UserID == userID {
			m.parts[convID] = append(list[:i], list[i+1:]...)
			return nil
		}
	}
	return domain.NewDomainError(domain.ErrPart001, "participant not found", nil)
}
func (m *mockPartRepo) UpdateRole(ctx context.Context, convID, userID string, role domain.ParticipantRole) error {
	for _, p := range m.parts[convID] {
		if p.UserID == userID {
			p.Role = role
			return nil
		}
	}
	return domain.NewDomainError(domain.ErrPart001, "participant not found", nil)
}

type mockClock struct{ now int64 }

func (m *mockClock) Now() time.Time  { return time.Unix(m.now, 0) }
func (m *mockClock) NowUnix() int64  { return m.now }

type mockUUIDGen struct{ counter int }

func (m *mockUUIDGen) New() string {
	m.counter++
	return "msg-uuid-" + string(rune('0'+m.counter))
}

type mockLogger struct{}

func (l *mockLogger) Debug(msg string, args ...interface{}) {}
func (l *mockLogger) Info(msg string, args ...interface{})  {}
func (l *mockLogger) Warn(msg string, args ...interface{})  {}
func (l *mockLogger) Error(msg string, args ...interface{}) {}

type mockTxManager struct{}

func (m *mockTxManager) WithinTransaction(ctx context.Context, fn func(ctx context.Context) error) error {
	return fn(ctx)
}

func TestGroupAndChannel_CreationAndMessaging(t *testing.T) {
	convRepo := &mockConvRepo{convs: make(map[string]*domain.Conversation)}
	partRepo := &mockPartRepo{parts: make(map[string][]*domain.Participant)}
	groupMsgRepo := newMockGroupMsgRepo()
	broadcaster := &mockBroadcaster{}
	clk := &mockClock{now: 1000000}
	uuidGen := &mockUUIDGen{}
	logger := &mockLogger{}
	txMgr := &mockTxManager{}

	convUC := NewConversationUseCase(convRepo, partRepo, txMgr, clk, uuidGen, logger)
	groupMsgUC := NewGroupMessageUseCase(groupMsgRepo, convRepo, partRepo, clk, uuidGen, broadcaster, logger)

	// 1. Create a GROUP conversation
	groupConv, err := convUC.CreateGroupOrChannel(
		context.Background(),
		"user-alice",
		domain.ConvTypeGroup,
		"Dev Team",
		"Engineering team discussion",
		[]string{"user-bob", "user-charlie"},
		false,
		"",
	)
	if err != nil {
		t.Fatalf("create group failed: %v", err)
	}
	if groupConv.Type != domain.ConvTypeGroup {
		t.Errorf("expected GROUP type, got %s", groupConv.Type)
	}

	// Verify Alice is OWNER, Bob is MEMBER
	ownerPart, _ := partRepo.GetByConversationAndUser(context.Background(), groupConv.ID, "user-alice")
	if ownerPart == nil || ownerPart.Role != domain.RoleOwner {
		t.Errorf("expected Alice to be OWNER, got %v", ownerPart)
	}
	bobPart, _ := partRepo.GetByConversationAndUser(context.Background(), groupConv.ID, "user-bob")
	if bobPart == nil || bobPart.Role != domain.RoleMember {
		t.Errorf("expected Bob to be MEMBER, got %v", bobPart)
	}

	// 2. Member sends message in GROUP
	msg1, err := groupMsgUC.SendMessage(context.Background(), "user-bob", groupConv.ID, "Hello team!", nil)
	if err != nil {
		t.Fatalf("send group message failed: %v", err)
	}
	if msg1.Content != "Hello team!" {
		t.Errorf("expected 'Hello team!', got %s", msg1.Content)
	}
	if len(broadcaster.sentMessages) != 1 {
		t.Errorf("expected 1 broadcasted message, got %d", len(broadcaster.sentMessages))
	}

	// 3. Unified Architecture: DIRECT conversation messaging succeeds with permanent storage
	directConv := &domain.Conversation{ID: "conv-direct-1", Type: domain.ConvTypeDirect, CreatedAt: 100}
	convRepo.Create(context.Background(), directConv)
	partRepo.Create(context.Background(), &domain.Participant{ConversationID: "conv-direct-1", UserID: "user-alice", Role: domain.RoleOwner})

	directMsg, err := groupMsgUC.SendMessage(context.Background(), "user-alice", "conv-direct-1", "Plaintext!", nil)
	if err != nil {
		t.Fatalf("expected sending message to DIRECT conversation to succeed, got error: %v", err)
	}
	if directMsg.Content != "Plaintext!" {
		t.Errorf("expected 'Plaintext!', got %s", directMsg.Content)
	}

	// 4. Create a CHANNEL conversation
	channelConv, err := convUC.CreateGroupOrChannel(
		context.Background(),
		"user-alice",
		domain.ConvTypeChannel,
		"Announcements",
		"Broadcast only channel",
		[]string{"user-bob"},
		false,
		"",
	)
	if err != nil {
		t.Fatalf("create channel failed: %v", err)
	}

	// Verify Bob is SUBSCRIBER in channel
	subPart, _ := partRepo.GetByConversationAndUser(context.Background(), channelConv.ID, "user-bob")
	if subPart == nil || subPart.Role != domain.RoleSubscriber {
		t.Errorf("expected Bob to be SUBSCRIBER, got %v", subPart)
	}

	// 5. SUBSCRIBER attempting to post in CHANNEL must fail
	_, err = groupMsgUC.SendMessage(context.Background(), "user-bob", channelConv.ID, "Spam", nil)
	if err == nil {
		t.Fatalf("expected error when SUBSCRIBER posts in CHANNEL, got nil")
	}

	// 6. OWNER posting in CHANNEL must succeed
	chanMsg, err := groupMsgUC.SendMessage(context.Background(), "user-alice", channelConv.ID, "First announcement", nil)
	if err != nil {
		t.Fatalf("owner post in channel failed: %v", err)
	}
	if chanMsg.Content != "First announcement" {
		t.Errorf("unexpected content: %s", chanMsg.Content)
	}

	// 7. Edit message within 24h
	clk.now += 3600 // 1 hour later
	edited, err := groupMsgUC.EditMessage(context.Background(), "user-alice", channelConv.ID, chanMsg.ID, "Updated announcement")
	if err != nil {
		t.Fatalf("edit message failed: %v", err)
	}
	if edited.Content != "Updated announcement" || edited.EditedAt == nil {
		t.Errorf("expected edited content and timestamp, got %v", edited)
	}

	// 8. Delete message (allowed for Alice as author & owner)
	err = groupMsgUC.DeleteMessage(context.Background(), "user-alice", channelConv.ID, chanMsg.ID)
	if err != nil {
		t.Fatalf("delete message failed: %v", err)
	}
	deletedMsg, _ := groupMsgRepo.GetByID(context.Background(), chanMsg.ID)
	if deletedMsg.Content != "[deleted]" || deletedMsg.DeletedAt == nil {
		t.Errorf("expected soft deleted message, got %v", deletedMsg)
	}
}

func TestGroupMessageUseCase_RejectCorruptedContent(t *testing.T) {
	convRepo := &mockConvRepo{convs: make(map[string]*domain.Conversation)}
	partRepo := &mockPartRepo{parts: make(map[string][]*domain.Participant)}
	groupMsgRepo := newMockGroupMsgRepo()
	broadcaster := &mockBroadcaster{}
	clk := &mockClock{now: 1000}
	uuidGen := &mockUUIDGen{}
	logger := &mockLogger{}
	txMgr := &mockTxManager{}

	convUC := NewConversationUseCase(convRepo, partRepo, txMgr, clk, uuidGen, logger)
	groupMsgUC := NewGroupMessageUseCase(groupMsgRepo, convRepo, partRepo, clk, uuidGen, broadcaster, logger)

	// Create test DIRECT conversation
	conv, err := convUC.CreateConversation(context.Background(), domain.ConvTypeDirect, "user-alice", []string{"user-bob"})
	if err != nil {
		t.Fatalf("create conversation failed: %v", err)
	}

	corruptInputs := []struct {
		name    string
		content string
	}{
		{name: "unicode replacement character", content: "Invalid text with \uFFFD"},
		{name: "null byte", content: "Invalid text with \x00 null byte"},
		{name: "control byte 0x01", content: "\x019!M#binaryblob"},
		{name: "bell byte 0x07", content: "beep \x07 sound"},
		{name: "control byte 0x1B ESC", content: "\x1B[31mcolor code\x1B[0m"},
	}

	for _, tc := range corruptInputs {
		t.Run(tc.name, func(t *testing.T) {
			_, err := groupMsgUC.SendMessage(context.Background(), "user-alice", conv.ID, tc.content, nil)
			if err == nil {
				t.Fatalf("expected SendMessage to reject %s, but succeeded", tc.name)
			}
		})
	}

	// Clean UTF-8 message (including Persian and emoji) must succeed
	validContent := "Hello! این یک پیام آزمایشی معتبر است. 🚀"
	validMsg, err := groupMsgUC.SendMessage(context.Background(), "user-alice", conv.ID, validContent, nil)
	if err != nil {
		t.Fatalf("expected valid message to succeed, got: %v", err)
	}
	if validMsg.Content != validContent {
		t.Errorf("expected content %q, got %q", validContent, validMsg.Content)
	}
}
