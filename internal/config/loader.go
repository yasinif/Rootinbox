package config

import (
	"encoding/hex"
	"os"
	"strings"

	"rootinbox/internal/domain"
)

// loadSecret loads a secret from an environment variable or its _FILE counterpart.
// Implements ADR-P10-12: _FILE precedence, mutual-exclusion error.
func loadSecret(name string) (Secret, error) {
	valFile := os.Getenv(name + "_FILE")
	valInline := os.Getenv(name)

	if valFile != "" && valInline != "" {
		return Secret{}, domain.NewDomainError(domain.ErrCfg001, "ambiguous secret provenance for "+name, nil)
	}

	if valFile != "" {
		b, err := os.ReadFile(valFile)
		if err != nil {
			return Secret{}, domain.NewDomainError(domain.ErrCfg001, "failed to read secret file "+name+"_FILE", err)
		}
		return NewSecret([]byte(strings.TrimSpace(string(b)))), nil
	}

	if valInline != "" {
		return NewSecret([]byte(valInline)), nil
	}

	return Secret{}, nil
}

// loadHexSecret loads a hex-encoded secret, decodes it, and enforces a minimum byte length.
func loadHexSecret(name string, minBytes int) (Secret, error) {
	sec, err := loadSecret(name)
	if err != nil {
		return Secret{}, err
	}
	if sec.IsZero() {
		return Secret{}, nil
	}

	b := sec.Reveal()
	dec := make([]byte, hex.DecodedLen(len(b)))
	n, err := hex.Decode(dec, b)
	if err != nil {
		return Secret{}, domain.NewDomainError(domain.ErrCfg001, "failed to decode hex secret "+name, err)
	}

	if n < minBytes {
		return Secret{}, domain.NewDomainError(domain.ErrCfg001, "hex secret too short: "+name, nil)
	}

	return NewSecret(dec[:n]), nil
}
