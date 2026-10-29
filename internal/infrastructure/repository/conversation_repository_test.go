package repository

import (
	"context"
	"testing"
	"time"

	"rootinbox/internal/domain"
)

func TestConversationRepository_WatermarksAndDelivery(t *testing.T) {
	writer, reader := setupTestDB(t)
	repo := NewConversationRepository(writer, reader)
	ctx := context.Background()

	alice := "user-alice"
	bob := "user-bob"
	convID := "conv-direct-1"

	createTestUserAndConv(t, writer, alice, convID, domain.ConvTypeDirect)

	// Add Bob as participant
	_, err := writer.ExecContext(ctx, `
		INSERT OR IGNORE INTO users (id, identity_hash, public_key, status, created_at)
		VALUES (?, ?, ?, 'active', ?)
	`, bob, "hash-"+bob, "pk-"+bob, time.Now().UnixMilli())
	if err != nil {
		t.Fatalf("inserting bob: %v", err)
	}
	_, err = writer.ExecContext(ctx, `
		INSERT OR IGNORE INTO participants (conversation_id, user_id, role, joined_at)
		VALUES (?, ?, 'member', ?)
	`, convID, bob, time.Now().UnixMilli())
	if err != nil {
		t.Fatalf("inserting bob participant: %v", err)
	}

	// 1. Initial watermarks should be 0
	readAt, delivAt, err := repo.GetPeerWatermarks(ctx, convID, alice)
	if err != nil {
		t.Fatalf("GetPeerWatermarks initial: %v", err)
	}
	if readAt != 0 || delivAt != 0 {
		t.Fatalf("expected 0/0 initial watermarks, got read=%d deliv=%d", readAt, delivAt)
	}

	// 2. Bob receives message at time T1 (delivery watermark)
	t1 := int64(1700000000000)
	if err := repo.SetDeliveryWatermark(ctx, bob, convID, t1); err != nil {
		t.Fatalf("SetDeliveryWatermark failed: %v", err)
	}

	bobDeliv, err := repo.GetDeliveryWatermark(ctx, bob, convID)
	if err != nil {
		t.Fatalf("GetDeliveryWatermark failed: %v", err)
	}
	if bobDeliv != t1 {
		t.Fatalf("expected delivery watermark %d, got %d", t1, bobDeliv)
	}

	// Alice checks peer watermarks -> Bob delivered at t1, read at 0
	readAt, delivAt, err = repo.GetPeerWatermarks(ctx, convID, alice)
	if err != nil {
		t.Fatalf("GetPeerWatermarks after delivery: %v", err)
	}
	if readAt != 0 || delivAt != t1 {
		t.Fatalf("expected read=0, deliv=%d, got read=%d deliv=%d", t1, readAt, delivAt)
	}

	// 3. Bob reads message at time T2 (read watermark advances both read and delivery)
	t2 := int64(1700000005000)
	if err := repo.SetWatermark(ctx, bob, convID, t2); err != nil {
		t.Fatalf("SetWatermark failed: %v", err)
	}

	bobRead, err := repo.GetWatermark(ctx, bob, convID)
	if err != nil {
		t.Fatalf("GetWatermark failed: %v", err)
	}
	if bobRead != t2 {
		t.Fatalf("expected read watermark %d, got %d", t2, bobRead)
	}

	readAt, delivAt, err = repo.GetPeerWatermarks(ctx, convID, alice)
	if err != nil {
		t.Fatalf("GetPeerWatermarks after read: %v", err)
	}
	if readAt != t2 || delivAt != t2 {
		t.Fatalf("expected read=%d, deliv=%d, got read=%d deliv=%d", t2, t2, readAt, delivAt)
	}

	// 4. Test legacy 10-digit second timestamps normalization
	// Passing 1700000010 (seconds) should normalize to 1700000010000 (ms)
	tSeconds := int64(1700000010)
	expectedMs := tSeconds * 1000
	if err := repo.SetWatermark(ctx, bob, convID, tSeconds); err != nil {
		t.Fatalf("SetWatermark with seconds failed: %v", err)
	}

	readAt, delivAt, err = repo.GetPeerWatermarks(ctx, convID, alice)
	if err != nil {
		t.Fatalf("GetPeerWatermarks after seconds update: %v", err)
	}
	if readAt != expectedMs || delivAt != expectedMs {
		t.Fatalf("expected normalized ms %d, got read=%d deliv=%d", expectedMs, readAt, delivAt)
	}
}
