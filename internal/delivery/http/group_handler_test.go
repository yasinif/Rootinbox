package http

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"rootinbox/internal/domain"
	"rootinbox/internal/usecase"
)

func TestGroupAndChannel_HTTPEndpoints(t *testing.T) {
	convRepo := &mockConvRepo{convs: make(map[string]*domain.Conversation)}
	partRepo := &mockParticipantRepo{parts: make(map[string][]*domain.Participant)}
	groupMsgRepo := newMockGroupMsgRepo()
	txMgr := &mockTxManager{}
	clk := &mockClock{}
	uuidGen := &mockUUIDGen{}
	logger := &testLogger{}

	convUC := usecase.NewConversationUseCase(convRepo, partRepo, txMgr, clk, uuidGen, logger)
	groupMsgUC := usecase.NewGroupMessageUseCase(groupMsgRepo, convRepo, partRepo, clk, uuidGen, nil, logger)

	userRepo := newMockUserRepo()
	userRepo.Create(context.Background(), &domain.User{
		ID:           "u1",
		IdentityHash: "hash1",
		PublicKey:    "pk1",
		Status:       domain.UserStatusActive,
		CreatedAt:    1000,
	})
	aliceUName := "alice"
	userRepo.UpdateUsername(context.Background(), "u1", &aliceUName)

	userRepo.Create(context.Background(), &domain.User{
		ID:           "u2",
		IdentityHash: "hash2",
		PublicKey:    "pk2",
		Status:       domain.UserStatusActive,
		CreatedAt:    1000,
	})
	bobUName := "bob"
	userRepo.UpdateUsername(context.Background(), "u2", &bobUName)

	handler := NewConversationHandler(convUC, userRepo, partRepo)
	handler.SetGroupMessageUseCase(groupMsgUC)

	// 1. POST /api/v1/conversations {type: "GROUP", name: "Team Beta", member_usernames: ["bob"]}
	createBody := bytes.NewBufferString(`{"type":"GROUP","name":"Team Beta","member_usernames":["bob"]}`)
	req1 := httptest.NewRequest(http.MethodPost, "/api/v1/conversations", createBody)
	req1 = req1.WithContext(domain.WithUserID(req1.Context(), "u1"))
	w1 := httptest.NewRecorder()
	handler.HandleCreateConversation()(w1, req1)

	if w1.Code != http.StatusCreated {
		t.Fatalf("create group expected 201, got %d: %s", w1.Code, w1.Body.String())
	}

	var resp1 SuccessResponse
	if err := json.NewDecoder(w1.Body).Decode(&resp1); err != nil {
		t.Fatalf("decode resp1: %v", err)
	}
	data1 := resp1.Data.(map[string]interface{})
	convID := data1["conversation_id"].(string)

	// 2. POST /api/v1/conversations/{id}/messages {"content": "Welcome to Team Beta"}
	sendBody := bytes.NewBufferString(`{"content":"Welcome to Team Beta"}`)
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/conversations/"+convID+"/messages", sendBody)
	req2.SetPathValue("id", convID)
	req2 = req2.WithContext(domain.WithUserID(req2.Context(), "u1"))
	w2 := httptest.NewRecorder()
	handler.HandleSendGroupMessage()(w2, req2)

	if w2.Code != http.StatusCreated {
		t.Fatalf("send message expected 201, got %d: %s", w2.Code, w2.Body.String())
	}

	var resp2 SuccessResponse
	if err := json.NewDecoder(w2.Body).Decode(&resp2); err != nil {
		t.Fatalf("decode resp2: %v", err)
	}
	msgData := resp2.Data.(map[string]interface{})
	msgID := msgData["id"].(string)

	// 3. GET /api/v1/conversations/{id}/messages
	req3 := httptest.NewRequest(http.MethodGet, "/api/v1/conversations/"+convID+"/messages", nil)
	req3.SetPathValue("id", convID)
	req3 = req3.WithContext(domain.WithUserID(req3.Context(), "u1"))
	w3 := httptest.NewRecorder()
	handler.HandleListGroupMessages()(w3, req3)

	if w3.Code != http.StatusOK {
		t.Fatalf("list messages expected 200, got %d: %s", w3.Code, w3.Body.String())
	}

	// 4. PATCH /api/v1/conversations/{id}/messages/{msg_id} {"content": "Edited welcome"}
	editBody := bytes.NewBufferString(`{"content":"Edited welcome"}`)
	req4 := httptest.NewRequest(http.MethodPatch, "/api/v1/conversations/"+convID+"/messages/"+msgID, editBody)
	req4.SetPathValue("id", convID)
	req4.SetPathValue("msg_id", msgID)
	req4 = req4.WithContext(domain.WithUserID(req4.Context(), "u1"))
	w4 := httptest.NewRecorder()
	handler.HandleEditGroupMessage()(w4, req4)

	if w4.Code != http.StatusOK {
		t.Fatalf("edit message expected 200, got %d: %s", w4.Code, w4.Body.String())
	}

	// 5. GET /api/v1/conversations/{id}/members
	req5 := httptest.NewRequest(http.MethodGet, "/api/v1/conversations/"+convID+"/members", nil)
	req5.SetPathValue("id", convID)
	req5 = req5.WithContext(domain.WithUserID(req5.Context(), "u1"))
	w5 := httptest.NewRecorder()
	handler.HandleListMembers()(w5, req5)

	if w5.Code != http.StatusOK {
		t.Fatalf("list members expected 200, got %d: %s", w5.Code, w5.Body.String())
	}

	// 6. DELETE /api/v1/conversations/{id}/messages/{msg_id}
	req6 := httptest.NewRequest(http.MethodDelete, "/api/v1/conversations/"+convID+"/messages/"+msgID, nil)
	req6.SetPathValue("id", convID)
	req6.SetPathValue("msg_id", msgID)
	req6 = req6.WithContext(domain.WithUserID(req6.Context(), "u1"))
	w6 := httptest.NewRecorder()
	handler.HandleDeleteGroupMessage()(w6, req6)

	if w6.Code != http.StatusOK {
		t.Fatalf("delete message expected 200, got %d: %s", w6.Code, w6.Body.String())
	}
}

type testGroupMsgRepo struct {
	msgs map[string]*domain.GroupMessage
}

func newMockGroupMsgRepo() *testGroupMsgRepo {
	return &testGroupMsgRepo{msgs: make(map[string]*domain.GroupMessage)}
}

func (r *testGroupMsgRepo) Save(ctx context.Context, msg *domain.GroupMessage) error {
	msg.ServerID = int64(len(r.msgs) + 1)
	r.msgs[msg.ID] = msg
	return nil
}
func (r *testGroupMsgRepo) GetByID(ctx context.Context, id string) (*domain.GroupMessage, error) {
	msg, ok := r.msgs[id]
	if !ok {
		return nil, domain.NewDomainError(domain.ErrMsg001, "not found", nil)
	}
	return msg, nil
}
func (r *testGroupMsgRepo) ListByConversation(ctx context.Context, convID string, beforeServerID int64, limit int) ([]*domain.GroupMessage, error) {
	var res []*domain.GroupMessage
	for _, m := range r.msgs {
		if m.ConversationID == convID {
			res = append(res, m)
		}
	}
	return res, nil
}
func (r *testGroupMsgRepo) UpdateContent(ctx context.Context, id string, content string, editedAt int64) error {
	m, ok := r.msgs[id]
	if !ok {
		return domain.NewDomainError(domain.ErrMsg001, "not found", nil)
	}
	m.Content = content
	m.EditedAt = &editedAt
	return nil
}
func (r *testGroupMsgRepo) SoftDelete(ctx context.Context, id string, deletedAt int64) error {
	m, ok := r.msgs[id]
	if !ok {
		return domain.NewDomainError(domain.ErrMsg001, "not found", nil)
	}
	m.DeletedAt = &deletedAt
	m.Content = "[deleted]"
	return nil
}

func (r *testGroupMsgRepo) GetUnreadCount(ctx context.Context, convID, currentUserID string, myLastReadAt int64) (int, error) {
	count := 0
	for _, m := range r.msgs {
		if m.ConversationID == convID && m.SenderID != currentUserID && m.DeletedAt == nil && m.CreatedAt > myLastReadAt {
			count++
		}
	}
	return count, nil
}

func (r *testGroupMsgRepo) HardDeleteByConversation(ctx context.Context, convID string) error {
	for id, m := range r.msgs {
		if m.ConversationID == convID {
			delete(r.msgs, id)
		}
	}
	return nil
}

func (r *testGroupMsgRepo) GetLastMessage(ctx context.Context, convID string, minCreatedAt ...int64) (*domain.GroupMessage, error) {
	minTime := int64(0)
	if len(minCreatedAt) > 0 && minCreatedAt[0] > 0 {
		minTime = domain.NormalizeTimestamp(minCreatedAt[0])
	}
	var newest *domain.GroupMessage
	for _, m := range r.msgs {
		if m.ConversationID == convID && m.DeletedAt == nil && (minTime == 0 || domain.NormalizeTimestamp(m.CreatedAt) > minTime) {
			if newest == nil || m.ServerID > newest.ServerID {
				newest = m
			}
		}
	}
	return newest, nil
}

func (r *testGroupMsgRepo) GetLastUnreadMessage(ctx context.Context, convID, currentUserID string, myLastReadAt int64) (*domain.GroupMessage, error) {
	var newest *domain.GroupMessage
	for _, m := range r.msgs {
		if m.ConversationID == convID && m.SenderID != currentUserID && m.DeletedAt == nil && m.CreatedAt > myLastReadAt {
			if newest == nil || m.ServerID > newest.ServerID {
				newest = m
			}
		}
	}
	return newest, nil
}
