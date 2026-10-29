package ratelimit

import (
	"context"
	"sync"
	"time"

	"golang.org/x/time/rate"
	"rootinbox/internal/domain"
)

type Limiter struct {
	mu            sync.Mutex
	ipLimiters    map[string]*rate.Limiter
	userLimiters  map[string]*rate.Limiter
	lastSeenIP    map[string]time.Time
	lastSeenUser  map[string]time.Time
	stateMax      int
}

func NewLimiter(stateMax int) *Limiter {
	l := &Limiter{
		ipLimiters:   make(map[string]*rate.Limiter),
		userLimiters: make(map[string]*rate.Limiter),
		lastSeenIP:   make(map[string]time.Time),
		lastSeenUser: make(map[string]time.Time),
		stateMax:     stateMax,
	}
	go l.cleanupLoop()
	return l
}

func (l *Limiter) Allow(ctx context.Context, routeClass domain.RouteClass, ipHash string, userID string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()

	now := time.Now()

	// Enforce global state cap (LRU logic conceptually handled by cleanupLoop)
	// If maps grow beyond stateMax, we proactively prune oldest right away.
	if len(l.ipLimiters)+len(l.userLimiters) > l.stateMax {
		l.pruneOldestUnlocked()
	}

	allow := true

	if routeClass.Dimension == domain.DimensionIP || routeClass.Dimension == domain.DimensionBoth {
		if ipHash != "" {
			key := ipHash + ":" + routeClass.Name
			limiter, exists := l.ipLimiters[key]
			if !exists {
				// per-minute rate converted to requests-per-second
				rps := rate.Limit(float64(routeClass.PerMinuteIP) / 60.0)
				limiter = rate.NewLimiter(rps, routeClass.PerMinuteIP)
				l.ipLimiters[key] = limiter
			}
			l.lastSeenIP[key] = now
			if !limiter.Allow() {
				allow = false
			}
		}
	}

	if routeClass.Dimension == domain.DimensionUser || routeClass.Dimension == domain.DimensionBoth {
		if userID != "" {
			key := userID + ":" + routeClass.Name
			limiter, exists := l.userLimiters[key]
			if !exists {
				rps := rate.Limit(float64(routeClass.PerMinuteUser) / 60.0)
				limiter = rate.NewLimiter(rps, routeClass.PerMinuteUser)
				l.userLimiters[key] = limiter
			}
			l.lastSeenUser[key] = now
			if !limiter.Allow() {
				allow = false
			}
		}
	}

	return allow
}

func (l *Limiter) cleanupLoop() {
	ticker := time.NewTicker(5 * time.Minute)
	for range ticker.C {
		l.mu.Lock()
		now := time.Now()
		for k, v := range l.lastSeenIP {
			if now.Sub(v) > 10*time.Minute {
				delete(l.lastSeenIP, k)
				delete(l.ipLimiters, k)
			}
		}
		for k, v := range l.lastSeenUser {
			if now.Sub(v) > 10*time.Minute {
				delete(l.lastSeenUser, k)
				delete(l.userLimiters, k)
			}
		}
		l.mu.Unlock()
	}
}

func (l *Limiter) pruneOldestUnlocked() {
	// Best effort prune 10%
	target := l.stateMax / 10
	pruned := 0
	
	// Just randomly delete to avoid O(N) sort. The map iteration is semi-random.
	for k := range l.lastSeenIP {
		if pruned >= target {
			break
		}
		delete(l.lastSeenIP, k)
		delete(l.ipLimiters, k)
		pruned++
	}
	
	for k := range l.lastSeenUser {
		if pruned >= target {
			break
		}
		delete(l.lastSeenUser, k)
		delete(l.userLimiters, k)
		pruned++
	}
}
