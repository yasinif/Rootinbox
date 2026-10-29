package crypto_test

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/hkdf"

	"rootinbox/pkg/crypto"
)

// TestExportConformanceVectorsV2 generates docs/vectors/crypto-vectors-v2.json
// containing Phase 12B conformance vectors for call signaling, media crypto,
// and content envelope. The frontend MUST produce byte-identical outputs.
//
// Run: go test -run TestExportConformanceVectorsV2 -v ./pkg/crypto/
func TestExportConformanceVectorsV2(t *testing.T) {
	vectors := make(map[string]interface{})

	// ═══ Shared test inputs ═══
	// Fixed caller/callee identity keys (reuse v1 pattern).
	callerSeed := [32]byte{}
	for i := range callerSeed {
		callerSeed[i] = byte(i + 1)
	}
	calleeSeed := [32]byte{}
	for i := range calleeSeed {
		calleeSeed[i] = byte(i + 65)
	}

	callerPub, callerPriv := crypto.Ed25519FromSeed(callerSeed)
	calleePub, _ := crypto.Ed25519FromSeed(calleeSeed)

	callerIdentityHash := sha256Bytes(callerPub)
	calleeIdentityHash := sha256Bytes(calleePub)

	// Fixed X25519 session keys for ECDH.
	var callerX25519Priv, calleeX25519Priv [32]byte
	for i := range callerX25519Priv {
		callerX25519Priv[i] = byte(i + 10)
	}
	for i := range calleeX25519Priv {
		calleeX25519Priv[i] = byte(i + 50)
	}
	callerX25519Priv[0] &= 248
	callerX25519Priv[31] &= 127
	callerX25519Priv[31] |= 64
	calleeX25519Priv[0] &= 248
	calleeX25519Priv[31] &= 127
	calleeX25519Priv[31] |= 64

	callerX25519Pub, _ := curve25519.X25519(callerX25519Priv[:], curve25519.Basepoint)
	calleeX25519Pub, _ := curve25519.X25519(calleeX25519Priv[:], curve25519.Basepoint)

	// Shared secret (caller→callee ECDH).
	sharedSecret, _ := curve25519.X25519(callerX25519Priv[:], calleeX25519Pub)
	var sharedSecretArr [32]byte
	copy(sharedSecretArr[:], sharedSecret)

	// Fixed call_id (16 raw bytes).
	callID := [16]byte{}
	for i := range callID {
		callID[i] = byte(i + 200)
	}

	// Fixed file_id (16 raw bytes, UUID v4 format).
	fileID := [16]byte{}
	for i := range fileID {
		fileID[i] = byte(i + 100)
	}

	// Protocol-wide HKDF salt.
	hkdfSalt := sha256.Sum256([]byte("rootinbox-hkdf-salt-v1"))

	// ═══════════════════════════════════════════
	// 1. call_key_info — HKDF info for call signal keys
	// ═══════════════════════════════════════════
	callerToCalleePrefix := []byte("e2ee/v1/call-signal-key/caller-to-callee")
	calleeToCallerPrefix := []byte("e2ee/v1/call-signal-key/callee-to-caller")

	callerToCalleeInfo := make([]byte, 0, 120)
	callerToCalleeInfo = append(callerToCalleeInfo, callerToCalleePrefix...)
	callerToCalleeInfo = append(callerToCalleeInfo, callID[:]...)
	callerToCalleeInfo = append(callerToCalleeInfo, callerIdentityHash[:]...)
	callerToCalleeInfo = append(callerToCalleeInfo, calleeIdentityHash[:]...)

	calleeToCallerInfo := make([]byte, 0, 120)
	calleeToCallerInfo = append(calleeToCallerInfo, calleeToCallerPrefix...)
	calleeToCallerInfo = append(calleeToCallerInfo, callID[:]...)
	calleeToCallerInfo = append(calleeToCallerInfo, callerIdentityHash[:]...)
	calleeToCallerInfo = append(calleeToCallerInfo, calleeIdentityHash[:]...)

	if len(callerToCalleeInfo) != 120 || len(calleeToCallerInfo) != 120 {
		t.Fatalf("info lengths: %d, %d (expected 120)", len(callerToCalleeInfo), len(calleeToCallerInfo))
	}

	vectors["call_key_info"] = map[string]interface{}{
		"caller_identity_hash_hex":    hex.EncodeToString(callerIdentityHash[:]),
		"callee_identity_hash_hex":    hex.EncodeToString(calleeIdentityHash[:]),
		"call_id_hex":                 hex.EncodeToString(callID[:]),
		"caller_to_callee_prefix":     string(callerToCalleePrefix),
		"callee_to_caller_prefix":     string(calleeToCallerPrefix),
		"caller_to_callee_info_hex":   hex.EncodeToString(callerToCalleeInfo),
		"callee_to_caller_info_hex":   hex.EncodeToString(calleeToCallerInfo),
		"info_length":                 120,
	}

	// ═══════════════════════════════════════════
	// 2. call_keys — derived directional keys
	// ═══════════════════════════════════════════
	callerToCalleeKey := hkdfDerive(t, sharedSecretArr, hkdfSalt, callerToCalleeInfo)
	calleeToCallerKey := hkdfDerive(t, sharedSecretArr, hkdfSalt, calleeToCallerInfo)

	vectors["call_keys"] = map[string]interface{}{
		"shared_secret_hex":         hex.EncodeToString(sharedSecretArr[:]),
		"salt_hex":                  hex.EncodeToString(hkdfSalt[:]),
		"caller_to_callee_key_hex": hex.EncodeToString(callerToCalleeKey[:]),
		"callee_to_caller_key_hex": hex.EncodeToString(calleeToCallerKey[:]),
		"caller_x25519_priv_hex":   hex.EncodeToString(callerX25519Priv[:]),
		"caller_x25519_pub_hex":    hex.EncodeToString(callerX25519Pub),
		"callee_x25519_priv_hex":   hex.EncodeToString(calleeX25519Priv[:]),
		"callee_x25519_pub_hex":    hex.EncodeToString(calleeX25519Pub),
	}

	// ═══════════════════════════════════════════
	// 3. call_iv_prefix — HKDF-derived 4-byte IV prefix
	// ═══════════════════════════════════════════
	ivPrefixInfo := []byte("e2ee/v1/call-iv-prefix")
	callerSendPrefix := hkdfDeriveN(t, callerToCalleeKey, hkdfSalt, ivPrefixInfo, 4)
	calleeSendPrefix := hkdfDeriveN(t, calleeToCallerKey, hkdfSalt, ivPrefixInfo, 4)

	vectors["call_iv_prefix"] = map[string]interface{}{
		"info":                     string(ivPrefixInfo),
		"info_hex":                 hex.EncodeToString(ivPrefixInfo),
		"info_length":              len(ivPrefixInfo),
		"caller_send_prefix_hex":   hex.EncodeToString(callerSendPrefix),
		"callee_send_prefix_hex":   hex.EncodeToString(calleeSendPrefix),
	}

	// ═══════════════════════════════════════════
	// 4. call_iv — full 12-byte IVs at various sequences
	// ═══════════════════════════════════════════
	type ivCase struct {
		SeqBigInt string `json:"seq_bigint"`
		SeqHex    string `json:"seq_hex"`
		IVHex     string `json:"iv_hex"`
	}

	buildCallIV := func(prefix []byte, seq uint64) []byte {
		iv := make([]byte, 12)
		copy(iv[:4], prefix)
		binary.BigEndian.PutUint64(iv[4:], seq)
		return iv
	}

	ivCases := []ivCase{
		{"1", fmt.Sprintf("%016x", uint64(1)), hex.EncodeToString(buildCallIV(callerSendPrefix, 1))},
		{"9007199254740991", fmt.Sprintf("%016x", uint64(9007199254740991)), hex.EncodeToString(buildCallIV(callerSendPrefix, 9007199254740991))},
		{"9007199254740992", fmt.Sprintf("%016x", uint64(9007199254740992)), hex.EncodeToString(buildCallIV(callerSendPrefix, 9007199254740992))},
	}

	vectors["call_iv"] = map[string]interface{}{
		"prefix_hex": hex.EncodeToString(callerSendPrefix),
		"cases":      ivCases,
	}

	// ═══════════════════════════════════════════
	// 5. call_aad — 26-byte AAD for each frame type
	// ═══════════════════════════════════════════
	type aadCase struct {
		FrameType byte   `json:"frame_type"`
		Seq       uint64 `json:"seq"`
		AADHex    string `json:"aad_hex"`
		AADLength int    `json:"aad_length"`
	}

	buildCallAAD := func(version byte, callIDRaw [16]byte, frameType byte, seq uint64) []byte {
		aad := make([]byte, 26)
		aad[0] = version
		copy(aad[1:17], callIDRaw[:])
		aad[17] = frameType
		binary.BigEndian.PutUint64(aad[18:26], seq)
		return aad
	}

	frameTypes := []byte{0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07}
	var aadCases []aadCase
	for _, ft := range frameTypes {
		aad := buildCallAAD(0x01, callID, ft, 1)
		aadCases = append(aadCases, aadCase{ft, 1, hex.EncodeToString(aad), 26})
	}

	vectors["call_aad"] = map[string]interface{}{
		"version":    1,
		"call_id_hex": hex.EncodeToString(callID[:]),
		"cases":      aadCases,
	}

	// ═══════════════════════════════════════════
	// 6. call_frame_sealed — seal/open a call signaling frame
	// ═══════════════════════════════════════════
	frameAAD := buildCallAAD(0x01, callID, 0x01, 1)
	frameIV := buildCallIV(callerSendPrefix, 1)
	framePlaintext := []byte(`{"type":"offer","sdp":"v=0\r\n","sig":"AAAA"}`)

	frameSealed := aesGcmSeal(t, callerToCalleeKey[:], frameIV, framePlaintext, frameAAD)

	vectors["call_frame_sealed"] = map[string]interface{}{
		"key_hex":        hex.EncodeToString(callerToCalleeKey[:]),
		"iv_hex":         hex.EncodeToString(frameIV),
		"aad_hex":        hex.EncodeToString(frameAAD),
		"plaintext":      string(framePlaintext),
		"plaintext_hex":  hex.EncodeToString(framePlaintext),
		"ciphertext_hex": hex.EncodeToString(frameSealed),
		"frame_type":     0x01,
		"seq":            1,
	}

	// ═══════════════════════════════════════════
	// 7. call_fingerprint_payload — 73-byte signing payload
	// ═══════════════════════════════════════════
	fingerprintPrefix := []byte("e2ee/v1/call-fingerprint")
	fingerprint := [32]byte{}
	for i := range fingerprint {
		fingerprint[i] = byte(0xAB + i)
	}

	buildFPPayload := func(fp [32]byte, callIDRaw [16]byte, roleByte byte) []byte {
		p := make([]byte, 0, 73)
		p = append(p, fingerprintPrefix...)
		p = append(p, callIDRaw[:]...)
		p = append(p, fp[:]...)
		p = append(p, roleByte)
		return p
	}

	callerFPPayload := buildFPPayload(fingerprint, callID, 0x01)
	calleeFPPayload := buildFPPayload(fingerprint, callID, 0x02)

	callerFPSig := ed25519.Sign(callerPriv, callerFPPayload)

	vectors["call_fingerprint_payload"] = map[string]interface{}{
		"prefix":                  string(fingerprintPrefix),
		"prefix_length":           len(fingerprintPrefix),
		"fingerprint_hex":         hex.EncodeToString(fingerprint[:]),
		"call_id_hex":             hex.EncodeToString(callID[:]),
		"caller_payload_hex":      hex.EncodeToString(callerFPPayload),
		"callee_payload_hex":      hex.EncodeToString(calleeFPPayload),
		"payload_length":          73,
	}

	vectors["call_fingerprint_sig"] = map[string]interface{}{
		"caller_identity_pk_hex":  hex.EncodeToString(callerPub),
		"caller_priv_seed_hex":    hex.EncodeToString(callerSeed[:]),
		"signature_hex":           hex.EncodeToString(callerFPSig),
		"payload_hex":             hex.EncodeToString(callerFPPayload),
	}

	// ═══════════════════════════════════════════
	// 8. call_fingerprint_sdp — SDP fingerprint parsing
	// ═══════════════════════════════════════════
	sdpFPLine := "a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89"
	sdpFPBytes, _ := hex.DecodeString("ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789")

	vectors["call_fingerprint_sdp"] = map[string]interface{}{
		"sdp_line":       sdpFPLine,
		"raw_bytes_hex":  hex.EncodeToString(sdpFPBytes),
		"byte_length":    32,
	}

	// ═══════════════════════════════════════════
	// 9. call_sas — SAS computation
	// ═══════════════════════════════════════════
	callerFP := [32]byte{}
	calleeFP := [32]byte{}
	for i := range callerFP {
		callerFP[i] = byte(i + 1)
	}
	for i := range calleeFP {
		calleeFP[i] = byte(i + 33)
	}

	sasInput := make([]byte, 80)
	copy(sasInput[0:32], callerFP[:])
	copy(sasInput[32:64], calleeFP[:])
	copy(sasInput[64:80], callID[:])

	sasHash := sha256.Sum256(sasInput)
	sasVal := binary.BigEndian.Uint32(sasHash[:4])

	sasDigits := ""
	if sasVal < 4294000000 {
		sasDigits = fmt.Sprintf("%06d", sasVal%1000000)
	}

	vectors["call_sas"] = map[string]interface{}{
		"caller_fp_hex":   hex.EncodeToString(callerFP[:]),
		"callee_fp_hex":   hex.EncodeToString(calleeFP[:]),
		"call_id_hex":     hex.EncodeToString(callID[:]),
		"input_hex":       hex.EncodeToString(sasInput),
		"input_length":    80,
		"hash_hex":        hex.EncodeToString(sasHash[:]),
		"val":             sasVal,
		"accepted":        sasVal < 4294000000,
		"sas_digits":      sasDigits,
		"threshold":       uint32(4294000000),
	}

	// SAS rejection vector: engineer an input where Val >= 4294000000.
	// Brute force a call ID that produces a rejection.
	var rejCallID [16]byte
	var rejHash [32]byte
	var rejVal uint32
	found := false
	for a := byte(0); a < 255 && !found; a++ {
		for b := byte(0); b < 255 && !found; b++ {
			rejCallID[0] = a
			rejCallID[1] = b
			for j := 2; j < 16; j++ {
				rejCallID[j] = byte(j) + a ^ b
			}
			rejInput := make([]byte, 80)
			copy(rejInput[0:32], callerFP[:])
			copy(rejInput[32:64], calleeFP[:])
			copy(rejInput[64:80], rejCallID[:])
			rejHash = sha256.Sum256(rejInput)
			rejVal = binary.BigEndian.Uint32(rejHash[:4])
			if rejVal >= 4294000000 {
				found = true
				rehashInput := rejHash[:]
				rehash := sha256.Sum256(rehashInput)
				rehashVal := binary.BigEndian.Uint32(rehash[:4])
				rehashDigits := ""
				if rehashVal < 4294000000 {
					rehashDigits = fmt.Sprintf("%06d", rehashVal%1000000)
				}
				vectors["call_sas_rejection"] = map[string]interface{}{
					"caller_fp_hex":     hex.EncodeToString(callerFP[:]),
					"callee_fp_hex":     hex.EncodeToString(calleeFP[:]),
					"call_id_hex":       hex.EncodeToString(rejCallID[:]),
					"first_hash_hex":    hex.EncodeToString(rejHash[:]),
					"first_val":         rejVal,
					"rehash_hex":        hex.EncodeToString(rehash[:]),
					"rehash_val":        rehashVal,
					"rehash_accepted":   rehashVal < 4294000000,
					"sas_digits":        rehashDigits,
				}
			}
		}
	}
	if !found {
		t.Log("WARNING: could not find a SAS rejection vector")
	}

	// SAS boundary vector: Val == 4294000000 exactly must be rejected.
	vectors["call_sas_boundary"] = map[string]interface{}{
		"threshold":  uint32(4294000000),
		"comparison": ">=",
		"note":       "Val == 4294000000 MUST trigger rehash (comparison is >=, not >)",
	}

	// ═══════════════════════════════════════════
	// 10. call_replay — signaling replay window
	// ═══════════════════════════════════════════
	rw := &crypto.ReplayWindow{}
	type rwStep struct {
		SeqNum uint64 `json:"seq_num"`
		Action string `json:"action"`
		Result bool   `json:"result"`
		HiSeq  uint64 `json:"highest_sequence_after"`
		Bitmap uint64 `json:"bitmap_after"`
	}
	var crSteps []rwStep

	addCRStep := func(seq uint64, action string) {
		if action == "check" {
			result := rw.Check(seq)
			crSteps = append(crSteps, rwStep{seq, action, result, rw.HighestSequence, rw.Bitmap})
		} else {
			rw.Accept(seq)
			crSteps = append(crSteps, rwStep{seq, action, true, rw.HighestSequence, rw.Bitmap})
		}
	}

	addCRStep(0, "check")   // invalid: always false
	addCRStep(1, "check")   // true (new)
	addCRStep(1, "accept")  // accept
	addCRStep(1, "check")   // false (replay)
	addCRStep(65, "check")  // true (advance)
	addCRStep(65, "accept") // accept
	addCRStep(1, "check")   // false (evicted: 65-1=64 >= 64)

	vectors["call_replay"] = map[string]interface{}{
		"window_size": 64,
		"steps":       crSteps,
	}

	// ═══════════════════════════════════════════
	// 11. chunk_aad — 25-byte media chunk AAD
	// ═══════════════════════════════════════════
	type chunkAADCase struct {
		ChunkIndex  uint32 `json:"chunk_index"`
		TotalChunks uint32 `json:"total_chunks"`
		AADHex      string `json:"aad_hex"`
		AADLength   int    `json:"aad_length"`
	}

	buildChunkAAD := func(version byte, fid [16]byte, chunkIndex, totalChunks uint32) []byte {
		aad := make([]byte, 25)
		aad[0] = version
		copy(aad[1:17], fid[:])
		binary.BigEndian.PutUint32(aad[17:21], chunkIndex)
		binary.BigEndian.PutUint32(aad[21:25], totalChunks)
		return aad
	}

	chunkAADCases := []chunkAADCase{
		{0, 400, hex.EncodeToString(buildChunkAAD(0x01, fileID, 0, 400)), 25},
		{399, 400, hex.EncodeToString(buildChunkAAD(0x01, fileID, 399, 400)), 25},
	}

	vectors["chunk_aad"] = map[string]interface{}{
		"version":     1,
		"file_id_hex": hex.EncodeToString(fileID[:]),
		"cases":       chunkAADCases,
	}

	// ═══════════════════════════════════════════
	// 12. chunk_nonce — 12-byte media chunk nonce
	// ═══════════════════════════════════════════
	fileIVPrefix := [4]byte{0xCA, 0xFE, 0xBA, 0xBE}

	type chunkNonceCase struct {
		ChunkIndex uint64 `json:"chunk_index"`
		NonceHex   string `json:"nonce_hex"`
	}

	buildChunkNonce := func(prefix [4]byte, index uint64) []byte {
		nonce := make([]byte, 12)
		copy(nonce[:4], prefix[:])
		binary.BigEndian.PutUint64(nonce[4:], index)
		return nonce
	}

	nonceCases := []chunkNonceCase{
		{0, hex.EncodeToString(buildChunkNonce(fileIVPrefix, 0))},
		{1, hex.EncodeToString(buildChunkNonce(fileIVPrefix, 1))},
		{399, hex.EncodeToString(buildChunkNonce(fileIVPrefix, 399))},
	}

	vectors["chunk_nonce"] = map[string]interface{}{
		"file_iv_prefix_hex": hex.EncodeToString(fileIVPrefix[:]),
		"cases":              nonceCases,
	}

	// ═══════════════════════════════════════════
	// 13. chunk_sealed — seal a small plaintext chunk
	// ═══════════════════════════════════════════
	// Use a small test plaintext (not 5MB — just for vector correctness).
	var mediaKey [32]byte
	for i := range mediaKey {
		mediaKey[i] = byte(i + 150)
	}
	chunkPlaintext := make([]byte, 64) // small test plaintext
	for i := range chunkPlaintext {
		chunkPlaintext[i] = byte(i)
	}
	chunkAAD := buildChunkAAD(0x01, fileID, 0, 1)
	chunkNonce := buildChunkNonce(fileIVPrefix, 0)
	chunkCiphertext := aesGcmSeal(t, mediaKey[:], chunkNonce, chunkPlaintext, chunkAAD)
	chunkCiphertextHash := sha256.Sum256(chunkCiphertext)

	vectors["chunk_sealed"] = map[string]interface{}{
		"media_key_hex":       hex.EncodeToString(mediaKey[:]),
		"file_iv_prefix_hex":  hex.EncodeToString(fileIVPrefix[:]),
		"file_id_hex":         hex.EncodeToString(fileID[:]),
		"chunk_index":         0,
		"total_chunks":        1,
		"plaintext_hex":       hex.EncodeToString(chunkPlaintext),
		"plaintext_length":    len(chunkPlaintext),
		"nonce_hex":           hex.EncodeToString(chunkNonce),
		"aad_hex":             hex.EncodeToString(chunkAAD),
		"ciphertext_hex":      hex.EncodeToString(chunkCiphertext),
		"ciphertext_length":   len(chunkCiphertext),
		"ciphertext_sha256_hex": hex.EncodeToString(chunkCiphertextHash[:]),
	}

	// ═══════════════════════════════════════════
	// 14. manifest — SHA256(concat of raw chunk hashes)
	// ═══════════════════════════════════════════
	hash0 := sha256.Sum256([]byte("chunk-0-data"))
	hash1 := sha256.Sum256([]byte("chunk-1-data"))
	hash2 := sha256.Sum256([]byte("chunk-2-data"))

	manifestInput := make([]byte, 96) // 32 * 3
	copy(manifestInput[0:32], hash0[:])
	copy(manifestInput[32:64], hash1[:])
	copy(manifestInput[64:96], hash2[:])
	manifestHash := sha256.Sum256(manifestInput)

	// Swapped order for sensitivity test.
	swappedInput := make([]byte, 96)
	copy(swappedInput[0:32], hash1[:]) // swapped
	copy(swappedInput[32:64], hash0[:]) // swapped
	copy(swappedInput[64:96], hash2[:])
	swappedHash := sha256.Sum256(swappedInput)

	vectors["manifest"] = map[string]interface{}{
		"chunk_hashes_hex": []string{
			hex.EncodeToString(hash0[:]),
			hex.EncodeToString(hash1[:]),
			hex.EncodeToString(hash2[:]),
		},
		"input_hex":         hex.EncodeToString(manifestInput),
		"input_length":      96,
		"manifest_hash_hex": hex.EncodeToString(manifestHash[:]),
		"swapped_hash_hex":  hex.EncodeToString(swappedHash[:]),
	}

	// ═══════════════════════════════════════════
	// 15. thumbnail_aad — 17-byte thumbnail AAD
	// ═══════════════════════════════════════════
	thumbAAD := make([]byte, 17)
	thumbAAD[0] = 0x01
	copy(thumbAAD[1:17], fileID[:])

	vectors["thumbnail_aad"] = map[string]interface{}{
		"version":     1,
		"file_id_hex": hex.EncodeToString(fileID[:]),
		"aad_hex":     hex.EncodeToString(thumbAAD),
		"aad_length":  17,
	}

	// ═══════════════════════════════════════════
	// 16. thumbnail_plain — ADR-P12B-35 layout
	// ═══════════════════════════════════════════
	imageBytes := make([]byte, 100) // small test image
	for i := range imageBytes {
		imageBytes[i] = byte(0xFF - byte(i))
	}
	thumbPlain := make([]byte, 32768)
	binary.BigEndian.PutUint32(thumbPlain[0:4], uint32(len(imageBytes)))
	copy(thumbPlain[4:4+len(imageBytes)], imageBytes)
	// rest is zero padding

	vectors["thumbnail_plain"] = map[string]interface{}{
		"image_hex":        hex.EncodeToString(imageBytes),
		"image_length":     len(imageBytes),
		"padded_hex":       hex.EncodeToString(thumbPlain),
		"padded_length":    32768,
		"max_image_length": 32764,
	}

	// ═══════════════════════════════════════════
	// 17. thumbnail_sealed — 32,797-byte wire form
	// ═══════════════════════════════════════════
	var thumbIV [12]byte
	for i := range thumbIV {
		thumbIV[i] = byte(0xFE - byte(i))
	}
	thumbCiphertext := aesGcmSeal(t, mediaKey[:], thumbIV[:], thumbPlain, thumbAAD)

	thumbWire := make([]byte, 0, 32797)
	thumbWire = append(thumbWire, 0x01) // version byte
	thumbWire = append(thumbWire, thumbIV[:]...)
	thumbWire = append(thumbWire, thumbCiphertext...)

	thumbWireHash := sha256.Sum256(thumbWire)

	vectors["thumbnail_sealed"] = map[string]interface{}{
		"media_key_hex":      hex.EncodeToString(mediaKey[:]),
		"iv_hex":             hex.EncodeToString(thumbIV[:]),
		"aad_hex":            hex.EncodeToString(thumbAAD),
		"plaintext_length":   32768,
		"wire_hex_prefix":    hex.EncodeToString(thumbWire[:32]), // first 32 bytes for sanity
		"wire_length":        len(thumbWire),
		"wire_sha256_hex":    hex.EncodeToString(thumbWireHash[:]),
		"version_byte":       0x01,
	}

	// ═══════════════════════════════════════════
	// 18. media_token — SHA256(token) as lowercase hex
	// ═══════════════════════════════════════════
	var mediaToken [32]byte
	for i := range mediaToken {
		mediaToken[i] = byte(i + 200)
	}
	tokenHash := sha256.Sum256(mediaToken[:])

	vectors["media_token"] = map[string]interface{}{
		"token_hex":      hex.EncodeToString(mediaToken[:]),
		"token_hash_hex": hex.EncodeToString(tokenHash[:]),
		"encoding":       "lowercase-hex",
		"note":           "V-1 deviation: server uses hex.EncodeToString, not Base64, despite RFC-0007 §7.1",
	}

	// ═══════════════════════════════════════════
	// 19. mce_text — MCE v1 text envelope
	// ═══════════════════════════════════════════
	mceText := `{"v":1,"t":"text","b":"Hello, World!"}`
	mceTextEmoji := `{"v":1,"t":"text","b":"Hello 👋\r\nWorld \"quoted\""}`

	vectors["mce_text"] = map[string]interface{}{
		"simple_json":    mceText,
		"simple_hex":     hex.EncodeToString([]byte(mceText)),
		"emoji_json":     mceTextEmoji,
		"emoji_hex":      hex.EncodeToString([]byte(mceTextEmoji)),
	}

	// ═══════════════════════════════════════════
	// 20. mce_media — MCE v1 media envelope (field order)
	// ═══════════════════════════════════════════
	vectors["mce_media"] = map[string]interface{}{
		"field_order": []string{"v", "t", "m"},
		"m_field_order": []string{
			"file_id", "media_key", "file_iv_prefix",
			"media_token", "original_size", "total_chunks",
			"file_manifest_hash", "mime_type", "inline_thumbnail",
		},
		"note": "All binary fields inside 'm' use Base64 standard padded except file_id (UUID string) and original_size (JSON number)",
	}

	// ═══════════════════════════════════════════
	// 21. chunk_padding — padding verification
	// ═══════════════════════════════════════════
	vectors["chunk_padding"] = map[string]interface{}{
		"chunk_plaintext_size": 5242880,
		"chunk_ciphertext_size": 5242896,
		"gcm_tag_size":         16,
		"max_total_chunks":     400,
		"max_file_size":        5242880 * 400,
		"chunk_count_cases": []map[string]interface{}{
			{"original_size": 0, "chunks": 1},
			{"original_size": 1, "chunks": 1},
			{"original_size": 5242879, "chunks": 1},
			{"original_size": 5242880, "chunks": 1, "note": "exact multiple — NO extra chunk"},
			{"original_size": 5242881, "chunks": 2},
			{"original_size": 10485760, "chunks": 2, "note": "exact multiple — NO extra chunk"},
			{"original_size": 2097152000, "chunks": 400},
			{"original_size": 2097152001, "rejected": true, "note": "exceeds 400 chunks"},
		},
	}

	// ═══════════════════════════════════════════
	// Write JSON
	// ═══════════════════════════════════════════
	wrapper := map[string]interface{}{
		"version":     "v2",
		"description": "RootInbox Phase 12B conformance vectors. Call signaling, media crypto, and MCE. Generated by Go backend (pkg/crypto). Frontend MUST produce byte-identical outputs.",
		"vectors":     vectors,
	}

	jsonData, err := json.MarshalIndent(wrapper, "", "  ")
	if err != nil {
		t.Fatalf("marshaling JSON: %v", err)
	}

	// Write to docs/vectors/crypto-vectors-v2.json
	_, thisFile, _, _ := runtime.Caller(0)
	projectRoot := filepath.Join(filepath.Dir(thisFile), "..", "..")
	outDir := filepath.Join(projectRoot, "docs", "vectors")
	if err := os.MkdirAll(outDir, 0755); err != nil {
		t.Fatalf("creating output dir: %v", err)
	}
	outPath := filepath.Join(outDir, "crypto-vectors-v2.json")
	if err := os.WriteFile(outPath, jsonData, 0644); err != nil {
		t.Fatalf("writing vectors: %v", err)
	}
	t.Logf("Wrote v2 conformance vectors to %s (%d bytes)", outPath, len(jsonData))

	// Copy to web/src/__vectors__/
	webDir := filepath.Join(projectRoot, "web", "src", "__vectors__")
	if err := os.MkdirAll(webDir, 0755); err != nil {
		t.Fatalf("creating web vectors dir: %v", err)
	}
	webPath := filepath.Join(webDir, "crypto-vectors-v2.json")
	if err := os.WriteFile(webPath, jsonData, 0644); err != nil {
		t.Fatalf("writing web vectors: %v", err)
	}
	t.Logf("Copied to %s", webPath)
}

// ── Helpers ──

func sha256Bytes(data []byte) [32]byte {
	return sha256.Sum256(data)
}

func hkdfDerive(t *testing.T, secret, salt [32]byte, info []byte) [32]byte {
	t.Helper()
	var result [32]byte
	reader := hkdf.New(sha256.New, secret[:], salt[:], info)
	if _, err := io.ReadFull(reader, result[:]); err != nil {
		t.Fatalf("HKDF: %v", err)
	}
	return result
}

func hkdfDeriveN(t *testing.T, secret, salt [32]byte, info []byte, n int) []byte {
	t.Helper()
	result := make([]byte, n)
	reader := hkdf.New(sha256.New, secret[:], salt[:], info)
	if _, err := io.ReadFull(reader, result); err != nil {
		t.Fatalf("HKDF: %v", err)
	}
	return result
}

func aesGcmSeal(t *testing.T, key, iv, plaintext, aad []byte) []byte {
	t.Helper()
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatalf("NewCipher: %v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("NewGCM: %v", err)
	}
	return gcm.Seal(nil, iv, plaintext, aad)
}
