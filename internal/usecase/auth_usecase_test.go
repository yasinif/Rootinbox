package usecase

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"testing"

	"rootinbox/internal/domain"
	"rootinbox/pkg/crypto"
)

type mockUserRepoForAuth struct {
	usersByID       map[string]*domain.User
	usersByUsername map[string]*domain.User
	usersByHash     map[string]*domain.User
}

func newMockUserRepoForAuth() *mockUserRepoForAuth {
	return &mockUserRepoForAuth{
		usersByID:       make(map[string]*domain.User),
		usersByUsername: make(map[string]*domain.User),
		usersByHash:     make(map[string]*domain.User),
	}
}

func (m *mockUserRepoForAuth) Create(ctx context.Context, u *domain.User) error {
	m.usersByID[u.ID] = u
	m.usersByHash[u.IdentityHash] = u
	if u.Username != nil {
		m.usersByUsername[*u.Username] = u
	}
	return nil
}

func (m *mockUserRepoForAuth) GetByID(ctx context.Context, id string) (*domain.User, error) {
	if u, ok := m.usersByID[id]; ok {
		return u, nil
	}
	return nil, domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
}

func (m *mockUserRepoForAuth) GetByIdentityHash(ctx context.Context, hash string) (*domain.User, error) {
	if u, ok := m.usersByHash[hash]; ok {
		return u, nil
	}
	return nil, domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
}

func (m *mockUserRepoForAuth) GetByUsername(ctx context.Context, username string) (*domain.User, error) {
	if u, ok := m.usersByUsername[username]; ok {
		return u, nil
	}
	return nil, domain.NewDomainError(domain.ErrUsr001, "user not found", nil)
}

func (m *mockUserRepoForAuth) SearchByUsername(ctx context.Context, query string, limit int) ([]*domain.User, error) {
	return nil, nil
}

func (m *mockUserRepoForAuth) UpdateStatus(ctx context.Context, id string, status domain.UserStatus, updatedAt int64) error {
	return nil
}

func (m *mockUserRepoForAuth) UpdateUsername(ctx context.Context, id string, username *string) error {
	return nil
}

func (m *mockUserRepoForAuth) UpdateAvatar(ctx context.Context, id string, mime *string, updatedAt *int64) error {
	return nil
}

func (m *mockUserRepoForAuth) UpdateProfile(ctx context.Context, id string, displayName, lastName, bio *string) error {
	return nil
}

func (m *mockUserRepoForAuth) UpdateLastSeen(ctx context.Context, id string, timestampMs int64) error {
	return nil
}

func (m *mockUserRepoForAuth) UpdateAuthCredentials(ctx context.Context, id string, authPubkey, kdfSalt string, memoryKiB, iterations, parallelism int) error {
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

func (m *mockUserRepoForAuth) Delete(ctx context.Context, id string) error {
	delete(m.usersByID, id)
	return nil
}

type mockSessionRepoForAuth struct {
	sessions       map[string]*domain.Session
	tokens         map[string]string // tokenHash -> sessionID
	latestVersions map[string]int
}

func newMockSessionRepoForAuth() *mockSessionRepoForAuth {
	return &mockSessionRepoForAuth{
		sessions:       make(map[string]*domain.Session),
		tokens:         make(map[string]string),
		latestVersions: make(map[string]int),
	}
}

func (m *mockSessionRepoForAuth) Create(ctx context.Context, s *domain.Session) error {
	m.sessions[s.ID] = s
	m.latestVersions[s.UserID] = s.SessionVersion
	return nil
}

func (m *mockSessionRepoForAuth) CreateToken(ctx context.Context, tokenHash string, sessionID string, createdAt int64) error {
	m.tokens[tokenHash] = sessionID
	return nil
}

func (m *mockSessionRepoForAuth) GetByTokenHash(ctx context.Context, tokenHash string) (*domain.Session, error) {
	sessID, ok := m.tokens[tokenHash]
	if !ok {
		return nil, domain.NewDomainError(domain.ErrAuth001, "session token not found", nil)
	}
	return m.sessions[sessID], nil
}

func (m *mockSessionRepoForAuth) GetActiveByUserID(ctx context.Context, userID string) (*domain.Session, error) {
	for _, s := range m.sessions {
		if s.UserID == userID && s.RevokedAt == nil {
			return s, nil
		}
	}
	return nil, domain.NewDomainError(domain.ErrAuth001, "no active session", nil)
}

func (m *mockSessionRepoForAuth) RevokeByUserID(ctx context.Context, userID string, revokedAt int64) error {
	for _, s := range m.sessions {
		if s.UserID == userID && s.RevokedAt == nil {
			s.RevokedAt = &revokedAt
		}
	}
	return nil
}

func (m *mockSessionRepoForAuth) RevokeOtherSessions(ctx context.Context, userID, currentSessionID string, revokedAt int64) error {
	for _, s := range m.sessions {
		if s.UserID == userID && s.ID != currentSessionID && s.RevokedAt == nil {
			s.RevokedAt = &revokedAt
		}
	}
	return nil
}

func (m *mockSessionRepoForAuth) GetLatestVersionByUserID(ctx context.Context, userID string) (int, error) {
	return m.latestVersions[userID], nil
}

func (m *mockSessionRepoForAuth) DeleteByUserID(ctx context.Context, userID string) error {
	return nil
}

func (m *mockSessionRepoForAuth) DeleteTokensBySessionID(ctx context.Context, sessionID string) error {
	return nil
}

func (m *mockSessionRepoForAuth) GetByID(ctx context.Context, sessionID string) (*domain.Session, error) {
	if s, ok := m.sessions[sessionID]; ok {
		return s, nil
	}
	return nil, domain.NewDomainError(domain.ErrAuth001, "session not found", nil)
}

func (m *mockSessionRepoForAuth) GetActiveSessionsByUserID(ctx context.Context, userID string) ([]*domain.Session, error) {
	return nil, nil
}

func (m *mockSessionRepoForAuth) UpdateLastActive(ctx context.Context, sessionID string, lastActiveAt int64) error {
	return nil
}

func (m *mockSessionRepoForAuth) RevokeSession(ctx context.Context, sessionID string, revokedAt int64) error {
	return nil
}

type mockNonceStoreForAuth struct {
	nonces map[string][]byte
}

func newMockNonceStoreForAuth() *mockNonceStoreForAuth {
	return &mockNonceStoreForAuth{nonces: make(map[string][]byte)}
}

func (m *mockNonceStoreForAuth) Store(ctx context.Context, key string, nonce []byte, ttlSeconds int) error {
	m.nonces[key] = nonce
	return nil
}

func (m *mockNonceStoreForAuth) Consume(ctx context.Context, key string) ([]byte, error) {
	val, ok := m.nonces[key]
	if !ok {
		return nil, fmt.Errorf("nonce not found or already consumed")
	}
	delete(m.nonces, key)
	return val, nil
}

func TestAuthUseCase_DecoupledAuthAndKDF(t *testing.T) {
	userRepo := newMockUserRepoForAuth()
	sessionRepo := newMockSessionRepoForAuth()
	nonceStore := newMockNonceStoreForAuth()
	clock := &mockClock{now: 1714567890}
	uuidGen := &mockUUIDGen{}
	logger := &mockLogger{}
	txMgr := &mockTxManager{}

	authUC := NewAuthUseCase(userRepo, sessionRepo, nonceStore, nil, txMgr, clock, uuidGen, logger, nil)
	authUC.SetServerSaltSecret([]byte("test-salt-secret-0000111122223333"))

	// Generate keypairs: Identity keypair and decoupled Auth keypair
	idPub, _, _ := ed25519.GenerateKey(rand.Reader)
	authPub, authPriv, _ := ed25519.GenerateKey(rand.Reader)

	idHashBytes := sha256.Sum256(idPub)
	idHashHex := hex.EncodeToString(idHashBytes[:])
	aliceAuthPKHex := hex.EncodeToString(authPub)
	aliceSalt := "4a7bc901e23f00001122334455667788"

	aliceUsername := "alice"
	aliceUser := &domain.User{
		ID:             "alice-uuid-1",
		IdentityHash:   idHashHex,
		PublicKey:      hex.EncodeToString(idPub),
		Username:       &aliceUsername,
		AuthPubkey:     &aliceAuthPKHex,
		KDFSalt:        &aliceSalt,
		KDFMemoryKiB:   32768,
		KDFIterations:  4,
		KDFParallelism: 1,
		Status:         domain.UserStatusActive,
		CreatedAt:      clock.NowUnix(),
	}
	_ = userRepo.Create(context.Background(), aliceUser)

	t.Run("GetKDFParams returns user params", func(t *testing.T) {
		res, err := authUC.GetKDFParams(context.Background(), "alice")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res.Salt != aliceSalt {
			t.Errorf("expected salt %s, got %s", aliceSalt, res.Salt)
		}
		if res.MemoryKiB != 32768 || res.Iterations != 4 || res.Parallelism != 1 {
			t.Errorf("unexpected argon2 parameters: %+v", res)
		}
	})

	t.Run("GetKDFParams returns deterministic fake salt for unknown username", func(t *testing.T) {
		res1, err := authUC.GetKDFParams(context.Background(), "bob_unknown")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		res2, err := authUC.GetKDFParams(context.Background(), "bob_unknown")
		if err != nil {
			t.Fatalf("unexpected error: %v", err)
		}
		if res1.Salt != res2.Salt {
			t.Errorf("fake salt should be deterministic: %s vs %s", res1.Salt, res2.Salt)
		}
	})

	t.Run("Challenge by username and Verify with AuthPubkey signature", func(t *testing.T) {
		challengeRes, err := authUC.Challenge(context.Background(), "alice")
		if err != nil {
			t.Fatalf("challenge failed: %v", err)
		}

		nonceBytes, _ := base64.RawURLEncoding.DecodeString(challengeRes.Nonce)
		challengeIDBytes, _ := base64.RawURLEncoding.DecodeString(challengeRes.ChallengeID)

		sessionPK := make([]byte, 32)
		_, _ = rand.Read(sessionPK)

		authPayload := buildLoginPayload(nonceBytes, sessionPK, challengeIDBytes)
		loginSig := ed25519.Sign(authPriv, authPayload)

		var sessPKArr [32]byte
		copy(sessPKArr[:], sessionPK)
		var idHashArr [32]byte
		copy(idHashArr[:], idHashBytes[:])
		expiresAt := clock.NowUnix() + 604800

		sessionSigArr := crypto.SignSessionKey(authPriv, crypto.CryptoSuiteV1, sessPKArr, expiresAt, idHashArr)

		authRes, err := authUC.Verify(
			context.Background(),
			"alice",
			challengeRes.ChallengeID,
			base64.RawURLEncoding.EncodeToString(sessionPK),
			base64.RawURLEncoding.EncodeToString(loginSig),
			base64.RawURLEncoding.EncodeToString(sessionSigArr[:]),
			expiresAt,
		)
		if err != nil {
			t.Fatalf("verify with authPubkey failed: %v", err)
		}
		if authRes.UserID != "alice-uuid-1" {
			t.Errorf("expected userID alice-uuid-1, got %s", authRes.UserID)
		}
		if authRes.RawToken == "" {
			t.Errorf("expected non-empty session token")
		}
	})

	t.Run("Legacy user without AuthPubkey succeeds with identityPriv", func(t *testing.T) {
		legPub, legPriv, _ := ed25519.GenerateKey(rand.Reader)
		legHash := sha256.Sum256(legPub)
		legHashHex := hex.EncodeToString(legHash[:])

		legacyUsername := "legacy_user"
		legacyUser := &domain.User{
			ID:           "legacy-uuid-2",
			IdentityHash: legHashHex,
			PublicKey:    hex.EncodeToString(legPub),
			Username:     &legacyUsername,
			Status:       domain.UserStatusActive,
			CreatedAt:    clock.NowUnix(),
		}
		_ = userRepo.Create(context.Background(), legacyUser)

		challengeRes, err := authUC.Challenge(context.Background(), legacyUsername)
		if err != nil {
			t.Fatalf("challenge failed: %v", err)
		}

		nonceBytes, _ := base64.RawURLEncoding.DecodeString(challengeRes.Nonce)
		challengeIDBytes, _ := base64.RawURLEncoding.DecodeString(challengeRes.ChallengeID)

		sessionPK := make([]byte, 32)
		_, _ = rand.Read(sessionPK)

		authPayload := buildLoginPayload(nonceBytes, sessionPK, challengeIDBytes)
		loginSig := ed25519.Sign(legPriv, authPayload)

		var sessPKArr [32]byte
		copy(sessPKArr[:], sessionPK)
		var idHashArr [32]byte
		copy(idHashArr[:], legHash[:])
		expiresAt := clock.NowUnix() + 604800

		sessionSigArr := crypto.SignSessionKey(legPriv, crypto.CryptoSuiteV1, sessPKArr, expiresAt, idHashArr)

		authRes, err := authUC.Verify(
			context.Background(),
			legacyUsername,
			challengeRes.ChallengeID,
			base64.RawURLEncoding.EncodeToString(sessionPK),
			base64.RawURLEncoding.EncodeToString(loginSig),
			base64.RawURLEncoding.EncodeToString(sessionSigArr[:]),
			expiresAt,
		)
		if err != nil {
			t.Fatalf("verify for legacy user failed: %v", err)
		}
		if authRes.UserID != "legacy-uuid-2" {
			t.Errorf("expected userID legacy-uuid-2, got %s", authRes.UserID)
		}
	})

	t.Run("Verify fails with tampered signature", func(t *testing.T) {
		challengeRes, err := authUC.Challenge(context.Background(), "alice")
		if err != nil {
			t.Fatalf("challenge failed: %v", err)
		}

		sessionPK := make([]byte, 32)
		_, _ = rand.Read(sessionPK)
		expiresAt := clock.NowUnix() + 604800

		tamperedSig := make([]byte, 64)

		_, err = authUC.Verify(
			context.Background(),
			"alice",
			challengeRes.ChallengeID,
			base64.RawURLEncoding.EncodeToString(sessionPK),
			base64.RawURLEncoding.EncodeToString(tamperedSig),
			base64.RawURLEncoding.EncodeToString(tamperedSig),
			expiresAt,
		)
		if err == nil {
			t.Fatalf("expected verify to fail with invalid signature, but succeeded")
		}
	})
}
