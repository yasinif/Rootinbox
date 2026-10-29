package crypto_test

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"golang.org/x/crypto/curve25519"

	"rootinbox/pkg/crypto"
)

// TestExportConformanceVectors generates docs/vectors/crypto-vectors-v1.json
// containing deterministic test vectors for cross-platform conformance.
// The frontend Vitest suite asserts byte-identical results against this file.
//
// Run: go test -run TestExportConformanceVectors -v ./pkg/crypto/
func TestExportConformanceVectors(t *testing.T) {
	// ── Fixed inputs ──
	const (
		username = "TestUser"
		password = "correct-horse-battery-staple"
	)

	vectors := make(map[string]interface{})

	// ═══════════════════════════════════════════
	// 1. Argon2id Identity Seed
	// ═══════════════════════════════════════════
	identitySeed := crypto.DeriveIdentityKey(username, password)
	normalizedUsername := crypto.NormalizeUsername(username)
	identitySalt := sha256.Sum256([]byte(normalizedUsername + "IDENTITY"))

	vectors["argon2id_identity"] = map[string]interface{}{
		"username":            username,
		"normalized_username": normalizedUsername,
		"password":            password,
		"salt_input":          normalizedUsername + "IDENTITY",
		"salt_hex":            hex.EncodeToString(identitySalt[:]),
		"memory":              65536,
		"time":                3,
		"parallelism":         4,
		"key_length":          32,
		"seed_hex":            hex.EncodeToString(identitySeed[:]),
	}

	// ═══════════════════════════════════════════
	// 2. Argon2id Vault Key
	// ═══════════════════════════════════════════
	vaultKey := crypto.DeriveVaultKey(username, password)
	vaultSalt := sha256.Sum256([]byte(normalizedUsername + "VAULT"))

	vectors["argon2id_vault"] = map[string]interface{}{
		"salt_input": normalizedUsername + "VAULT",
		"salt_hex":   hex.EncodeToString(vaultSalt[:]),
		"key_hex":    hex.EncodeToString(vaultKey[:]),
	}

	// ═══════════════════════════════════════════
	// 3. Ed25519 seed → pubkey + signature
	// ═══════════════════════════════════════════
	pubKey, privKey := crypto.Ed25519FromSeed(identitySeed)

	signMessage := []byte("rootinbox/conformance/ed25519-test-payload")
	ed25519Sig := ed25519.Sign(privKey, signMessage)

	vectors["ed25519"] = map[string]interface{}{
		"seed_hex":       hex.EncodeToString(identitySeed[:]),
		"public_key_hex": hex.EncodeToString(pubKey),
		"sign_message":   string(signMessage),
		"signature_hex":  hex.EncodeToString(ed25519Sig),
	}

	// ═══════════════════════════════════════════
	// 4. X25519 Shared Secret (deterministic keys)
	// ═══════════════════════════════════════════
	// Use deterministic private keys for reproducibility.
	var privA, privB [32]byte
	for i := range privA {
		privA[i] = byte(i + 1)
	}
	for i := range privB {
		privB[i] = byte(i + 33)
	}
	// Clamp per RFC 7748.
	privA[0] &= 248
	privA[31] &= 127
	privA[31] |= 64
	privB[0] &= 248
	privB[31] &= 127
	privB[31] |= 64

	// Compute public keys from private keys via scalar mult with basepoint.
	pubABytes, err := curve25519.X25519(privA[:], curve25519.Basepoint)
	if err != nil {
		t.Fatalf("computing pubA: %v", err)
	}
	pubBBytes, err := curve25519.X25519(privB[:], curve25519.Basepoint)
	if err != nil {
		t.Fatalf("computing pubB: %v", err)
	}
	var pubA, pubB [32]byte
	copy(pubA[:], pubABytes)
	copy(pubB[:], pubBBytes)

	sharedAB, err := crypto.ComputeSharedSecret(privA, pubB)
	if err != nil {
		t.Fatalf("ECDH(A,B): %v", err)
	}
	sharedBA, err := crypto.ComputeSharedSecret(privB, pubA)
	if err != nil {
		t.Fatalf("ECDH(B,A): %v", err)
	}
	if sharedAB != sharedBA {
		t.Fatal("ECDH commutativity check failed")
	}

	// Low-order points that MUST be rejected.
	lowOrderPoints := []string{
		"0000000000000000000000000000000000000000000000000000000000000000",
		"0100000000000000000000000000000000000000000000000000000000000000",
		"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
		"e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
		"5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
	}

	vectors["x25519"] = map[string]interface{}{
		"private_a_hex":     hex.EncodeToString(privA[:]),
		"public_a_hex":      hex.EncodeToString(pubA[:]),
		"private_b_hex":     hex.EncodeToString(privB[:]),
		"public_b_hex":      hex.EncodeToString(pubB[:]),
		"shared_secret_hex": hex.EncodeToString(sharedAB[:]),
		"low_order_points":  lowOrderPoints,
	}

	// ═══════════════════════════════════════════
	// 5. HKDF-SHA256 Message Key
	// ═══════════════════════════════════════════
	var hkdfSharedSecret [32]byte
	for i := range hkdfSharedSecret {
		hkdfSharedSecret[i] = byte(i)
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

	hkdfSalt := sha256.Sum256([]byte("rootinbox-hkdf-salt-v1"))
	hkdfInfo := crypto.BuildMessageKeyInfo(senderHash, receiverHash, convIDHash, 1)
	hkdfKey, err := crypto.DeriveMessageKey(hkdfSharedSecret, hkdfInfo)
	if err != nil {
		t.Fatalf("DeriveMessageKey: %v", err)
	}

	if len(hkdfInfo) != 133 {
		t.Fatalf("info length: got %d, want 133", len(hkdfInfo))
	}

	vectors["hkdf"] = map[string]interface{}{
		"shared_secret_hex": hex.EncodeToString(hkdfSharedSecret[:]),
		"salt_hex":          hex.EncodeToString(hkdfSalt[:]),
		"info_hex":          hex.EncodeToString(hkdfInfo),
		"info_length":       len(hkdfInfo),
		"sequence_number":   1,
		"sender_hash_hex":   hex.EncodeToString(senderHash[:]),
		"receiver_hash_hex": hex.EncodeToString(receiverHash[:]),
		"conv_id_hash_hex":  hex.EncodeToString(convIDHash[:]),
		"derived_key_hex":   hex.EncodeToString(hkdfKey[:]),
	}

	// ═══════════════════════════════════════════
	// 6. AES-256-GCM Sealed Ciphertext
	// ═══════════════════════════════════════════
	var aesKey [32]byte
	for i := range aesKey {
		aesKey[i] = byte(i)
	}
	var aesIV [12]byte
	for i := range aesIV {
		aesIV[i] = byte(i + 100)
	}
	aesPlaintext := []byte("Hello, RootInbox! This is a conformance test.")

	// Build a 128-byte AAD.
	var clientUUID [16]byte
	for i := range clientUUID {
		clientUUID[i] = byte(i + 1)
	}
	var aadSenderHash, aadReceiverHash, aadConvIDHash [32]byte
	for i := range aadSenderHash {
		aadSenderHash[i] = byte(i + 20)
	}
	for i := range aadReceiverHash {
		aadReceiverHash[i] = byte(i + 52)
	}
	for i := range aadConvIDHash {
		aadConvIDHash[i] = byte(i + 84)
	}
	var aadSenderSessionID [8]byte
	for i := range aadSenderSessionID {
		aadSenderSessionID[i] = byte(i + 120)
	}

	aad := crypto.BuildAAD(42, clientUUID, aadSenderHash, aadReceiverHash, aadConvIDHash, aadSenderSessionID)

	sealed, err := crypto.Encrypt(aesKey, aesIV, aesPlaintext, aad[:])
	if err != nil {
		t.Fatalf("Encrypt: %v", err)
	}

	vectors["aes_gcm"] = map[string]interface{}{
		"key_hex":       hex.EncodeToString(aesKey[:]),
		"iv_hex":        hex.EncodeToString(aesIV[:]),
		"plaintext":     string(aesPlaintext),
		"plaintext_hex": hex.EncodeToString(aesPlaintext),
		"aad_hex":       hex.EncodeToString(aad[:]),
		"aad_length":    len(aad),
		"sealed_hex":    hex.EncodeToString(sealed),
		"sealed_length": len(sealed),
	}

	// ═══════════════════════════════════════════
	// 7. IV Layout (Hybrid)
	// ═══════════════════════════════════════════
	var ivPrefix [4]byte
	ivPrefix[0] = 0xDE
	ivPrefix[1] = 0xAD
	ivPrefix[2] = 0xBE
	ivPrefix[3] = 0xEF
	ivCounter := uint64(42)
	builtIV := crypto.BuildIV(ivPrefix, ivCounter)

	vectors["iv_layout"] = map[string]interface{}{
		"prefix_hex": hex.EncodeToString(ivPrefix[:]),
		"counter":    ivCounter,
		"iv_hex":     hex.EncodeToString(builtIV[:]),
		"iv_length":  12,
	}

	// ═══════════════════════════════════════════
	// 8. Replay Window Sequences
	// ═══════════════════════════════════════════
	rw := &crypto.ReplayWindow{}

	type rwStep struct {
		SeqNum  uint64 `json:"seq_num"`
		Action  string `json:"action"`
		Result  bool   `json:"result"`
		HiSeq   uint64 `json:"highest_sequence_after"`
		Bitmap  uint64 `json:"bitmap_after"`
	}
	var rwSteps []rwStep

	addStep := func(seq uint64, action string) {
		if action == "check" {
			result := rw.Check(seq)
			rwSteps = append(rwSteps, rwStep{seq, action, result, rw.HighestSequence, rw.Bitmap})
		} else {
			rw.Accept(seq)
			rwSteps = append(rwSteps, rwStep{seq, action, true, rw.HighestSequence, rw.Bitmap})
		}
	}

	addStep(0, "check")   // always false
	addStep(1, "check")   // true (new)
	addStep(1, "accept")  // accept seq 1
	addStep(1, "check")   // false (replay)
	addStep(5, "check")   // true (new)
	addStep(5, "accept")  // accept seq 5
	addStep(3, "check")   // true (within window, not received)
	addStep(3, "accept")  // accept seq 3
	addStep(3, "check")   // false (replay)
	addStep(70, "check")  // true (jumps ahead)
	addStep(70, "accept") // accept seq 70
	addStep(1, "check")   // false (outside window: 70-1=69 >= 64)

	vectors["replay_window"] = map[string]interface{}{
		"window_size": 64,
		"steps":       rwSteps,
	}

	// ═══════════════════════════════════════════
	// 9. Registration Wire Format (137 bytes)
	// ═══════════════════════════════════════════
	var regIdentityPK, regSessionPK [32]byte
	var regSig [64]byte
	for i := range regIdentityPK {
		regIdentityPK[i] = byte(i)
	}
	for i := range regSessionPK {
		regSessionPK[i] = byte(i + 32)
	}
	for i := range regSig {
		regSig[i] = byte(i + 64)
	}
	regVersion := crypto.CryptoSuiteV1
	regExpiresAt := int64(1700000000)

	regWire := crypto.EncodeRegistration(regIdentityPK, regSessionPK, regSig, regVersion, regExpiresAt)

	vectors["registration_wire"] = map[string]interface{}{
		"identity_pk_hex": hex.EncodeToString(regIdentityPK[:]),
		"session_pk_hex":  hex.EncodeToString(regSessionPK[:]),
		"signature_hex":   hex.EncodeToString(regSig[:]),
		"version":         regVersion,
		"expires_at":      regExpiresAt,
		"wire_hex":        hex.EncodeToString(regWire[:]),
		"wire_length":     len(regWire),
	}

	// ═══════════════════════════════════════════
	// 10. Session Signature Payload (73 bytes)
	// ═══════════════════════════════════════════
	var sessSignPK [32]byte
	for i := range sessSignPK {
		sessSignPK[i] = byte(i + 200)
	}
	sessExpiresAt := int64(1700000000)
	var sessPubKeyArr [32]byte
	copy(sessPubKeyArr[:], pubKey)
	sessIdentityHash := crypto.IdentityHash(sessPubKeyArr)

	// Build the 73-byte payload manually for the vector.
	sessPayload := make([]byte, 73)
	sessPayload[0] = crypto.CryptoSuiteV1
	copy(sessPayload[1:33], sessSignPK[:])
	binary.BigEndian.PutUint64(sessPayload[33:41], uint64(sessExpiresAt))
	copy(sessPayload[41:73], sessIdentityHash[:])

	sessSig := crypto.SignSessionKey(privKey, crypto.CryptoSuiteV1, sessSignPK, sessExpiresAt, sessIdentityHash)

	vectors["session_signature"] = map[string]interface{}{
		"version":           crypto.CryptoSuiteV1,
		"session_pk_hex":    hex.EncodeToString(sessSignPK[:]),
		"expires_at":        sessExpiresAt,
		"identity_hash_hex": hex.EncodeToString(sessIdentityHash[:]),
		"payload_hex":       hex.EncodeToString(sessPayload),
		"payload_length":    73,
		"identity_pk_hex":   hex.EncodeToString(pubKey),
		"signature_hex":     hex.EncodeToString(sessSig[:]),
	}

	// ═══════════════════════════════════════════
	// 11. Auth Payload (RFC-0004 §5.3)
	// ═══════════════════════════════════════════
	nonce := make([]byte, 32)
	for i := range nonce {
		nonce[i] = byte(i + 128)
	}
	authSessionPK := make([]byte, 32)
	for i := range authSessionPK {
		authSessionPK[i] = byte(i + 160)
	}
	challengeID := make([]byte, 16)
	for i := range challengeID {
		challengeID[i] = byte(i + 192)
	}

	// Auth Payload: "rootinbox/v1/login" || nonce(32) || sessionPK(32) || challengeID(16)
	authPrefix := []byte("rootinbox/v1/login")
	authPayload := make([]byte, len(authPrefix)+32+32+16)
	n := copy(authPayload, authPrefix)
	n += copy(authPayload[n:], nonce)
	n += copy(authPayload[n:], authSessionPK)
	copy(authPayload[n:], challengeID)

	authSig := ed25519.Sign(privKey, authPayload)

	vectors["auth_payload"] = map[string]interface{}{
		"prefix":           string(authPrefix),
		"nonce_hex":        hex.EncodeToString(nonce),
		"session_pk_hex":   hex.EncodeToString(authSessionPK),
		"challenge_id_hex": hex.EncodeToString(challengeID),
		"payload_hex":      hex.EncodeToString(authPayload),
		"payload_length":   len(authPayload),
		"identity_pk_hex":  hex.EncodeToString(pubKey),
		"signature_hex":    hex.EncodeToString(authSig),
	}

	// ═══════════════════════════════════════════
	// 12. Base64URL Round-trips
	// ═══════════════════════════════════════════
	type b64TestCase struct {
		Name    string `json:"name"`
		Hex     string `json:"hex"`
		Base64  string `json:"base64url"`
	}

	b64Items := []b64TestCase{
		{"1-byte", "aa", base64.RawURLEncoding.EncodeToString(hexDecVec("aa"))},
		{"2-byte", "aabb", base64.RawURLEncoding.EncodeToString(hexDecVec("aabb"))},
		{"3-byte", "aabbcc", base64.RawURLEncoding.EncodeToString(hexDecVec("aabbcc"))},
		{"32-byte-seed", hex.EncodeToString(identitySeed[:]), base64.RawURLEncoding.EncodeToString(identitySeed[:])},
		{"64-byte-sig", hex.EncodeToString(ed25519Sig), base64.RawURLEncoding.EncodeToString(ed25519Sig)},
	}

	vectors["base64url_roundtrip"] = b64Items

	// ═══════════════════════════════════════════
	// Write JSON
	// ═══════════════════════════════════════════
	wrapper := map[string]interface{}{
		"version":     "v1",
		"description": "RootInbox cross-platform cryptographic conformance vectors. Generated by Go backend (pkg/crypto). Frontend MUST produce byte-identical outputs.",
		"vectors":     vectors,
	}

	jsonData, err := json.MarshalIndent(wrapper, "", "  ")
	if err != nil {
		t.Fatalf("marshaling JSON: %v", err)
	}

	// Resolve output path relative to project root.
	_, thisFile, _, _ := runtime.Caller(0)
	projectRoot := filepath.Join(filepath.Dir(thisFile), "..", "..")
	outDir := filepath.Join(projectRoot, "docs", "vectors")
	if err := os.MkdirAll(outDir, 0755); err != nil {
		t.Fatalf("creating output dir: %v", err)
	}
	outPath := filepath.Join(outDir, "crypto-vectors-v1.json")
	if err := os.WriteFile(outPath, jsonData, 0644); err != nil {
		t.Fatalf("writing vectors: %v", err)
	}

	t.Logf("Wrote conformance vectors to %s (%d bytes)", outPath, len(jsonData))
}

func hexDecVec(s string) []byte {
	b, _ := hex.DecodeString(s)
	return b
}
