package http

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"rootinbox/internal/domain"
	"rootinbox/internal/usecase"
)

type mockSessionRepo struct {
	sessions    map[string]*domain.Session
	tokens      map[string]string // tokenHash -> sessionID
	lastActive  map[string]int64
	revokedList map[string]int64
}

func newMockSessionRepo() *mockSessionRepo {
	return &mockSessionRepo{
		sessions:    make(map[string]*domain.Session),
		tokens:      make(map[string]string),
		lastActive:  make(map[string]int64),
		revokedList: make(map[string]int64),
	}
}

func (m *mockSessionRepo) Create(_ context.Context, s *domain.Session) error {
	m.sessions[s.ID] = s
	return nil
}

func (m *mockSessionRepo) CreateToken(_ context.Context, tokenHash, sessionID string, _ int64) error {
	m.tokens[tokenHash] = sessionID
	return nil
}

func (m *mockSessionRepo) GetByID(_ context.Context, sessionID string) (*domain.Session, error) {
	s, ok := m.sessions[sessionID]
	if !ok {
		return nil, domain.NewDomainError(domain.ErrSess001, "session not found", nil)
	}
	return s, nil
}

func (m *mockSessionRepo) GetByTokenHash(_ context.Context, tokenHash string) (*domain.Session, error) {
	sID, ok := m.tokens[tokenHash]
	if !ok {
		return nil, domain.NewDomainError(domain.ErrAuth001, "token not found", nil)
	}
	return m.sessions[sID], nil
}

func (m *mockSessionRepo) GetActiveByUserID(_ context.Context, userID string) (*domain.Session, error) {
	for _, s := range m.sessions {
		if s.UserID == userID && s.RevokedAt == nil {
			return s, nil
		}
	}
	return nil, domain.NewDomainError(domain.ErrAuth001, "no active session", nil)
}

func (m *mockSessionRepo) GetActiveSessionsByUserID(_ context.Context, userID string) ([]*domain.Session, error) {
	now := time.Now().Unix()
	var list []*domain.Session
	for _, s := range m.sessions {
		if s.UserID == userID && s.IsActive(now) {
			list = append(list, s)
		}
	}
	return list, nil
}

func (m *mockSessionRepo) GetLatestVersionByUserID(_ context.Context, userID string) (int, error) {
	maxVer := 0
	for _, s := range m.sessions {
		if s.UserID == userID && s.SessionVersion > maxVer {
			maxVer = s.SessionVersion
		}
	}
	return maxVer, nil
}

func (m *mockSessionRepo) RevokeSession(_ context.Context, sessionID string, revokedAt int64) error {
	if s, ok := m.sessions[sessionID]; ok {
		s.RevokedAt = &revokedAt
		m.revokedList[sessionID] = revokedAt
	}
	return nil
}

func (m *mockSessionRepo) RevokeOtherSessions(_ context.Context, userID, exceptSessionID string, revokedAt int64) error {
	for _, s := range m.sessions {
		if s.UserID == userID && s.ID != exceptSessionID && s.RevokedAt == nil {
			s.RevokedAt = &revokedAt
			m.revokedList[s.ID] = revokedAt
		}
	}
	return nil
}

func (m *mockSessionRepo) RevokeByUserID(_ context.Context, userID string, revokedAt int64) error {
	for _, s := range m.sessions {
		if s.UserID == userID && s.RevokedAt == nil {
			s.RevokedAt = &revokedAt
			m.revokedList[s.ID] = revokedAt
		}
	}
	return nil
}

func (m *mockSessionRepo) UpdateLastActive(_ context.Context, sessionID string, lastActiveAt int64) error {
	m.lastActive[sessionID] = lastActiveAt
	if s, ok := m.sessions[sessionID]; ok {
		s.LastActiveAt = lastActiveAt
	}
	return nil
}

func (m *mockSessionRepo) DeleteTokensBySessionID(_ context.Context, sessionID string) error {
	for th, sID := range m.tokens {
		if sID == sessionID {
			delete(m.tokens, th)
		}
	}
	return nil
}

func (m *mockSessionRepo) DeleteByUserID(_ context.Context, userID string) error {
	for id, s := range m.sessions {
		if s.UserID == userID {
			delete(m.sessions, id)
		}
	}
	return nil
}

type mockSessionTerminator struct {
	closedSessions []struct {
		SessionID string
		Code      int
		Reason    string
	}
}

func (t *mockSessionTerminator) CloseSession(sessionID string, code int, reason string) {
	t.closedSessions = append(t.closedSessions, struct {
		SessionID string
		Code      int
		Reason    string
	}{SessionID: sessionID, Code: code, Reason: reason})
}

func TestDeviceLabelParsing(t *testing.T) {
	cases := []struct {
		ua       string
		expected string
	}{
		{
			ua:       "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			expected: "Chrome on Windows",
		},
		{
			ua:       "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
			expected: "Safari on iPhone",
		},
		{
			ua:       "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
			expected: "Chrome on macOS",
		},
		{
			ua:       "Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/119.0",
			expected: "Firefox on Linux",
		},
		{
			ua:       "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
			expected: "Chrome on Android",
		},
		{
			ua:       "",
			expected: "Web Browser",
		},
	}

	for _, tc := range cases {
		actual := ParseDeviceLabel(tc.ua)
		if actual != tc.expected {
			t.Errorf("ParseDeviceLabel(%q) = %q; want %q", tc.ua, actual, tc.expected)
		}
	}
}

func TestActiveSessions_3DeviceLifecycle(t *testing.T) {
	now := time.Now().Unix()
	clock := &mockClock{}
	sessionRepo := newMockSessionRepo()
	terminator := &mockSessionTerminator{}

	authUC := usecase.NewAuthUseCase(
		nil,
		sessionRepo,
		nil,
		nil,
		&mockTxManager{},
		clock,
		&mockUUIDGen{},
		&testLogger{},
		nil,
	)
	authUC.SetSessionTerminator(terminator)
	handler := NewAuthHandler(authUC)

	userID := "usr-alice"

	// Create 3 active sessions for Alice
	sessionRepo.sessions["sess-desktop"] = &domain.Session{
		ID:           "sess-desktop",
		UserID:       userID,
		DeviceLabel:  "Chrome on Windows",
		IPHash:       "ip-hash-desktop",
		CreatedAt:    now - 3600,
		LastActiveAt: now - 60,
		ExpiresAt:    now + 86400,
	}
	sessionRepo.sessions["sess-phone"] = &domain.Session{
		ID:           "sess-phone",
		UserID:       userID,
		DeviceLabel:  "Safari on iPhone",
		IPHash:       "ip-hash-phone",
		CreatedAt:    now - 7200,
		LastActiveAt: now - 300,
		ExpiresAt:    now + 86400,
	}
	sessionRepo.sessions["sess-tablet"] = &domain.Session{
		ID:           "sess-tablet",
		UserID:       userID,
		DeviceLabel:  "Chrome on Android",
		IPHash:       "ip-hash-tablet",
		CreatedAt:    now - 14400,
		LastActiveAt: now - 1200,
		ExpiresAt:    now + 86400,
	}

	// 1. GET /api/v1/auth/sessions from Desktop
	req := httptest.NewRequest("GET", "/api/v1/auth/sessions", nil)
	ctx := domain.WithUserID(req.Context(), userID)
	ctx = domain.WithSessionID(ctx, "sess-desktop")
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()

	handler.HandleListSessions()(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 OK; got %d: %s", w.Code, w.Body.String())
	}

	var resp struct {
		Data []sessionItemResponse `json:"data"`
	}
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}

	if len(resp.Data) != 3 {
		t.Fatalf("expected 3 sessions; got %d", len(resp.Data))
	}

	for _, s := range resp.Data {
		if s.ID == "sess-desktop" && !s.IsCurrent {
			t.Errorf("expected sess-desktop to have is_current = true")
		}
		if s.ID != "sess-desktop" && s.IsCurrent {
			t.Errorf("expected session %s to have is_current = false", s.ID)
		}
	}

	// 2. DELETE /api/v1/auth/sessions/sess-desktop (Current Session) -> MUST FAIL (400 SESS_002)
	delCurrentReq := httptest.NewRequest("DELETE", "/api/v1/auth/sessions/sess-desktop", nil)
	delCurrentReq.SetPathValue("id", "sess-desktop")
	delCurrentReq = delCurrentReq.WithContext(ctx)
	delCurrentW := httptest.NewRecorder()

	handler.HandleTerminateSession()(delCurrentW, delCurrentReq)
	if delCurrentW.Code != http.StatusBadRequest {
		t.Fatalf("terminating current session should return 400 Bad Request; got %d", delCurrentW.Code)
	}

	// 3. DELETE /api/v1/auth/sessions/sess-phone (Other Session) -> MUST SUCCEED (200 OK)
	delPhoneReq := httptest.NewRequest("DELETE", "/api/v1/auth/sessions/sess-phone", nil)
	delPhoneReq.SetPathValue("id", "sess-phone")
	delPhoneReq = delPhoneReq.WithContext(ctx)
	delPhoneW := httptest.NewRecorder()

	handler.HandleTerminateSession()(delPhoneW, delPhoneReq)
	if delPhoneW.Code != http.StatusOK {
		t.Fatalf("terminating phone session should return 200 OK; got %d", delPhoneW.Code)
	}

	// Verify WebSocket close signal sent with code 1008
	if len(terminator.closedSessions) != 1 {
		t.Fatalf("expected 1 session termination call; got %d", len(terminator.closedSessions))
	}
	if terminator.closedSessions[0].SessionID != "sess-phone" || terminator.closedSessions[0].Code != 1008 {
		t.Errorf("expected close call for sess-phone with code 1008; got %+v", terminator.closedSessions[0])
	}
	if sessionRepo.sessions["sess-phone"].RevokedAt == nil {
		t.Errorf("sess-phone should be marked revoked in repository")
	}

	// 4. POST /api/v1/auth/sessions/terminate-others -> Terminate remaining other session (sess-tablet)
	termOthersReq := httptest.NewRequest("POST", "/api/v1/auth/sessions/terminate-others", nil)
	termOthersReq = termOthersReq.WithContext(ctx)
	termOthersW := httptest.NewRecorder()

	handler.HandleTerminateOtherSessions()(termOthersW, termOthersReq)
	if termOthersW.Code != http.StatusOK {
		t.Fatalf("terminating other sessions should return 200 OK; got %d", termOthersW.Code)
	}

	if len(terminator.closedSessions) != 2 {
		t.Fatalf("expected 2 session termination calls total; got %d", len(terminator.closedSessions))
	}
	if terminator.closedSessions[1].SessionID != "sess-tablet" || terminator.closedSessions[1].Code != 1008 {
		t.Errorf("expected close call for sess-tablet with code 1008; got %+v", terminator.closedSessions[1])
	}
	if sessionRepo.sessions["sess-tablet"].RevokedAt == nil {
		t.Errorf("sess-tablet should be marked revoked in repository")
	}

	// sess-desktop must still be active
	if sessionRepo.sessions["sess-desktop"].RevokedAt != nil {
		t.Errorf("sess-desktop must remain active")
	}
}
