package http

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"rootinbox/internal/domain"
	"rootinbox/internal/usecase"
)

type mockConvRepo struct {
	convs      map[string]*domain.Conversation
	watermarks map[string]int64
	cleared    map[string]int64
	hidden     map[string]int64
}

func (m *mockConvRepo) EnsureWatermarksTable(ctx context.Context) error { return nil }
func (m *mockConvRepo) SetWatermark(ctx context.Context, userID, conversationID string, lastReadAt int64) error {
	if m.watermarks == nil {
		m.watermarks = make(map[string]int64)
	}
	m.watermarks[userID+":"+conversationID] = lastReadAt
	return nil
}
func (m *mockConvRepo) GetWatermark(ctx context.Context, userID, conversationID string) (int64, error) {
	if m.watermarks == nil {
		return 0, nil
	}
	return m.watermarks[userID+":"+conversationID], nil
}
func (m *mockConvRepo) GetWatermarksForUser(ctx context.Context, userID string) (map[string]int64, error) {
	return make(map[string]int64), nil
}
func (m *mockConvRepo) SetDeliveryWatermark(ctx context.Context, userID, conversationID string, lastDeliveredAt int64) error {
	return nil
}
func (m *mockConvRepo) GetDeliveryWatermark(ctx context.Context, userID, conversationID string) (int64, error) {
	return 0, nil
}
func (m *mockConvRepo) GetPeerWatermarks(ctx context.Context, conversationID, currentUserID string) (int64, int64, error) {
	return 0, 0, nil
}
func (m *mockConvRepo) SetClearedAt(ctx context.Context, userID, conversationID string, clearedAt int64) error {
	if m.cleared == nil {
		m.cleared = make(map[string]int64)
	}
	m.cleared[userID+":"+conversationID] = clearedAt
	return nil
}
func (m *mockConvRepo) GetClearedAt(ctx context.Context, userID, conversationID string) (int64, error) {
	if m.cleared == nil {
		return 0, nil
	}
	return m.cleared[userID+":"+conversationID], nil
}
func (m *mockConvRepo) SetHiddenAt(ctx context.Context, userID, conversationID string, hiddenAt int64) error {
	if m.hidden == nil {
		m.hidden = make(map[string]int64)
	}
	m.hidden[userID+":"+conversationID] = hiddenAt
	return nil
}
func (m *mockConvRepo) GetHiddenAt(ctx context.Context, userID, conversationID string) (int64, error) {
	if m.hidden == nil {
		return 0, nil
	}
	return m.hidden[userID+":"+conversationID], nil
}

func (m *mockConvRepo) Create(ctx context.Context, conv *domain.Conversation) error {
	if m.convs == nil {
		m.convs = make(map[string]*domain.Conversation)
	}
	m.convs[conv.ID] = conv
	return nil
}

func (m *mockConvRepo) GetByID(ctx context.Context, id string) (*domain.Conversation, error) {
	if c, ok := m.convs[id]; ok {
		return c, nil
	}
	return nil, domain.NewDomainError(domain.ErrConv001, "conversation not found", nil)
}

func (m *mockConvRepo) ListByUserID(ctx context.Context, userID string, cursor *domain.Cursor, limit int) ([]*domain.Conversation, *domain.Cursor, error) {
	var list []*domain.Conversation
	for _, c := range m.convs {
		list = append(list, c)
	}
	return list, nil, nil
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

type mockParticipantRepo struct {
	parts map[string][]*domain.Participant
}

func (m *mockParticipantRepo) Create(ctx context.Context, p *domain.Participant) error {
	m.parts[p.ConversationID] = append(m.parts[p.ConversationID], p)
	return nil
}

func (m *mockParticipantRepo) ListByConversationID(ctx context.Context, convID string) ([]*domain.Participant, error) {
	return m.parts[convID], nil
}

func (m *mockParticipantRepo) ListByUserID(ctx context.Context, userID string) ([]*domain.Participant, error) {
	var list []*domain.Participant
	for _, ps := range m.parts {
		for _, p := range ps {
			if p.UserID == userID {
				list = append(list, p)
			}
		}
	}
	return list, nil
}

func (m *mockParticipantRepo) GetByConversationAndUser(ctx context.Context, convID, userID string) (*domain.Participant, error) {
	for _, p := range m.parts[convID] {
		if p.UserID == userID {
			return p, nil
		}
	}
	return nil, domain.NewDomainError(domain.ErrPart001, "participant not found", nil)
}

func (m *mockParticipantRepo) Delete(ctx context.Context, convID, userID string) error {
	parts := m.parts[convID]
	for i, p := range parts {
		if p.UserID == userID {
			m.parts[convID] = append(parts[:i], parts[i+1:]...)
			return nil
		}
	}
	return domain.NewDomainError(domain.ErrPart001, "participant not found", nil)
}

func (m *mockParticipantRepo) UpdateRole(ctx context.Context, convID, userID string, role domain.ParticipantRole) error {
	for _, p := range m.parts[convID] {
		if p.UserID == userID {
			p.Role = role
			return nil
		}
	}
	return domain.NewDomainError(domain.ErrPart001, "participant not found", nil)
}

type mockTxManager struct{}

func (m *mockTxManager) WithinTransaction(ctx context.Context, fn func(ctx context.Context) error) error {
	return fn(ctx)
}

type mockClock struct{}

func (m *mockClock) NowUnix() int64 { return 1234567890 }

type mockUUIDGen struct {
	counter int
}

func (m *mockUUIDGen) New() string {
	m.counter++
	return "uuid-" + string(rune('0'+m.counter))
}

func TestConversationHandler_SelfConversation_Idempotency(t *testing.T) {
	convRepo := &mockConvRepo{convs: make(map[string]*domain.Conversation)}
	partRepo := &mockParticipantRepo{parts: make(map[string][]*domain.Participant)}
	txMgr := &mockTxManager{}
	clock := &mockClock{}
	uuidGen := &mockUUIDGen{}
	logger := &testLogger{}

	convUC := usecase.NewConversationUseCase(convRepo, partRepo, txMgr, clock, uuidGen, logger)
	userRepo := newMockUserRepo()
	userRepo.Create(context.Background(), &domain.User{
		ID:           "u1",
		IdentityHash: "hash1",
		PublicKey:    "pk1",
		Status:       domain.UserStatusActive,
		CreatedAt:    1000,
	})

	handler := NewConversationHandler(convUC, userRepo, partRepo)

	// 1. Create SELF conversation via HandleCreateConversation with type "SELF"
	body1 := bytes.NewBufferString(`{"type":"SELF"}`)
	req1 := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", body1)
	req1 = req1.WithContext(domain.WithUserID(req1.Context(), "u1"))
	w1 := httptest.NewRecorder()
	handler.HandleCreateConversation()(w1, req1)

	if w1.Code != http.StatusCreated {
		t.Fatalf("first creation expected 201, got %d: %s", w1.Code, w1.Body.String())
	}

	var resp1 SuccessResponse
	if err := json.NewDecoder(w1.Body).Decode(&resp1); err != nil {
		t.Fatalf("decode resp1: %v", err)
	}
	data1 := resp1.Data.(map[string]interface{})
	convID1 := data1["conversation_id"].(string)
	if data1["type"] != "SELF" {
		t.Errorf("expected type SELF, got %v", data1["type"])
	}

	// 2. Second creation via HandleGetOrCreateSelfConversation (must be idempotent)
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/conversations/self", nil)
	req2 = req2.WithContext(domain.WithUserID(req2.Context(), "u1"))
	w2 := httptest.NewRecorder()
	handler.HandleGetOrCreateSelfConversation()(w2, req2)

	if w2.Code != http.StatusCreated {
		t.Fatalf("second creation expected 201, got %d: %s", w2.Code, w2.Body.String())
	}

	var resp2 SuccessResponse
	if err := json.NewDecoder(w2.Body).Decode(&resp2); err != nil {
		t.Fatalf("decode resp2: %v", err)
	}
	data2 := resp2.Data.(map[string]interface{})
	convID2 := data2["conversation_id"].(string)

	if convID1 != convID2 {
		t.Errorf("idempotency failure: expected convID %s == %s", convID1, convID2)
	}

	// 3. HandleListConversations includes SELF conversation with peer_identity_hash populated
	req3 := httptest.NewRequest(http.MethodGet, "/api/v1/conversations", nil)
	req3 = req3.WithContext(domain.WithUserID(req3.Context(), "u1"))
	w3 := httptest.NewRecorder()
	handler.HandleListConversations()(w3, req3)

	if w3.Code != http.StatusOK {
		t.Fatalf("list expected 200, got %d: %s", w3.Code, w3.Body.String())
	}

	var resp3 SuccessResponse
	if err := json.NewDecoder(w3.Body).Decode(&resp3); err != nil {
		t.Fatalf("decode resp3: %v", err)
	}
	items := resp3.Data.([]interface{})
	if len(items) != 1 {
		t.Fatalf("expected 1 conversation, got %d", len(items))
	}
	item := items[0].(map[string]interface{})
	if item["type"] != "SELF" {
		t.Errorf("expected item type SELF, got %v", item["type"])
	}
	if item["peer_identity_hash"] != "hash1" {
		t.Errorf("expected peer_identity_hash hash1, got %v", item["peer_identity_hash"])
	}
}

type mockTestRouter struct {
	routed []struct {
		recipient string
		data      []byte
	}
}

func (r *mockTestRouter) Route(recipientUserID string, data []byte) bool {
	r.routed = append(r.routed, struct {
		recipient string
		data      []byte
	}{recipient: recipientUserID, data: data})
	return true
}

func TestConversationHandler_ClearHistory_Scopes(t *testing.T) {
	convRepo := &mockConvRepo{convs: make(map[string]*domain.Conversation)}
	partRepo := &mockParticipantRepo{parts: make(map[string][]*domain.Participant)}
	groupMsgRepo := newMockGroupMsgRepo()
	txMgr := &mockTxManager{}
	clk := &mockClock{}
	uuidGen := &mockUUIDGen{}
	logger := &testLogger{}
	router := &mockTestRouter{}

	convUC := usecase.NewConversationUseCase(convRepo, partRepo, txMgr, clk, uuidGen, logger)
	groupMsgUC := usecase.NewGroupMessageUseCase(groupMsgRepo, convRepo, partRepo, clk, uuidGen, nil, logger)
	userRepo := newMockUserRepo()
	userRepo.Create(context.Background(), &domain.User{ID: "u1", IdentityHash: "h1", Status: domain.UserStatusActive})
	userRepo.Create(context.Background(), &domain.User{ID: "u2", IdentityHash: "h2", Status: domain.UserStatusActive})

	handler := NewConversationHandler(convUC, userRepo, partRepo)
	handler.SetGroupMessageUseCase(groupMsgUC)
	handler.SetGroupMessageRepository(groupMsgRepo)
	handler.SetMessageRouter(router)

	// Create direct conversation between u1 and u2
	conv, err := convUC.CreateConversation(context.Background(), domain.ConvTypeDirect, "u1", []string{"u2"})
	if err != nil {
		t.Fatalf("create conversation failed: %v", err)
	}

	// Add 2 messages to conversation
	_ = groupMsgRepo.Save(context.Background(), &domain.GroupMessage{
		ID:             "msg-1",
		ConversationID: conv.ID,
		SenderID:       "u1",
		Content:        "Message 1",
		CreatedAt:      1000,
	})
	_ = groupMsgRepo.Save(context.Background(), &domain.GroupMessage{
		ID:             "msg-2",
		ConversationID: conv.ID,
		SenderID:       "u2",
		Content:        "Message 2",
		CreatedAt:      2000,
	})

	// 1. Clear history with scope=me for u1
	reqMe := httptest.NewRequest(http.MethodDelete, "/api/v1/conversations/"+conv.ID+"/history?scope=me", nil)
	reqMe.SetPathValue("id", conv.ID)
	reqMe = reqMe.WithContext(domain.WithUserID(reqMe.Context(), "u1"))
	wMe := httptest.NewRecorder()
	handler.HandleClearHistory()(wMe, reqMe)

	if wMe.Code != http.StatusOK {
		t.Fatalf("clear history scope=me expected 200, got %d: %s", wMe.Code, wMe.Body.String())
	}

	// In scope=me: messages in DB MUST NOT be deleted (u2 still has them)
	if len(groupMsgRepo.msgs) != 2 {
		t.Fatalf("expected 2 messages to remain in groupMsgRepo after scope=me, got %d", len(groupMsgRepo.msgs))
	}
	clearedAt, _ := convUC.GetClearedAt(context.Background(), "u1", conv.ID)
	if clearedAt == 0 {
		t.Fatalf("expected cleared_at to be set > 0 for u1")
	}

	// Verify conv.cleared broadcast routed to u1 with scope=me
	foundMe := false
	for _, m := range router.routed {
		if m.recipient == "u1" && strings.Contains(string(m.data), `"conv.cleared"`) && strings.Contains(string(m.data), `"scope":"me"`) {
			foundMe = true
			break
		}
	}
	if !foundMe {
		t.Errorf("expected conv.cleared broadcast with scope:me to u1")
	}

	// 2. Clear history with scope=both
	router.routed = nil
	reqBoth := httptest.NewRequest(http.MethodDelete, "/api/v1/conversations/"+conv.ID+"/history?scope=both", nil)
	reqBoth.SetPathValue("id", conv.ID)
	reqBoth = reqBoth.WithContext(domain.WithUserID(reqBoth.Context(), "u1"))
	wBoth := httptest.NewRecorder()
	handler.HandleClearHistory()(wBoth, reqBoth)

	if wBoth.Code != http.StatusOK {
		t.Fatalf("clear history scope=both expected 200, got %d: %s", wBoth.Code, wBoth.Body.String())
	}

	// In scope=both: messages MUST be hard-deleted from DB
	if len(groupMsgRepo.msgs) != 0 {
		t.Fatalf("expected 0 messages in groupMsgRepo after scope=both, got %d", len(groupMsgRepo.msgs))
	}

	// Verify conv.cleared broadcast routed to both participants u1 and u2
	recipientsBoth := make(map[string]bool)
	for _, m := range router.routed {
		if strings.Contains(string(m.data), `"conv.cleared"`) && strings.Contains(string(m.data), `"scope":"both"`) {
			recipientsBoth[m.recipient] = true
		}
	}
	if !recipientsBoth["u1"] || !recipientsBoth["u2"] {
		t.Errorf("expected conv.cleared broadcast with scope:both to both u1 and u2, got: %+v", recipientsBoth)
	}
}

func TestConversationHandler_DeleteConversation_Scopes(t *testing.T) {
	convRepo := &mockConvRepo{convs: make(map[string]*domain.Conversation)}
	partRepo := &mockParticipantRepo{parts: make(map[string][]*domain.Participant)}
	groupMsgRepo := newMockGroupMsgRepo()
	txMgr := &mockTxManager{}
	clk := &mockClock{}
	uuidGen := &mockUUIDGen{}
	logger := &testLogger{}
	router := &mockTestRouter{}

	convUC := usecase.NewConversationUseCase(convRepo, partRepo, txMgr, clk, uuidGen, logger)
	groupMsgUC := usecase.NewGroupMessageUseCase(groupMsgRepo, convRepo, partRepo, clk, uuidGen, nil, logger)
	userRepo := newMockUserRepo()
	userRepo.Create(context.Background(), &domain.User{ID: "u1", IdentityHash: "h1", Status: domain.UserStatusActive})
	userRepo.Create(context.Background(), &domain.User{ID: "u2", IdentityHash: "h2", Status: domain.UserStatusActive})

	handler := NewConversationHandler(convUC, userRepo, partRepo)
	handler.SetGroupMessageUseCase(groupMsgUC)
	handler.SetGroupMessageRepository(groupMsgRepo)
	handler.SetMessageRouter(router)

	// Create direct conversation
	conv, err := convUC.CreateConversation(context.Background(), domain.ConvTypeDirect, "u1", []string{"u2"})
	if err != nil {
		t.Fatalf("create conversation failed: %v", err)
	}

	// 1. Delete conversation for me (scope=me)
	reqMe := httptest.NewRequest(http.MethodDelete, "/api/v1/conversations/"+conv.ID+"?scope=me", nil)
	reqMe.SetPathValue("id", conv.ID)
	reqMe = reqMe.WithContext(domain.WithUserID(reqMe.Context(), "u1"))
	wMe := httptest.NewRecorder()
	handler.HandleDeleteConversation()(wMe, reqMe)

	if wMe.Code != http.StatusOK {
		t.Fatalf("delete conversation scope=me expected 200, got %d: %s", wMe.Code, wMe.Body.String())
	}

	// Participant records must NOT be deleted for DIRECT conversation
	parts, _ := partRepo.ListByConversationID(context.Background(), conv.ID)
	if len(parts) != 2 {
		t.Fatalf("expected 2 participants to remain in direct conversation, got %d", len(parts))
	}
	hiddenAt, _ := convUC.GetHiddenAt(context.Background(), "u1", conv.ID)
	if hiddenAt == 0 {
		t.Fatalf("expected hidden_at to be set > 0 for u1")
	}

	// HandleListConversations for u1: must omit conversation since hidden_at > 0 and no newer messages
	reqList1 := httptest.NewRequest(http.MethodGet, "/api/v1/conversations", nil)
	reqList1 = reqList1.WithContext(domain.WithUserID(reqList1.Context(), "u1"))
	wList1 := httptest.NewRecorder()
	handler.HandleListConversations()(wList1, reqList1)
	if wList1.Code != http.StatusOK {
		t.Fatalf("list expected 200, got %d", wList1.Code)
	}
	var respList1 SuccessResponse
	_ = json.NewDecoder(wList1.Body).Decode(&respList1)
	if len(respList1.Data.([]interface{})) != 0 {
		t.Fatalf("expected conversation to be hidden from u1, but was listed")
	}

	// Now simulate a new message sent after hiddenAt
	_ = groupMsgRepo.Save(context.Background(), &domain.GroupMessage{
		ID:             "msg-new-after-delete",
		ConversationID: conv.ID,
		SenderID:       "u2",
		Content:        "Are you there?",
		CreatedAt:      hiddenAt + 5000,
	})

	// HandleListConversations for u1: now conversation MUST reappear
	reqList2 := httptest.NewRequest(http.MethodGet, "/api/v1/conversations", nil)
	reqList2 = reqList2.WithContext(domain.WithUserID(reqList2.Context(), "u1"))
	wList2 := httptest.NewRecorder()
	handler.HandleListConversations()(wList2, reqList2)
	var respList2 SuccessResponse
	_ = json.NewDecoder(wList2.Body).Decode(&respList2)
	if len(respList2.Data.([]interface{})) != 1 {
		t.Fatalf("expected conversation to reappear after new message, got %d", len(respList2.Data.([]interface{})))
	}

	// 2. Delete conversation for both (scope=both)
	router.routed = nil
	reqBoth := httptest.NewRequest(http.MethodDelete, "/api/v1/conversations/"+conv.ID+"?scope=both", nil)
	reqBoth.SetPathValue("id", conv.ID)
	reqBoth = reqBoth.WithContext(domain.WithUserID(reqBoth.Context(), "u1"))
	wBoth := httptest.NewRecorder()
	handler.HandleDeleteConversation()(wBoth, reqBoth)

	if wBoth.Code != http.StatusOK {
		t.Fatalf("delete conversation scope=both expected 200, got %d: %s", wBoth.Code, wBoth.Body.String())
	}

	// In scope=both: conversation record and messages must be permanently deleted
	_, err = convRepo.GetByID(context.Background(), conv.ID)
	if err == nil {
		t.Fatalf("expected conversation to be deleted from convRepo")
	}
	if len(groupMsgRepo.msgs) != 0 {
		t.Fatalf("expected 0 messages in groupMsgRepo, got %d", len(groupMsgRepo.msgs))
	}
}
