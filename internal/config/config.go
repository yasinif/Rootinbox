// Package config handles configuration loading, validation, and immutability.
// RFC-0001 Section 3: Configuration is loaded once at startup and is IMMUTABLE during runtime.
// RFC-0001A Section 5.1: Load -> Default -> Validate -> Freeze Contract.
package config

import (
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"

	"rootinbox/internal/domain"
)

// ConfigSchemaVersion tracks the configuration schema version.
// RFC-0001A Section 6: Logger metadata MUST include ConfigSchemaVersion at startup.
const ConfigSchemaVersion = "1.0.0"

// BuiltinTLSSupported indicates the single-binary has built-in TLS generation and management (tlsman).
const BuiltinTLSSupported = true

// HasBuiltinTLS reports whether the binary supports built-in TLS.
func HasBuiltinTLS() bool {
	return BuiltinTLSSupported
}

// Config holds all application configuration. Immutable after Load+Validate.
// RFC-0001A Section 5.1: No setters, no mutable pointers after initialization.
type Config struct {
	Server    ServerConfig
	Database  DatabaseConfig
	App       AppConfig
	Log       LogConfig
	Media     MediaConfig
	TURN      TURNConfig
	Push      PushConfig
	Security  SecurityConfig
	Admin     AdminConfig
	RateLimit RateLimitConfig
	Quota     QuotaConfig
	TLS       TLSConfig

	// Zero-Config Deployment Fields
	Platform             string   // Railway, Docker, or Bare Host
	DataDir              string   // Resolved data directory (e.g. /data or ./data)
	StoragePersistent    bool     // True if volume is persistent, false if ephemeral
	WaitingForDomain     bool     // True if in safe waiting-for-domain mode
	BootstrappedAdminKey string   // Hex admin API key if bootstrapped on this boot
	Warnings             []string // Non-fatal configuration warnings
	loadErr              error    // Deferred error from secrets loading or safety guards
}

// ServerConfig holds HTTP server settings.
// RFC-0001A Section 5.4: Explicitly define ReadTimeout, WriteTimeout, IdleTimeout, MaxHeaderBytes.
type ServerConfig struct {
	Host           string
	Port           int
	ReadTimeout    time.Duration
	WriteTimeout   time.Duration
	IdleTimeout    time.Duration
	MaxHeaderBytes int
}

// DatabaseConfig holds SQLite database settings.
type DatabaseConfig struct {
	Path           string
	ReaderMaxConns int
}

// AppConfig holds build-time application metadata.
// RFC-0001A Section 6: Logger MUST include these at startup.
type AppConfig struct {
	Version             string
	BuildHash           string
	BuildTime           string
	GoVersion           string
	ConfigSchemaVersion string
}

// LogConfig holds logging configuration.
type LogConfig struct {
	Level string
}

// MediaConfig holds media storage settings.
// RFC-0007 §8.1: Strict Local Storage.
type MediaConfig struct {
	BasePath          string        // Local filesystem path for media storage
	DefaultQuotaBytes int64         // Default per-user quota in bytes
	GCInterval        time.Duration // How often the GC worker runs
}

// TURNConfig holds STUN/TURN server settings.
// RFC-0008 §5.1-§5.2: Self-hosted STUN/TURN infrastructure.
type TURNConfig struct {
	Enabled        bool          // Whether the embedded TURN server is active
	ListenAddr     string        // UDP listen address for STUN/TURN
	Realm          string        // TURN realm
	ActiveSecret   string        // Immutable keyring active secret (≥32 bytes)
	PreviousSecret string        // Immutable keyring previous secret (≥32 bytes, optional during first deploy)
	CredentialTTL  time.Duration // TURN credential lifetime
	RelayIP        net.IP        // Relay IP returned to clients (TURN_RELAY_IP or derived from PUBLIC_HOST)
	MinPort        uint16        // Minimum relay port (TURN_MIN_PORT)
	MaxPort        uint16        // Maximum relay port (TURN_MAX_PORT)
}

// PushConfig holds RFC-0009 Web Push Notification settings.
type PushConfig struct {
	Enabled            bool          // PUSH_ENABLED,                  default true
	VAPIDEncryptionKey [32]byte      // PUSH_VAPID_ENCRYPTION_KEY (Base64URL, REQUIRED when Enabled)
	vapidKeyErr        error         // Stores decode error from loadFromEnv for Validate to surface
	VAPIDSubject       string        // PUSH_VAPID_SUBJECT,            REQUIRED when Enabled
	DispatchQueueSize  int           // PUSH_DISPATCH_QUEUE_SIZE,      default 1024
	DispatchTimeout    time.Duration // PUSH_DISPATCH_TIMEOUT_SECONDS, default 10
	DebounceWindow     time.Duration // PUSH_DEBOUNCE_WINDOW_SECONDS,  default 60
	PendingRingCap     int           // PUSH_PENDING_RING_CAPACITY,    default 1024
}

type SecurityConfig struct {
	AppOrigin          string
	IPHashSecret       Secret
	TrustedProxiesCIDR []*net.IPNet
	InsecureDevMode    bool
	AuditRetentionDays int
	RateLimitStateMax  int
	AdminEnabled       bool
}

type AdminConfig struct {
	APIKeyHashActive      Secret
	APIKeyHashPrevious    Secret
	PreviousExpiresAtUnix int64
	ConfirmationTTL       time.Duration
	MetricsCacheInterval  time.Duration
	AdminTokenHash        string
}

type RateLimitConfig struct {
	RequestsPerSecond float64
	Burst             int
}

type QuotaConfig struct {
	MaxMessagesPerHour int
}

// TLSConfig holds built-in TLS mode settings (Stage 2).
type TLSConfig struct {
	Mode           string // TLS_MODE: "off", "selfsigned", "files". Default: "off"
	PublicHost     string // PUBLIC_HOST: IP or domain. Required when Mode is "selfsigned"
	DataDir        string // TLS_DATA_DIR: directory to store CA and server certificates. Default: "/data/tls"
	OnboardingPort int    // TLS_ONBOARDING_PORT: HTTP port for /ca.crt and guide. Default: 8080
	CertFile       string // TLS_CERT_FILE: for Mode == "files"
	KeyFile        string // TLS_KEY_FILE: for Mode == "files"
	RegenerateCA   bool   // TLS_REGENERATE_CA: allow regenerating CA if corrupted/unreadable. Default: false
}

// OnboardingAddr returns the plain-HTTP listen address for certificate onboarding.
func (t TLSConfig) OnboardingAddr() string {
	return fmt.Sprintf("0.0.0.0:%d", t.OnboardingPort)
}

// Addr returns the server listen address as host:port.
func (s ServerConfig) Addr() string {
	return fmt.Sprintf("%s:%d", s.Host, s.Port)
}

// Load reads configuration from environment variables with sensible defaults.
// RFC-0001 Section 6 Step 1: Load configuration.
// Build-time variables are injected from the caller (set via ldflags in main).
func Load(version, buildHash, buildTime string) *Config {
	cfg := &Config{}

	// Apply defaults
	applyDefaults(cfg)

	// Override from environment
	loadFromEnv(cfg)

	// Build info (from ldflags, not overridable by env)
	cfg.App.Version = version
	cfg.App.BuildHash = buildHash
	cfg.App.BuildTime = buildTime
	cfg.App.GoVersion = runtime.Version()
	cfg.App.ConfigSchemaVersion = ConfigSchemaVersion

	return cfg
}

// Validate performs strict validation of the loaded configuration.
// RFC-0001 Section 6 Step 2: Validate configuration.
// RFC-0001A Section 5.2: Any startup failure MUST abort (Fail Fast).
func Validate(cfg *Config) error {
	if cfg.loadErr != nil {
		return fmt.Errorf("[%s] %w", "CFG_001", cfg.loadErr)
	}
	if cfg.Server.Port < 1 || cfg.Server.Port > 65535 {
		return fmt.Errorf("[%s] SERVER_PORT must be between 1 and 65535, got %d", "CFG_001", cfg.Server.Port)
	}
	if cfg.Database.Path == "" {
		return fmt.Errorf("[%s] DB_PATH must not be empty", "CFG_001")
	}
	// RFC-0001 Section 5: Reader MaxOpenConns 4 to 8.
	if cfg.Database.ReaderMaxConns < 4 || cfg.Database.ReaderMaxConns > 8 {
		return fmt.Errorf("[%s] DB_READER_MAX_CONNS must be between 4 and 8, got %d", "CFG_001", cfg.Database.ReaderMaxConns)
	}
	if cfg.Server.ReadTimeout <= 0 {
		return fmt.Errorf("[%s] ReadTimeout must be positive", "CFG_001")
	}
	if cfg.Server.WriteTimeout <= 0 {
		return fmt.Errorf("[%s] WriteTimeout must be positive", "CFG_001")
	}
	if cfg.Server.IdleTimeout <= 0 {
		return fmt.Errorf("[%s] IdleTimeout must be positive", "CFG_001")
	}
	if cfg.Server.MaxHeaderBytes <= 0 {
		return fmt.Errorf("[%s] MaxHeaderBytes must be positive", "CFG_001")
	}
	if cfg.App.Version == "" {
		return fmt.Errorf("[%s] application version must not be empty", "CFG_001")
	}
	// RFC-0008 §5.2: TURN secrets MUST be ≥32 bytes when TURN is enabled.
	// No random fallback — fail fast.
	if cfg.TURN.Enabled {
		if len(cfg.TURN.ActiveSecret) < 32 {
			return fmt.Errorf("[%s] TURN_ACTIVE_SECRET must be at least 32 bytes when TURN is enabled", "CFG_001")
		}
		if strings.Contains(cfg.TURN.ActiveSecret, "CHANGE_THIS") {
			return fmt.Errorf("[%s] TURN_ACTIVE_SECRET contains prohibited placeholder 'CHANGE_THIS'; a secure random 32+ byte secret must be generated", "CFG_001")
		}
		if cfg.TURN.PreviousSecret != "" && strings.Contains(cfg.TURN.PreviousSecret, "CHANGE_THIS") {
			return fmt.Errorf("[%s] TURN_PREVIOUS_SECRET contains prohibited placeholder 'CHANGE_THIS'", "CFG_001")
		}
		if cfg.TURN.RelayIP == nil {
			if cfg.Security.InsecureDevMode {
				cfg.TURN.RelayIP = net.ParseIP("127.0.0.1")
			} else {
				return fmt.Errorf("[%s] TURN_RELAY_IP (or an IP-based PUBLIC_HOST) is required when TURN is enabled", "CFG_001")
			}
		}
		if cfg.TURN.RelayIP.IsUnspecified() {
			return fmt.Errorf("[%s] TURN_RELAY_IP cannot be %s; a routable relay IP is required", "CFG_001", cfg.TURN.RelayIP.String())
		}
		if (cfg.TURN.MinPort == 0 && cfg.TURN.MaxPort != 0) || (cfg.TURN.MinPort != 0 && cfg.TURN.MaxPort == 0) {
			return fmt.Errorf("[%s] both TURN_MIN_PORT and TURN_MAX_PORT must be specified if port range is configured", "CFG_001")
		}
		if cfg.TURN.MinPort != 0 {
			if cfg.TURN.MinPort < 1024 {
				return fmt.Errorf("[%s] TURN_MIN_PORT must be >= 1024, got %d", "CFG_001", cfg.TURN.MinPort)
			}
			if cfg.TURN.MinPort > cfg.TURN.MaxPort {
				return fmt.Errorf("[%s] TURN_MIN_PORT (%d) cannot be greater than TURN_MAX_PORT (%d)", "CFG_001", cfg.TURN.MinPort, cfg.TURN.MaxPort)
			}
		}
	}
	if cfg.Push.Enabled {
		if cfg.Push.vapidKeyErr != nil {
			return fmt.Errorf("[%s] PUSH_VAPID_ENCRYPTION_KEY decode error: %w", "CFG_001", cfg.Push.vapidKeyErr)
		}
		if cfg.Push.VAPIDSubject == "" {
			return fmt.Errorf("[%s] PUSH_VAPID_SUBJECT is required when Push is enabled", "CFG_001")
		}
		if !strings.HasPrefix(cfg.Push.VAPIDSubject, "mailto:") && !strings.HasPrefix(cfg.Push.VAPIDSubject, "https://") {
			return fmt.Errorf("[%s] PUSH_VAPID_SUBJECT must start with mailto: or https://", "CFG_001")
		}
	}
	if cfg.Push.DispatchQueueSize < 1 {
		return fmt.Errorf("[%s] PUSH_DISPATCH_QUEUE_SIZE must be >= 1", "CFG_001")
	}
	if cfg.Push.DispatchTimeout <= 0 {
		return fmt.Errorf("[%s] PUSH_DISPATCH_TIMEOUT_SECONDS must be positive", "CFG_001")
	}
	if cfg.Push.PendingRingCap < 1 {
		return fmt.Errorf("[%s] PUSH_PENDING_RING_CAPACITY must be >= 1", "CFG_001")
	}
	if cfg.Push.DebounceWindow <= 0 || cfg.Push.DebounceWindow > 60*time.Second {
		return fmt.Errorf("[%s] PUSH_DEBOUNCE_WINDOW_SECONDS must be positive and <= 60s", "CFG_001")
	}
	if domain.CallTriggerTTLSeconds >= domain.RingTimeoutSeconds {
		return fmt.Errorf("[%s] CallTriggerTTLSeconds (%d) must be < RingTimeoutSeconds (%d)", "CFG_001", domain.CallTriggerTTLSeconds, domain.RingTimeoutSeconds)
	}

	if cfg.Security.AppOrigin == "" {
		return fmt.Errorf("[%s] APP_ORIGIN must not be empty", "CFG_001")
	}
	u, err := url.Parse(cfg.Security.AppOrigin)
	if err != nil || u.Scheme == "" || u.Host == "" || strings.HasSuffix(cfg.Security.AppOrigin, "/") {
		return fmt.Errorf("[%s] APP_ORIGIN must be a valid URL with scheme and host, without trailing slash", "CFG_001")
	}
	if !cfg.Security.InsecureDevMode && !cfg.WaitingForDomain && u.Scheme != "https" {
		return fmt.Errorf("[%s] APP_ORIGIN must be https when not in dev mode", "CFG_001")
	}
	if cfg.Security.IPHashSecret.Len() < 32 {
		return fmt.Errorf("[%s] IP_HASH_SECRET must be at least 32 bytes", "CFG_001")
	}
	if strings.Contains(string(cfg.Security.IPHashSecret.Reveal()), "CHANGE_THIS") {
		return fmt.Errorf("[%s] IP_HASH_SECRET contains prohibited placeholder 'CHANGE_THIS'; a secure random 32+ byte secret must be generated", "CFG_001")
	}
	switch cfg.TLS.Mode {
	case "off", "":
		cfg.TLS.Mode = "off"
		if !cfg.Security.InsecureDevMode && len(cfg.Security.TrustedProxiesCIDR) == 0 {
			return fmt.Errorf("[%s] TRUSTED_PROXIES_CIDR must not be empty unless INSECURE_DEV_MODE is true", "CFG_001")
		}
	case "selfsigned":
		if cfg.TLS.PublicHost == "" {
			return fmt.Errorf("[%s] PUBLIC_HOST is required when TLS_MODE is selfsigned", "CFG_001")
		}
		if cfg.TLS.DataDir == "" {
			return fmt.Errorf("[%s] TLS_DATA_DIR must not be empty", "CFG_001")
		}
		if cfg.TLS.OnboardingPort < 1 || cfg.TLS.OnboardingPort > 65535 {
			return fmt.Errorf("[%s] TLS_ONBOARDING_PORT must be between 1 and 65535, got %d", "CFG_001", cfg.TLS.OnboardingPort)
		}
		if cfg.TLS.OnboardingPort == cfg.Server.Port {
			return fmt.Errorf("[%s] TLS_ONBOARDING_PORT cannot be the same as SERVER_PORT (%d)", "CFG_001", cfg.Server.Port)
		}
	case "files":
		if cfg.TLS.CertFile == "" || cfg.TLS.KeyFile == "" {
			return fmt.Errorf("[%s] TLS_CERT_FILE and TLS_KEY_FILE are required when TLS_MODE is files", "CFG_001")
		}
	default:
		return fmt.Errorf("[%s] invalid TLS_MODE: %s (must be off, selfsigned, or files)", "CFG_001", cfg.TLS.Mode)
	}
	for _, cidr := range cfg.Security.TrustedProxiesCIDR {
		if cidr.String() == "0.0.0.0/0" || cidr.String() == "::/0" {
			return fmt.Errorf("[%s] TRUSTED_PROXIES_CIDR cannot be 0.0.0.0/0 or ::/0", "CFG_001")
		}
	}
	if cfg.Security.InsecureDevMode {
		if cfg.Server.Host != "127.0.0.1" && cfg.Server.Host != "::1" && cfg.Server.Host != "localhost" && cfg.Server.Host != "0.0.0.0" {
			return fmt.Errorf("[%s] Server.Host must be local or 0.0.0.0 when INSECURE_DEV_MODE is true", "CFG_001")
		}
	}
	if cfg.Security.AuditRetentionDays < 1 {
		return fmt.Errorf("[%s] SECURITY_EVENTS_RETENTION_DAYS must be >= 1", "CFG_001")
	}
	if cfg.Security.RateLimitStateMax < 1000 {
		return fmt.Errorf("[%s] RateLimitStateMax must be >= 1000", "CFG_001")
	}

	// Admin config
	if cfg.Security.AdminEnabled {
		if cfg.Admin.APIKeyHashActive.Len() != 32 {
			return fmt.Errorf("[%s] ADMIN_API_KEY_HASH_ACTIVE must be exactly 32 bytes", "CFG_001")
		}
		if strings.Contains(string(cfg.Admin.APIKeyHashActive.Reveal()), "CHANGE_THIS") {
			return fmt.Errorf("[%s] ADMIN_API_KEY_HASH_ACTIVE contains prohibited placeholder 'CHANGE_THIS'", "CFG_001")
		}
		if !cfg.Admin.APIKeyHashPrevious.IsZero() {
			if cfg.Admin.PreviousExpiresAtUnix <= 0 {
				return fmt.Errorf("[%s] ADMIN_PREVIOUS_KEY_EXPIRES_AT must be set when previous key is used", "CFG_001")
			}
			now := time.Now().Unix()
			if cfg.Admin.PreviousExpiresAtUnix > now+86400 {
				return fmt.Errorf("[%s] ADMIN_PREVIOUS_KEY_EXPIRES_AT cannot be more than 24 hours in the future", "CFG_001")
			}
		}
	}

	// Pairwise secret checks
	secrets := [][]byte{
		cfg.Security.IPHashSecret.Reveal(),
	}
	if cfg.Push.Enabled {
		secrets = append(secrets, cfg.Push.VAPIDEncryptionKey[:])
	}
	if cfg.TURN.Enabled {
		secrets = append(secrets, []byte(cfg.TURN.ActiveSecret))
		if cfg.TURN.PreviousSecret != "" {
			secrets = append(secrets, []byte(cfg.TURN.PreviousSecret))
		}
	}
	if cfg.Security.AdminEnabled {
		secrets = append(secrets, cfg.Admin.APIKeyHashActive.Reveal())
		if !cfg.Admin.APIKeyHashPrevious.IsZero() {
			secrets = append(secrets, cfg.Admin.APIKeyHashPrevious.Reveal())
		}
	}

	for i := 0; i < len(secrets); i++ {
		for j := i + 1; j < len(secrets); j++ {
			if len(secrets[i]) > 0 && len(secrets[i]) == len(secrets[j]) {
				if subtle.ConstantTimeCompare(secrets[i], secrets[j]) == 1 {
					return fmt.Errorf("[%s] Secrets must be pairwise distinct", "CFG_001")
				}
			}
		}
	}

	return nil
}

func applyDefaults(cfg *Config) {
	cfg.Platform = DetectPlatform()
	cfg.DataDir, cfg.StoragePersistent = DetectDataDir(cfg.Platform)
	if !cfg.StoragePersistent && cfg.Platform == PlatformRailway {
		cfg.Warnings = append(cfg.Warnings, "WARNING: Ephemeral storage detected! Data will be lost on redeploy. Attach a persistent volume at /data.")
	}

	cfg.Server.Host = "0.0.0.0"
	cfg.Server.Port = 8080
	cfg.Server.ReadTimeout = 15 * time.Second
	cfg.Server.WriteTimeout = 15 * time.Second
	cfg.Server.IdleTimeout = 60 * time.Second
	cfg.Server.MaxHeaderBytes = 1 << 20 // 1 MB

	if cfg.Platform == PlatformRailway {
		cfg.Database.Path = filepath.Join(cfg.DataDir, "rootinbox.db")
		cfg.Media.BasePath = filepath.Join(cfg.DataDir, "media")
	} else {
		cfg.Database.Path = "rootinbox.db"
		cfg.Media.BasePath = "./data/media"
	}
	cfg.Database.ReaderMaxConns = 4
	cfg.Media.DefaultQuotaBytes = 1_073_741_824 // 1 GB
	cfg.Media.GCInterval = 15 * time.Minute

	// RFC-0008 TURN defaults.
	cfg.TURN.Enabled = false
	cfg.TURN.ListenAddr = "0.0.0.0:3478"
	cfg.TURN.Realm = "rootinbox"
	cfg.TURN.CredentialTTL = 24 * time.Hour

	// RFC-0009 Push defaults.
	// In zero-config/Railway, default to false. Can be enabled explicitly via PUSH_ENABLED=true.
	if cfg.Platform == PlatformRailway {
		cfg.Push.Enabled = false
	} else {
		// On non-Railway platforms, default Push to false unless explicitly configured or VAPID key is provided
		if os.Getenv("PUSH_ENABLED") == "" && os.Getenv("PUSH_VAPID_ENCRYPTION_KEY") == "" {
			cfg.Push.Enabled = false
		} else {
			cfg.Push.Enabled = true
		}
	}
	cfg.Push.DispatchQueueSize = 1024
	cfg.Push.DispatchTimeout = 10 * time.Second
	cfg.Push.DebounceWindow = 60 * time.Second
	cfg.Push.PendingRingCap = 1024

	// Security & Admin defaults.
	cfg.Security.AuditRetentionDays = 90
	cfg.Security.RateLimitStateMax = 100_000
	cfg.Security.InsecureDevMode = false
	cfg.Security.AdminEnabled = false
	cfg.Admin.ConfirmationTTL = 120 * time.Second
	cfg.Admin.MetricsCacheInterval = 300 * time.Second

	// Default Railway Proxy CIDRs ONLY in Railway mode
	if cfg.Platform == PlatformRailway {
		cfg.Security.TrustedProxiesCIDR = DefaultRailwayProxyCIDRs()
	}

	cfg.RateLimit.RequestsPerSecond = 5.0
	cfg.RateLimit.Burst = 20

	cfg.Quota.MaxMessagesPerHour = 1000

	// Stage 2 TLS defaults
	cfg.TLS.Mode = "off"
	cfg.TLS.DataDir = filepath.Join(cfg.DataDir, "tls")
	cfg.TLS.OnboardingPort = 8080
}

func loadFromEnv(cfg *Config) {
	if v := os.Getenv("SERVER_HOST"); v != "" {
		cfg.Server.Host = v
	}
	if v := os.Getenv("PORT"); v != "" {
		if port, err := strconv.Atoi(v); err == nil {
			cfg.Server.Port = port
		}
	}
	if v := os.Getenv("SERVER_PORT"); v != "" {
		if port, err := strconv.Atoi(v); err == nil {
			cfg.Server.Port = port
		}
	}
	if v := os.Getenv("DB_PATH"); v != "" {
		cfg.Database.Path = v
	}
	if v := os.Getenv("DB_READER_MAX_CONNS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.Database.ReaderMaxConns = n
		}
	}
	if v := os.Getenv("LOG_LEVEL"); v != "" {
		cfg.Log.Level = v
	}
	if v := os.Getenv("MEDIA_PATH"); v != "" {
		cfg.Media.BasePath = v
	}
	if v := os.Getenv("MEDIA_QUOTA_BYTES"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			cfg.Media.DefaultQuotaBytes = n
		}
	}
	// TURN configuration.
	if v := os.Getenv("TURN_ENABLED"); v == "true" || v == "1" {
		cfg.TURN.Enabled = true
	}
	if v := os.Getenv("TURN_LISTEN_ADDR"); v != "" {
		cfg.TURN.ListenAddr = v
	}
	if v := os.Getenv("TURN_REALM"); v != "" {
		cfg.TURN.Realm = v
	}
	if v := os.Getenv("TURN_ACTIVE_SECRET"); v != "" {
		cfg.TURN.ActiveSecret = v
	}
	if v := os.Getenv("TURN_PREVIOUS_SECRET"); v != "" {
		cfg.TURN.PreviousSecret = v
	}
	if v := os.Getenv("TURN_RELAY_IP"); v != "" {
		if ip := net.ParseIP(strings.TrimSpace(v)); ip != nil {
			cfg.TURN.RelayIP = ip
		}
	}
	if v := os.Getenv("TURN_MIN_PORT"); v != "" {
		if p, err := strconv.ParseUint(strings.TrimSpace(v), 10, 16); err == nil {
			cfg.TURN.MinPort = uint16(p)
		}
	}
	if v := os.Getenv("TURN_MAX_PORT"); v != "" {
		if p, err := strconv.ParseUint(strings.TrimSpace(v), 10, 16); err == nil {
			cfg.TURN.MaxPort = uint16(p)
		}
	}

	// Push configuration.
	if v := os.Getenv("PUSH_ENABLED"); v == "false" || v == "0" {
		cfg.Push.Enabled = false
	}
	if v := os.Getenv("PUSH_VAPID_ENCRYPTION_KEY"); v != "" {
		if strings.Contains(v, "=") {
			cfg.Push.vapidKeyErr = fmt.Errorf("PUSH_VAPID_ENCRYPTION_KEY must be unpadded base64url (padding '=' is rejected)")
		} else {
			decoded, err := base64.RawURLEncoding.DecodeString(v)
			if err != nil {
				cfg.Push.vapidKeyErr = fmt.Errorf("PUSH_VAPID_ENCRYPTION_KEY must be unpadded base64url: %w", err)
			} else if len(decoded) != 32 {
				cfg.Push.vapidKeyErr = fmt.Errorf("must be exactly 32 decoded bytes, got %d", len(decoded))
			} else {
				copy(cfg.Push.VAPIDEncryptionKey[:], decoded)
			}
		}
	} else if cfg.Push.Enabled {
		cfg.Push.vapidKeyErr = fmt.Errorf("PUSH_VAPID_ENCRYPTION_KEY is required when PUSH_ENABLED is true")
	}
	if v := os.Getenv("PUSH_VAPID_SUBJECT"); v != "" {
		cfg.Push.VAPIDSubject = v
	}
	if v := os.Getenv("PUSH_DISPATCH_QUEUE_SIZE"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.Push.DispatchQueueSize = n
		}
	}
	if v := os.Getenv("PUSH_DISPATCH_TIMEOUT_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.Push.DispatchTimeout = time.Duration(n) * time.Second
		}
	}
	if v := os.Getenv("PUSH_DEBOUNCE_WINDOW_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.Push.DebounceWindow = time.Duration(n) * time.Second
		}
	}
	if v := os.Getenv("PUSH_PENDING_RING_CAPACITY"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.Push.PendingRingCap = n
		}
	}

	// Security
	if v := os.Getenv("APP_ORIGIN"); v != "" {
		cfg.Security.AppOrigin = v
	}
	if sec, err := loadSecret("IP_HASH_SECRET"); err == nil {
		cfg.Security.IPHashSecret = sec
	}
	if v := os.Getenv("TRUSTED_PROXIES_CIDR"); v != "" {
		for _, part := range strings.Split(v, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			_, cidr, err := net.ParseCIDR(part)
			if err == nil {
				cfg.Security.TrustedProxiesCIDR = append(cfg.Security.TrustedProxiesCIDR, cidr)
			}
		}
	}
	if v := os.Getenv("INSECURE_DEV_MODE"); v == "true" || v == "1" {
		cfg.Security.InsecureDevMode = true
	}
	if v := os.Getenv("SECURITY_EVENTS_RETENTION_DAYS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			cfg.Security.AuditRetentionDays = n
		}
	}
	if v := os.Getenv("ADMIN_ENABLED"); v == "true" || v == "1" {
		cfg.Security.AdminEnabled = true
	}
	if sec, err := loadHexSecret("ADMIN_API_KEY_HASH_ACTIVE", 32); err == nil {
		cfg.Admin.APIKeyHashActive = sec
	} else if v := os.Getenv("ADMIN_API_KEY_HASH_ACTIVE"); v != "" {
		cfg.Admin.APIKeyHashActive = NewSecret([]byte(v))
	}
	if sec, err := loadHexSecret("ADMIN_API_KEY_HASH_PREVIOUS", 32); err == nil {
		cfg.Admin.APIKeyHashPrevious = sec
	}
	if v := os.Getenv("ADMIN_PREVIOUS_KEY_EXPIRES_AT"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			cfg.Admin.PreviousExpiresAtUnix = n
		}
	}
	if v := os.Getenv("ADMIN_TOKEN_HASH"); v != "" {
		cfg.Admin.AdminTokenHash = v
	}

	// Stage 2 TLS environment configuration
	if v := os.Getenv("TLS_MODE"); v != "" {
		cfg.TLS.Mode = strings.ToLower(strings.TrimSpace(v))
	}
	if v := os.Getenv("PUBLIC_HOST"); v != "" {
		cfg.TLS.PublicHost = strings.TrimSpace(v)
	}
	if v := os.Getenv("TLS_DATA_DIR"); v != "" {
		cfg.TLS.DataDir = strings.TrimSpace(v)
	}
	if v := os.Getenv("TLS_ONBOARDING_PORT"); v != "" {
		if port, err := strconv.Atoi(v); err == nil && port > 0 {
			cfg.TLS.OnboardingPort = port
		}
	}
	if v := os.Getenv("TLS_CERT_FILE"); v != "" {
		cfg.TLS.CertFile = strings.TrimSpace(v)
	}
	if v := os.Getenv("TLS_KEY_FILE"); v != "" {
		cfg.TLS.KeyFile = strings.TrimSpace(v)
	}
	if v := os.Getenv("TLS_REGENERATE_CA"); v == "true" || v == "1" {
		cfg.TLS.RegenerateCA = true
	}

	// Zero-Config Platform and Origin resolution
	if cfg.Platform == PlatformRailway {
		if os.Getenv("PUSH_ENABLED") == "" {
			cfg.Push.Enabled = false
		}
		if os.Getenv("TURN_ENABLED") == "" {
			cfg.TURN.Enabled = false
		}
		// Railway APP_ORIGIN derivation
		if cfg.Security.AppOrigin == "" {
			if domain := os.Getenv("RAILWAY_PUBLIC_DOMAIN"); domain != "" {
				cfg.Security.AppOrigin = "https://" + CleanAppOrigin(domain)
			} else {
				// Waiting for domain mode
				cfg.WaitingForDomain = true
				cfg.Security.AppOrigin = "https://waiting-for-domain.local"
				cfg.Warnings = append(cfg.Warnings, "No public domain detected on Railway. Running in safe waiting-for-domain mode.")
			}
		}
	} else {
		// Non-Railway Zero-Config
		if HasBuiltinTLS() && cfg.TLS.PublicHost != "" && os.Getenv("TLS_MODE") == "" {
			cfg.TLS.Mode = "selfsigned"
			if os.Getenv("PORT") == "" && os.Getenv("SERVER_PORT") == "" {
				cfg.Server.Port = 8443
			}
		}
		if cfg.Security.AppOrigin == "" && cfg.TLS.PublicHost == "" {
			// Nothing configured: bind to 127.0.0.1 only
			cfg.Server.Host = "127.0.0.1"
			cfg.Security.InsecureDevMode = true
			cfg.Security.AppOrigin = fmt.Sprintf("http://127.0.0.1:%d", cfg.Server.Port)
			cfg.Warnings = append(cfg.Warnings, "No public host or origin configured. Listening on 127.0.0.1 only for local access (never guessing a public IP).")
		}
	}

	// Automatic APP_ORIGIN derivation for selfsigned mode or when PUBLIC_HOST is set
	if cfg.Security.AppOrigin == "" && cfg.TLS.PublicHost != "" && (cfg.TLS.Mode == "selfsigned" || cfg.TLS.Mode == "files") {
		cfg.Security.AppOrigin = deriveAppOrigin(cfg.TLS.PublicHost, cfg.Server.Port)
	}

	// Automatic RelayIP derivation from PUBLIC_HOST when PUBLIC_HOST is a valid IP
	if cfg.TURN.RelayIP == nil && cfg.TLS.PublicHost != "" {
		if ip := net.ParseIP(cfg.TLS.PublicHost); ip != nil {
			cfg.TURN.RelayIP = ip
		}
	}

	// Zero-Config Secrets Resolution & Persistence
	secretsRes, secErr := LoadOrInitializeSecrets(cfg.DataDir, cfg.Database.Path)
	if secErr != nil {
		cfg.loadErr = secErr
	} else if secretsRes != nil {
		if cfg.Security.IPHashSecret.IsZero() {
			cfg.Security.IPHashSecret = secretsRes.IPHashSecret
		}
		if cfg.TURN.ActiveSecret == "" {
			cfg.TURN.ActiveSecret = secretsRes.TURNActiveSecret
		}
		if cfg.Admin.AdminTokenHash == "" && os.Getenv("ADMIN_API_KEY_HASH_ACTIVE") == "" && secretsRes.AdminTokenHash != "" {
			cfg.Admin.AdminTokenHash = secretsRes.AdminTokenHash
		}
		if cfg.Admin.AdminTokenHash != "" && cfg.Admin.APIKeyHashActive.IsZero() && os.Getenv("ADMIN_API_KEY_HASH_ACTIVE") == "" {
			cfg.Security.AdminEnabled = true
			if dec, err := hex.DecodeString(cfg.Admin.AdminTokenHash); err == nil && len(dec) == 32 {
				cfg.Admin.APIKeyHashActive = NewSecret(dec)
			}
		}
		cfg.BootstrappedAdminKey = secretsRes.BootstrappedAdminKey
		cfg.Warnings = append(cfg.Warnings, secretsRes.Warnings...)
	}
}

func deriveAppOrigin(publicHost string, port int) string {
	host := publicHost
	if ip := net.ParseIP(publicHost); ip != nil && ip.To4() == nil {
		host = "[" + publicHost + "]"
	}
	if port == 443 {
		return fmt.Sprintf("https://%s", host)
	}
	return fmt.Sprintf("https://%s:%d", host, port)
}
