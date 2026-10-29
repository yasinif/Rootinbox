// Package push implements RFC-0009 Web Push. It owns ALL P-256 / RFC 8291
// material and MUST NOT import or influence pkg/crypto's X25519/Ed25519 suite
// beyond the generic AES-256-GCM helper used for at-rest encryption (§5.1).
package push

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"log/slog"

	"rootinbox/internal/domain"
	"rootinbox/pkg/crypto"
)

type VAPIDIdentity struct {
	publicB64  string // Base64URL uncompressed 65-byte point
	privateB64 string // Base64URL 32-byte scalar
}

// PublicKeyBase64URL satisfies domain.VAPIDKeyProvider.
func (v *VAPIDIdentity) PublicKeyBase64URL() string {
	return v.publicB64
}

// PrivateKeyBase64URL satisfies domain.VAPIDKeyProvider.
func (v *VAPIDIdentity) PrivateKeyBase64URL() string {
	return v.privateB64
}

// InitOrLoad implements the §4.1 first-boot / subsequent-boot contract.
// MUST be called from bootstrap between migrations and readiness (ADR-P9-4).
func InitOrLoad(
	ctx context.Context,
	repo domain.ApplicationKeyRepository,
	encryptionKey [32]byte,
	clock domain.Clock,
	logger *slog.Logger,
) (*VAPIDIdentity, error) {
	existing, err := repo.GetByID(ctx, domain.VAPIDKeyRowID)
	if err != nil {
		var de *domain.DomainError
		if errors.As(err, &de) && de.Code == domain.ErrPush001 {
			// Absent -> generate
			return generateAndPersist(ctx, repo, encryptionKey, clock, logger)
		}
		// Any other error -> return it wrapped
		return nil, fmt.Errorf("reading vapid key: %w", err)
	}

	// Found -> decrypt
	return decryptExisting(ctx, repo, existing, encryptionKey, logger)
}

func generateAndPersist(
	ctx context.Context,
	repo domain.ApplicationKeyRepository,
	encryptionKey [32]byte,
	clock domain.Clock,
	logger *slog.Logger,
) (*VAPIDIdentity, error) {
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, fmt.Errorf("generating vapid keypair: %w", err)
	}

	// Serialize private scalar into exactly 32 bytes using FillBytes (never Bytes()).
	var scalar32 [32]byte
	priv.D.FillBytes(scalar32[:])
	defer crypto.Zeroize(scalar32[:])

	// Serialize public key as uncompressed point (0x04 || X || Y), each 32 bytes.
	var x32, y32 [32]byte
	priv.PublicKey.X.FillBytes(x32[:])
	priv.PublicKey.Y.FillBytes(y32[:])

	pubUncompressed := make([]byte, 1+32+32)
	pubUncompressed[0] = 0x04
	copy(pubUncompressed[1:33], x32[:])
	copy(pubUncompressed[33:65], y32[:])

	publicB64 := base64.RawURLEncoding.EncodeToString(pubUncompressed)

	// Encrypt at rest
	var iv [12]byte
	if _, err := rand.Read(iv[:]); err != nil {
		return nil, fmt.Errorf("generating iv: %w", err)
	}

	aad := []byte("rootinbox/v1/vapid-private-key")
	var eKey [32]byte
	copy(eKey[:], encryptionKey[:])
	var eIV [12]byte
	copy(eIV[:], iv[:])
	sealed, err := crypto.Encrypt(eKey, eIV, scalar32[:], aad)
	if err != nil {
		return nil, fmt.Errorf("encrypting vapid key: %w", err)
	}

	privateKeyEncrypted := hex.EncodeToString(append(iv[:], sealed...))

	// Persist
	keyRecord := &domain.ApplicationKey{
		ID:                    domain.VAPIDKeyRowID,
		PrivateKeyEncrypted:   privateKeyEncrypted,
		PublicKeyUncompressed: publicB64,
		CreatedAt:             clock.NowUnix(),
	}

	if err := repo.Create(ctx, keyRecord); err != nil {
		// ADR-P9-5: A UNIQUE/PK violation here means a concurrent boot won. Abort.
		return nil, fmt.Errorf("persisting generated vapid key: %w", err)
	}

	pubPrefix := ""
	if len(publicB64) >= 12 {
		pubPrefix = publicB64[:12]
	}
	logger.Info("vapid keypair generated", "public_key_prefix", pubPrefix)

	return &VAPIDIdentity{
		publicB64:  publicB64,
		privateB64: base64.RawURLEncoding.EncodeToString(scalar32[:]),
	}, nil
}

func decryptScalar(
	existing *domain.ApplicationKey,
	encryptionKey [32]byte,
) ([]byte, string, error) {
	raw, err := hex.DecodeString(existing.PrivateKeyEncrypted)
	if err != nil {
		return nil, "", domain.NewDomainError(domain.ErrPush002, "vapid private key hex decode failed", err)
	}

	if len(raw) < 12+16+1 {
		return nil, "", domain.NewDomainError(domain.ErrPush002, "vapid private key ciphertext too short", nil)
	}

	iv := raw[:12]
	sealed := raw[12:]
	aad := []byte("rootinbox/v1/vapid-private-key")

	// Decrypt
	var eKey [32]byte
	copy(eKey[:], encryptionKey[:])
	var eIV [12]byte
	copy(eIV[:], iv)
	scalar, err := crypto.Decrypt(eKey, eIV, sealed, aad)
	if err != nil {
		// ADR-P9-5: NEVER regenerate on failure. Abort.
		return nil, "", domain.NewDomainError(domain.ErrPush002, "vapid private key decryption failed: PUSH_VAPID_ENCRYPTION_KEY does not match stored key", err)
	}

	if len(scalar) != 32 {
		crypto.Zeroize(scalar)
		return nil, "", domain.NewDomainError(domain.ErrPush002, "vapid private key scalar is not 32 bytes", nil)
	}

	// Consistency check: recompute public point from decrypted scalar.
	curve := elliptic.P256()
	x, y := curve.ScalarBaseMult(scalar)
	var x32, y32 [32]byte
	x.FillBytes(x32[:])
	y.FillBytes(y32[:])

	pubUncompressed := make([]byte, 1+32+32)
	pubUncompressed[0] = 0x04
	copy(pubUncompressed[1:33], x32[:])
	copy(pubUncompressed[33:65], y32[:])

	computedPubB64 := base64.RawURLEncoding.EncodeToString(pubUncompressed)

	if !crypto.ConstantTimeCompare([]byte(computedPubB64), []byte(existing.PublicKeyUncompressed)) {
		crypto.Zeroize(scalar)
		return nil, "", domain.NewDomainError(domain.ErrPush002, "vapid consistency check failed: public key mismatch", nil)
	}

	return scalar, computedPubB64, nil
}

func decryptExisting(
	ctx context.Context,
	repo domain.ApplicationKeyRepository,
	existing *domain.ApplicationKey,
	encryptionKey [32]byte,
	logger *slog.Logger,
) (*VAPIDIdentity, error) {
	scalar, computedPubB64, err := decryptScalar(existing, encryptionKey)
	if err == nil {
		defer crypto.Zeroize(scalar)
		pubPrefix := ""
		if len(computedPubB64) >= 12 {
			pubPrefix = computedPubB64[:12]
		}
		logger.Info("vapid keypair loaded", "created_at", existing.CreatedAt, "public_key_prefix", pubPrefix)

		return &VAPIDIdentity{
			publicB64:  computedPubB64,
			privateB64: base64.RawURLEncoding.EncodeToString(scalar),
		}, nil
	}

	// ONLY when a real (non-zero) key is configured:
	var zeroKey [32]byte
	if encryptionKey != zeroKey {
		zeroScalar, zeroPubB64, zeroErr := decryptScalar(existing, zeroKey)
		if zeroErr == nil {
			defer crypto.Zeroize(zeroScalar)

			// Decrypting with configured key failed AND decrypting with all-zero key succeeded:
			// re-encrypt the SAME keypair under the configured key, persist it, and log it.
			var iv [12]byte
			if _, randErr := rand.Read(iv[:]); randErr != nil {
				return nil, fmt.Errorf("generating iv for vapid key migration: %w", randErr)
			}

			aad := []byte("rootinbox/v1/vapid-private-key")
			var eKey [32]byte
			copy(eKey[:], encryptionKey[:])
			var eIV [12]byte
			copy(eIV[:], iv[:])
			sealed, encErr := crypto.Encrypt(eKey, eIV, zeroScalar, aad)
			if encErr != nil {
				return nil, fmt.Errorf("re-encrypting vapid key for migration: %w", encErr)
			}

			migrated := &domain.ApplicationKey{
				ID:                    domain.VAPIDKeyRowID,
				PrivateKeyEncrypted:   hex.EncodeToString(append(iv[:], sealed...)),
				PublicKeyUncompressed: zeroPubB64,
				CreatedAt:             existing.CreatedAt,
			}

			if updateErr := repo.UpdateCAS(ctx, migrated, existing.PrivateKeyEncrypted); updateErr != nil {
				return nil, fmt.Errorf("persisting migrated vapid key: %w", updateErr)
			}

			pubPrefix := ""
			if len(zeroPubB64) >= 12 {
				pubPrefix = zeroPubB64[:12]
			}
			logger.Info("vapid keypair migrated from zero-key to configured key", "public_key_prefix", pubPrefix)

			return &VAPIDIdentity{
				publicB64:  zeroPubB64,
				privateB64: base64.RawURLEncoding.EncodeToString(zeroScalar),
			}, nil
		}
	}

	// In every other failure case keep failing exactly as today.
	return nil, err
}
