package domain

// NormalizeTimestamp converts any Unix timestamp to milliseconds (13-digit Unix timestamp).
// If ts is positive and less than 10,000,000,000 (i.e. in seconds), it is multiplied by 1000.
func NormalizeTimestamp(ts int64) int64 {
	if ts > 0 && ts < 10000000000 {
		return ts * 1000
	}
	return ts
}

// NormalizeTimestampPtr normalizes a pointer to int64 timestamp, returning nil if input is nil.
func NormalizeTimestampPtr(ts *int64) *int64 {
	if ts == nil {
		return nil
	}
	val := NormalizeTimestamp(*ts)
	return &val
}
