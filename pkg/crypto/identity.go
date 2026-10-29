package crypto

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/binary"
)

// IdentityHash computes SHA-256 of the raw Ed25519 public key.
// RFC-0003 §6.1: SHA-256(Raw 32-byte RFC8032 encoded Ed25519 Public Key).
func IdentityHash(publicKey [32]byte) [32]byte {
	return sha256.Sum256(publicKey[:])
}

// ConversationIDHash computes SHA-256 of the raw UUID bytes.
// RFC-0003 §6.1: SHA-256(Conversation UUID).
// RFC-0003 §6.1: UUID encoded as 16 raw binary bytes (NOT ASCII strings).
func ConversationIDHash(uuid [16]byte) [32]byte {
	return sha256.Sum256(uuid[:])
}

// SessionIdentifier returns the first 8 bytes of SHA-256(Session Public Key).
// RFC-0003 §6.1.
func SessionIdentifier(sessionPubKey [32]byte) [8]byte {
	hash := sha256.Sum256(sessionPubKey[:])
	var id [8]byte
	copy(id[:], hash[:8])
	return id
}

// Ed25519FromSeed creates an Ed25519 key pair from a 32-byte seed.
// RFC-0003 §4.1: Argon2id output used directly as Ed25519 Seed.
func Ed25519FromSeed(seed [32]byte) (publicKey ed25519.PublicKey, privateKey ed25519.PrivateKey) {
	privateKey = ed25519.NewKeyFromSeed(seed[:])
	publicKey = privateKey.Public().(ed25519.PublicKey)
	return publicKey, privateKey
}

// sessionSignaturePayload constructs the exact signature payload.
// RFC-0003 §5.1: Crypto Suite Version Byte (1) || SessionPublicKey (32) ||
// ExpirationUnix (8, BigEndian) || IdentityPublicKeyHash (32) = 73 bytes.
func sessionSignaturePayload(version byte, sessionPK [32]byte, expiresAt int64, identityPKHash [32]byte) []byte {
	payload := make([]byte, 1+32+8+32) // 73 bytes
	payload[0] = version
	copy(payload[1:33], sessionPK[:])
	binary.BigEndian.PutUint64(payload[33:41], uint64(expiresAt))
	copy(payload[41:73], identityPKHash[:])
	return payload
}

// SignSessionKey signs a session key registration payload.
// RFC-0003 §5.1: Signature Payload.
func SignSessionKey(
	identityPrivKey ed25519.PrivateKey,
	version byte,
	sessionPK [32]byte,
	expiresAt int64,
	identityPKHash [32]byte,
) [64]byte {
	payload := sessionSignaturePayload(version, sessionPK, expiresAt, identityPKHash)
	sig := ed25519.Sign(identityPrivKey, payload)
	var result [64]byte
	copy(result[:], sig)
	return result
}

// VerifySessionSignature verifies a session key signature against the identity public key.
// RFC-0003 §5.1, §5.2 step 2: Verify Ed25519 Signature against the Identity Public Key.
func VerifySessionSignature(
	identityPubKey ed25519.PublicKey,
	version byte,
	sessionPK [32]byte,
	expiresAt int64,
	identityPKHash [32]byte,
	signature [64]byte,
) bool {
	payload := sessionSignaturePayload(version, sessionPK, expiresAt, identityPKHash)
	return ed25519.Verify(identityPubKey, payload, signature[:])
}

// RegistrationWireSize is the total size of the registration wire format.
// RFC-0003 §5.1: [IdentityPK(32)] [SessionPK(32)] [Signature(64)]
// [CryptoSuiteVersion(1)] [ExpiresAt(8)] = 137 bytes.
const RegistrationWireSize = 32 + 32 + 64 + 1 + 8

// EncodeRegistration encodes the session key registration wire format.
// RFC-0003 §5.1: Registration Wire Format.
func EncodeRegistration(identityPK [32]byte, sessionPK [32]byte, sig [64]byte, version byte, expiresAt int64) [RegistrationWireSize]byte {
	var buf [RegistrationWireSize]byte
	copy(buf[0:32], identityPK[:])
	copy(buf[32:64], sessionPK[:])
	copy(buf[64:128], sig[:])
	buf[128] = version
	binary.BigEndian.PutUint64(buf[129:137], uint64(expiresAt))
	return buf
}

// DecodeRegistration decodes the session key registration wire format.
// RFC-0003 §5.1: Registration Wire Format.
func DecodeRegistration(data [RegistrationWireSize]byte) (identityPK [32]byte, sessionPK [32]byte, sig [64]byte, version byte, expiresAt int64) {
	copy(identityPK[:], data[0:32])
	copy(sessionPK[:], data[32:64])
	copy(sig[:], data[64:128])
	version = data[128]
	expiresAt = int64(binary.BigEndian.Uint64(data[129:137]))
	return
}
