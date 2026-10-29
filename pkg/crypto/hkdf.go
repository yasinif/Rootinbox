package crypto

import (
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"io"

	"golang.org/x/crypto/hkdf"
)

// hkdfSalt is the precomputed SHA256("rootinbox-hkdf-salt-v1").
// RFC-0003 §4.3: Salt for HKDF-SHA256.
var hkdfSalt = sha256.Sum256([]byte("rootinbox-hkdf-salt-v1"))

// messageKeyInfoPrefix is the domain separation prefix for message key derivation.
// RFC-0003 §4.4: Every HKDF usage MUST define a unique Info string prefix.
var messageKeyInfoPrefix = []byte("rootinbox/v1/e2ee-message-key")

// DeriveMessageKey derives a per-message AES-256-GCM key using HKDF-SHA256.
// RFC-0003 §4.3: A new derivation MUST be performed for EVERY message.
// RFC-0003 §4.3: Derived Message Keys MUST NOT be cached under any circumstances.
// IKM: The cached 32-byte ECDH shared secret.
func DeriveMessageKey(sharedSecret [32]byte, info []byte) ([32]byte, error) {
	var result [32]byte
	reader := hkdf.New(sha256.New, sharedSecret[:], hkdfSalt[:], info)
	if _, err := io.ReadFull(reader, result[:]); err != nil {
		return result, fmt.Errorf("HKDF derivation failed: %w", err)
	}
	return result, nil
}

// BuildMessageKeyInfo constructs the HKDF Info parameter for message key derivation.
// RFC-0003 §4.3 Info:
// "rootinbox/v1/e2ee-message-key" || Sender Identity Hash || Receiver Identity Hash
// || Conversation ID Hash || 8-byte Sequence Number (BigEndian).
func BuildMessageKeyInfo(
	senderIdentityHash, receiverIdentityHash, convIDHash [32]byte,
	sequenceNum uint64,
) []byte {
	// Total: len(prefix) + 32 + 32 + 32 + 8 = 29 + 104 = 133 bytes.
	info := make([]byte, len(messageKeyInfoPrefix)+32+32+32+8)
	n := copy(info, messageKeyInfoPrefix)
	n += copy(info[n:], senderIdentityHash[:])
	n += copy(info[n:], receiverIdentityHash[:])
	n += copy(info[n:], convIDHash[:])
	binary.BigEndian.PutUint64(info[n:], sequenceNum)
	return info
}
