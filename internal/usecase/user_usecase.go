// Package usecase contains business logic.
// RFC-0001 Section 3: usecase MUST NOT return HTTP types or know about sqlx.
// RFC-0001A §2.1: UseCases MUST NOT call time.Now() or uuid.New() directly.
// RFC-0001A §4.3: usecase MUST inspect and return ONLY standard Domain errors.
package usecase

import (
	"context"
	"regexp"
	"strings"

	"rootinbox/internal/domain"
)

// usernameRegex validates username format: lowercase alphanumeric + underscore, 3-32 chars.
// Amendment RFC-0002-A §7A.3.
var usernameRegex = regexp.MustCompile(`^[a-z0-9_]{3,32}$`)

// UserUseCase implements business logic for User operations.
// RFC-0001 §3: Dependencies are injected, no global singletons.
type UserUseCase struct {
	userRepo    domain.UserRepository
	convRepo    domain.ConversationRepository
	sessionRepo domain.SessionRepository
	vaultRepo   domain.VaultRepository
	subRepo     domain.PushSubscriptionRepository
	txManager     domain.TransactionManager
	clock         domain.Clock
	uuidGen       domain.UUIDGenerator
	logger        domain.Logger
	avatarStorage domain.AvatarStorage
}

// NewUserUseCase creates a new UserUseCase with all required dependencies.
func NewUserUseCase(
	userRepo domain.UserRepository,
	convRepo domain.ConversationRepository,
	sessionRepo domain.SessionRepository,
	vaultRepo domain.VaultRepository,
	subRepo domain.PushSubscriptionRepository,
	txManager domain.TransactionManager,
	clock domain.Clock,
	uuidGen domain.UUIDGenerator,
	logger domain.Logger,
	avatarStorage domain.AvatarStorage,
) *UserUseCase {
	return &UserUseCase{
		userRepo:      userRepo,
		convRepo:      convRepo,
		sessionRepo:   sessionRepo,
		vaultRepo:     vaultRepo,
		subRepo:       subRepo,
		txManager:     txManager,
		clock:         clock,
		uuidGen:       uuidGen,
		logger:        logger,
		avatarStorage: avatarStorage,
	}
}

// CreateUser creates a new user account.
// RFC-0002 §7: A user account can be created using ONLY cryptographic hashes.
// RFC-0001A §2.1: Uses injected Clock and UUIDGenerator for deterministic behavior.
func (uc *UserUseCase) CreateUser(ctx context.Context, identityHash, publicKey string) (*domain.User, error) {
	// Validate inputs.
	if identityHash == "" {
		return nil, domain.NewDomainError(domain.ErrUsr002, "identity hash is required", nil)
	}
	if publicKey == "" {
		return nil, domain.NewDomainError(domain.ErrUsr002, "public key is required", nil)
	}

	// Check for existing user with same identity hash.
	existing, err := uc.userRepo.GetByIdentityHash(ctx, identityHash)
	if err != nil {
		// If error is not "not found", it's a real error.
		var de *domain.DomainError
		if ok := isDomainError(err, &de); !ok || de.Code != domain.ErrUsr001 {
			return nil, domain.NewDomainError(domain.ErrDB002, "checking existing user", err)
		}
	}
	if existing != nil {
		return nil, domain.NewDomainError(domain.ErrUsr002, "user with this identity hash already exists", nil)
	}

	user := &domain.User{
		ID:           uc.uuidGen.New(),
		IdentityHash: identityHash,
		PublicKey:     publicKey,
		Status:        domain.UserStatusActive,
		CreatedAt:     uc.clock.NowUnix(),
	}

	if err := uc.userRepo.Create(ctx, user); err != nil {
		// Check for uniqueness violation (concurrent creation).
		if isUniqueViolation(err) {
			return nil, domain.NewDomainError(domain.ErrUsr002, "user with this identity hash already exists", nil)
		}
		return nil, domain.NewDomainError(domain.ErrDB002, "creating user", err)
	}

	uc.logger.Info("user created", "user_id", user.ID)
	return user, nil
}

// GetUserByID retrieves a user by their canonical UUIDv4.
func (uc *UserUseCase) GetUserByID(ctx context.Context, id string) (*domain.User, error) {
	user, err := uc.userRepo.GetByID(ctx, id)
	if err != nil {
		return nil, err // Domain error from repository.
	}
	return user, nil
}

// GetUserByIdentityHash retrieves a user by their deterministic public-key hash.
// RFC-0002 §7: A user account can be queried using ONLY cryptographic hashes.
func (uc *UserUseCase) GetUserByIdentityHash(ctx context.Context, hash string) (*domain.User, error) {
	user, err := uc.userRepo.GetByIdentityHash(ctx, hash)
	if err != nil {
		return nil, err // Domain error from repository.
	}
	return user, nil
}

// UpdateUsername validates and sets or clears a user's username.
// Amendment RFC-0002-A §7A.5.
func (uc *UserUseCase) UpdateUsername(ctx context.Context, userID string, username *string) (*domain.User, error) {
	// Validate format if setting (not clearing).
	if username != nil {
		normalized := strings.ToLower(strings.TrimSpace(*username))
		if !usernameRegex.MatchString(normalized) {
			return nil, domain.NewDomainError(domain.ErrUsr004,
				"username must be 3-32 characters, lowercase alphanumeric or underscore", nil)
		}
		username = &normalized
	}

	if err := uc.userRepo.UpdateUsername(ctx, userID, username); err != nil {
		if isUniqueViolation(err) {
			return nil, domain.NewDomainError(domain.ErrUsr003, "username is already taken", nil)
		}
		return nil, err
	}

	// Return the updated user.
	user, err := uc.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	uc.logger.Info("username updated", "user_id", userID, "has_username", username != nil)
	return user, nil
}

// UpdateProfile updates display_name, last_name, and bio for a user.
// Fix 1+2: Telegram-style profile. Bio is capped at 200 characters.
func (uc *UserUseCase) UpdateProfile(ctx context.Context, userID string, displayName, lastName, bio *string) (*domain.User, error) {
	var cleanDisplayName *string
	if displayName != nil {
		trimmed := strings.TrimSpace(*displayName)
		if len([]rune(trimmed)) == 0 {
			return nil, domain.NewDomainError(domain.ErrUsr004, "display name cannot be empty", nil)
		}
		if len([]rune(trimmed)) > 64 {
			return nil, domain.NewDomainError(domain.ErrUsr004, "display name must be 64 characters or fewer", nil)
		}
		cleanDisplayName = &trimmed
	}

	var cleanLastName *string
	if lastName != nil {
		trimmed := strings.TrimSpace(*lastName)
		if len([]rune(trimmed)) > 64 {
			return nil, domain.NewDomainError(domain.ErrUsr004, "last name must be 64 characters or fewer", nil)
		}
		cleanLastName = &trimmed
	}

	var cleanBio *string
	if bio != nil {
		trimmed := strings.TrimSpace(*bio)
		if len([]rune(trimmed)) > 200 {
			return nil, domain.NewDomainError(domain.ErrUsr004, "bio must be 200 characters or fewer", nil)
		}
		cleanBio = &trimmed
	}

	if err := uc.userRepo.UpdateProfile(ctx, userID, cleanDisplayName, cleanLastName, cleanBio); err != nil {
		return nil, err
	}

	user, err := uc.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	uc.logger.Info("user profile updated", "user_id", userID)
	return user, nil
}

// GetProfile retrieves a user's public profile by user ID.
func (uc *UserUseCase) GetProfile(ctx context.Context, targetUserID string) (*domain.User, error) {
	user, err := uc.userRepo.GetByID(ctx, targetUserID)
	if err != nil {
		return nil, err
	}
	return user, nil
}

// SearchUsers performs a prefix search on usernames.
// Amendment RFC-0002-A §7A.4.
func (uc *UserUseCase) SearchUsers(ctx context.Context, query string, limit int) ([]*domain.User, error) {
	// Minimum query length.
	if len(query) < 2 {
		return nil, domain.NewDomainError(domain.ErrUsr004, "search query must be at least 2 characters", nil)
	}

	// Cap limit.
	if limit <= 0 || limit > 20 {
		limit = 20
	}

	// Normalize query to lowercase.
	query = strings.ToLower(query)

	return uc.userRepo.SearchByUsername(ctx, query, limit)
}

// DeleteUser executes the Hard Delete Cascade policy.
// RFC-0002 §4.3: Domain Deletion Policy (Hard Delete Cascade).
// Step 1: DELETE FROM users WHERE id = ? (Triggers cascade for participants).
// Step 2: Delete all orphaned conversations where count(participants) == 0.
// Step 3: Hard delete all sessions for the user_id.
// Step 4: Hard delete all vaults for the user_id (RFC-0006).
func (uc *UserUseCase) DeleteUser(ctx context.Context, userID string) error {
	return uc.txManager.WithinTransaction(ctx, func(ctx context.Context) error {
		// Step 3: Delete sessions (before user delete, explicit cleanup).
		if err := uc.sessionRepo.DeleteByUserID(ctx, userID); err != nil {
			return domain.NewDomainError(domain.ErrDB002, "deleting sessions", err)
		}

		// Step 4: Delete vaults (before user delete, explicit cleanup).
		// RFC-0002 §4.3 Step 4: Hard delete all vaults for the user_id.
		if err := uc.vaultRepo.DeleteByUserID(ctx, userID); err != nil {
			return domain.NewDomainError(domain.ErrDB002, "deleting vaults", err)
		}

		// Step 5: Delete push subscriptions (RFC-0009).
		if err := uc.subRepo.DeleteByUserID(ctx, userID); err != nil {
			return domain.NewDomainError(domain.ErrDB002, "deleting push subscriptions", err)
		}

		// Step 1: Delete user (FK cascade deletes participant records).
		if err := uc.userRepo.Delete(ctx, userID); err != nil {
			return err
		}

		// Step 2: Delete orphaned conversations with zero participants.
		orphaned, err := uc.convRepo.DeleteOrphaned(ctx)
		if err != nil {
			return domain.NewDomainError(domain.ErrDB002, "deleting orphaned conversations", err)
		}

		// Clean up avatar from disk if exists.
		if uc.avatarStorage != nil {
			_ = uc.avatarStorage.Delete(userID)
		}

		uc.logger.Info("user deleted",
			"user_id", userID,
			"orphaned_conversations_deleted", orphaned,
		)

		return nil
	})
}

// UploadAvatar validates, saves, and associates an avatar image for a user.
// Bundle 4: Personalization. Max 2MB, strict MIME check (image/jpeg, image/png, image/webp).
func (uc *UserUseCase) UploadAvatar(ctx context.Context, userID string, mimeType string, data []byte) (*domain.User, error) {
	if uc.avatarStorage == nil {
		return nil, domain.NewDomainError(domain.ErrSys001, "avatar storage is not configured", nil)
	}

	normalizedMime := strings.ToLower(strings.TrimSpace(mimeType))
	switch normalizedMime {
	case "image/jpeg", "image/png", "image/webp":
		// valid
	default:
		return nil, domain.NewDomainError(domain.ErrUsr005, "unsupported avatar image type; must be image/jpeg, image/png, or image/webp", nil)
	}

	if len(data) == 0 {
		return nil, domain.NewDomainError(domain.ErrUsr006, "avatar data cannot be empty", nil)
	}
	if len(data) > domain.MaxAvatarSizeBytes {
		return nil, domain.NewDomainError(domain.ErrUsr006, "avatar size exceeds maximum allowed 2MB", nil)
	}

	user, err := uc.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	if err := uc.avatarStorage.Save(userID, data); err != nil {
		return nil, domain.NewDomainError(domain.ErrSys001, "saving avatar to storage", err)
	}

	now := uc.clock.NowUnix()
	if err := uc.userRepo.UpdateAvatar(ctx, userID, &normalizedMime, &now); err != nil {
		return nil, err
	}

	user.AvatarMime = &normalizedMime
	user.AvatarUpdatedAt = &now
	uc.logger.Info("avatar uploaded successfully", "user_id", userID, "mime", normalizedMime, "size", len(data))
	return user, nil
}

// GetAvatar retrieves the avatar image bytes, MIME type, and last updated epoch timestamp for a user.
func (uc *UserUseCase) GetAvatar(ctx context.Context, userID string) ([]byte, string, int64, error) {
	if uc.avatarStorage == nil {
		return nil, "", 0, domain.NewDomainError(domain.ErrSys001, "avatar storage is not configured", nil)
	}

	user, err := uc.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, "", 0, err
	}

	if user.AvatarMime == nil || user.AvatarUpdatedAt == nil {
		return nil, "", 0, domain.NewDomainError(domain.ErrUsr001, "user has no avatar", nil)
	}

	data, err := uc.avatarStorage.Read(userID)
	if err != nil {
		return nil, "", 0, domain.NewDomainError(domain.ErrUsr001, "avatar file not found", err)
	}

	return data, *user.AvatarMime, *user.AvatarUpdatedAt, nil
}

// DeleteAvatar removes the user's avatar image and clears database columns.
func (uc *UserUseCase) DeleteAvatar(ctx context.Context, userID string) (*domain.User, error) {
	if uc.avatarStorage == nil {
		return nil, domain.NewDomainError(domain.ErrSys001, "avatar storage is not configured", nil)
	}

	user, err := uc.userRepo.GetByID(ctx, userID)
	if err != nil {
		return nil, err
	}

	_ = uc.avatarStorage.Delete(userID)

	if err := uc.userRepo.UpdateAvatar(ctx, userID, nil, nil); err != nil {
		return nil, err
	}

	user.AvatarMime = nil
	user.AvatarUpdatedAt = nil
	uc.logger.Info("avatar deleted successfully", "user_id", userID)
	return user, nil
}


// isDomainError checks if an error is a DomainError.
func isDomainError(err error, target **domain.DomainError) bool {
	var de *domain.DomainError
	if ok := isErrorAs(err, &de); ok {
		*target = de
		return true
	}
	return false
}

// isErrorAs is a type-safe errors.As helper.
func isErrorAs(err error, target interface{}) bool {
	// Use a simple type switch instead of errors.As to avoid
	// importing errors package (domain doesn't import it).
	switch e := err.(type) {
	case *domain.DomainError:
		if t, ok := target.(**domain.DomainError); ok {
			*t = e
			return true
		}
	}
	// Check wrapped errors.
	type unwrapper interface {
		Unwrap() error
	}
	if u, ok := err.(unwrapper); ok {
		return isErrorAs(u.Unwrap(), target)
	}
	return false
}

// isUniqueViolation checks if an error indicates a UNIQUE constraint violation.
func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	return strings.Contains(err.Error(), "UNIQUE constraint failed")
}

