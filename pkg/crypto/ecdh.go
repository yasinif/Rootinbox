package crypto

import (
	"crypto/rand"
	"fmt"

	"golang.org/x/crypto/curve25519"
)

// GenerateSessionKeyPair generates an X25519 keypair for session key exchange.
// RFC-0003 §4.3: X25519 ECDH.
// RFC-0003 §8.1: ONLY crypto/rand permitted for RNG.
func GenerateSessionKeyPair() (publicKey, privateKey [32]byte, err error) {
	if _, err = rand.Read(privateKey[:]); err != nil {
		return publicKey, privateKey, fmt.Errorf("generating random key: %w", err)
	}
	pub, err := curve25519.X25519(privateKey[:], curve25519.Basepoint)
	if err != nil {
		return publicKey, privateKey, fmt.Errorf("computing public key: %w", err)
	}
	copy(publicKey[:], pub)
	return publicKey, privateKey, nil
}

// ComputeSharedSecret performs X25519 ECDH key agreement.
// RFC-0003 §4.3: ECDH(Sender Session Private Key, Receiver Session Public Key).
// RFC-0003 §5.2 step 1: Validate key length exactly 32 bytes and reject low-order points.
// The curve25519.X25519 function returns an error for low-order points per RFC 7748.
func ComputeSharedSecret(privateKey, peerPublicKey [32]byte) ([32]byte, error) {
	var result [32]byte
	shared, err := curve25519.X25519(privateKey[:], peerPublicKey[:])
	if err != nil {
		return result, fmt.Errorf("ECDH computation failed: %w", err)
	}
	copy(result[:], shared)
	return result, nil
}
