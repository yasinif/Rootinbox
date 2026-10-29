package usecase

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"

	"rootinbox/internal/domain"
)

// VaultUseCase implements business logic for vault operations.
// RFC-0006 §4.3: Vault Archival Lifecycle.
type VaultUseCase struct {
	vaultRepo domain.VaultRepository
	clock     domain.Clock
	uuidGen   domain.UUIDGenerator
	logger    domain.Logger
}

// NewVaultUseCase creates a new VaultUseCase.
func NewVaultUseCase(
	vaultRepo domain.VaultRepository,
	clock domain.Clock,
	uuidGen domain.UUIDGenerator,
	logger domain.Logger,
) *VaultUseCase {
	return &VaultUseCase{
		vaultRepo: vaultRepo,
		clock:     clock,
		uuidGen:   uuidGen,
		logger:    logger,
	}
}

// UploadVault stages, validates, and persists a vault.
// RFC-0006 §6 (F2): Staging + hash verification + atomic commit.
// RFC-0006 §4.3: Immutability — reject overwrite of finalized vault (409).
func (uc *VaultUseCase) UploadVault(ctx context.Context, userID, monthYear string, data []byte, expectedHash string, schemaVersion int) (*domain.Vault, error) {
	// Step 1: Validate inputs.
	if monthYear == "" || len(data) == 0 || expectedHash == "" {
		return nil, domain.NewDomainError(domain.ErrSys001, "month_year, data, and hash are required", nil)
	}

	// Step 2: Check immutability — reject if finalized vault exists.
	// RFC-0006 §4.3: Server MUST reject (HTTP 409) overwriting an existing finalized Vault.
	existing, err := uc.vaultRepo.GetByUserAndMonth(ctx, userID, monthYear)
	if err == nil && existing != nil && existing.Finalized {
		return nil, domain.NewDomainError(domain.ErrVault001,
			fmt.Sprintf("vault for %s already exists and is finalized", monthYear), nil)
	}

	// Step 3: SHA-256 hash verification.
	// RFC-0006 §4.3: Client calculates SHA-256(Ciphertext) and attaches via X-Vault-Hash.
	computed := sha256.Sum256(data)
	computedHex := hex.EncodeToString(computed[:])
	if !strings.EqualFold(computedHex, expectedHash) {
		return nil, domain.NewDomainError(domain.ErrVault002,
			"content hash mismatch: upload integrity check failed", nil)
	}

	// Step 4: Atomic commit.
	vault := &domain.Vault{
		ID:            uc.uuidGen.New(),
		UserID:        userID,
		MonthYear:     monthYear,
		EncryptedData: data,
		ContentHash:   computedHex,
		SchemaVersion: schemaVersion,
		Finalized:     true,
		CreatedAt:     uc.clock.NowUnix(),
	}

	if err := uc.vaultRepo.Create(ctx, vault); err != nil {
		// Check for UNIQUE constraint violation (concurrent upload).
		if strings.Contains(err.Error(), "UNIQUE constraint failed") {
			return nil, domain.NewDomainError(domain.ErrVault001,
				fmt.Sprintf("vault for %s already exists", monthYear), nil)
		}
		return nil, domain.NewDomainError(domain.ErrDB002, "creating vault", err)
	}

	uc.logger.Info("vault uploaded",
		"vault_id", vault.ID,
		"user_id", userID,
		"month_year", monthYear,
		"size_bytes", len(data),
	)
	return vault, nil
}

// GetVault retrieves a vault by user and month.
func (uc *VaultUseCase) GetVault(ctx context.Context, userID, monthYear string) (*domain.Vault, error) {
	vault, err := uc.vaultRepo.GetByUserAndMonth(ctx, userID, monthYear)
	if err != nil {
		return nil, err // Domain error from repository.
	}
	return vault, nil
}

// ListVaults retrieves all vault metadata for a user (no BLOB data).
func (uc *VaultUseCase) ListVaults(ctx context.Context, userID string) ([]*domain.Vault, error) {
	vaults, err := uc.vaultRepo.ListByUserID(ctx, userID)
	if err != nil {
		return nil, fmt.Errorf("listing vaults: %w", err)
	}
	return vaults, nil
}
