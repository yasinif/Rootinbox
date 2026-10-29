package domain

import (
	"encoding/base64"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// uuidRegex validates canonical lowercase UUID v4 format.
// RFC-0002 §4.2: All UUIDs MUST be stored as canonical lowercase strings.
// RFC-0002 §6 F1: Cursor UUID MUST be validated with regex.
var uuidRegex = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// Cursor represents a decoded pagination cursor.
// RFC-0002 §4.5: Cursor Format is Base64URL(last_created_at + "_" + last_uuid).
type Cursor struct {
	CreatedAt int64
	ID        string
}

// EncodeCursor encodes a pagination cursor.
// RFC-0002 §4.5: Base64URL(last_created_at + "_" + last_uuid).
func EncodeCursor(createdAt int64, id string) string {
	raw := fmt.Sprintf("%d_%s", createdAt, id)
	return base64.URLEncoding.EncodeToString([]byte(raw))
}

// DecodeCursor decodes and validates a pagination cursor.
// RFC-0002 §4.5: Deterministic cursor-based pagination.
// RFC-0002 §6 F1: Base64URL cursor MUST be explicitly decoded and structurally
// validated (splitting by "_", checking integer and UUID regex) before querying.
func DecodeCursor(encoded string) (*Cursor, error) {
	raw, err := base64.URLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("invalid cursor encoding: %w", err)
	}

	parts := strings.SplitN(string(raw), "_", 2)
	if len(parts) != 2 {
		return nil, fmt.Errorf("invalid cursor format")
	}

	createdAt, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return nil, fmt.Errorf("invalid cursor timestamp: %w", err)
	}

	id := parts[1]
	if !uuidRegex.MatchString(id) {
		return nil, fmt.Errorf("invalid cursor UUID format")
	}

	return &Cursor{CreatedAt: createdAt, ID: id}, nil
}

// Encode encodes the cursor to a Base64URL string.
func (c *Cursor) Encode() string {
	return EncodeCursor(c.CreatedAt, c.ID)
}
