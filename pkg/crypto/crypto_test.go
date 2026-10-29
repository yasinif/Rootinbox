package crypto

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"testing"
)

// ==========================================
// RFC-0003 §10: Cryptographic Test Vectors
// All vectors use deterministic lowercase HEX.
// ==========================================

// --- Test Vector Inputs (Deterministic) ---
const (
	tvUsername = "TestUser"
	tvPassword = "correct-horse-battery-staple"
)

// hexDecode is a test helper that panics on invalid hex.
func hexDecode(t *testing.T, s string) []byte {
	t.Helper()
	b, err := hex.DecodeString(s)
	if err != nil {
		t.Fatalf("invalid hex: %s", err)
	}
	return b
}

func toArray32(b []byte) [32]byte {
	var arr [32]byte
	copy(arr[:], b)
	return arr
}

// =============================================================
// 1. Argon2id Identity Seed Derivation (RFC-0003 §4.1)
// =============================================================
func TestArgon2idIdentitySeed(t *testing.T) {
	seed := DeriveIdentityKey(tvUsername, tvPassword)
	seedHex := hex.EncodeToString(seed[:])
	t.Logf("Identity Seed: %s", seedHex)

	// Verify determinism: same inputs produce same output.
	seed2 := DeriveIdentityKey(tvUsername, tvPassword)
	if seed != seed2 {
		t.Fatal("Argon2id is not deterministic")
	}

	// Verify username normalization: "TestUser" → "testuser".
	seed3 := DeriveIdentityKey("testuser", tvPassword)
	if seed != seed3 {
		t.Fatal("username normalization failed: TestUser != testuser")
	}

	// Verify different passwords produce different seeds.
	seedDiff := DeriveIdentityKey(tvUsername, "wrong-password")
	if seed == seedDiff {
		t.Fatal("different passwords produced same seed")
	}
}

// =============================================================
// 2. Argon2id Vault Key Derivation (RFC-0003 §4.2)
// =============================================================
func TestArgon2idVaultKey(t *testing.T) {
	vaultKey := DeriveVaultKey(tvUsername, tvPassword)
	vaultHex := hex.EncodeToString(vaultKey[:])
	t.Logf("Vault Key: %s", vaultHex)

	// Vault key MUST differ from identity key (different salt).
	identityKey := DeriveIdentityKey(tvUsername, tvPassword)
	if vaultKey == identityKey {
		t.Fatal("vault key and identity key must differ")
	}

	// Determinism.
	vaultKey2 := DeriveVaultKey(tvUsername, tvPassword)
	if vaultKey != vaultKey2 {
		t.Fatal("vault key derivation not deterministic")
	}
}

// =============================================================
// 3. Ed25519 Public Key Extraction (RFC-0003 §4.1)
// =============================================================
func TestEd25519FromSeed(t *testing.T) {
	seed := DeriveIdentityKey(tvUsername, tvPassword)
	pubKey, privKey := Ed25519FromSeed(seed)

	t.Logf("Ed25519 Public Key: %s", hex.EncodeToString(pubKey))

	// Public key must be 32 bytes.
	if len(pubKey) != ed25519.PublicKeySize {
		t.Fatalf("public key size: got %d, want %d", len(pubKey), ed25519.PublicKeySize)
	}
	// Private key must be 64 bytes.
	if len(privKey) != ed25519.PrivateKeySize {
		t.Fatalf("private key size: got %d, want %d", len(privKey), ed25519.PrivateKeySize)
	}

	// Determinism.
	pubKey2, _ := Ed25519FromSeed(seed)
	if !bytes.Equal(pubKey, pubKey2) {
		t.Fatal("Ed25519FromSeed not deterministic")
	}

	// Sign and verify roundtrip.
	msg := []byte("test message")
	sig := ed25519.Sign(privKey, msg)
	if !ed25519.Verify(pubKey, msg, sig) {
		t.Fatal("Ed25519 sign/verify roundtrip failed")
	}
}

// =============================================================
// 4. X25519 Shared Secret (RFC-0003 §4.3)
// =============================================================
func TestX25519SharedSecret(t *testing.T) {
	pubA, privA, err := GenerateSessionKeyPair()
	if err != nil {
		t.Fatalf("generating keypair A: %v", err)
	}
	pubB, privB, err := GenerateSessionKeyPair()
	if err != nil {
		t.Fatalf("generating keypair B: %v", err)
	}

	// ECDH: A's private + B's public.
	secretAB, err := ComputeSharedSecret(privA, pubB)
	if err != nil {
		t.Fatalf("ECDH(A,B): %v", err)
	}

	// ECDH: B's private + A's public.
	secretBA, err := ComputeSharedSecret(privB, pubA)
	if err != nil {
		t.Fatalf("ECDH(B,A): %v", err)
	}

	// Shared secrets must match (ECDH commutativity).
	if secretAB != secretBA {
		t.Fatal("ECDH shared secrets do not match")
	}

	t.Logf("Shared Secret: %s", hex.EncodeToString(secretAB[:]))
}

// =============================================================
// 5. X25519 Low-Order Point Rejection (RFC-0003 §5.2 step 1)
// =============================================================
func TestX25519LowOrderRejection(t *testing.T) {
	_, privA, err := GenerateSessionKeyPair()
	if err != nil {
		t.Fatalf("generating keypair: %v", err)
	}

	// All-zeros public key is a low-order point.
	var zeroPoint [32]byte
	_, err = ComputeSharedSecret(privA, zeroPoint)
	if err == nil {
		t.Fatal("expected error for low-order point, got nil")
	}
}

// =============================================================
// 6. HKDF-SHA256 Message Key Derivation (RFC-0003 §4.3)
// =============================================================
func TestHKDFMessageKey(t *testing.T) {
	// Deterministic shared secret for testing.
	var sharedSecret [32]byte
	for i := range sharedSecret {
		sharedSecret[i] = byte(i)
	}

	var senderHash, receiverHash, convIDHash [32]byte
	for i := range senderHash {
		senderHash[i] = byte(i + 32)
	}
	for i := range receiverHash {
		receiverHash[i] = byte(i + 64)
	}
	for i := range convIDHash {
		convIDHash[i] = byte(i + 96)
	}

	info := BuildMessageKeyInfo(senderHash, receiverHash, convIDHash, 1)

	// Verify info length: 29 + 32 + 32 + 32 + 8 = 133 bytes.
	expectedInfoLen := len([]byte("rootinbox/v1/e2ee-message-key")) + 32 + 32 + 32 + 8
	if len(info) != expectedInfoLen {
		t.Fatalf("info length: got %d, want %d", len(info), expectedInfoLen)
	}

	key, err := DeriveMessageKey(sharedSecret, info)
	if err != nil {
		t.Fatalf("DeriveMessageKey: %v", err)
	}
	t.Logf("Message Key (seq=1): %s", hex.EncodeToString(key[:]))

	// Determinism: same inputs produce same key.
	key2, err := DeriveMessageKey(sharedSecret, info)
	if err != nil {
		t.Fatalf("DeriveMessageKey 2: %v", err)
	}
	if key != key2 {
		t.Fatal("HKDF not deterministic")
	}

	// Different sequence numbers produce different keys.
	info2 := BuildMessageKeyInfo(senderHash, receiverHash, convIDHash, 2)
	key3, err := DeriveMessageKey(sharedSecret, info2)
	if err != nil {
		t.Fatalf("DeriveMessageKey seq=2: %v", err)
	}
	if key == key3 {
		t.Fatal("different sequence numbers produced same key")
	}
}

// =============================================================
// 7. AES-256-GCM Encrypt/Decrypt Roundtrip (RFC-0003 §4.5)
// =============================================================
func TestAESGCMRoundtrip(t *testing.T) {
	var key [32]byte
	for i := range key {
		key[i] = byte(i)
	}
	var iv [12]byte
	for i := range iv {
		iv[i] = byte(i + 100)
	}

	plaintext := []byte("Hello, RootInbox! This is a test message.")
	aad := []byte("additional-authenticated-data")

	// Encrypt.
	sealed, err := Encrypt(key, iv, plaintext, aad)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}
	t.Logf("Sealed Ciphertext: %s", hex.EncodeToString(sealed))

	// Sealed must be larger than plaintext (includes 16-byte auth tag).
	if len(sealed) != len(plaintext)+16 {
		t.Fatalf("sealed length: got %d, want %d (plaintext + 16-byte tag)", len(sealed), len(plaintext)+16)
	}

	// Decrypt.
	decrypted, err := Decrypt(key, iv, sealed, aad)
	if err != nil {
		t.Fatalf("Decrypt: %v", err)
	}
	if !bytes.Equal(decrypted, plaintext) {
		t.Fatal("decrypted text does not match plaintext")
	}
}

// =============================================================
// 8. AES-GCM Auth Failure — Sanitized Error (RFC-0003 §8.2)
// =============================================================
func TestAESGCMAuthFailure(t *testing.T) {
	var key [32]byte
	var iv [12]byte
	plaintext := []byte("secret")

	sealed, err := Encrypt(key, iv, plaintext, nil)
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}

	// Tamper with ciphertext.
	sealed[0] ^= 0xFF

	_, err = Decrypt(key, iv, sealed, nil)
	if err == nil {
		t.Fatal("expected decryption error for tampered ciphertext")
	}
	// RFC-0003 §8.2: Error must not reveal specific details.
	if err.Error() != "decryption failed" {
		t.Fatalf("expected generic 'decryption failed', got: %v", err)
	}
}

// =============================================================
// 9. Wire Format Encode/Decode Roundtrip (RFC-0003 §6.2)
// =============================================================
func TestCiphertextWireRoundtrip(t *testing.T) {
	var sessionID [8]byte
	for i := range sessionID {
		sessionID[i] = byte(i + 1)
	}
	var iv [12]byte
	for i := range iv {
		iv[i] = byte(i + 10)
	}
	sealed := []byte("encrypted-payload-data-here")

	// Encode.
	encoded, err := EncodeCiphertext(CryptoSuiteV1, sessionID, iv, sealed)
	if err != nil {
		t.Fatalf("EncodeCiphertext: %v", err)
	}

	// Verify total size.
	expectedSize := CiphertextHeaderSize + len(sealed)
	if len(encoded) != expectedSize {
		t.Fatalf("encoded size: got %d, want %d", len(encoded), expectedSize)
	}

	// Decode.
	version, decodedSID, decodedIV, decodedSealed, err := DecodeCiphertext(encoded)
	if err != nil {
		t.Fatalf("DecodeCiphertext: %v", err)
	}
	if version != CryptoSuiteV1 {
		t.Fatalf("version: got 0x%02x, want 0x%02x", version, CryptoSuiteV1)
	}
	if decodedSID != sessionID {
		t.Fatal("session ID mismatch")
	}
	if decodedIV != iv {
		t.Fatal("IV mismatch")
	}
	if !bytes.Equal(decodedSealed, sealed) {
		t.Fatal("sealed data mismatch")
	}
}

// =============================================================
// 10. Version Rejection (RFC-0003 §6.3)
// =============================================================
func TestVersionRejection(t *testing.T) {
	// Create a payload with unknown version 0xFF.
	data := make([]byte, CiphertextHeaderSize+10)
	data[0] = 0xFF

	_, _, _, _, err := DecodeCiphertext(data)
	if err == nil {
		t.Fatal("expected error for unknown version byte")
	}
}

// =============================================================
// 11. Ciphertext Size Limit (RFC-0003 §6.4)
// =============================================================
func TestCiphertextSizeLimit(t *testing.T) {
	var sessionID [8]byte
	var iv [12]byte

	// Payload that would exceed 5MB total.
	oversized := make([]byte, MaxCiphertextSize)
	_, err := EncodeCiphertext(CryptoSuiteV1, sessionID, iv, oversized)
	if err == nil {
		t.Fatal("expected error for oversized ciphertext")
	}
}

// =============================================================
// 12. AAD Construction (RFC-0003 §6.5)
// =============================================================
func TestAADConstruction(t *testing.T) {
	var clientUUID [16]byte
	var senderHash, receiverHash, convIDHash [32]byte
	var senderSessionID [8]byte

	for i := range clientUUID {
		clientUUID[i] = byte(i + 1)
	}
	for i := range senderHash {
		senderHash[i] = byte(i + 20)
	}
	for i := range receiverHash {
		receiverHash[i] = byte(i + 52)
	}
	for i := range convIDHash {
		convIDHash[i] = byte(i + 84)
	}
	for i := range senderSessionID {
		senderSessionID[i] = byte(i + 120)
	}

	aad := BuildAAD(42, clientUUID, senderHash, receiverHash, convIDHash, senderSessionID)

	// RFC-0003 §6.5: AAD must be exactly 128 bytes.
	if len(aad) != AADSize {
		t.Fatalf("AAD size: got %d, want %d", len(aad), AADSize)
	}

	// Verify SeqNum at offset 0 (BigEndian).
	seqNum := binary.BigEndian.Uint64(aad[0:8])
	if seqNum != 42 {
		t.Fatalf("AAD seqNum: got %d, want 42", seqNum)
	}

	// Verify ClientUUID at offset 8.
	if !bytes.Equal(aad[8:24], clientUUID[:]) {
		t.Fatal("AAD clientUUID mismatch")
	}

	// Verify SenderIdentityHash at offset 24.
	if !bytes.Equal(aad[24:56], senderHash[:]) {
		t.Fatal("AAD senderHash mismatch")
	}

	// Verify ReceiverIdentityHash at offset 56.
	if !bytes.Equal(aad[56:88], receiverHash[:]) {
		t.Fatal("AAD receiverHash mismatch")
	}

	// Verify ConvIDHash at offset 88.
	if !bytes.Equal(aad[88:120], convIDHash[:]) {
		t.Fatal("AAD convIDHash mismatch")
	}

	// Verify SenderSessionID at offset 120.
	if !bytes.Equal(aad[120:128], senderSessionID[:]) {
		t.Fatal("AAD senderSessionID mismatch")
	}

	t.Logf("AAD: %s", hex.EncodeToString(aad[:]))
}

// =============================================================
// 13. Replay Window (RFC-0003 §7)
// =============================================================
func TestReplayWindow(t *testing.T) {
	rw := &ReplayWindow{}

	// Fresh window: seq 1 should be accepted.
	if !rw.Check(1) {
		t.Fatal("seq 1 should be new")
	}
	rw.Accept(1)

	// Replay: seq 1 again should be rejected.
	if rw.Check(1) {
		t.Fatal("seq 1 replay should be rejected")
	}

	// Seq 2: new, accept.
	if !rw.Check(2) {
		t.Fatal("seq 2 should be new")
	}
	rw.Accept(2)

	// Jump ahead to seq 50.
	if !rw.Check(50) {
		t.Fatal("seq 50 should be new")
	}
	rw.Accept(50)

	// Seq 1 should still be in window (50-1 = 49 < 64).
	if rw.Check(1) {
		t.Fatal("seq 1 should still be rejected (in window, already received)")
	}

	// Seq 3: not received, within window (50-3 = 47 < 64).
	if !rw.Check(3) {
		t.Fatal("seq 3 should be new (within window, not received)")
	}
	rw.Accept(3)

	// Jump far ahead to seq 200 — seq 1,2,3 should be outside window.
	rw.Accept(200)
	// Seq 1 is now outside window (200-1 = 199 >= 64).
	if rw.Check(1) {
		t.Fatal("seq 1 should be outside window")
	}

	// Seq 0 is always invalid.
	if rw.Check(0) {
		t.Fatal("seq 0 should always be rejected")
	}
}

// =============================================================
// 14. Replay Window Exhaustion (RFC-0003 §7)
// =============================================================
func TestReplayWindowExhaustion(t *testing.T) {
	if NeedsRotation(100) {
		t.Fatal("seq 100 should not need rotation")
	}
	if !NeedsRotation(^uint64(0) - 500) {
		t.Fatal("near-max seq should need rotation")
	}
}

// =============================================================
// 15. Session Signature Sign/Verify (RFC-0003 §5.1)
// =============================================================
func TestSessionSignatureRoundtrip(t *testing.T) {
	seed := DeriveIdentityKey(tvUsername, tvPassword)
	pubKey, privKey := Ed25519FromSeed(seed)

	var pubKeyArr [32]byte
	copy(pubKeyArr[:], pubKey)
	identityPKHash := IdentityHash(pubKeyArr)

	var sessionPK [32]byte
	for i := range sessionPK {
		sessionPK[i] = byte(i + 200)
	}
	expiresAt := int64(1700000000)

	// Sign.
	sig := SignSessionKey(privKey, CryptoSuiteV1, sessionPK, expiresAt, identityPKHash)
	t.Logf("Session Signature: %s", hex.EncodeToString(sig[:]))

	// Verify — should succeed.
	if !VerifySessionSignature(pubKey, CryptoSuiteV1, sessionPK, expiresAt, identityPKHash, sig) {
		t.Fatal("valid session signature rejected")
	}

	// Verify — wrong version should fail.
	if VerifySessionSignature(pubKey, 0xFF, sessionPK, expiresAt, identityPKHash, sig) {
		t.Fatal("wrong version should be rejected")
	}

	// Verify — wrong expiration should fail.
	if VerifySessionSignature(pubKey, CryptoSuiteV1, sessionPK, expiresAt+1, identityPKHash, sig) {
		t.Fatal("wrong expiration should be rejected")
	}

	// Verify — tampered signature should fail.
	tamperedSig := sig
	tamperedSig[0] ^= 0xFF
	if VerifySessionSignature(pubKey, CryptoSuiteV1, sessionPK, expiresAt, identityPKHash, tamperedSig) {
		t.Fatal("tampered signature should be rejected")
	}
}

// =============================================================
// 16. Registration Wire Format (RFC-0003 §5.1)
// =============================================================
func TestRegistrationWireRoundtrip(t *testing.T) {
	var identityPK, sessionPK [32]byte
	var sig [64]byte
	for i := range identityPK {
		identityPK[i] = byte(i)
	}
	for i := range sessionPK {
		sessionPK[i] = byte(i + 32)
	}
	for i := range sig {
		sig[i] = byte(i + 64)
	}
	version := CryptoSuiteV1
	expiresAt := int64(1700000000)

	// Encode.
	wire := EncodeRegistration(identityPK, sessionPK, sig, version, expiresAt)

	// Must be exactly 137 bytes.
	if len(wire) != RegistrationWireSize {
		t.Fatalf("wire size: got %d, want %d", len(wire), RegistrationWireSize)
	}

	// Decode.
	dIdentityPK, dSessionPK, dSig, dVersion, dExpiresAt := DecodeRegistration(wire)
	if dIdentityPK != identityPK {
		t.Fatal("identityPK mismatch")
	}
	if dSessionPK != sessionPK {
		t.Fatal("sessionPK mismatch")
	}
	if dSig != sig {
		t.Fatal("signature mismatch")
	}
	if dVersion != version {
		t.Fatalf("version: got 0x%02x, want 0x%02x", dVersion, version)
	}
	if dExpiresAt != expiresAt {
		t.Fatalf("expiresAt: got %d, want %d", dExpiresAt, expiresAt)
	}
}

// =============================================================
// 17. Identity and Session Hashes (RFC-0003 §6.1)
// =============================================================
func TestIdentityHashes(t *testing.T) {
	var pubKey [32]byte
	for i := range pubKey {
		pubKey[i] = byte(i)
	}

	// IdentityHash: SHA-256(pubKey).
	hash := IdentityHash(pubKey)
	expected := sha256.Sum256(pubKey[:])
	if hash != expected {
		t.Fatal("IdentityHash mismatch")
	}
	t.Logf("IdentityHash: %s", hex.EncodeToString(hash[:]))

	// ConversationIDHash: SHA-256(UUID bytes).
	var uuid [16]byte
	for i := range uuid {
		uuid[i] = byte(i + 100)
	}
	convHash := ConversationIDHash(uuid)
	expectedConv := sha256.Sum256(uuid[:])
	if convHash != expectedConv {
		t.Fatal("ConversationIDHash mismatch")
	}

	// SessionIdentifier: first 8 bytes of SHA-256(sessionPK).
	var sessionPK [32]byte
	for i := range sessionPK {
		sessionPK[i] = byte(i + 50)
	}
	sessionID := SessionIdentifier(sessionPK)
	sessionHash := sha256.Sum256(sessionPK[:])
	if !bytes.Equal(sessionID[:], sessionHash[:8]) {
		t.Fatal("SessionIdentifier mismatch")
	}
	t.Logf("SessionID: %s", hex.EncodeToString(sessionID[:]))
}

// =============================================================
// 18. IV Generation (RFC-0003 §8.1)
// =============================================================
func TestIVGeneration(t *testing.T) {
	prefix, err := GenerateIVPrefix()
	if err != nil {
		t.Fatalf("GenerateIVPrefix: %v", err)
	}

	iv0 := BuildIV(prefix, 0)
	iv1 := BuildIV(prefix, 1)
	ivMax := BuildIV(prefix, ^uint64(0))

	// Same prefix, different counters → different IVs.
	if iv0 == iv1 {
		t.Fatal("IV with counter 0 and 1 should differ")
	}

	// First 4 bytes should be the prefix.
	if !bytes.Equal(iv0[:4], prefix[:]) {
		t.Fatal("IV prefix mismatch")
	}

	// Last 8 bytes should be the counter (BigEndian).
	counter := binary.BigEndian.Uint64(iv1[4:])
	if counter != 1 {
		t.Fatalf("IV counter: got %d, want 1", counter)
	}
	counterMax := binary.BigEndian.Uint64(ivMax[4:])
	if counterMax != ^uint64(0) {
		t.Fatal("IV max counter mismatch")
	}

	// Two prefixes should differ (probabilistic, but 2^32 collision is negligible).
	prefix2, _ := GenerateIVPrefix()
	if prefix == prefix2 {
		t.Log("WARNING: two random prefixes matched (statistically improbable)")
	}
}

// =============================================================
// 19. Constant-Time Compare (RFC-0003 §8.1)
// =============================================================
func TestConstantTimeCompare(t *testing.T) {
	a := []byte("hello")
	b := []byte("hello")
	c := []byte("world")
	d := []byte("hell")

	if !ConstantTimeCompare(a, b) {
		t.Fatal("equal slices should match")
	}
	if ConstantTimeCompare(a, c) {
		t.Fatal("different slices should not match")
	}
	if ConstantTimeCompare(a, d) {
		t.Fatal("different length slices should not match")
	}
}

// =============================================================
// 20. Memory Zeroization (RFC-0003 §8.3)
// =============================================================
func TestZeroize(t *testing.T) {
	buf := []byte{1, 2, 3, 4, 5}
	Zeroize(buf)
	for i, b := range buf {
		if b != 0 {
			t.Fatalf("byte %d not zeroed: got %d", i, b)
		}
	}
}

// =============================================================
// 21. Full E2EE Pipeline (Integration)
// =============================================================
func TestFullE2EEPipeline(t *testing.T) {
	// Alice and Bob generate session keys.
	pubA, privA, err := GenerateSessionKeyPair()
	if err != nil {
		t.Fatal(err)
	}
	pubB, privB, err := GenerateSessionKeyPair()
	if err != nil {
		t.Fatal(err)
	}

	// ECDH: both compute same shared secret.
	sharedAB, err := ComputeSharedSecret(privA, pubB)
	if err != nil {
		t.Fatal(err)
	}
	sharedBA, err := ComputeSharedSecret(privB, pubA)
	if err != nil {
		t.Fatal(err)
	}
	if sharedAB != sharedBA {
		t.Fatal("shared secrets mismatch")
	}

	// Identity hashes.
	var pubAArr, pubBArr [32]byte
	copy(pubAArr[:], pubA[:])
	copy(pubBArr[:], pubB[:])
	senderHash := IdentityHash(pubAArr)
	receiverHash := IdentityHash(pubBArr)
	var convUUID [16]byte
	for i := range convUUID {
		convUUID[i] = byte(i + 42)
	}
	convHash := ConversationIDHash(convUUID)

	// Derive per-message key (seq=1).
	info := BuildMessageKeyInfo(senderHash, receiverHash, convHash, 1)
	msgKey, err := DeriveMessageKey(sharedAB, info)
	if err != nil {
		t.Fatal(err)
	}

	// Generate IV.
	prefix, err := GenerateIVPrefix()
	if err != nil {
		t.Fatal(err)
	}
	iv := BuildIV(prefix, 1)

	// Build AAD.
	senderSessionID := SessionIdentifier(pubAArr)
	aad := BuildAAD(1, convUUID, senderHash, receiverHash, convHash, senderSessionID)

	// Encrypt.
	plaintext := []byte("Hello Bob, this is Alice!")
	sealed, err := Encrypt(msgKey, iv, plaintext, aad[:])
	if err != nil {
		t.Fatal(err)
	}

	// Wire encode.
	wire, err := EncodeCiphertext(CryptoSuiteV1, senderSessionID, iv, sealed)
	if err != nil {
		t.Fatal(err)
	}

	// --- Bob receives the wire payload ---

	// Wire decode.
	version, decodedSID, decodedIV, decodedSealed, err := DecodeCiphertext(wire)
	if err != nil {
		t.Fatal(err)
	}
	if version != CryptoSuiteV1 {
		t.Fatalf("version: 0x%02x", version)
	}

	// Replay check.
	rw := &ReplayWindow{}
	if !rw.Check(1) {
		t.Fatal("replay check failed for new message")
	}

	// Bob derives the same message key.
	infoBob := BuildMessageKeyInfo(senderHash, receiverHash, convHash, 1)
	msgKeyBob, err := DeriveMessageKey(sharedBA, infoBob)
	if err != nil {
		t.Fatal(err)
	}
	if msgKey != msgKeyBob {
		t.Fatal("Bob derived different message key")
	}

	// Bob reconstructs AAD.
	aadBob := BuildAAD(1, convUUID, senderHash, receiverHash, convHash, decodedSID)
	if aad != aadBob {
		t.Fatal("AAD mismatch")
	}

	// Decrypt.
	decrypted, err := Decrypt(msgKeyBob, decodedIV, decodedSealed, aadBob[:])
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(decrypted, plaintext) {
		t.Fatal("decrypted text mismatch")
	}

	// Accept in replay window.
	rw.Accept(1)

	// Replay: same message again should be rejected.
	if rw.Check(1) {
		t.Fatal("replay should be rejected")
	}

	t.Log("Full E2EE pipeline: Alice → Bob roundtrip successful")
}
