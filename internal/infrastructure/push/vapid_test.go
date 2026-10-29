package push

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"rootinbox/internal/domain"
)

type memoryAppKeyRepo struct {
	keys map[string]*domain.ApplicationKey
}

func newMemoryAppKeyRepo() *memoryAppKeyRepo {
	return &memoryAppKeyRepo{keys: make(map[string]*domain.ApplicationKey)}
}

func (m *memoryAppKeyRepo) GetByID(ctx context.Context, id string) (*domain.ApplicationKey, error) {
	k, ok := m.keys[id]
	if !ok {
		return nil, domain.NewDomainError(domain.ErrPush001, "application key not found", nil)
	}
	// Return a copy so caller mutations don't alter storage directly
	cp := *k
	return &cp, nil
}

func (m *memoryAppKeyRepo) Create(ctx context.Context, key *domain.ApplicationKey) error {
	if _, ok := m.keys[key.ID]; ok {
		return domain.NewDomainError(domain.ErrDB002, "key already exists", nil)
	}
	cp := *key
	m.keys[key.ID] = &cp
	return nil
}

func (m *memoryAppKeyRepo) UpdateCAS(ctx context.Context, key *domain.ApplicationKey, expectedOldCiphertext string) error {
	existing, ok := m.keys[key.ID]
	if !ok {
		return domain.NewDomainError(domain.ErrPush001, "key not found", nil)
	}
	if existing.PrivateKeyEncrypted != expectedOldCiphertext {
		return domain.NewDomainError(domain.ErrPush002, "concurrent modification: expected old ciphertext did not match", nil)
	}
	cp := *key
	m.keys[key.ID] = &cp
	return nil
}

type fixedClock struct {
	now int64
}

func (c fixedClock) NowUnix() int64 { return c.now }

// TestVAPID_FreshInstall verifies that on first boot when application_keys is empty,
// a valid VAPID keypair is generated and stored.
func TestVAPID_FreshInstall(t *testing.T) {
	ctx := context.Background()
	repo := newMemoryAppKeyRepo()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	clock := fixedClock{now: 1700000000}

	var key [32]byte
	for i := range key {
		key[i] = byte(i + 1)
	}

	id, err := InitOrLoad(ctx, repo, key, clock, logger)
	if err != nil {
		t.Fatalf("InitOrLoad on fresh install failed: %v", err)
	}
	if id == nil {
		t.Fatalf("expected non-nil identity")
	}
	if id.PublicKeyBase64URL() == "" {
		t.Fatalf("expected non-empty public key")
	}
	if id.PrivateKeyBase64URL() == "" {
		t.Fatalf("expected non-empty private key")
	}

	stored, err := repo.GetByID(ctx, domain.VAPIDKeyRowID)
	if err != nil {
		t.Fatalf("stored key not found: %v", err)
	}
	if stored.PublicKeyUncompressed != id.PublicKeyBase64URL() {
		t.Fatalf("stored public key %s != identity %s", stored.PublicKeyUncompressed, id.PublicKeyBase64URL())
	}
}

// TestVAPID_NormalReload verifies that subsequent boots with the same configured key
// decrypt and return the existing keypair without regenerating.
func TestVAPID_NormalReload(t *testing.T) {
	ctx := context.Background()
	repo := newMemoryAppKeyRepo()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	clock := fixedClock{now: 1700000000}

	var key [32]byte
	for i := range key {
		key[i] = byte(i + 7)
	}

	// First boot
	id1, err := InitOrLoad(ctx, repo, key, clock, logger)
	if err != nil {
		t.Fatalf("first boot failed: %v", err)
	}

	// Second boot (same key)
	id2, err := InitOrLoad(ctx, repo, key, clock, logger)
	if err != nil {
		t.Fatalf("second boot failed: %v", err)
	}

	if id1.PublicKeyBase64URL() != id2.PublicKeyBase64URL() {
		t.Fatalf("reloaded public key mismatch: %s != %s", id1.PublicKeyBase64URL(), id2.PublicKeyBase64URL())
	}
	if id1.PrivateKeyBase64URL() != id2.PrivateKeyBase64URL() {
		t.Fatalf("reloaded private key mismatch")
	}
}

// TestVAPID_ZeroKeyToRealKeyMigration verifies that when a database contains a VAPID
// keypair encrypted with the all-zero key (created during disabled push), booting with
// a real non-zero key transparently decrypts using the zero-key, re-encrypts the SAME
// keypair under the configured key, persists it, and returns the identity.
func TestVAPID_ZeroKeyToRealKeyMigration(t *testing.T) {
	ctx := context.Background()
	repo := newMemoryAppKeyRepo()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	clock := fixedClock{now: 1700000000}

	var zeroKey [32]byte
	// 1. First boot with zeroKey (production live DB state)
	idZero, err := InitOrLoad(ctx, repo, zeroKey, clock, logger)
	if err != nil {
		t.Fatalf("zeroKey boot failed: %v", err)
	}
	originalPub := idZero.PublicKeyBase64URL()
	originalPriv := idZero.PrivateKeyBase64URL()

	// 2. Second boot with a real configured key -> Migration triggers!
	var realKey [32]byte
	for i := range realKey {
		realKey[i] = byte(i + 42)
	}

	idMigrated, err := InitOrLoad(ctx, repo, realKey, clock, logger)
	if err != nil {
		t.Fatalf("migration boot with realKey failed: %v", err)
	}

	// Must be the SAME keypair!
	if idMigrated.PublicKeyBase64URL() != originalPub {
		t.Fatalf("migrated public key changed: got %s, want %s", idMigrated.PublicKeyBase64URL(), originalPub)
	}
	if idMigrated.PrivateKeyBase64URL() != originalPriv {
		t.Fatalf("migrated private key changed: got %s, want %s", idMigrated.PrivateKeyBase64URL(), originalPriv)
	}

	// 3. Third boot with realKey (normal reload of migrated row)
	idReloaded, err := InitOrLoad(ctx, repo, realKey, clock, logger)
	if err != nil {
		t.Fatalf("reload after migration failed: %v", err)
	}
	if idReloaded.PublicKeyBase64URL() != originalPub {
		t.Fatalf("reloaded public key changed: got %s, want %s", idReloaded.PublicKeyBase64URL(), originalPub)
	}

	// 4. Fourth boot with zero-key now FAILS, proving row is no longer encrypted with zeroKey
	_, err = InitOrLoad(ctx, repo, zeroKey, clock, logger)
	if err == nil {
		t.Fatalf("expected boot with zero-key to fail after migration, but succeeded")
	}
}

// TestVAPID_WrongKeyStillFails verifies that if stored row was encrypted with key A,
// and server boots with key B (where neither is zeroKey), decryption fails outright.
func TestVAPID_WrongKeyStillFails(t *testing.T) {
	ctx := context.Background()
	repo := newMemoryAppKeyRepo()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	clock := fixedClock{now: 1700000000}

	var keyA [32]byte
	keyA[0] = 0xAA
	var keyB [32]byte
	keyB[0] = 0xBB

	// Boot with keyA
	_, err := InitOrLoad(ctx, repo, keyA, clock, logger)
	if err != nil {
		t.Fatalf("boot with keyA failed: %v", err)
	}

	// Boot with wrong keyB
	_, err = InitOrLoad(ctx, repo, keyB, clock, logger)
	if err == nil {
		t.Fatalf("expected boot with wrong keyB to fail, but succeeded")
	}

	var de *domain.DomainError
	if !errors.As(err, &de) {
		t.Fatalf("expected domain error, got %v", err)
	}
	if de.Code != domain.ErrPush002 {
		t.Fatalf("expected error code ErrPush002, got %s", de.Code)
	}
}

// TestVAPID_StartupFailure_WithoutMigrationReproduced explicitly reproduces the exact
// production startup crash that occurs when a database initialized with zero-key (PUSH_ENABLED=false)
// is booted with a configured real key without transparent migration.
func TestVAPID_StartupFailure_WithoutMigrationReproduced(t *testing.T) {
	ctx := context.Background()
	repo := newMemoryAppKeyRepo()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	clock := fixedClock{now: 1700000000}

	// 1. Initial boot with all-zero key (live Railway state when PUSH_ENABLED=false)
	var zeroKey [32]byte
	_, err := InitOrLoad(ctx, repo, zeroKey, clock, logger)
	if err != nil {
		t.Fatalf("fresh boot with zero-key failed: %v", err)
	}

	storedRow, err := repo.GetByID(ctx, domain.VAPIDKeyRowID)
	if err != nil {
		t.Fatalf("failed to retrieve stored row: %v", err)
	}

	// 2. Attempting to decrypt the zero-key encrypted row directly with a configured real key
	// FAILS, reproducing the exact startup failure that broke the server prior to the migration fix.
	var realKey [32]byte
	for i := range realKey {
		realKey[i] = byte(i + 100)
	}

	_, _, decryptErr := decryptScalar(storedRow, realKey)
	if decryptErr == nil {
		t.Fatalf("expected direct decryption of zero-key ciphertext using real key to fail, but succeeded")
	}
	var de *domain.DomainError
	if !errors.As(decryptErr, &de) {
		t.Fatalf("expected domain error from decryption failure, got %v", decryptErr)
	}
	if de.Code != domain.ErrPush002 {
		t.Fatalf("expected ErrPush002, got %s", de.Code)
	}

	// 3. Proves that InitOrLoad with the migration logic handles this exact state gracefully:
	migratedIdentity, err := InitOrLoad(ctx, repo, realKey, clock, logger)
	if err != nil {
		t.Fatalf("InitOrLoad failed to migrate zero-key row: %v", err)
	}
	if migratedIdentity == nil || migratedIdentity.PublicKeyBase64URL() == "" {
		t.Fatalf("migrated identity is invalid")
	}
}

// TestVAPID_WrongNonZeroKey_FailsDistinctFromCorruptKey covers requirement C1(d):
// Proves that a row encrypted with a different NON-zero key fails with the specific wrong-key error,
// which is distinct from corrupt ciphertext (e.g. invalid hex or truncated bytes).
func TestVAPID_WrongNonZeroKey_FailsDistinctFromCorruptKey(t *testing.T) {
	ctx := context.Background()
	repo := newMemoryAppKeyRepo()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	clock := fixedClock{now: 1700000000}

	var keyA, keyB [32]byte
	for i := range keyA {
		keyA[i] = byte(i + 1)
		keyB[i] = byte(i + 50)
	}

	// 1. Fresh boot with keyA
	_, err := InitOrLoad(ctx, repo, keyA, clock, logger)
	if err != nil {
		t.Fatalf("fresh boot with keyA failed: %v", err)
	}

	// 2. Boot with wrong non-zero keyB -> decryption fails with specific error
	_, err = InitOrLoad(ctx, repo, keyB, clock, logger)
	if err == nil {
		t.Fatalf("expected boot with keyB to fail, but succeeded")
	}
	var deWrongKey *domain.DomainError
	if !errors.As(err, &deWrongKey) || deWrongKey.Code != domain.ErrPush002 {
		t.Fatalf("expected ErrPush002 for wrong key, got: %v", err)
	}
	if deWrongKey.Message != "vapid private key decryption failed: PUSH_VAPID_ENCRYPTION_KEY does not match stored key" {
		t.Fatalf("unexpected error message for wrong key: %s", deWrongKey.Message)
	}

	// 3. Corrupt ciphertext in repo (invalid hex)
	corruptRow := &domain.ApplicationKey{
		ID:                    domain.VAPIDKeyRowID,
		PrivateKeyEncrypted:   "not_valid_hex!@#$",
		PublicKeyUncompressed: "test",
		CreatedAt:             1700000000,
	}
	storedKey, _ := repo.GetByID(ctx, domain.VAPIDKeyRowID)
	_ = repo.UpdateCAS(ctx, corruptRow, storedKey.PrivateKeyEncrypted)

	_, err = InitOrLoad(ctx, repo, keyA, clock, logger)
	if err == nil {
		t.Fatalf("expected boot with corrupt hex to fail, but succeeded")
	}
	var deCorrupt *domain.DomainError
	if !errors.As(err, &deCorrupt) || deCorrupt.Code != domain.ErrPush002 {
		t.Fatalf("expected ErrPush002 for corrupt hex, got: %v", err)
	}
	if deCorrupt.Message != "vapid private key hex decode failed" {
		t.Fatalf("unexpected error message for corrupt hex: %s", deCorrupt.Message)
	}
}

// TestVAPID_ZeroKeyConfigured_NeverTriggersMigration covers requirement C1(e):
// Proves that when the configured key is all-zero (e.g. PUSH_ENABLED=false),
// it NEVER triggers migration even if a non-zero encrypted row is present.
func TestVAPID_ZeroKeyConfigured_NeverTriggersMigration(t *testing.T) {
	ctx := context.Background()
	repo := newMemoryAppKeyRepo()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	clock := fixedClock{now: 1700000000}

	var realKey [32]byte
	for i := range realKey {
		realKey[i] = byte(i + 1)
	}

	// Initial boot with real non-zero key
	_, err := InitOrLoad(ctx, repo, realKey, clock, logger)
	if err != nil {
		t.Fatalf("initial boot failed: %v", err)
	}

	storedBefore, _ := repo.GetByID(ctx, domain.VAPIDKeyRowID)

	// Boot with all-zero key: must fail decryption and NEVER mutate/migrate the row
	var zeroKey [32]byte
	_, err = InitOrLoad(ctx, repo, zeroKey, clock, logger)
	if err == nil {
		t.Fatalf("expected boot with zero-key on real-key encrypted row to fail")
	}

	storedAfter, _ := repo.GetByID(ctx, domain.VAPIDKeyRowID)
	if storedBefore.PrivateKeyEncrypted != storedAfter.PrivateKeyEncrypted {
		t.Fatalf("row ciphertext was modified despite zero-key configured")
	}
}

// TestVAPID_Migration_AtomicCAS_FailsIfRowModifiedConcurrently covers requirement C1(f):
// Proves that re-encrypt + persist is atomic and guarded by compare-and-set on the old ciphertext.
func TestVAPID_Migration_AtomicCAS_FailsIfRowModifiedConcurrently(t *testing.T) {
	ctx := context.Background()
	repo := newMemoryAppKeyRepo()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	clock := fixedClock{now: 1700000000}

	var zeroKey [32]byte
	// 1. Create row with zeroKey
	_, err := InitOrLoad(ctx, repo, zeroKey, clock, logger)
	if err != nil {
		t.Fatalf("zeroKey install failed: %v", err)
	}

	// 2. Simulate concurrent modification between read and UpdateCAS
	var realKey [32]byte
	for i := range realKey {
		realKey[i] = byte(i + 42)
	}

	// Intercept repo to mutate before UpdateCAS
	concurrentRepo := &concurrentModAppKeyRepo{
		memoryAppKeyRepo: repo,
		onUpdateCAS: func() {
			stored, _ := repo.GetByID(ctx, domain.VAPIDKeyRowID)
			oldCiphertext := stored.PrivateKeyEncrypted
			stored.PrivateKeyEncrypted = "deadbeef12345678" + stored.PrivateKeyEncrypted[16:]
			_ = repo.UpdateCAS(ctx, stored, oldCiphertext)
		},
	}

	_, err = InitOrLoad(ctx, concurrentRepo, realKey, clock, logger)
	if err == nil {
		t.Fatalf("expected InitOrLoad to fail when concurrent modification occurs, but succeeded")
	}
}

type concurrentModAppKeyRepo struct {
	*memoryAppKeyRepo
	onUpdateCAS func()
}

func (c *concurrentModAppKeyRepo) UpdateCAS(ctx context.Context, key *domain.ApplicationKey, oldCiphertext string) error {
	if c.onUpdateCAS != nil {
		c.onUpdateCAS()
	}
	return c.memoryAppKeyRepo.UpdateCAS(ctx, key, oldCiphertext)
}
