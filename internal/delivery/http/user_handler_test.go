package http

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"rootinbox/internal/domain"
	"rootinbox/internal/usecase"
)

type mockUserRepo struct {
	usersByID       map[string]*domain.User
	usersByUsername map[string]*domain.User
}

func newMockUserRepo() *mockUserRepo {
	return &mockUserRepo{
		usersByID:       make(map[string]*domain.User),
		usersByUsername: make(map[string]*domain.User),
	}
}

func (m *mockUserRepo) Create(ctx context.Context, user *domain.User) error {
	m.usersByID[user.ID] = user
	if user.Username != nil {
		if _, exists := m.usersByUsername[*user.Username]; exists {
			return fmt.Errorf("UNIQUE constraint failed: users.username")
		}
		m.usersByUsername[*user.Username] = user
	}
	return nil
}

func (m *mockUserRepo) GetByID(ctx context.Context, id string) (*domain.User, error) {
	if u, ok := m.usersByID[id]; ok {
		return u, nil
	}
	return nil, domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
}

func (m *mockUserRepo) GetByIdentityHash(ctx context.Context, hash string) (*domain.User, error) {
	for _, u := range m.usersByID {
		if u.IdentityHash == hash {
			return u, nil
		}
	}
	return nil, domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
}

func (m *mockUserRepo) Delete(ctx context.Context, id string) error {
	delete(m.usersByID, id)
	return nil
}

func (m *mockUserRepo) UpdateStatus(ctx context.Context, id string, status domain.UserStatus, updatedAt int64) error {
	if u, ok := m.usersByID[id]; ok {
		u.Status = status
		return nil
	}
	return domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
}

func (m *mockUserRepo) UpdateUsername(ctx context.Context, id string, username *string) error {
	u, ok := m.usersByID[id]
	if !ok {
		return domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
	}
	if username != nil {
		if existing, exists := m.usersByUsername[*username]; exists && existing.ID != id {
			return fmt.Errorf("UNIQUE constraint failed: users.username")
		}
		if u.Username != nil {
			delete(m.usersByUsername, *u.Username)
		}
		u.Username = username
		m.usersByUsername[*username] = u
	} else {
		if u.Username != nil {
			delete(m.usersByUsername, *u.Username)
		}
		u.Username = nil
	}
	return nil
}

func (m *mockUserRepo) GetByUsername(ctx context.Context, username string) (*domain.User, error) {
	if u, ok := m.usersByUsername[username]; ok {
		return u, nil
	}
	return nil, domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
}

func (m *mockUserRepo) SearchByUsername(ctx context.Context, query string, limit int) ([]*domain.User, error) {
	var results []*domain.User
	for _, u := range m.usersByID {
		if u.Status == domain.UserStatusActive && u.Username != nil && strings.HasPrefix(*u.Username, query) {
			results = append(results, u)
			if len(results) >= limit {
				break
			}
		}
	}
	return results, nil
}

func (m *mockUserRepo) UpdateAvatar(ctx context.Context, id string, mime *string, updatedAt *int64) error {
	u, ok := m.usersByID[id]
	if !ok {
		return domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
	}
	u.AvatarMime = mime
	u.AvatarUpdatedAt = updatedAt
	return nil
}

func (m *mockUserRepo) UpdateProfile(ctx context.Context, id string, displayName, lastName, bio *string) error {
	u, ok := m.usersByID[id]
	if !ok {
		return domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
	}
	u.DisplayName = displayName
	u.LastName = lastName
	u.Bio = bio
	return nil
}

func (m *mockUserRepo) UpdateLastSeen(ctx context.Context, id string, timestampMs int64) error {
	u, ok := m.usersByID[id]
	if !ok {
		return domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
	}
	u.LastSeenAt = timestampMs
	return nil
}

func (m *mockUserRepo) UpdateAuthCredentials(ctx context.Context, id string, authPubkey, kdfSalt string, memoryKiB, iterations, parallelism int) error {
	u, ok := m.usersByID[id]
	if !ok {
		return domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
	}
	u.AuthPubkey = &authPubkey
	u.KDFSalt = &kdfSalt
	u.KDFMemoryKiB = memoryKiB
	u.KDFIterations = iterations
	u.KDFParallelism = parallelism
	return nil
}

type testLogger struct{}

func (l *testLogger) Info(msg string, args ...any)  {}
func (l *testLogger) Error(msg string, args ...any) {}

type testClock struct{}

func (c *testClock) NowUnix() int64 { return 1700000000 }
func (c *testClock) Now() time.Time { return time.Unix(1700000000, 0) }

type mockAvatarStorage struct {
	files map[string][]byte
}

func newMockAvatarStorage() *mockAvatarStorage {
	return &mockAvatarStorage{files: make(map[string][]byte)}
}

func (s *mockAvatarStorage) Save(userID string, data []byte) error {
	s.files[userID] = data
	return nil
}

func (s *mockAvatarStorage) Read(userID string) ([]byte, error) {
	data, ok := s.files[userID]
	if !ok {
		return nil, fmt.Errorf("avatar not found")
	}
	return data, nil
}

func (s *mockAvatarStorage) Delete(userID string) error {
	delete(s.files, userID)
	return nil
}

func (s *mockAvatarStorage) Exists(userID string) bool {
	_, ok := s.files[userID]
	return ok
}

func setupTestUserHandler() (*UserHandler, *mockUserRepo) {
	repo := newMockUserRepo()
	logger := &testLogger{}
	storage := newMockAvatarStorage()
	clock := &testClock{}
	uc := usecase.NewUserUseCase(repo, nil, nil, nil, nil, nil, clock, nil, logger, storage)
	handler := NewUserHandler(uc)
	return handler, repo
}

func TestUserHandler_Search_Success(t *testing.T) {
	handler, repo := setupTestUserHandler()
	uname1 := "alice_wonder"
	uname2 := "alice_smith"
	repo.Create(context.Background(), &domain.User{
		ID:           "u1",
		IdentityHash: "hash1",
		PublicKey:    "pk1",
		Username:     &uname1,
		Status:       domain.UserStatusActive,
		CreatedAt:    1000,
	})
	repo.Create(context.Background(), &domain.User{
		ID:           "u2",
		IdentityHash: "hash2",
		PublicKey:    "pk2",
		Username:     &uname2,
		Status:       domain.UserStatusActive,
		CreatedAt:    1001,
	})

	req := httptest.NewRequest(http.MethodGet, "/api/v1/users/search?q=alice", nil)
	ctx := domain.WithUserID(req.Context(), "u1")
	req = req.WithContext(ctx)
	w := httptest.NewRecorder()

	handler.HandleSearch()(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var resp SuccessResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}

	items, ok := resp.Data.([]interface{})
	if !ok {
		t.Fatalf("expected array in data, got %T", resp.Data)
	}
	if len(items) != 2 {
		t.Fatalf("expected 2 search results, got %d", len(items))
	}

	// Verify privacy: only user_id, username, identity_hash
	first := items[0].(map[string]interface{})
	if _, hasPK := first["public_key"]; hasPK {
		t.Errorf("privacy violation: public_key exposed in search result")
	}
	if _, hasStatus := first["status"]; hasStatus {
		t.Errorf("privacy violation: status exposed in search result")
	}
	if first["username"] == "" || first["user_id"] == "" || first["identity_hash"] == "" {
		t.Errorf("missing required fields in search result: %+v", first)
	}
}

func TestUserHandler_Search_ValidationErrors(t *testing.T) {
	handler, _ := setupTestUserHandler()

	// Missing query parameter
	req1 := httptest.NewRequest(http.MethodGet, "/api/v1/users/search", nil)
	w1 := httptest.NewRecorder()
	handler.HandleSearch()(w1, req1)
	if w1.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for missing query, got %d", w1.Code)
	}

	// Query too short (< 2 chars)
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/users/search?q=a", nil)
	w2 := httptest.NewRecorder()
	handler.HandleSearch()(w2, req2)
	if w2.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for query length < 2, got %d", w2.Code)
	}
}

func TestUserHandler_UpdateUsername_SuccessAndConflict(t *testing.T) {
	handler, repo := setupTestUserHandler()
	existingName := "existing_user"
	repo.Create(context.Background(), &domain.User{
		ID:           "u1",
		IdentityHash: "hash1",
		PublicKey:    "pk1",
		Username:     &existingName,
		Status:       domain.UserStatusActive,
		CreatedAt:    1000,
	})
	repo.Create(context.Background(), &domain.User{
		ID:           "u2",
		IdentityHash: "hash2",
		PublicKey:    "pk2",
		Username:     nil,
		Status:       domain.UserStatusActive,
		CreatedAt:    1001,
	})

	// Valid update for u2
	body := bytes.NewBufferString(`{"username":"new_user_123"}`)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/users/me/username", body)
	req = req.WithContext(domain.WithUserID(req.Context(), "u2"))
	w := httptest.NewRecorder()
	handler.HandleUpdateUsername()(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	// Conflict: try to take u1's username
	conflictBody := bytes.NewBufferString(`{"username":"existing_user"}`)
	conflictReq := httptest.NewRequest(http.MethodPut, "/api/v1/users/me/username", conflictBody)
	conflictReq = conflictReq.WithContext(domain.WithUserID(conflictReq.Context(), "u2"))
	conflictW := httptest.NewRecorder()
	handler.HandleUpdateUsername()(conflictW, conflictReq)

	if conflictW.Code != http.StatusConflict {
		t.Errorf("expected 409 conflict, got %d: %s", conflictW.Code, conflictW.Body.String())
	}

	// Invalid format (too short, uppercase)
	invalidBody := bytes.NewBufferString(`{"username":"AB"}`)
	invalidReq := httptest.NewRequest(http.MethodPut, "/api/v1/users/me/username", invalidBody)
	invalidReq = invalidReq.WithContext(domain.WithUserID(invalidReq.Context(), "u2"))
	invalidW := httptest.NewRecorder()
	handler.HandleUpdateUsername()(invalidW, invalidReq)

	if invalidW.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid username format, got %d", invalidW.Code)
	}

	// Clear username
	clearBody := bytes.NewBufferString(`{"username":null}`)
	clearReq := httptest.NewRequest(http.MethodPut, "/api/v1/users/me/username", clearBody)
	clearReq = clearReq.WithContext(domain.WithUserID(clearReq.Context(), "u2"))
	clearW := httptest.NewRecorder()
	handler.HandleUpdateUsername()(clearW, clearReq)

	if clearW.Code != http.StatusOK {
		t.Errorf("expected 200 for clearing username, got %d: %s", clearW.Code, clearW.Body.String())
	}
}

func TestUserHandler_GetMe(t *testing.T) {
	handler, repo := setupTestUserHandler()
	name := "my_username"
	repo.Create(context.Background(), &domain.User{
		ID:           "u1",
		IdentityHash: "hash1",
		PublicKey:    "pk1",
		Username:     &name,
		Status:       domain.UserStatusActive,
		CreatedAt:    1000,
	})

	// Unauthenticated
	req1 := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	w1 := httptest.NewRecorder()
	handler.HandleGetMe()(w1, req1)
	if w1.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 unauthenticated, got %d", w1.Code)
	}

	// Authenticated
	req2 := httptest.NewRequest(http.MethodGet, "/api/v1/users/me", nil)
	req2 = req2.WithContext(domain.WithUserID(req2.Context(), "u1"))
	w2 := httptest.NewRecorder()
	handler.HandleGetMe()(w2, req2)
	if w2.Code != http.StatusOK {
		t.Errorf("expected 200 authenticated, got %d: %s", w2.Code, w2.Body.String())
	}
}

func TestUserHandler_Avatar_Lifecycle(t *testing.T) {
	handler, repo := setupTestUserHandler()
	repo.Create(context.Background(), &domain.User{
		ID:           "u1",
		IdentityHash: "hash1",
		PublicKey:    "pk1",
		Status:       domain.UserStatusActive,
		CreatedAt:    1000,
	})

	// 1. Initial GET when no avatar exists -> 404 (ErrUsr001)
	getReq0 := httptest.NewRequest(http.MethodGet, "/api/v1/users/u1/avatar", nil)
	getReq0.SetPathValue("id", "u1")
	getW0 := httptest.NewRecorder()
	handler.HandleGetAvatar()(getW0, getReq0)
	if getW0.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for non-existent avatar, got %d", getW0.Code)
	}

	// 2. Upload invalid MIME type -> 415 (ErrMed003)
	badBody := bytes.NewReader([]byte("not an image"))
	badReq := httptest.NewRequest(http.MethodPost, "/api/v1/users/me/avatar", badBody)
	badReq.Header.Set("Content-Type", "text/plain")
	badReq = badReq.WithContext(domain.WithUserID(badReq.Context(), "u1"))
	badW := httptest.NewRecorder()
	handler.HandleUploadAvatar()(badW, badReq)
	if badW.Code != http.StatusUnsupportedMediaType {
		t.Fatalf("expected 415 for invalid MIME, got %d: %s", badW.Code, badW.Body.String())
	}

	// 3. Upload valid PNG image
	validPng := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00}
	upReq := httptest.NewRequest(http.MethodPost, "/api/v1/users/me/avatar", bytes.NewReader(validPng))
	upReq.Header.Set("Content-Type", "image/png")
	upReq = upReq.WithContext(domain.WithUserID(upReq.Context(), "u1"))
	upW := httptest.NewRecorder()
	handler.HandleUploadAvatar()(upW, upReq)
	if upW.Code != http.StatusOK {
		t.Fatalf("expected 200 on avatar upload, got %d: %s", upW.Code, upW.Body.String())
	}

	// 4. GET Avatar -> 200 with Content-Type and ETag
	getReq1 := httptest.NewRequest(http.MethodGet, "/api/v1/users/u1/avatar", nil)
	getReq1.SetPathValue("id", "u1")
	getW1 := httptest.NewRecorder()
	handler.HandleGetAvatar()(getW1, getReq1)
	if getW1.Code != http.StatusOK {
		t.Fatalf("expected 200 on get avatar, got %d: %s", getW1.Code, getW1.Body.String())
	}
	if getW1.Header().Get("Content-Type") != "image/png" {
		t.Errorf("expected Content-Type image/png, got %s", getW1.Header().Get("Content-Type"))
	}
	etag := getW1.Header().Get("ETag")
	if etag == "" {
		t.Errorf("expected ETag header to be set")
	}

	// 5. GET Avatar with matching If-None-Match -> 304 Not Modified
	getReq2 := httptest.NewRequest(http.MethodGet, "/api/v1/users/u1/avatar", nil)
	getReq2.SetPathValue("id", "u1")
	getReq2.Header.Set("If-None-Match", etag)
	getW2 := httptest.NewRecorder()
	handler.HandleGetAvatar()(getW2, getReq2)
	if getW2.Code != http.StatusNotModified {
		t.Fatalf("expected 304 Not Modified, got %d", getW2.Code)
	}

	// 6. DELETE Avatar -> 200 OK
	delReq := httptest.NewRequest(http.MethodDelete, "/api/v1/users/me/avatar", nil)
	delReq = delReq.WithContext(domain.WithUserID(delReq.Context(), "u1"))
	delW := httptest.NewRecorder()
	handler.HandleDeleteAvatar()(delW, delReq)
	if delW.Code != http.StatusOK {
		t.Fatalf("expected 200 on delete avatar, got %d: %s", delW.Code, delW.Body.String())
	}

	// 7. Subsequent GET -> 404 Not Found
	getReq3 := httptest.NewRequest(http.MethodGet, "/api/v1/users/u1/avatar", nil)
	getReq3.SetPathValue("id", "u1")
	getW3 := httptest.NewRecorder()
	handler.HandleGetAvatar()(getW3, getReq3)
	if getW3.Code != http.StatusNotFound {
		t.Fatalf("expected 404 after deletion, got %d", getW3.Code)
	}
}
