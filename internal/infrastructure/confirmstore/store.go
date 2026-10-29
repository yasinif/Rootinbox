package confirmstore

import (
	"context"
	"time"

	"github.com/hashicorp/golang-lru/v2/expirable"
)

type Store struct {
	cache *expirable.LRU[string, string]
}

func NewStore(ttl time.Duration) *Store {
	// LRU of 10,000 confirmation tokens, expiring according to TTL
	cache := expirable.NewLRU[string, string](10000, nil, ttl)
	return &Store{cache: cache}
}

func (s *Store) Set(ctx context.Context, token string, actionPayload string) error {
	s.cache.Add(token, actionPayload)
	return nil
}

func (s *Store) Get(ctx context.Context, token string) (string, bool) {
	return s.cache.Get(token)
}

func (s *Store) Delete(ctx context.Context, token string) error {
	s.cache.Remove(token)
	return nil
}
