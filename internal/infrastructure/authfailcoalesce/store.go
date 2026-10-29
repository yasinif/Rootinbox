package authfailcoalesce

import (
	"context"
	"sync"
	"time"

	"github.com/hashicorp/golang-lru/v2/expirable"
)

type Store struct {
	cache *expirable.LRU[string, int64]
	mu    sync.Mutex
}

func NewStore() *Store {
	// LRU of 10,000 IPs, expiring after 1 minute
	cache := expirable.NewLRU[string, int64](10000, nil, time.Minute)
	return &Store{cache: cache}
}

// ShouldEmit checks if an auth failure for this IP hash should be emitted.
// Returns true if the event should be emitted (cooldown passed or first time).
func (s *Store) ShouldEmit(ctx context.Context, ipHash string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now().Unix()
	lastEmit, ok := s.cache.Get(ipHash)
	
	if !ok || now-lastEmit >= 60 {
		s.cache.Add(ipHash, now)
		return true
	}
	
	return false
}
