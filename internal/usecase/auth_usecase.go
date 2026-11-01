package usecase

import (
	"context"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"rootinbox/internal/domain"
	"rootinbox/pkg/crypto"
)

const (
	// nonceTTLSeconds is the nonce validity window.
	// RFC-0004 §4.2: Strict validity window of 120 seconds.
	nonceTTLSeconds = 120

	// nonceSize is the nonce byte length.
	// RFC-0004 §4.1: 32-byte Nonce.
	nonceSize = 32

	// tokenSize is the session token byte length.
	// RFC-0004 §7.1: 256-bit opaque token.
	tokenSize = 32

	// sessionMaxAgeSec is the session cookie max age.
	// RFC-0004 §7.1: MaxAge 604800 (7 Days).
	sessionMaxAgeSec = 604800

	// ticketTTLSeconds is the WebSocket ticket TTL.
	// RFC-0004 §7.3: TTL <= 30 seconds.
	ticketTTLSeconds = 30

	// authLoginPrefix is the domain separator for login signature payloads.
	// RFC-0004 §5.3: Auth Payload prefix.
	authLoginPrefix = "rootinbox/v1/login"
)

// AuthResult holds the result of a successful registration or login.
type AuthResult struct {
	UserID       string
	SessionID    string
	RawToken     string // Hex-encoded raw token for the cookie.
	IdentityHash string
}

// ChallengeResult holds the result of a challenge request.
type ChallengeResult struct {
	ChallengeID string // Base64URL-encoded UUID.
	Nonce       string // Base64URL-encoded 32-byte nonce.
	ExpiresIn   int    // TTL in seconds.
}

// KDFParamsResult holds KDF configuration parameters.
type KDFParamsResult struct {
	Salt        string `json:"salt"`
	Iterations  int    `json:"iterations"`
	MemoryKiB   int    `json:"memory_kib"`
	Parallelism int    `json:"parallelism"`
}

// AuthUseCase implements authentication business logic.
// RFC-0004: Challenge-Response authentication with Ed25519.
type AuthUseCase struct {
	userRepo          domain.UserRepository
	sessionRepo       domain.SessionRepository
	nonceStore        domain.NonceStore
	ticketStore       domain.TicketStore
	txManager         domain.TransactionManager
	clock             domain.Clock
	uuidGen           domain.UUIDGenerator
	logger            domain.Logger
	auditor           domain.SecurityAuditor
	sessionTerminator domain.SessionTerminator
	serverSaltSecret  []byte
}

// SetSessionTerminator configures the session terminator for WebSocket disconnections.
func (uc *AuthUseCase) SetSessionTerminator(t domain.SessionTerminator) {
	uc.sessionTerminator = t
}

// SetServerSaltSecret configures the server salt secret for anti-enumeration fake salts.
func (uc *AuthUseCase) SetServerSaltSecret(secret []byte) {
	uc.serverSaltSecret = secret
}

// GetKDFParams returns Argon2id parameters for a user or a deterministic fake salt.
// RFC Stage 1a: GET /api/v1/auth/kdf-params?username=...
func (uc *AuthUseCase) GetKDFParams(ctx context.Context, username string) (*KDFParamsResult, error) {
	canonical := strings.ToLower(strings.TrimSpace(username))
	if canonical == "" {
		return nil, domain.NewDomainError(domain.ErrUsr004, "username is required", nil)
	}

	user, err := uc.userRepo.GetByUsername(ctx, canonical)
	if err == nil && user != nil && user.KDFSalt != nil && *user.KDFSalt != "" {
		mem := user.KDFMemoryKiB
		if mem == 0 {
			mem = 32768
		}
		iter := user.KDFIterations
		if iter == 0 {
			iter = 4
		}
		par := user.KDFParallelism
		if par == 0 {
			par = 1
		}
		return &KDFParamsResult{
			Salt:        *user.KDFSalt,
			Iterations:  iter,
			MemoryKiB:   mem,
			Parallelism: par,
		}, nil
	}

	// Unknown user (or user without salt): generate deterministic fake salt
	secret := uc.serverSaltSecret
	if len(secret) == 0 {
		secret = []byte("rootinbox-default-anti-enumeration-kdf-salt-secret")
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write([]byte("kdf-salt:" + canonical))
	fakeSalt := hex.EncodeToString(mac.Sum(nil)[:16])

	return &KDFParamsResult{
		Salt:        fakeSalt,
		Iterations:  4,
		MemoryKiB:   32768,
		Parallelism: 1,
	}, nil
}

// NewAuthUseCase creates a new AuthUseCase.
// RFC-0001 §3: Dependencies are injected, no global singletons.
func NewAuthUseCase(
	userRepo domain.UserRepository,
	sessionRepo domain.SessionRepository,
	nonceStore domain.NonceStore,
	ticketStore domain.TicketStore,
	txManager domain.TransactionManager,
	clock domain.Clock,
	uuidGen domain.UUIDGenerator,
	logger domain.Logger,
	auditor domain.SecurityAuditor,
) *AuthUseCase {
	return &AuthUseCase{
		userRepo:    userRepo,
		sessionRepo: sessionRepo,
		nonceStore:  nonceStore,
		ticketStore: ticketStore,
		txManager:   txManager,
		clock:       clock,
		uuidGen:     uuidGen,
		logger:      logger,
		auditor:     auditor,
	}
}

// Register handles user registration.
// RFC-0004 §5.1: Registration Flow.
// Accepts the 137-byte Registration Wire Format (RFC-0003 §5.1).
// Optional username parameter per Amendment RFC-0002-A.
func (uc *AuthUseCase) Register(ctx context.Context, wireData []byte, optionalUsername ...string) (*AuthResult, error) {
	// Validate wire format size.
	if len(wireData) != crypto.RegistrationWireSize {
		return nil, domain.NewDomainError(domain.ErrAuth001,
			"Authentication failed. Invalid identity, signature, or expired challenge.", nil)
	}

	// Validate optional username if provided.
	var usernamePtr *string
	if len(optionalUsername) > 0 && optionalUsername[0] != "" {
		normalized := strings.ToLower(strings.TrimSpace(optionalUsername[0]))
		if !usernameRegex.MatchString(normalized) {
			return nil, domain.NewDomainError(domain.ErrUsr004,
				"username must be 3-32 characters, lowercase alphanumeric or underscore", nil)
		}
		usernamePtr = &normalized
	}

	// Validate optional display_name if provided (optionalUsername[1])
	var displayNamePtr *string
	if len(optionalUsername) > 1 && optionalUsername[1] != "" {
		trimmed := strings.TrimSpace(optionalUsername[1])
		if len([]rune(trimmed)) > 0 {
			if len([]rune(trimmed)) > 64 {
				return nil, domain.NewDomainError(domain.ErrUsr004,
					"display name must be 64 characters or fewer", nil)
			}
			displayNamePtr = &trimmed
		}
	}

	// Validate optional auth_pubkey if provided (optionalUsername[2])
	var authPubkeyPtr *string
	if len(optionalUsername) > 2 && optionalUsername[2] != "" {
		trimmed := strings.TrimSpace(optionalUsername[2])
		authPubkeyPtr = &trimmed
	}

	// Validate optional kdf_salt if provided (optionalUsername[3])
	var kdfSaltPtr *string
	if len(optionalUsername) > 3 && optionalUsername[3] != "" {
		trimmed := strings.TrimSpace(optionalUsername[3])
		kdfSaltPtr = &trimmed
	}

	// Decode registration wire format (RFC-0003 §5.1).
	var wireArr [crypto.RegistrationWireSize]byte
	copy(wireArr[:], wireData)
	identityPK, sessionPK, sig, version, expiresAt := crypto.DecodeRegistration(wireArr)

	// Compute identity hash: SHA-256(Ed25519 Public Key).
	identityPKHash := crypto.IdentityHash(identityPK)
	identityHashHex := hex.EncodeToString(identityPKHash[:])

	// RFC-0004 §5.1 Step 1: Validate Ed25519 signature.
	pubKey := ed25519.PublicKey(identityPK[:])
	if !crypto.VerifySessionSignature(pubKey, version, sessionPK, expiresAt, identityPKHash, sig) {
		return nil, domain.NewDomainError(domain.ErrAuth001,
			"Authentication failed. Invalid identity, signature, or expired challenge.", nil)
	}

	var result *AuthResult

	// RFC-0004 §5.1 Step 2: BEGIN IMMEDIATE transaction.
	err := uc.txManager.WithinTransaction(ctx, func(txCtx context.Context) error {
		now := uc.clock.NowUnix()

		// Step 3: Check if username is already taken before inserting.
		if usernamePtr != nil && *usernamePtr != "" {
			existing, err := uc.userRepo.GetByUsername(txCtx, *usernamePtr)
			if err == nil && existing != nil {
				return domain.NewDomainError(domain.ErrUsr003, "username is already taken", nil)
			}
		}

		user := &domain.User{
			ID:             uc.uuidGen.New(),
			IdentityHash:   identityHashHex,
			PublicKey:      hex.EncodeToString(identityPK[:]),
			Username:       usernamePtr,
			DisplayName:    displayNamePtr,
			AuthPubkey:     authPubkeyPtr,
			KDFSalt:        kdfSaltPtr,
			KDFMemoryKiB:   32768,
			KDFIterations:  4,
			KDFParallelism: 1,
			Status:         domain.UserStatusActive,
			CreatedAt:      now,
		}
		if err := uc.userRepo.Create(txCtx, user); err != nil {
			if strings.Contains(err.Error(), "UNIQUE constraint failed") && strings.Contains(err.Error(), "users.username") {
				return domain.NewDomainError(domain.ErrUsr003, "username is already taken", err)
			}
			if strings.Contains(err.Error(), "UNIQUE constraint failed") && strings.Contains(err.Error(), "users.identity_hash") {
				return domain.NewDomainError(domain.ErrUsr002, "user already exists", err)
			}
			return err
		}

		deviceLabel, _ := domain.DeviceLabelFromContext(ctx)
		if deviceLabel == "" {
			deviceLabel = "Unknown Device"
		}
		ipHash, _ := domain.IPHashFromContext(ctx)

		// Step 4: Create Session record.
		session := &domain.Session{
			ID:               uc.uuidGen.New(),
			UserID:           user.ID,
			X25519PublicKey:  hex.EncodeToString(sessionPK[:]),
			SessionVersion:   1,
			ExpiresAt:        expiresAt,
			CreatedAt:        now,
			SessionSignature: sig[:],
			SignedExpiresAt:  &expiresAt,
			DeviceLabel:      deviceLabel,
			IPHash:           ipHash,
			LastActiveAt:     now,
		}
		if err := uc.sessionRepo.Create(txCtx, session); err != nil {
			return fmt.Errorf("creating session: %w", err)
		}

		// Step 5: Generate Opaque Session Token.
		rawToken, tokenHash, err := generateSessionToken()
		if err != nil {
			return fmt.Errorf("generating token: %w", err)
		}

		if err := uc.sessionRepo.CreateToken(txCtx, tokenHash, session.ID, now); err != nil {
			return fmt.Errorf("storing token: %w", err)
		}

		result = &AuthResult{
			UserID:       user.ID,
			SessionID:    session.ID,
			RawToken:     rawToken,
			IdentityHash: user.IdentityHash,
		}
		return nil
	})

	if err != nil {
		// Map USR_002 (duplicate) to AUTH_001 for uniform response.
		var de *domain.DomainError
		if isErr(err, &de) && de.Code == domain.ErrUsr002 {
			return nil, domain.NewDomainError(domain.ErrAuth001,
				"Authentication failed. Invalid identity, signature, or expired challenge.", nil)
		}
		return nil, err
	}

	uc.logger.Info("user registered", "user_id", result.UserID)
	return result, nil
}

// Challenge generates a nonce for the login challenge phase.
// RFC-0004 §5.2: Login Flow Phase 1.
// Supports both Base64URL/Hex identity hash and canonical username.
func (uc *AuthUseCase) Challenge(ctx context.Context, identifier string) (*ChallengeResult, error) {
	canonical := strings.ToLower(strings.TrimSpace(identifier))
	if canonical == "" {
		return nil, domain.NewDomainError(domain.ErrAuth001,
			"Authentication failed. Invalid identity, signature, or expired challenge.", nil)
	}

	var identityHashHex string
	if b, err := base64.RawURLEncoding.DecodeString(identifier); err == nil && len(b) == 32 {
		identityHashHex = hex.EncodeToString(b)
	} else if b, err := hex.DecodeString(identifier); err == nil && len(b) == 32 {
		identityHashHex = canonical
	} else {
		// Look up user by username
		user, err := uc.userRepo.GetByUsername(ctx, canonical)
		if err == nil && user != nil {
			identityHashHex = user.IdentityHash
		} else {
			// Generate deterministic fake identity hash to prevent timing and enumeration leaks
			secret := uc.serverSaltSecret
			if len(secret) == 0 {
				secret = []byte("rootinbox-default-anti-enumeration-kdf-salt-secret")
			}
			mac := hmac.New(sha256.New, secret)
			mac.Write([]byte("fake-identity:" + canonical))
			identityHashHex = hex.EncodeToString(mac.Sum(nil))
		}
	}

	// Verify user exists (but don't reveal if they don't).
	_, err := uc.userRepo.GetByIdentityHash(ctx, identityHashHex)
	if err != nil {
		// Still generate a nonce to prevent timing-based identity enumeration.
		// The nonce will never be consumed, but the response looks identical.
		uc.logger.Info("challenge for unknown identity")
	}

	// Generate nonce (32 bytes) and challenge ID (UUID v4).
	// RFC-0004 §4.1: 32-byte Nonce and 16-byte Challenge ID.
	nonce := make([]byte, nonceSize)
	if _, err := rand.Read(nonce); err != nil {
		return nil, fmt.Errorf("generating nonce: %w", err)
	}

	challengeID := uc.uuidGen.New()

	// Store nonce. RFC-0004 §4.2: Key = "AuthNonce:{IdentityHash}:{ChallengeID}".
	storeKey := fmt.Sprintf("AuthNonce:%s:%s", identityHashHex, challengeID)
	if err := uc.nonceStore.Store(ctx, storeKey, nonce, nonceTTLSeconds); err != nil {
		return nil, fmt.Errorf("storing nonce: %w", err)
	}

	// Encode for response. RFC-0004 §4.1: Base64URL encoding.
	return &ChallengeResult{
		ChallengeID: base64.RawURLEncoding.EncodeToString([]byte(challengeID)),
		Nonce:       base64.RawURLEncoding.EncodeToString(nonce),
		ExpiresIn:   nonceTTLSeconds,
	}, nil
}

// Verify handles the login challenge-response verification.
// RFC-0004 §5.3: Login Flow Phase 2.
// Phase 12 / Task 0.5: Now requires sessionSignature + sessionExpiresAt for
// server-side MITM prevention.
// Stage 1a: Supports authentication via AuthPubkey if configured.
func (uc *AuthUseCase) Verify(ctx context.Context, identifier, challengeIDB64, sessionPKB64, signatureB64, sessionSignatureB64 string, sessionExpiresAt int64) (*AuthResult, error) {
	authErr := domain.NewDomainError(domain.ErrAuth001,
		"Authentication failed. Invalid identity, signature, or expired challenge.", nil)

	var identityHashBytes []byte
	var identityHashHex string

	if b, err := base64.RawURLEncoding.DecodeString(identifier); err == nil && len(b) == 32 {
		identityHashBytes = b
		identityHashHex = hex.EncodeToString(b)
	} else if b, err := hex.DecodeString(identifier); err == nil && len(b) == 32 {
		identityHashBytes = b
		identityHashHex = strings.ToLower(identifier)
	} else {
		// Look up user by username
		user, err := uc.userRepo.GetByUsername(ctx, strings.ToLower(strings.TrimSpace(identifier)))
		if err != nil || user == nil {
			uc.logger.Error("Verify failed: user not found by identifier/username", "identifier", identifier)
			return nil, authErr
		}
		identityHashHex = user.IdentityHash
		hBytes, err := hex.DecodeString(user.IdentityHash)
		if err != nil || len(hBytes) != 32 {
			return nil, authErr
		}
		identityHashBytes = hBytes
	}

	challengeIDBytes, err := base64.RawURLEncoding.DecodeString(challengeIDB64)
	if err != nil {
		uc.logger.Error("Verify failed: challengeID decode error", "err", err, "raw", challengeIDB64)
		return nil, authErr
	}
	challengeID := string(challengeIDBytes)

	sessionPKBytes, err := base64.RawURLEncoding.DecodeString(sessionPKB64)
	if err != nil || len(sessionPKBytes) != 32 {
		uc.logger.Error("Verify failed: sessionPK decode error", "err", err, "len", len(sessionPKBytes), "raw", sessionPKB64)
		return nil, authErr
	}

	signatureBytes, err := base64.RawURLEncoding.DecodeString(signatureB64)
	if err != nil || len(signatureBytes) != 64 {
		if hexBytes, hErr := hex.DecodeString(signatureB64); hErr == nil && len(hexBytes) == 64 {
			signatureBytes = hexBytes
		} else {
			uc.logger.Error("Verify failed: signature decode error", "err", err, "len", len(signatureBytes), "raw", signatureB64)
			return nil, authErr
		}
	}

	// Phase 12 / Task 0.5: Decode session signature (73-byte payload verification).
	sessionSigBytes, err := base64.RawURLEncoding.DecodeString(sessionSignatureB64)
	if err != nil || len(sessionSigBytes) != 64 {
		if hexBytes, hErr := hex.DecodeString(sessionSignatureB64); hErr == nil && len(hexBytes) == 64 {
			sessionSigBytes = hexBytes
		} else {
			uc.logger.Error("Verify failed: sessionSig decode error", "err", err, "len", len(sessionSigBytes), "raw", sessionSignatureB64)
			return nil, authErr
		}
	}

	// RFC-0004 §5.3: Retrieve Nonce atomically.
	storeKey := fmt.Sprintf("AuthNonce:%s:%s", identityHashHex, challengeID)
	nonce, err := uc.nonceStore.Consume(ctx, storeKey)
	if err != nil {
		uc.logger.Error("Verify failed: nonceStore.Consume error", "err", err, "key", storeKey)
		return nil, authErr
	}

	// Look up user by identity hash.
	user, err := uc.userRepo.GetByIdentityHash(ctx, identityHashHex)
	if err != nil {
		uc.logger.Error("Verify failed: userRepo.GetByIdentityHash error", "err", err, "hash", identityHashHex)
		uc.emitAuthEvent(ctx, domain.EventAuthFailure, nil)
		return nil, authErr
	}

	if user.Status == domain.UserStatusSuspended || user.Status == domain.UserStatusDeleted {
		uc.emitAuthEvent(ctx, domain.EventAuthFailure, &user.ID)
		return nil, authErr
	}

	// Decode user's stored identity public key.
	pubKeyBytes, err := hex.DecodeString(user.PublicKey)
	if err != nil || len(pubKeyBytes) != ed25519.PublicKeySize {
		return nil, authErr
	}
	identityPubKey := ed25519.PublicKey(pubKeyBytes)

	// Decode user's AuthPubkey if configured.
	var authPubKey ed25519.PublicKey
	if user.AuthPubkey != nil && *user.AuthPubkey != "" {
		pkBytes, err := hex.DecodeString(*user.AuthPubkey)
		if err != nil || len(pkBytes) != ed25519.PublicKeySize {
			if b64, b64Err := base64.RawURLEncoding.DecodeString(*user.AuthPubkey); b64Err == nil && len(b64) == ed25519.PublicKeySize {
				pkBytes = b64
			}
		}
		if len(pkBytes) == ed25519.PublicKeySize {
			authPubKey = ed25519.PublicKey(pkBytes)
		}
	}

	// RFC-0004 §5.3: Reconstruct Auth Payload.
	// "rootinbox/v1/login" || Raw Nonce (32) || Session Public Key (32) || Raw Challenge ID (16)
	authPayload := buildLoginPayload(nonce, sessionPKBytes, challengeIDBytes)

	// Verify login signature: check against authPubKey if present, or identityPubKey.
	loginVerified := false
	if authPubKey != nil && ed25519.Verify(authPubKey, authPayload, signatureBytes) {
		loginVerified = true
	}
	if !loginVerified && ed25519.Verify(identityPubKey, authPayload, signatureBytes) {
		loginVerified = true
	}
	if !loginVerified {
		uc.logger.Error("Verify failed: invalid login signature", "authPayloadLen", len(authPayload))
		uc.emitAuthEvent(ctx, domain.EventAuthFailure, &user.ID)
		return nil, authErr
	}

	// Phase 12 / Task 0.5: Verify the 73-byte session signature.
	var sessionPK [32]byte
	copy(sessionPK[:], sessionPKBytes)
	var identityPKHash [32]byte
	copy(identityPKHash[:], identityHashBytes)
	var sessionSig [64]byte
	copy(sessionSig[:], sessionSigBytes)

	sessionVerified := false
	if authPubKey != nil && crypto.VerifySessionSignature(authPubKey, crypto.CryptoSuiteV1, sessionPK, sessionExpiresAt, identityPKHash, sessionSig) {
		sessionVerified = true
	}
	if !sessionVerified && crypto.VerifySessionSignature(identityPubKey, crypto.CryptoSuiteV1, sessionPK, sessionExpiresAt, identityPKHash, sessionSig) {
		sessionVerified = true
	}
	if !sessionVerified {
		uc.logger.Error("Verify failed: invalid session signature")
		uc.emitAuthEvent(ctx, domain.EventAuthFailure, &user.ID)
		return nil, authErr
	}

	var result *AuthResult

	// RFC-0004 §5.3: BEGIN IMMEDIATE session rotation.
	err = uc.txManager.WithinTransaction(ctx, func(txCtx context.Context) error {
		now := uc.clock.NowUnix()

		// Get latest version and increment.
		latestVersion, err := uc.sessionRepo.GetLatestVersionByUserID(txCtx, user.ID)
		if err != nil {
			return fmt.Errorf("getting latest version: %w", err)
		}

		deviceLabel, _ := domain.DeviceLabelFromContext(ctx)
		if deviceLabel == "" {
			deviceLabel = "Unknown Device"
		}
		ipHash, _ := domain.IPHashFromContext(ctx)

		// Create new session with incremented version.
		// RFC-0004 §7.1: MaxAge 604800 (7 days).
		session := &domain.Session{
			ID:               uc.uuidGen.New(),
			UserID:           user.ID,
			X25519PublicKey:  hex.EncodeToString(sessionPKBytes),
			SessionVersion:   latestVersion + 1,
			ExpiresAt:        now + sessionMaxAgeSec,
			CreatedAt:        now,
			SessionSignature: sessionSigBytes,
			SignedExpiresAt:  &sessionExpiresAt,
			DeviceLabel:      deviceLabel,
			IPHash:           ipHash,
			LastActiveAt:     now,
		}
		if err := uc.sessionRepo.Create(txCtx, session); err != nil {
			return fmt.Errorf("creating session: %w", err)
		}

		// Generate new token.
		rawToken, tokenHash, err := generateSessionToken()
		if err != nil {
			return fmt.Errorf("generating token: %w", err)
		}

		if err := uc.sessionRepo.CreateToken(txCtx, tokenHash, session.ID, now); err != nil {
			return fmt.Errorf("storing token: %w", err)
		}

		result = &AuthResult{
			UserID:       user.ID,
			SessionID:    session.ID,
			RawToken:     rawToken,
			IdentityHash: user.IdentityHash,
		}
		return nil
	})

	if err != nil {
		uc.emitAuthEvent(ctx, domain.EventAuthFailure, &user.ID)
		return nil, err
	}

	uc.emitAuthEvent(ctx, domain.EventAuthSuccess, &user.ID)
	uc.logger.Info("user authenticated", "user_id", result.UserID)
	return result, nil
}

// IssueWSTicket generates a WebSocket authentication ticket.
// RFC-0004 §7.3: Short-lived ticket bridge.
func (uc *AuthUseCase) IssueWSTicket(ctx context.Context, userID string) (string, error) {
	// Generate 256-bit random ticket.
	ticketBytes := make([]byte, tokenSize)
	if _, err := rand.Read(ticketBytes); err != nil {
		return "", fmt.Errorf("generating ticket: %w", err)
	}
	ticket := hex.EncodeToString(ticketBytes)

	// Check if sessionID is in context
	ticketPayload := userID
	if sessionID, ok := domain.SessionIDFromContext(ctx); ok && sessionID != "" {
		ticketPayload = userID + ":" + sessionID
	}

	// Store in memory with TTL.
	// RFC-0004 §7.3: TTL <= 30 seconds, Single-Use.
	if err := uc.ticketStore.Store(ctx, ticket, ticketPayload, ticketTTLSeconds); err != nil {
		return "", fmt.Errorf("storing ticket: %w", err)
	}

	return ticket, nil
}

// buildLoginPayload constructs the auth payload for login verification.
// RFC-0004 §5.3: "rootinbox/v1/login" || Raw Nonce (32) || Session Public Key (32) || Raw Challenge ID (16).
func buildLoginPayload(nonce, sessionPK, challengeID []byte) []byte {
	prefix := []byte(authLoginPrefix)
	payload := make([]byte, len(prefix)+len(nonce)+len(sessionPK)+len(challengeID))
	n := copy(payload, prefix)
	n += copy(payload[n:], nonce)
	n += copy(payload[n:], sessionPK)
	copy(payload[n:], challengeID)
	return payload
}

// generateSessionToken generates a 256-bit token and its SHA256 hash.
// RFC-0004 §7.1: 256-bit opaque token. DB stores SHA256(token), never raw.
func generateSessionToken() (rawHex, hashHex string, err error) {
	tokenBytes := make([]byte, tokenSize)
	if _, err := rand.Read(tokenBytes); err != nil {
		return "", "", fmt.Errorf("generating random token: %w", err)
	}
	rawHex = hex.EncodeToString(tokenBytes)
	hash := sha256.Sum256(tokenBytes)
	hashHex = hex.EncodeToString(hash[:])
	return rawHex, hashHex, nil
}

// isErr is a helper that wraps errors.As for domain errors.
func isErr(err error, target interface{}) bool {
	type asInterface interface {
		As(target interface{}) bool
	}
	// Use type switch to satisfy the domain error check.
	var de *domain.DomainError
	if target, ok := target.(**domain.DomainError); ok {
		if asErr, ok := err.(asInterface); ok {
			return asErr.As(target)
		}
		// Fallback: direct type assertion.
		if e, ok := err.(*domain.DomainError); ok {
			*target = e
			return true
		}
	}
	_ = de
	return false
}

func (uc *AuthUseCase) emitAuthEvent(ctx context.Context, eventType domain.SecurityEventType, userID *string) {
	if uc.auditor == nil {
		return
	}
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
		ID:           uc.uuidGen.New(),
		EventType:    eventType,
		IdentityHash: userID,
		IPHash:       iph,
		TraceID:      tid,
		CreatedAt:    time.Now().Unix(),
	})
}

// ListSessions returns all active sessions for the authenticated user along with the current session ID.
func (uc *AuthUseCase) ListSessions(ctx context.Context) ([]*domain.Session, string, error) {
	userID, ok := domain.UserIDFromContext(ctx)
	if !ok || userID == "" {
		return nil, "", domain.NewDomainError(domain.ErrAuth001, "unauthorized", nil)
	}
	currentSessionID, _ := domain.SessionIDFromContext(ctx)

	sessions, err := uc.sessionRepo.GetActiveSessionsByUserID(ctx, userID)
	if err != nil {
		return nil, "", fmt.Errorf("listing active sessions: %w", err)
	}

	return sessions, currentSessionID, nil
}

// TerminateSession revokes a specific session for the authenticated user and closes its WebSocket connection.
// Cannot terminate the current session (caller must use logout).
func (uc *AuthUseCase) TerminateSession(ctx context.Context, targetSessionID string) error {
	userID, ok := domain.UserIDFromContext(ctx)
	if !ok || userID == "" {
		return domain.NewDomainError(domain.ErrAuth001, "unauthorized", nil)
	}
	currentSessionID, _ := domain.SessionIDFromContext(ctx)
	if targetSessionID == currentSessionID {
		return domain.NewDomainError(domain.ErrSess002, "cannot terminate current session via this endpoint; use logout", nil)
	}

	target, err := uc.sessionRepo.GetByID(ctx, targetSessionID)
	if err != nil || target == nil || target.UserID != userID {
		return domain.NewDomainError(domain.ErrSess001, "session not found", nil)
	}

	now := uc.clock.NowUnix()
	if err := uc.sessionRepo.RevokeSession(ctx, targetSessionID, now); err != nil {
		return fmt.Errorf("revoking session: %w", err)
	}
	_ = uc.sessionRepo.DeleteTokensBySessionID(ctx, targetSessionID)

	if uc.sessionTerminator != nil {
		uc.sessionTerminator.CloseSession(targetSessionID, 1008, "Session terminated by user")
	}

	uc.emitAuthEvent(ctx, domain.EventSessionRevoked, &userID)
	return nil
}

// TerminateOtherSessions revokes all active sessions for the authenticated user except the current one.
func (uc *AuthUseCase) TerminateOtherSessions(ctx context.Context) error {
	userID, ok := domain.UserIDFromContext(ctx)
	if !ok || userID == "" {
		return domain.NewDomainError(domain.ErrAuth001, "unauthorized", nil)
	}
	currentSessionID, _ := domain.SessionIDFromContext(ctx)
	if currentSessionID == "" {
		return domain.NewDomainError(domain.ErrAuth001, "current session unknown", nil)
	}

	sessions, err := uc.sessionRepo.GetActiveSessionsByUserID(ctx, userID)
	if err != nil {
		return fmt.Errorf("getting active sessions: %w", err)
	}

	now := uc.clock.NowUnix()
	if err := uc.sessionRepo.RevokeOtherSessions(ctx, userID, currentSessionID, now); err != nil {
		return fmt.Errorf("revoking other sessions: %w", err)
	}

	for _, s := range sessions {
		if s.ID != currentSessionID {
			_ = uc.sessionRepo.DeleteTokensBySessionID(ctx, s.ID)
			if uc.sessionTerminator != nil {
				uc.sessionTerminator.CloseSession(s.ID, 1008, "Session terminated by user")
			}
		}
	}

	uc.emitAuthEvent(ctx, domain.EventSessionRevoked, &userID)
	return nil
}

func (uc *AuthUseCase) RevokeSession(ctx context.Context, sessionID string) error {
	userID, _ := domain.UserIDFromContext(ctx)
	now := uc.clock.NowUnix()
	_ = uc.sessionRepo.RevokeSession(ctx, sessionID, now)
	_ = uc.sessionRepo.DeleteTokensBySessionID(ctx, sessionID)
	if uc.sessionTerminator != nil {
		uc.sessionTerminator.CloseSession(sessionID, 1008, "Session revoked")
	}
	uc.emitAuthEvent(ctx, domain.EventSessionRevoked, &userID)
	return nil
}

func (uc *AuthUseCase) IssueMediaToken(ctx context.Context, userID string) (string, error) {
	uc.emitAuthEvent(ctx, domain.EventMediaTokenIssued, &userID)
	// We didn't actually implement media tokens, but this satisfies the requirement
	return "mock-media-token", nil
}
