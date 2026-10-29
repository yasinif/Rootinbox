package usecase_test

import (
	"context"
	"testing"
	"time"

	"rootinbox/internal/config"
	"rootinbox/internal/domain"
	"rootinbox/internal/usecase"
)

type mockClock struct{ now int64 }

func (m *mockClock) NowUnix() int64 { return m.now }

type mockLogger struct{}

func (m *mockLogger) Info(msg string, args ...any)  {}
func (m *mockLogger) Warn(msg string, args ...any)  {}
func (m *mockLogger) Error(msg string, args ...any) {}

type mockRouter struct {
	routedUsers map[string][]string
	routeFn     func(userID string, data []byte) bool
}

func (m *mockRouter) Route(userID string, data []byte) bool {
	if m.routeFn != nil {
		return m.routeFn(userID, data)
	}
	m.routedUsers[userID] = append(m.routedUsers[userID], string(data))
	return true
}

type mockMessageRepo struct {
	messages     map[string]*domain.Message
	deliveryAcks map[string][]*domain.DeliveryAck
	nextAckID    int64
}

func newMockMessageRepo() *mockMessageRepo {
	return &mockMessageRepo{
		messages:     make(map[string]*domain.Message),
		deliveryAcks: make(map[string][]*domain.DeliveryAck),
		nextAckID:    1,
	}
}

func (m *mockMessageRepo) Create(ctx context.Context, msg *domain.Message) error {
	m.messages[msg.ClientUUID] = msg
	return nil
}
func (m *mockMessageRepo) GetPendingByReceiverID(ctx context.Context, receiverID string) ([]*domain.Message, error) {
	var res []*domain.Message
	for _, msg := range m.messages {
		if msg.ReceiverID == receiverID {
			res = append(res, msg)
		}
	}
	return res, nil
}
func (m *mockMessageRepo) GetPendingPaginated(ctx context.Context, receiverID string, cursor int64, limit int) ([]*domain.Message, error) {
	return m.GetPendingByReceiverID(ctx, receiverID)
}
func (m *mockMessageRepo) CountRecentBySenderID(ctx context.Context, senderID string, since int64) (int, error) {
	return 0, nil
}
func (m *mockMessageRepo) GetSenderByClientUUID(ctx context.Context, clientUUID string) (string, error) {
	if msg, ok := m.messages[clientUUID]; ok {
		return msg.SenderID, nil
	}
	return "", nil
}
func (m *mockMessageRepo) GetPendingByClientUUIDAndReceiver(ctx context.Context, clientUUID, receiverID string) (*domain.Message, error) {
	if msg, ok := m.messages[clientUUID]; ok && msg.ReceiverID == receiverID {
		return msg, nil
	}
	return nil, nil
}
func (m *mockMessageRepo) GetSendersByClientUUIDsAndReceiver(ctx context.Context, clientUUIDs []string, receiverID string) (map[string]string, error) {
	res := make(map[string]string)
	for _, id := range clientUUIDs {
		if msg, ok := m.messages[id]; ok && msg.ReceiverID == receiverID {
			res[id] = msg.SenderID
		}
	}
	return res, nil
}
func (m *mockMessageRepo) DeleteByClientUUID(ctx context.Context, clientUUID string) error {
	delete(m.messages, clientUUID)
	return nil
}
func (m *mockMessageRepo) DeleteByClientUUIDAndReceiver(ctx context.Context, clientUUID, receiverID string) (int64, error) {
	if msg, ok := m.messages[clientUUID]; ok && msg.ReceiverID == receiverID {
		delete(m.messages, clientUUID)
		return 1, nil
	}
	return 0, nil
}
func (m *mockMessageRepo) DeleteByClientUUIDs(ctx context.Context, clientUUIDs []string) (int64, error) {
	var count int64
	for _, id := range clientUUIDs {
		if _, ok := m.messages[id]; ok {
			delete(m.messages, id)
			count++
		}
	}
	return count, nil
}
func (m *mockMessageRepo) DeleteByClientUUIDsAndReceiver(ctx context.Context, clientUUIDs []string, receiverID string) (int64, error) {
	var count int64
	for _, id := range clientUUIDs {
		if msg, ok := m.messages[id]; ok && msg.ReceiverID == receiverID {
			delete(m.messages, id)
			count++
		}
	}
	return count, nil
}
func (m *mockMessageRepo) QueueDeliveryAck(ctx context.Context, senderID, requestID string, createdAt int64) error {
	ack := &domain.DeliveryAck{
		ID:        m.nextAckID,
		SenderID:  senderID,
		RequestID: requestID,
		CreatedAt: createdAt,
	}
	m.nextAckID++
	m.deliveryAcks[senderID] = append(m.deliveryAcks[senderID], ack)
	return nil
}
func (m *mockMessageRepo) GetDeliveryAcks(ctx context.Context, senderID string, cursor int64, limit int) ([]*domain.DeliveryAck, error) {
	var res []*domain.DeliveryAck
	for _, ack := range m.deliveryAcks[senderID] {
		if ack.ID > cursor {
			res = append(res, ack)
			if len(res) >= limit {
				break
			}
		}
	}
	return res, nil
}
func (m *mockMessageRepo) DeleteExpiredDeliveryAcks(ctx context.Context, olderThan int64) error {
	for sender, acks := range m.deliveryAcks {
		var active []*domain.DeliveryAck
		for _, ack := range acks {
			if ack.CreatedAt >= olderThan {
				active = append(active, ack)
			}
		}
		m.deliveryAcks[sender] = active
	}
	return nil
}

type mockPushTrigger struct{}

func (m *mockPushTrigger) HasSubscriptions(ctx context.Context, userID string) (bool, error) {
	return false, nil
}
func (m *mockPushTrigger) TriggerMessage(receiverID string) {}
func (m *mockPushTrigger) TriggerCall(receiverID string)    {}

func TestMessageDelivery_SelfFanoutDoesNotDeleteBobPendingMessage(t *testing.T) {
	repo := newMockMessageRepo()
	router := &mockRouter{routedUsers: make(map[string][]string)}
	clock := &mockClock{now: time.Now().Unix()}
	logger := &mockLogger{}
	cfg := &config.Config{}
	cfg.Quota.MaxMessagesPerHour = 1000

	msgUC := usecase.NewMessageUseCase(repo, router, &mockPushTrigger{}, clock, logger, cfg, nil)
	ctx := context.Background()
	aliceID := "user_alice"
	bobID := "user_bob"
	msgUUID := "msg_self_fanout_test"

	// Step 1: Alice sends message to Bob
	err := msgUC.SendMessage(ctx, aliceID, msgUUID, bobID, []byte("encrypted_payload"), 1, "conv_1")
	if err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	// Step 2: Alice's PC erroneously transmits ack.client for msgUUID
	senderID, err := msgUC.AcknowledgeMessage(ctx, aliceID, msgUUID, 1)
	if err != nil {
		t.Fatalf("unexpected error on ACK: %v", err)
	}
	if senderID != "" {
		t.Fatalf("expected empty senderID when non-recipient ACKs, got %s", senderID)
	}

	// Step 3: Bob's message MUST still be pending in the messages table
	pending, err := repo.GetPendingByReceiverID(ctx, bobID)
	if err != nil || len(pending) != 1 {
		t.Fatalf("expected Bob's pending message to survive self-fanout ACK attempt, got %d messages", len(pending))
	}
	if pending[0].ClientUUID != msgUUID {
		t.Fatalf("pending message mismatch: expected %s, got %s", msgUUID, pending[0].ClientUUID)
	}

	// Step 4: No delivery ACK should have been queued for Alice
	acks, err := msgUC.GetDeliveryAcks(ctx, aliceID, 0, 10)
	if err != nil || len(acks) != 0 {
		t.Fatalf("expected 0 delivery acks for Alice after self-fanout, got %d", len(acks))
	}
}

func TestMessageDelivery_OfflineSenderQueueAndMultiDeviceDeliveryAcks(t *testing.T) {
	repo := newMockMessageRepo()
	router := &mockRouter{routedUsers: make(map[string][]string)}
	clock := &mockClock{now: time.Now().Unix()}
	logger := &mockLogger{}
	cfg := &config.Config{}
	cfg.Quota.MaxMessagesPerHour = 1000

	msgUC := usecase.NewMessageUseCase(repo, router, &mockPushTrigger{}, clock, logger, cfg, nil)
	syncUC := usecase.NewSyncUseCase(repo, router, clock, logger)

	ctx := context.Background()
	aliceID := "user_alice"
	bobID := "user_bob"
	msgUUID := "msg_12345"

	// Alice sends message to Bob
	err := msgUC.SendMessage(ctx, aliceID, msgUUID, bobID, []byte("encrypted_payload"), 1, "conv_1")
	if err != nil {
		t.Fatalf("SendMessage failed: %v", err)
	}

	// Bob acknowledges via REST sync while Alice is offline
	router.routeFn = func(userID string, data []byte) bool { return false } // simulate Alice offline
	deleted, err := syncUC.AcknowledgeMessages(ctx, bobID, []string{msgUUID})
	if err != nil {
		t.Fatalf("AcknowledgeMessages failed: %v", err)
	}
	if deleted != 1 {
		t.Fatalf("expected 1 message deleted, got %d", deleted)
	}

	// Verify delivery ACK was queued in SQLite
	acks, err := msgUC.GetDeliveryAcks(ctx, aliceID, 0, 10)
	if err != nil || len(acks) != 1 || acks[0].RequestID != msgUUID {
		t.Fatalf("expected 1 delivery ack for %s, got %+v", msgUUID, acks)
	}

	// Multi-Device Test: Alice's PC connects and reads delivery acks
	pcAcks, err := syncUC.GetDeliveryAcks(ctx, aliceID, 0, 10)
	if err != nil || len(pcAcks) != 1 {
		t.Fatalf("Alice PC failed to get delivery ack: %v", err)
	}

	// Alice's Mobile app connects later; verify Mobile ALSO gets delivery ack (no starvation)
	mobileAcks, err := syncUC.GetDeliveryAcks(ctx, aliceID, 0, 10)
	if err != nil || len(mobileAcks) != 1 {
		t.Fatalf("Alice Mobile starved of delivery ack: %v", err)
	}
}

func TestDeliveryAcks_RetentionPruning(t *testing.T) {
	repo := newMockMessageRepo()
	ctx := context.Background()
	senderID := "user_alice"
	now := time.Now().Unix()

	// Enqueue 1 old ACK (20 days old) and 1 recent ACK (1 day old)
	_ = repo.QueueDeliveryAck(ctx, senderID, "old_ack", now-20*24*3600)
	_ = repo.QueueDeliveryAck(ctx, senderID, "recent_ack", now-1*24*3600)

	fourteenDaysAgo := now - 14*24*3600
	err := repo.DeleteExpiredDeliveryAcks(ctx, fourteenDaysAgo)
	if err != nil {
		t.Fatalf("DeleteExpiredDeliveryAcks failed: %v", err)
	}

	acks, err := repo.GetDeliveryAcks(ctx, senderID, 0, 10)
	if err != nil || len(acks) != 1 {
		t.Fatalf("expected 1 active delivery ack after pruning, got %d", len(acks))
	}
	if acks[0].RequestID != "recent_ack" {
		t.Fatalf("expected recent_ack to survive, got %s", acks[0].RequestID)
	}
}
