package ipblock

import (
	"context"
	"sync"
	"time"

	"rootinbox/internal/domain"
)

type Cache struct {
	mu     sync.RWMutex
	blocks map[string]struct{}
	repo   domain.IPBlockRepository
}

func NewCache(repo domain.IPBlockRepository) *Cache {
	return &Cache{
		blocks: make(map[string]struct{}),
		repo:   repo,
	}
}

func (c *Cache) Refresh(ctx context.Context) error {
	blocks, err := c.repo.ListBlocked(ctx)
	if err != nil {
		return err
	}

	newBlocks := make(map[string]struct{})
	for _, b := range blocks {
		newBlocks[b.IPHash] = struct{}{}
	}

	c.mu.Lock()
	c.blocks = newBlocks
	c.mu.Unlock()
	return nil
}

func (c *Cache) IsBlocked(ipHash string) bool {
	c.mu.RLock()
	_, blocked := c.blocks[ipHash]
	c.mu.RUnlock()
	return blocked
}

// Block asynchronously updates the db and synchronously updates the cache.
func (c *Cache) Block(ctx context.Context, ipHash string) error {
	c.mu.Lock()
	c.blocks[ipHash] = struct{}{}
	c.mu.Unlock()

	// Best-effort write to DB
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = c.repo.Upsert(ctx, &domain.IPBlock{
			IPHash:    ipHash,
			Status:    domain.IPBlockStatusBlocked,
			CreatedAt: time.Now().Unix(),
			UpdatedAt: time.Now().Unix(),
		})
	}()
	return nil
}

// Unblock updates cache and db.
func (c *Cache) Unblock(ctx context.Context, ipHash string) error {
	c.mu.Lock()
	delete(c.blocks, ipHash)
	c.mu.Unlock()

	// Best-effort write to DB
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = c.repo.Upsert(ctx, &domain.IPBlock{
			IPHash:    ipHash,
			Status:    domain.IPBlockStatusUnblocked,
			CreatedAt: time.Now().Unix(),
			UpdatedAt: time.Now().Unix(),
		})
	}()
	return nil
}
