package config

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	SecretsFileName    = "secrets.json"
	SecretsFileVersion = 1
)

// PersistedSecrets represents the versioned on-disk secrets structure.
// Note: Today, the at-rest database key is derived from ip_hash_secret and stored
// directly alongside the data directory. E2EE Stage 1b eliminates this dependency.
type PersistedSecrets struct {
	Version          int       `json:"version"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at,omitempty"`
	IPHashSecret     string    `json:"ip_hash_secret"`     // 64 random bytes, hex-encoded (128 hex chars)
	TURNActiveSecret string    `json:"turn_active_secret"` // 32 random bytes, hex-encoded (64 hex chars)
	AdminTokenHash   string    `json:"admin_token_hash"`   // SHA-256 hash of the 256-bit admin key, hex-encoded (64 hex chars)
}

// SecretsLoadResult holds secrets resolved by the store along with bootstrap status.
type SecretsLoadResult struct {
	IPHashSecret         Secret
	TURNActiveSecret     string
	AdminTokenHash       string
	BootstrappedAdminKey string   // Set ONLY when a new admin key was generated on this startup
	Warnings             []string // Non-fatal warnings (e.g., env overrides persisted file)
}

// LoadOrInitializeSecrets loads existing persisted secrets from dataDir/secrets.json
// or generates new ones if no secrets file and no existing database exist.
//
// Precedence & Safety Guards:
//  1. Explicit env variables take priority over file-persisted values.
//  2. If the secrets file is corrupt or unreadable, refuses to start unless RESET_SECRETS=true.
//  3. If the database file exists with size > 0 but secrets.json and IP_HASH_SECRET are absent,
//     REFUSES to start to prevent encrypting or corrupting existing data under a mismatched key.
func LoadOrInitializeSecrets(dataDir string, dbPath string) (*SecretsLoadResult, error) {
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		return nil, fmt.Errorf("failed to create data directory %s: %w", dataDir, err)
	}

	secretsPath := filepath.Join(dataDir, SecretsFileName)
	res := &SecretsLoadResult{}

	// Check if explicit environment variables are set
	envIPHash := getExplicitSecret("IP_HASH_SECRET")
	envTURN := os.Getenv("TURN_ACTIVE_SECRET")
	envAdminActive := os.Getenv("ADMIN_API_KEY_HASH_ACTIVE")
	envAdminHash := os.Getenv("ADMIN_TOKEN_HASH")
	if envAdminHash == "" && envAdminActive != "" {
		envAdminHash = envAdminActive
	}

	resetRequested := os.Getenv("RESET_SECRETS") == "true" || os.Getenv("RESET_SECRETS") == "1"

	// Check if secrets file exists
	fileInfo, statErr := os.Stat(secretsPath)
	fileExists := statErr == nil && !fileInfo.IsDir()

	// Guard: Corrupt or unreadable secrets file
	var persisted PersistedSecrets
	if fileExists && !resetRequested {
		data, err := os.ReadFile(secretsPath)
		if err != nil {
			return nil, fmt.Errorf("fatal: secrets file exists at %s but cannot be read: %w (set RESET_SECRETS=true to force reset)", secretsPath, err)
		}
		if err := json.Unmarshal(data, &persisted); err != nil || persisted.Version < 1 || persisted.IPHashSecret == "" {
			return nil, fmt.Errorf("fatal: secrets file at %s is corrupt or invalid JSON: %w (set RESET_SECRETS=true to force reset)", secretsPath, err)
		}
	}

	// Guard: Existing database without secrets file or explicit IP_HASH_SECRET
	if !fileExists && envIPHash.IsZero() && !resetRequested {
		targetDB := dbPath
		if _, err := os.Stat(targetDB); err != nil && !filepath.IsAbs(targetDB) {
			candidate := filepath.Join(dataDir, filepath.Base(dbPath))
			if _, cErr := os.Stat(candidate); cErr == nil {
				targetDB = candidate
			}
		}

		if dbInfo, err := os.Stat(targetDB); err == nil && dbInfo.Size() > 0 {
			return nil, fmt.Errorf("fatal: existing database found at %s (%d bytes) but secrets file (%s) and IP_HASH_SECRET are missing. Refusing to boot to prevent unreadable data or corruption", targetDB, dbInfo.Size(), secretsPath)
		}
	}

	// If file does not exist or reset was requested, generate new secrets
	if !fileExists || resetRequested {
		newPersisted, rawAdminKey, err := generateFreshSecrets()
		if err != nil {
			return nil, fmt.Errorf("failed to generate random secrets: %w", err)
		}

		if err := saveSecretsAtomic(secretsPath, newPersisted); err != nil {
			return nil, fmt.Errorf("failed to persist secrets to %s: %w", secretsPath, err)
		}

		persisted = *newPersisted
		res.BootstrappedAdminKey = rawAdminKey
	}

	// 1. IP_HASH_SECRET resolution (explicit env > persisted)
	if !envIPHash.IsZero() {
		res.IPHashSecret = envIPHash
		if fileExists && persisted.IPHashSecret != "" {
			envBytes := envIPHash.Reveal()
			persistedBytes, _ := hex.DecodeString(persisted.IPHashSecret)
			if subtle.ConstantTimeCompare(envBytes, persistedBytes) != 1 {
				res.Warnings = append(res.Warnings, "WARNING: explicit IP_HASH_SECRET environment variable overrides persisted secret")
			}
		}
	} else {
		dec, err := hex.DecodeString(persisted.IPHashSecret)
		if err != nil || len(dec) < 32 {
			return nil, fmt.Errorf("persisted IP_HASH_SECRET in %s is invalid hex: %w", secretsPath, err)
		}
		res.IPHashSecret = NewSecret(dec)
	}

	// 2. TURN_ACTIVE_SECRET resolution (explicit env > persisted)
	if envTURN != "" {
		res.TURNActiveSecret = envTURN
		if fileExists && persisted.TURNActiveSecret != "" && envTURN != persisted.TURNActiveSecret {
			res.Warnings = append(res.Warnings, "WARNING: explicit TURN_ACTIVE_SECRET environment variable overrides persisted secret")
		}
	} else {
		res.TURNActiveSecret = persisted.TURNActiveSecret
	}

	// 3. ADMIN_TOKEN_HASH resolution (explicit env > persisted)
	if envAdminHash != "" {
		res.AdminTokenHash = envAdminHash
		if fileExists && persisted.AdminTokenHash != "" && envAdminHash != persisted.AdminTokenHash {
			res.Warnings = append(res.Warnings, "WARNING: explicit ADMIN_TOKEN_HASH environment variable overrides persisted hash")
		}
	} else {
		res.AdminTokenHash = persisted.AdminTokenHash
	}

	return res, nil
}

// ResetAdminKey generates a new 256-bit admin key, updates secrets.json,
// and returns the raw key to be printed once.
func ResetAdminKey(dataDir string) (string, error) {
	secretsPath := filepath.Join(dataDir, SecretsFileName)

	var persisted PersistedSecrets
	data, err := os.ReadFile(secretsPath)
	if err == nil {
		_ = json.Unmarshal(data, &persisted)
	}

	// Generate 32 bytes random key (256-bit)
	rawKeyBytes := make([]byte, 32)
	if _, err := rand.Read(rawKeyBytes); err != nil {
		return "", err
	}
	rawKeyHex := hex.EncodeToString(rawKeyBytes)

	hashBytes := sha256.Sum256([]byte(rawKeyHex))
	hashHex := hex.EncodeToString(hashBytes[:])

	persisted.Version = SecretsFileVersion
	persisted.AdminTokenHash = hashHex
	persisted.UpdatedAt = time.Now().UTC()

	// If missing other secrets, generate them as well to ensure a valid file
	if persisted.IPHashSecret == "" {
		ipBytes := make([]byte, 64)
		_, _ = rand.Read(ipBytes)
		persisted.IPHashSecret = hex.EncodeToString(ipBytes)
	}
	if persisted.TURNActiveSecret == "" {
		turnBytes := make([]byte, 32)
		_, _ = rand.Read(turnBytes)
		persisted.TURNActiveSecret = hex.EncodeToString(turnBytes)
	}
	if persisted.CreatedAt.IsZero() {
		persisted.CreatedAt = time.Now().UTC()
	}

	if err := saveSecretsAtomic(secretsPath, &persisted); err != nil {
		return "", fmt.Errorf("failed to update %s: %w", secretsPath, err)
	}

	return rawKeyHex, nil
}

func generateFreshSecrets() (*PersistedSecrets, string, error) {
	// 64 random bytes for IP_HASH_SECRET (128 hex chars)
	ipBytes := make([]byte, 64)
	if _, err := rand.Read(ipBytes); err != nil {
		return nil, "", err
	}

	// 32 random bytes for TURN_ACTIVE_SECRET (64 hex chars)
	turnBytes := make([]byte, 32)
	if _, err := rand.Read(turnBytes); err != nil {
		return nil, "", err
	}

	// 32 random bytes for admin key (64 hex chars)
	rawAdminKeyBytes := make([]byte, 32)
	if _, err := rand.Read(rawAdminKeyBytes); err != nil {
		return nil, "", err
	}
	rawAdminKeyHex := hex.EncodeToString(rawAdminKeyBytes)

	// Hash the admin key with SHA-256 for persistent storage
	adminHashBytes := sha256.Sum256([]byte(rawAdminKeyHex))
	adminHashHex := hex.EncodeToString(adminHashBytes[:])

	now := time.Now().UTC()
	sec := &PersistedSecrets{
		Version:          SecretsFileVersion,
		CreatedAt:        now,
		UpdatedAt:        now,
		IPHashSecret:     hex.EncodeToString(ipBytes),
		TURNActiveSecret: hex.EncodeToString(turnBytes),
		AdminTokenHash:   adminHashHex,
	}

	return sec, rawAdminKeyHex, nil
}

// saveSecretsAtomic writes the secrets JSON to a temporary file with 0600 permissions
// and atomically renames it to target.
// Note on Windows: 0600 mode bits are mapped to standard read/write attributes.
func saveSecretsAtomic(targetPath string, s *PersistedSecrets) error {
	dir := filepath.Dir(targetPath)
	tmpFile, err := os.CreateTemp(dir, "secrets_tmp_*")
	if err != nil {
		return err
	}
	tmpName := tmpFile.Name()
	defer func() {
		_ = tmpFile.Close()
		_ = os.Remove(tmpName)
	}()

	// Enforce 0600 permissions
	_ = tmpFile.Chmod(0600)

	encoder := json.NewEncoder(tmpFile)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(s); err != nil {
		return err
	}
	if err := tmpFile.Sync(); err != nil {
		return err
	}
	if err := tmpFile.Close(); err != nil {
		return err
	}

	// On Windows, target must not be open and may require overwrite
	if err := os.Rename(tmpName, targetPath); err != nil {
		// Fallback for Windows if target exists
		_ = os.Remove(targetPath)
		return os.Rename(tmpName, targetPath)
	}

	// Best-effort chmod target file
	_ = os.Chmod(targetPath, 0600)
	return nil
}

func getExplicitSecret(name string) Secret {
	sec, err := loadSecret(name)
	if err == nil && !sec.IsZero() {
		return sec
	}
	return Secret{}
}

// FormatStartupSummary formats the one startup summary string for display and testing.
// Invariants: secrets masked, comprehensive status for platform, data dir, origin, ports, TURN/push with reasons, admin key state, and version/commit.
func FormatStartupSummary(cfg *Config) string {
	storageDesc := "Persistent Storage"
	if !cfg.StoragePersistent {
		storageDesc = "Ephemeral Storage (WARNING: Data lost on redeploy)"
	}

	originDesc := cfg.Security.AppOrigin
	if cfg.WaitingForDomain {
		originDesc = "Waiting for Public Domain (read-only safe mode)"
	}

	// Ports breakdown
	serverProto := "HTTP"
	if cfg.TLS.Mode == "selfsigned" || cfg.TLS.Mode == "files" {
		serverProto = "HTTPS"
	}
	portsDesc := fmt.Sprintf("%s Listen: %d", serverProto, cfg.Server.Port)
	if cfg.TLS.Mode == "selfsigned" {
		portsDesc += fmt.Sprintf(", Onboarding HTTP: %d", cfg.TLS.OnboardingPort)
	}
	if cfg.TURN.Enabled {
		portsDesc += fmt.Sprintf(", TURN UDP: %s", cfg.TURN.ListenAddr)
	}

	turnDesc := "Disabled (Zero-config default / no TURN secret)"
	if cfg.TURN.Enabled {
		turnDesc = fmt.Sprintf("Enabled (Listen: %s)", cfg.TURN.ListenAddr)
	} else if cfg.Platform == PlatformRailway {
		turnDesc = "Disabled (Railway does not support UDP ingress)"
	}

	pushDesc := "Disabled (Zero-config default / no VAPID keys)"
	if cfg.Push.Enabled {
		pushDesc = "Enabled"
	} else if cfg.Platform == PlatformRailway {
		pushDesc = "Disabled (Zero-config default on Railway)"
	}

	adminDesc := "Disabled"
	if cfg.Security.AdminEnabled {
		if cfg.BootstrappedAdminKey != "" {
			adminDesc = "Active (One-time generated on this boot)"
		} else if os.Getenv("ADMIN_API_KEY_HASH_ACTIVE") != "" {
			adminDesc = "Active (Configured via environment variable)"
		} else {
			adminDesc = "Active (Loaded from persisted secrets.json)"
		}
	}

	var sb strings.Builder
	sb.WriteString("================================================================================\n")
	sb.WriteString(" ROOTINBOX STARTUP CONFIGURATION\n")
	sb.WriteString("================================================================================\n")
	sb.WriteString(fmt.Sprintf(" Platform:       %s\n", cfg.Platform))
	sb.WriteString(fmt.Sprintf(" Data Dir:       %s (%s)\n", cfg.DataDir, storageDesc))
	sb.WriteString(fmt.Sprintf(" Database:       %s\n", cfg.Database.Path))
	sb.WriteString(fmt.Sprintf(" Media Storage:  %s\n", cfg.Media.BasePath))
	sb.WriteString(fmt.Sprintf(" HTTP Listen:    %s\n", cfg.Server.Addr()))
	sb.WriteString(fmt.Sprintf(" App Origin:     %s\n", originDesc))
	sb.WriteString(fmt.Sprintf(" TLS Mode:       %s\n", cfg.TLS.Mode))
	sb.WriteString(fmt.Sprintf(" Ports:          %s\n", portsDesc))
	sb.WriteString(fmt.Sprintf(" Web Push:       %s\n", pushDesc))
	sb.WriteString(fmt.Sprintf(" TURN Relay:     %s\n", turnDesc))
	sb.WriteString(fmt.Sprintf(" Admin Access:   %s\n", adminDesc))
	sb.WriteString(fmt.Sprintf(" Version/Commit: %s (%s)\n", cfg.App.Version, cfg.App.BuildHash))
	sb.WriteString("================================================================================")
	return sb.String()
}

// LogStartupSummary outputs a unified, secure startup summary to logs.
func LogStartupSummary(logger *slog.Logger, cfg *Config) {
	fmt.Println(FormatStartupSummary(cfg))

	// Log warnings if any
	for _, w := range cfg.Warnings {
		fmt.Printf(" [!] %s\n", w)
		if logger != nil {
			logger.Warn(w)
		}
	}

	// Print one-time bootstrapped admin key if generated on this boot
	if cfg.BootstrappedAdminKey != "" {
		fmt.Println("")
		fmt.Println("================================================================================")
		fmt.Println(" ROOTINBOX ADMIN API KEY BOOTSTRAP (PRINTED EXACTLY ONCE)")
		fmt.Printf(" Admin API Key:  %s\n", cfg.BootstrappedAdminKey)
		fmt.Println(" Store this key securely. It will never be displayed in logs again.")
		fmt.Println(" Use 'rootinbox admin reset-key' to rotate or regenerate.")
		fmt.Println("================================================================================")
		fmt.Println("")
	}
}
