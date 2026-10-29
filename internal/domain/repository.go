package domain

import "context"

// UserRepository defines the data access contract for User entities.
// RFC-0001A §2: Interfaces belong to the consumer (Domain layer).
// RFC-0001 §3: EVERY public method MUST accept context.Context as first parameter.
// RFC-0001A §4.2: Repositories MUST return ONLY Domain Entities.
type UserRepository interface {
	// Create persists a new user.
	Create(ctx context.Context, user *User) error

	// GetByID retrieves a user by their canonical UUIDv4.
	GetByID(ctx context.Context, id string) (*User, error)

	// GetByIdentityHash retrieves a user by their deterministic public-key hash.
	// RFC-0002 §4.2: identity_hash is UNIQUE.
	GetByIdentityHash(ctx context.Context, hash string) (*User, error)

	// Delete removes a user by ID.
	// RFC-0002 §4.3: FK cascade automatically removes participant records.
	Delete(ctx context.Context, id string) error

	// UpdateStatus transitions a user's status.
	UpdateStatus(ctx context.Context, id string, status UserStatus, updatedAt int64) error

	// UpdateUsername sets or clears a user's username.
	// Amendment RFC-0002-A §7A.5: Opt-in public identifier.
	UpdateUsername(ctx context.Context, id string, username *string) error

	// GetByUsername retrieves a user by their unique username.
	// Amendment RFC-0002-A §7A.3: Username is UNIQUE.
	GetByUsername(ctx context.Context, username string) (*User, error)

	// SearchByUsername performs a prefix search on usernames.
	// Amendment RFC-0002-A §7A.4: Returns active users only, max 20 results.
	SearchByUsername(ctx context.Context, query string, limit int) ([]*User, error)

	// UpdateAvatar updates or clears a user's avatar MIME type and timestamp.
	// Bundle 4: Personalization.
	UpdateAvatar(ctx context.Context, id string, mime *string, updatedAt *int64) error

	// UpdateProfile updates display_name, last_name, and bio for a user.
	// Fix 1+2: Telegram-style profile.
	UpdateProfile(ctx context.Context, id string, displayName, lastName, bio *string) error

	// UpdateLastSeen updates the user's last_seen_at timestamp (epoch milliseconds).
	UpdateLastSeen(ctx context.Context, id string, timestampMs int64) error
}

// ConversationRepository defines the data access contract for Conversation entities.
// RFC-0001A §2: Interfaces belong to the consumer (Domain layer).
type ConversationRepository interface {
	// Create persists a new conversation.
	Create(ctx context.Context, conv *Conversation) error

	// GetByID retrieves a conversation by its canonical UUIDv4.
	GetByID(ctx context.Context, id string) (*Conversation, error)

	// ListByUserID retrieves conversations for a user with cursor-based pagination.
	// RFC-0002 §4.5: Traditional OFFSET/LIMIT pagination is FORBIDDEN.
	ListByUserID(ctx context.Context, userID string, cursor *Cursor, limit int) ([]*Conversation, *Cursor, error)

	// Delete removes a conversation by ID.
	Delete(ctx context.Context, id string) error

	// DeleteOrphaned removes all conversations with zero participants.
	// RFC-0002 §4.3 Step 2: Delete all orphaned conversations where count(participants) == 0.
	DeleteOrphaned(ctx context.Context) (int64, error)

	// GetByInviteCode retrieves a conversation by its private invite code.
	GetByInviteCode(ctx context.Context, inviteCode string) (*Conversation, error)

	// GetByUsername retrieves a public conversation by its username.
	GetByUsername(ctx context.Context, username string) (*Conversation, error)

	// SearchPublic retrieves public conversations matching query with limit.
	SearchPublic(ctx context.Context, query string, limit int) ([]*Conversation, error)
}

// ReadWatermarkRepository defines data access for conversation read and delivery watermarks.
type ReadWatermarkRepository interface {
	EnsureWatermarksTable(ctx context.Context) error
	SetWatermark(ctx context.Context, userID, conversationID string, lastReadAt int64) error
	GetWatermark(ctx context.Context, userID, conversationID string) (int64, error)
	GetWatermarksForUser(ctx context.Context, userID string) (map[string]int64, error)
	SetDeliveryWatermark(ctx context.Context, userID, conversationID string, lastDeliveredAt int64) error
	GetDeliveryWatermark(ctx context.Context, userID, conversationID string) (int64, error)
	GetPeerWatermarks(ctx context.Context, conversationID, currentUserID string) (peerLastReadAt int64, peerLastDeliveredAt int64, err error)
	SetClearedAt(ctx context.Context, userID, conversationID string, clearedAt int64) error
	GetClearedAt(ctx context.Context, userID, conversationID string) (int64, error)
	SetHiddenAt(ctx context.Context, userID, conversationID string, hiddenAt int64) error
	GetHiddenAt(ctx context.Context, userID, conversationID string) (int64, error)
}

// ParticipantRepository defines the data access contract for Participant entities.
// RFC-0001A §2: Interfaces belong to the consumer (Domain layer).
type ParticipantRepository interface {
	// Create persists a new participant.
	Create(ctx context.Context, p *Participant) error

	// GetByConversationAndUser retrieves a participant by composite key.
	// RFC-0002 §4.2: PRIMARY KEY (conversation_id, user_id).
	GetByConversationAndUser(ctx context.Context, convID, userID string) (*Participant, error)

	// ListByConversationID retrieves all participants in a conversation.
	ListByConversationID(ctx context.Context, convID string) ([]*Participant, error)

	// ListByUserID retrieves all conversations a user participates in.
	ListByUserID(ctx context.Context, userID string) ([]*Participant, error)

	// Delete removes a participant from a conversation.
	Delete(ctx context.Context, convID, userID string) error

	// UpdateRole updates a participant's role.
	UpdateRole(ctx context.Context, convID, userID string, role ParticipantRole) error
}

// GroupMessageRepository defines data access contract for permanent server-authoritative conversation messages.
// Phase 1: Unified message store for DIRECT, SELF, GROUP, and CHANNEL conversations.
type GroupMessageRepository interface {
	Save(ctx context.Context, msg *GroupMessage) error
	GetByID(ctx context.Context, id string) (*GroupMessage, error)
	ListByConversation(ctx context.Context, convID string, beforeServerID int64, limit int) ([]*GroupMessage, error)
	UpdateContent(ctx context.Context, id string, content string, editedAt int64) error
	SoftDelete(ctx context.Context, id string, deletedAt int64) error
	HardDeleteByConversation(ctx context.Context, convID string) error
	GetUnreadCount(ctx context.Context, convID, currentUserID string, myLastReadAt int64) (int, error)
	GetLastMessage(ctx context.Context, convID string, minCreatedAt ...int64) (*GroupMessage, error)
	GetLastUnreadMessage(ctx context.Context, convID, currentUserID string, myLastReadAt int64) (*GroupMessage, error)
}

// SessionRepository defines the data access contract for Session entities.
// RFC-0004 §6.2: Session Database Schema Contract.
// RFC-0001A §2: Interface belongs to the consumer (Domain layer).
type SessionRepository interface {
	// Create persists a new session.
	Create(ctx context.Context, session *Session) error

	// CreateToken stores a hashed session token.
	// RFC-0004 §7.1: Database MUST NEVER store the raw token. Store SHA256(cookie_token).
	CreateToken(ctx context.Context, tokenHash string, sessionID string, createdAt int64) error

	// GetByTokenHash retrieves a session by its token hash (JOINs session_tokens + sessions).
	GetByTokenHash(ctx context.Context, tokenHash string) (*Session, error)

	// GetActiveByUserID retrieves the currently active (non-revoked) session for a user.
	GetActiveByUserID(ctx context.Context, userID string) (*Session, error)

	// RevokeByUserID sets revoked_at on all active sessions for a user.
	// RFC-0004 §6.3: Transition active session to GRACE_PERIOD state.
	RevokeByUserID(ctx context.Context, userID string, revokedAt int64) error

	// GetLatestVersionByUserID returns the highest session_version for a user.
	GetLatestVersionByUserID(ctx context.Context, userID string) (int, error)

	// DeleteByUserID removes all sessions for a user.
	// RFC-0002 §4.3 Step 3: Hard delete all sessions for the user_id.
	DeleteByUserID(ctx context.Context, userID string) error

	// DeleteTokensBySessionID removes all tokens for a session.
	DeleteTokensBySessionID(ctx context.Context, sessionID string) error

	// GetByID retrieves a session by its ID.
	GetByID(ctx context.Context, sessionID string) (*Session, error)

	// GetActiveSessionsByUserID retrieves all active (non-revoked, non-expired) sessions for a user.
	GetActiveSessionsByUserID(ctx context.Context, userID string) ([]*Session, error)

	// RevokeSession sets revoked_at on a specific session.
	RevokeSession(ctx context.Context, sessionID string, revokedAt int64) error

	// RevokeOtherSessions sets revoked_at on all active sessions for a user except the given session ID.
	RevokeOtherSessions(ctx context.Context, userID string, exceptSessionID string, revokedAt int64) error

	// UpdateLastActive updates the last_active_at timestamp for a session.
	UpdateLastActive(ctx context.Context, sessionID string, lastActiveAt int64) error
}

// MessageRepository defines the data access contract for the transient message queue.
// RFC-0005 §7: Transient Queue Database Contract.
// RFC-0005 §6.1: UNIQUE (client_uuid) provides idempotency.
type MessageRepository interface {
	// Create persists a message. Uses INSERT OR IGNORE for idempotency.
	// RFC-0005 §6.1: SQLite UNIQUE constraint is the source of truth.
	Create(ctx context.Context, msg *Message) error

	// GetPendingByReceiverID retrieves all pending messages for a receiver.
	// RFC-0005 §4.2: Post-Auth Flush — query pending messages on connect.
	GetPendingByReceiverID(ctx context.Context, receiverID string) ([]*Message, error)

	// GetPendingPaginated retrieves pending messages with cursor-based pagination.
	// RFC-0006 §4.2: Cursor-based sync via auto-incrementing server_id.
	// Returns messages where server_id > cursor, ordered by server_id ASC, limited.
	GetPendingPaginated(ctx context.Context, receiverID string, cursor int64, limit int) ([]*Message, error)

	CountRecentBySenderID(ctx context.Context, senderID string, since int64) (int, error)

	// GetSenderByClientUUID returns the sender_id for a given client_uuid.
	GetSenderByClientUUID(ctx context.Context, clientUUID string) (string, error)

	// DeleteByClientUUID hard-deletes a message after ACK.
	// RFC-0005 §6.3: Server executes HARD DELETE upon validated ACK.
	DeleteByClientUUID(ctx context.Context, clientUUID string) error

	// DeleteByClientUUIDs batch hard-deletes messages after bulk ACK.
	// RFC-0006 §4.2: POST /api/v1/messages/ack with array of client_uuids.
	DeleteByClientUUIDs(ctx context.Context, clientUUIDs []string) (int64, error)

	// GetPendingByClientUUIDAndReceiver verifies if a message exists for the specific recipient.
	GetPendingByClientUUIDAndReceiver(ctx context.Context, clientUUID, receiverID string) (*Message, error)

	// GetSendersByClientUUIDsAndReceiver retrieves clientUUID -> senderID mapping strictly for messages destined to receiverID.
	GetSendersByClientUUIDsAndReceiver(ctx context.Context, clientUUIDs []string, receiverID string) (map[string]string, error)

	// DeleteByClientUUIDAndReceiver hard deletes a message only if the acknowledging user is the genuine recipient.
	DeleteByClientUUIDAndReceiver(ctx context.Context, clientUUID, receiverID string) (int64, error)

	// DeleteByClientUUIDsAndReceiver batch deletes messages strictly matching clientUUIDs and receiverID.
	DeleteByClientUUIDsAndReceiver(ctx context.Context, clientUUIDs []string, receiverID string) (int64, error)

	// QueueDeliveryAck records a delivery receipt in SQLite for multi-device sync and offline recovery.
	QueueDeliveryAck(ctx context.Context, senderID, requestID string, createdAt int64) error

	// GetDeliveryAcks retrieves delivery acks for a sender using cursor pagination.
	GetDeliveryAcks(ctx context.Context, senderID string, cursor int64, limit int) ([]*DeliveryAck, error)

	// DeleteExpiredDeliveryAcks removes delivery acks older than the specified epoch seconds.
	DeleteExpiredDeliveryAcks(ctx context.Context, olderThan int64) error
}

// VaultRepository defines the data access contract for encrypted monthly vaults.
// RFC-0006 §4.3: Vault Archival Lifecycle.
type VaultRepository interface {
	// Create persists a new vault.
	// RFC-0006 §4.3: UNIQUE (user_id, month_year) enforces immutability.
	Create(ctx context.Context, vault *Vault) error

	// GetByUserAndMonth retrieves a vault by user and month.
	GetByUserAndMonth(ctx context.Context, userID, monthYear string) (*Vault, error)

	// ListByUserID retrieves all vault metadata for a user.
	ListByUserID(ctx context.Context, userID string) ([]*Vault, error)

	// DeleteByUserID removes all vaults for a user.
	// RFC-0002 §4.3 Step 4: Hard delete all vaults for the user_id.
	DeleteByUserID(ctx context.Context, userID string) error
}

// MediaFileRepository defines the data access contract for media file records.
// RFC-0007 §8.1: media_files table.
type MediaFileRepository interface {
	// Create inserts a new media file record.
	Create(ctx context.Context, file *MediaFile) error

	// GetByID retrieves a media file by file_id.
	GetByID(ctx context.Context, fileID string) (*MediaFile, error)

	// UpdateStatus transitions the media file status.
	// RFC-0007 §6.1: Only valid state transitions are permitted.
	UpdateStatus(ctx context.Context, fileID string, from, to MediaStatus) (int64, error)

	// IncrementGeneration atomically increments the generation counter.
	// RFC-0007 §7.2: OCC — must verify status == PENDING.
	// Returns rows affected (must be 1 for success).
	IncrementGeneration(ctx context.Context, fileID string) (int64, error)

	// Delete hard-deletes a media file record.
	// RFC-0007 §8.5 Phase C: Final row deletion.
	Delete(ctx context.Context, fileID string) error

	// ListByStatusOlderThan finds files in a given status older than a timestamp.
	// RFC-0007 §8.6: GC timeout scan.
	ListByStatusOlderThan(ctx context.Context, status MediaStatus, olderThan int64) ([]*MediaFile, error)

	// ListByStatus finds all files in a given status.
	// RFC-0007 §8.6: Crash recovery — resume DELETING files.
	ListByStatus(ctx context.Context, status MediaStatus) ([]*MediaFile, error)
}

// MediaChunkRepository defines the data access contract for media chunk records.
// RFC-0007 §8.1: media_chunks table. Composite PK: (file_id, chunk_index).
type MediaChunkRepository interface {
	// Create inserts a new chunk record.
	Create(ctx context.Context, chunk *MediaChunk) error

	// GetByFileAndIndex retrieves a chunk by file_id and chunk_index.
	GetByFileAndIndex(ctx context.Context, fileID string, chunkIndex int) (*MediaChunk, error)

	// ListByFileID retrieves all chunks for a file, ordered by chunk_index.
	ListByFileID(ctx context.Context, fileID string) ([]*MediaChunk, error)

	// CountByFileID returns the number of chunks for a file.
	CountByFileID(ctx context.Context, fileID string) (int, error)

	// DeleteByFileID removes all chunk records for a file.
	// Called during 3-Phase deletion.
	DeleteByFileID(ctx context.Context, fileID string) error
}

// QuotaRepository defines the data access contract for user quotas.
// RFC-0007 §8.2: user_quotas table.
type QuotaRepository interface {
	// GetOrCreate retrieves a user's quota, creating with defaults if missing.
	GetOrCreate(ctx context.Context, userID string, defaultLimitBytes int64) (*UserQuota, error)

	// ReserveBytes atomically adds to reserved_bytes.
	// RFC-0007 §8.2 INIT: reserved_bytes += paddedSize.
	ReserveBytes(ctx context.Context, userID string, bytes int64) error

	// CommitBytes atomically moves bytes from reserved to committed.
	// RFC-0007 §8.2 FINALIZE: reserved -= paddedSize, committed += paddedSize.
	CommitBytes(ctx context.Context, userID string, bytes int64) error

	// ReleaseReserved atomically subtracts from reserved_bytes.
	// RFC-0007 §8.2 DELETE from PENDING: reserved -= paddedSize.
	ReleaseReserved(ctx context.Context, userID string, bytes int64) error

	// ReleaseCommitted atomically subtracts from committed_bytes.
	// RFC-0007 §8.2 DELETE from FINALIZED: committed -= paddedSize.
	ReleaseCommitted(ctx context.Context, userID string, bytes int64) error
}

// CallRepository defines the data access contract for call records.
// RFC-0008 §9: SQLite Schema (calls).
type CallRepository interface {
	// Create inserts a new call record.
	Create(ctx context.Context, call *Call) error

	// GetByID retrieves a call by ID.
	GetByID(ctx context.Context, id string) (*Call, error)

	// UpdateStatus atomically transitions a call status with WHERE guard.
	// RFC-0008 §7.3: Atomic state validation.
	// Returns rows affected.
	UpdateStatus(ctx context.Context, id string, from, to CallStatus) (int64, error)

	// SetActive atomically transitions RINGING→ACTIVE and sets started_at.
	SetActive(ctx context.Context, id string, startedAt int64) (int64, error)

	// SetEnded atomically transitions to a terminal state and sets ended_at.
	SetEnded(ctx context.Context, id string, from CallStatus, to CallStatus, endedAt int64) (int64, error)

	// GetActiveByUserID finds RINGING or ACTIVE calls involving a user.
	// RFC-0008 §7.2: Single-Active check.
	GetActiveByUserID(ctx context.Context, userID string) ([]*Call, error)

	// TransitionStaleRinging transitions all RINGING calls older than a timestamp to MISSED.
	// RFC-0008 §7.5: Ring timeout.
	TransitionStaleRinging(ctx context.Context, olderThan int64) ([]string, error)

	// TransitionAllRingingToFailed transitions all RINGING calls to FAILED.
	// RFC-0008 §10.2: Crash recovery.
	TransitionAllRingingToFailed(ctx context.Context, endedAt int64) (int64, error)

	// TransitionAllActiveToEnded transitions all ACTIVE calls to ENDED.
	// RFC-0008 §10.2: Crash recovery.
	TransitionAllActiveToEnded(ctx context.Context, endedAt int64) (int64, error)

	// GetMissedCallsByCallee retrieves missed calls for a callee.
	GetMissedCallsByCallee(ctx context.Context, calleeID string, limit int) ([]*Call, error)

	// Delete hard-deletes a call record.
	Delete(ctx context.Context, id string) error
}

// PushSubscriptionRepository defines the data access contract for Web Push
// subscriptions. RFC-0009 §6.2.
type PushSubscriptionRepository interface {
	// Upsert is idempotent on (user_id, endpoint) (§6.1).
	// INSERT ... ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh_key=?, auth_secret=?
	// MUST NOT create a duplicate row and MUST NOT change id or created_at.
	Upsert(ctx context.Context, sub *PushSubscription) error

	// ListByUserID returns every subscription for fan-out (§6.4), created_at ASC.
	ListByUserID(ctx context.Context, userID string) ([]*PushSubscription, error)

	// CountByUserID is the cheap existence probe used by the trigger paths.
	CountByUserID(ctx context.Context, userID string) (int, error)

	// DeleteByUserAndEndpoint enforces ownership in the WHERE clause (§6.1, T2).
	DeleteByUserAndEndpoint(ctx context.Context, userID, endpoint string) (int64, error)

	// DeleteByID hard-deletes a stale subscription (§F1).
	DeleteByID(ctx context.Context, id string) (int64, error)

	// DeleteByUserID implements Hard Delete Cascade Step 5 (§6.3).
	DeleteByUserID(ctx context.Context, userID string) error
}

// ApplicationKeyRepository defines access to the singleton application_keys row.
type ApplicationKeyRepository interface {
	// GetByID returns ErrPush001 when absent (first boot).
	GetByID(ctx context.Context, id string) (*ApplicationKey, error)
	// Create persists the singleton row. MUST use INSERT (not upsert) so a
	// concurrent double-generation fails loudly on the PK constraint.
	Create(ctx context.Context, key *ApplicationKey) error
	// UpdateCAS atomically persists modifications only if the stored ciphertext matches expectedOldCiphertext.
	UpdateCAS(ctx context.Context, key *ApplicationKey, expectedOldCiphertext string) error
}

type SecurityEventRepository interface {
	Create(ctx context.Context, e *SecurityEvent) error
	Query(ctx context.Context, f SecurityEventFilter) ([]*SecurityEvent, *string, error)
	DeleteOlderThan(ctx context.Context, cutoffUnix int64, batchSize int) (int64, error)
}

type IPBlockRepository interface {
	Upsert(ctx context.Context, b *IPBlock) error
	GetByIPHash(ctx context.Context, ipHash string) (*IPBlock, error)
	ListBlocked(ctx context.Context) ([]*IPBlock, error)
}
