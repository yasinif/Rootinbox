package repository

import (
	"context"
	"crypto/sha256"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/jmoiron/sqlx"

	"rootinbox/internal/domain"
	"rootinbox/internal/infrastructure/database"
	"rootinbox/internal/infrastructure/migrations"
)

func setupTestDB(t *testing.T) (*sqlx.DB, *sqlx.DB) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	db, err := database.Open(context.Background(), dbPath, 4)
	if err != nil {
		t.Fatalf("opening test db: %v", err)
	}
	t.Cleanup(func() {
		db.Writer.Close()
		db.Reader.Close()
	})

	runner := migrations.NewRunner(db.Writer, migrations.All(), slog.Default())
	if err := runner.Run(context.Background()); err != nil {
		t.Fatalf("running migrations: %v", err)
	}
	return db.Writer, db.Reader
}

func createTestUserAndConv(t *testing.T, writer *sqlx.DB, userID, convID string, convType domain.ConversationType) {
	t.Helper()
	ctx := context.Background()
	_, err := writer.ExecContext(ctx, `
		INSERT OR IGNORE INTO users (id, identity_hash, public_key, status, created_at)
		VALUES (?, ?, ?, 'active', ?)
	`, userID, "hash-"+userID, "pk-"+userID, time.Now().UnixMilli())
	if err != nil {
		t.Fatalf("inserting test user: %v", err)
	}

	_, err = writer.ExecContext(ctx, `
		INSERT OR IGNORE INTO conversations (id, type, created_at, is_public)
		VALUES (?, ?, ?, 0)
	`, convID, string(convType), time.Now().UnixMilli())
	if err != nil {
		t.Fatalf("inserting test conversation: %v", err)
	}

	_, err = writer.ExecContext(ctx, `
		INSERT OR IGNORE INTO participants (conversation_id, user_id, role, joined_at)
		VALUES (?, ?, 'owner', ?)
	`, convID, userID, time.Now().UnixMilli())
	if err != nil {
		t.Fatalf("inserting test participant: %v", err)
	}
}

func TestGroupMessageRepository_Level2EncryptionAtRest(t *testing.T) {
	writer, reader := setupTestDB(t)
	encKey := sha256.Sum256([]byte("test-secret-key-at-rest"))
	repo := NewGroupMessageRepository(writer, reader, encKey)

	ctx := context.Background()
	convID := "conv-direct-1"
	userID := "user-alice"
	createTestUserAndConv(t, writer, userID, convID, domain.ConvTypeDirect)

	msgID := "msg-secret-1"
	plaintext := "Top secret message content: Level-2 AES-256-GCM"

	msg := &domain.GroupMessage{
		ID:             msgID,
		ConversationID: convID,
		SenderID:       userID,
		Content:        plaintext,
		CreatedAt:      time.Now().UnixMilli(),
	}

	// 1. Save message
	if err := repo.Save(ctx, msg); err != nil {
		t.Fatalf("repo.Save failed: %v", err)
	}

	// 2. Query physical database row directly via raw SQL
	var rawContent string
	err := sqlx.GetContext(ctx, reader, &rawContent, "SELECT content FROM group_messages WHERE id = ?", msgID)
	if err != nil {
		t.Fatalf("querying raw content: %v", err)
	}

	// Assert ciphertext is stored, prefixed with enc:v1:, and plaintext is NOT on disk
	if !strings.HasPrefix(rawContent, "enc:v1:") {
		t.Fatalf("expected raw stored content to have 'enc:v1:' prefix, got: %s", rawContent)
	}
	if strings.Contains(rawContent, plaintext) {
		t.Fatalf("FATAL: plaintext was found unencrypted on disk in SQLite row!")
	}

	// 3. Transparent Decryption on Read
	fetched, err := repo.GetByID(ctx, msgID)
	if err != nil {
		t.Fatalf("repo.GetByID failed: %v", err)
	}
	if fetched.Content != plaintext {
		t.Fatalf("expected decrypted content %q, got %q", plaintext, fetched.Content)
	}

	// 4. UpdateContent transparent re-encryption
	newPlaintext := "Updated secret message content"
	now := time.Now().UnixMilli()
	if err := repo.UpdateContent(ctx, msgID, newPlaintext, now); err != nil {
		t.Fatalf("repo.UpdateContent failed: %v", err)
	}

	var rawUpdated string
	_ = sqlx.GetContext(ctx, reader, &rawUpdated, "SELECT content FROM group_messages WHERE id = ?", msgID)
	if !strings.HasPrefix(rawUpdated, "enc:v1:") || strings.Contains(rawUpdated, newPlaintext) {
		t.Fatalf("updated content was not properly encrypted on disk: %s", rawUpdated)
	}

	fetchedUpdated, err := repo.GetByID(ctx, msgID)
	if err != nil {
		t.Fatalf("GetByID after update failed: %v", err)
	}
	if fetchedUpdated.Content != newPlaintext {
		t.Fatalf("expected %q, got %q", newPlaintext, fetchedUpdated.Content)
	}

	// 5. SoftDelete leaves [deleted] placeholder unencrypted
	if err := repo.SoftDelete(ctx, msgID, now); err != nil {
		t.Fatalf("repo.SoftDelete failed: %v", err)
	}
	var rawDeleted string
	_ = sqlx.GetContext(ctx, reader, &rawDeleted, "SELECT content FROM group_messages WHERE id = ?", msgID)
	if rawDeleted != "[deleted]" {
		t.Fatalf("expected raw deleted marker '[deleted]', got %s", rawDeleted)
	}
	fetchedDeleted, err := repo.GetByID(ctx, msgID)
	if err != nil {
		t.Fatalf("GetByID after delete failed: %v", err)
	}
	if fetchedDeleted.Content != "[deleted]" {
		t.Fatalf("expected '[deleted]', got %s", fetchedDeleted.Content)
	}
}

func TestGroupMessageRepository_LegacyPlaintextFallback(t *testing.T) {
	writer, reader := setupTestDB(t)
	repo := NewGroupMessageRepository(writer, reader)

	ctx := context.Background()
	convID := "conv-legacy-1"
	userID := "user-bob"
	createTestUserAndConv(t, writer, userID, convID, domain.ConvTypeDirect)

	// Insert row directly with unencrypted legacy content
	legacyPlaintext := "Hello legacy pre-migration world"
	_, err := writer.ExecContext(ctx, `
		INSERT INTO group_messages (id, conversation_id, sender_id, content, created_at, server_id)
		VALUES ('msg-legacy-1', ?, ?, ?, ?, 1)
	`, convID, userID, legacyPlaintext, 1700000000000)
	if err != nil {
		t.Fatalf("inserting legacy message: %v", err)
	}

	// Read via repository: must transparently return plaintext without failing
	fetched, err := repo.GetByID(ctx, "msg-legacy-1")
	if err != nil {
		t.Fatalf("GetByID failed on legacy message: %v", err)
	}
	if fetched.Content != legacyPlaintext {
		t.Fatalf("expected legacy content %q, got %q", legacyPlaintext, fetched.Content)
	}
}

func TestGroupMessageRepository_IdempotencyAndSequenceAllocation(t *testing.T) {
	writer, reader := setupTestDB(t)
	repo := NewGroupMessageRepository(writer, reader)

	ctx := context.Background()
	convID := "conv-idem-1"
	userID := "user-alice"
	createTestUserAndConv(t, writer, userID, convID, domain.ConvTypeGroup)

	msgID := "client-uuid-1234"
	msg1 := &domain.GroupMessage{
		ID:             msgID,
		ConversationID: convID,
		SenderID:       userID,
		Content:        "First send attempt",
		CreatedAt:      1700000000000,
	}

	if err := repo.Save(ctx, msg1); err != nil {
		t.Fatalf("first Save failed: %v", err)
	}
	if msg1.ServerID != 1 {
		t.Fatalf("expected server_id 1, got %d", msg1.ServerID)
	}

	// Second send with same ID (idempotency check)
	msg2 := &domain.GroupMessage{
		ID:             msgID,
		ConversationID: convID,
		SenderID:       userID,
		Content:        "Duplicate send attempt",
		CreatedAt:      1700000001000,
	}

	if err := repo.Save(ctx, msg2); err != nil {
		t.Fatalf("idempotent Save failed: %v", err)
	}
	if msg2.ServerID != 1 {
		t.Fatalf("expected server_id 1 on duplicate send, got %d", msg2.ServerID)
	}

	// Verify only 1 row exists in database
	var count int
	_ = sqlx.GetContext(ctx, reader, &count, "SELECT COUNT(*) FROM group_messages WHERE conversation_id = ?", convID)
	if count != 1 {
		t.Fatalf("expected exactly 1 row, got %d", count)
	}

	// Monotonic increment on distinct message
	msg3 := &domain.GroupMessage{
		ID:             "client-uuid-5678",
		ConversationID: convID,
		SenderID:       userID,
		Content:        "Second message",
		CreatedAt:      1700000002000,
	}
	if err := repo.Save(ctx, msg3); err != nil {
		t.Fatalf("third message Save failed: %v", err)
	}
	if msg3.ServerID != 2 {
		t.Fatalf("expected server_id 2, got %d", msg3.ServerID)
	}
}

func TestGroupMessageRepository_UnreadCountsAndPreviews(t *testing.T) {
	writer, reader := setupTestDB(t)
	repo := NewGroupMessageRepository(writer, reader)

	ctx := context.Background()
	convID := "conv-unread-1"
	aliceID := "user-alice"
	bobID := "user-bob"
	createTestUserAndConv(t, writer, aliceID, convID, domain.ConvTypeDirect)
	createTestUserAndConv(t, writer, bobID, convID, domain.ConvTypeDirect)

	// Bob sends msg 1 at ts 1000000000 (10-digit second legacy format)
	_ = repo.Save(ctx, &domain.GroupMessage{
		ID:             "m1",
		ConversationID: convID,
		SenderID:       bobID,
		Content:        "Bob message 1",
		CreatedAt:      1000000000, // 10-digit seconds
	})

	// Bob sends msg 2 at ts 1700000000000 (13-digit millisecond format)
	_ = repo.Save(ctx, &domain.GroupMessage{
		ID:             "m2",
		ConversationID: convID,
		SenderID:       bobID,
		Content:        "Bob message 2",
		CreatedAt:      1700000000000,
	})

	// Alice sends msg 3 at ts 1700000010000
	_ = repo.Save(ctx, &domain.GroupMessage{
		ID:             "m3",
		ConversationID: convID,
		SenderID:       aliceID,
		Content:        "Alice reply",
		CreatedAt:      1700000010000,
	})

	// When Alice has read nothing (watermark 0): unread count should be 2 (m1 and m2 from Bob, Alice's own m3 ignored)
	unreadAlice, err := repo.GetUnreadCount(ctx, convID, aliceID, 0)
	if err != nil {
		t.Fatalf("GetUnreadCount failed: %v", err)
	}
	if unreadAlice != 2 {
		t.Fatalf("expected 2 unread messages for Alice, got %d", unreadAlice)
	}

	// Last message overall should be m3 (Alice reply)
	lastMsg, err := repo.GetLastMessage(ctx, convID)
	if err != nil {
		t.Fatalf("GetLastMessage failed: %v", err)
	}
	if lastMsg == nil || lastMsg.ID != "m3" || lastMsg.Content != "Alice reply" {
		t.Fatalf("expected m3 as last message, got %+v", lastMsg)
	}

	// Last unread message for Alice should be m2 (newest from Bob)
	lastUnread, err := repo.GetLastUnreadMessage(ctx, convID, aliceID, 0)
	if err != nil {
		t.Fatalf("GetLastUnreadMessage failed: %v", err)
	}
	if lastUnread == nil || lastUnread.ID != "m2" || lastUnread.Content != "Bob message 2" {
		t.Fatalf("expected m2 as last unread message for Alice, got %+v", lastUnread)
	}

	// When Alice reads up to m1 (ts 1000000000 -> normalized to 1000000000000):
	// unread count should be 1 (m2)
	unreadAliceAfterM1, err := repo.GetUnreadCount(ctx, convID, aliceID, 1000000000)
	if err != nil {
		t.Fatalf("GetUnreadCount after m1 failed: %v", err)
	}
	if unreadAliceAfterM1 != 1 {
		t.Fatalf("expected 1 unread message for Alice, got %d", unreadAliceAfterM1)
	}
}

func TestGroupMessageRepository_CorruptedMessageFilteringAndDelete(t *testing.T) {
	writer, reader := setupTestDB(t)
	repo := NewGroupMessageRepository(writer, reader)

	ctx := context.Background()
	convID := "conv-corrupt-test"
	aliceID := "user-alice"
	createTestUserAndConv(t, writer, aliceID, convID, domain.ConvTypeDirect)

	// 1. Insert a clean valid message
	validMsg := &domain.GroupMessage{
		ID:             "msg-valid-1",
		ConversationID: convID,
		SenderID:       aliceID,
		Content:        "Hello, this is a clean valid UTF-8 message! سلام",
		CreatedAt:      1700000000000,
	}
	if err := repo.Save(ctx, validMsg); err != nil {
		t.Fatalf("saving valid message failed: %v", err)
	}

	// 2. Directly insert raw corrupted messages into DB (simulating legacy corrupted data)
	// (a) Contains Unicode replacement character \uFFFD
	corruptContent1 := "Corrupted with replacement: \uFFFD and binary"
	_, err := writer.ExecContext(ctx, `
		INSERT INTO group_messages (id, conversation_id, sender_id, content, created_at, server_id)
		VALUES (?, ?, ?, ?, ?, ?)
	`, "msg-corrupt-1", convID, aliceID, corruptContent1, 1700000001000, 2)
	if err != nil {
		t.Fatalf("inserting corrupt message 1: %v", err)
	}

	// (b) Contains binary control byte 0x01 (legacy E2EE ciphertext envelope header 9!M#)
	corruptContent2 := "\x019!M#\x00\x05rawbinaryblob"
	_, err = writer.ExecContext(ctx, `
		INSERT INTO group_messages (id, conversation_id, sender_id, content, created_at, server_id)
		VALUES (?, ?, ?, ?, ?, ?)
	`, "msg-corrupt-2", convID, aliceID, corruptContent2, 1700000002000, 3)
	if err != nil {
		t.Fatalf("inserting corrupt message 2: %v", err)
	}

	// 3. Verify that ListByConversation filters out both corrupted messages
	messages, err := repo.ListByConversation(ctx, convID, 0, 50)
	if err != nil {
		t.Fatalf("ListByConversation failed: %v", err)
	}
	if len(messages) != 1 {
		t.Fatalf("expected exactly 1 valid message, got %d", len(messages))
	}
	if messages[0].ID != "msg-valid-1" {
		t.Fatalf("expected msg-valid-1, got %s", messages[0].ID)
	}

	// 4. Verify that GetByID returns not found for corrupted message
	_, err = repo.GetByID(ctx, "msg-corrupt-1")
	if err == nil {
		t.Fatalf("expected GetByID to fail on corrupt message 1, but succeeded")
	}

	// 5. Verify that the corrupted rows were physically DELETED from the database
	var count int
	err = sqlx.GetContext(ctx, reader, &count, "SELECT COUNT(*) FROM group_messages WHERE id IN ('msg-corrupt-1', 'msg-corrupt-2')")
	if err != nil {
		t.Fatalf("querying corrupt count: %v", err)
	}
	if count != 0 {
		t.Fatalf("expected 0 corrupt rows remaining in database, found %d", count)
	}
}
