package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"fmt"
)

// Encrypt performs AES-256-GCM encryption with Additional Authenticated Data.
// RFC-0003 §4.5: Authentication tag length MUST be strictly exactly 128 bits (16 bytes).
// Go's GCM implementation uses a 16-byte tag by default.
func Encrypt(key [32]byte, iv [12]byte, plaintext, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, fmt.Errorf("creating AES cipher: %w", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("creating GCM: %w", err)
	}
	// Seal appends the 16-byte authentication tag to the ciphertext.
	sealed := gcm.Seal(nil, iv[:], plaintext, aad)
	return sealed, nil
}

// Decrypt performs AES-256-GCM decryption with Additional Authenticated Data.
// RFC-0003 §8.2: Authentication failures MUST NOT reveal specific error details.
func Decrypt(key [32]byte, iv [12]byte, ciphertext, aad []byte) ([]byte, error) {
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, fmt.Errorf("decryption failed")
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("decryption failed")
	}
	plaintext, err := gcm.Open(nil, iv[:], ciphertext, aad)
	if err != nil {
		// RFC-0003 §8.2: Do not reveal specific error details.
		return nil, fmt.Errorf("decryption failed")
	}
	return plaintext, nil
}
