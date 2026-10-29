package crypto

import (
	"encoding/binary"
	"fmt"
)

const (
	// CryptoSuiteV1 is the version byte for X25519 + HKDF-SHA256 + AES-256-GCM.
	// RFC-0003 §6.2: Version Registry 0x01.
	CryptoSuiteV1 byte = 0x01

	// MaxCiphertextSize is the maximum encrypted message payload.
	// RFC-0003 §6.4: 5MB per WebSocket frame.
	MaxCiphertextSize = 5 * 1024 * 1024

	// CiphertextHeaderSize is Version(1) + SenderSessionID(8) + IV(12) = 21 bytes.
	CiphertextHeaderSize = 1 + 8 + 12

	// AADSize is the fixed-width AAD size for v1.
	// RFC-0003 §6.5: SeqNum(8) + ClientUUID(16) + SenderHash(32) +
	// ReceiverHash(32) + ConvIDHash(32) + SenderSessionID(8) = 128 bytes.
	AADSize = 128
)

// EncodeCiphertext encodes the ciphertext wire format.
// RFC-0003 §6.2 (BigEndian):
// [Version(1)] [SenderSessionID(8)] [IV(12)] [SealedCiphertext(var)].
func EncodeCiphertext(version byte, senderSessionID [8]byte, iv [12]byte, sealed []byte) ([]byte, error) {
	totalSize := CiphertextHeaderSize + len(sealed)
	if totalSize > MaxCiphertextSize {
		return nil, fmt.Errorf("ciphertext exceeds maximum size of %d bytes", MaxCiphertextSize)
	}

	buf := make([]byte, totalSize)
	buf[0] = version
	copy(buf[1:9], senderSessionID[:])
	copy(buf[9:21], iv[:])
	copy(buf[21:], sealed)
	return buf, nil
}

// DecodeCiphertext decodes the ciphertext wire format.
// RFC-0003 §6.3: Reject unknown/legacy version bytes silently before any decryption.
// RFC-0003 §6.4: Enforce 5MB max payload.
func DecodeCiphertext(data []byte) (version byte, senderSessionID [8]byte, iv [12]byte, sealed []byte, err error) {
	if len(data) < CiphertextHeaderSize {
		return 0, senderSessionID, iv, nil, fmt.Errorf("ciphertext too short: %d bytes", len(data))
	}
	if len(data) > MaxCiphertextSize {
		return 0, senderSessionID, iv, nil, fmt.Errorf("ciphertext exceeds maximum size")
	}

	version = data[0]
	if version != CryptoSuiteV1 {
		// RFC-0003 §6.3: Downgrade Rejection.
		return 0, senderSessionID, iv, nil, fmt.Errorf("unsupported crypto suite version: 0x%02x", version)
	}

	copy(senderSessionID[:], data[1:9])
	copy(iv[:], data[9:21])
	sealed = make([]byte, len(data)-CiphertextHeaderSize)
	copy(sealed, data[21:])

	return version, senderSessionID, iv, sealed, nil
}

// BuildAAD constructs the Additional Authenticated Data for AES-GCM.
// RFC-0003 §6.5: v1 fixed-width 128 bytes.
// [SeqNum(8)] [ClientUUID(16)] [SenderIdentityHash(32)]
// [ReceiverIdentityHash(32)] [ConvIDHash(32)] [SenderSessionID(8)].
func BuildAAD(
	seqNum uint64,
	clientUUID [16]byte,
	senderIdentityHash, receiverIdentityHash, convIDHash [32]byte,
	senderSessionID [8]byte,
) [AADSize]byte {
	var aad [AADSize]byte
	binary.BigEndian.PutUint64(aad[0:8], seqNum)
	copy(aad[8:24], clientUUID[:])
	copy(aad[24:56], senderIdentityHash[:])
	copy(aad[56:88], receiverIdentityHash[:])
	copy(aad[88:120], convIDHash[:])
	copy(aad[120:128], senderSessionID[:])
	return aad
}
