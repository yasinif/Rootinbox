/**
 * Domain ports — interfaces consumed by use cases.
 * RFC-0010 §4.1: Usecases MUST NOT import infrastructure directly.
 * Dependency injection via these ports; composition root in main.tsx wires concrete implementations.
 */

// ─── AuthPort ────────────────────────────────────────────────
export interface RegisterParams {
  username: string;
  password: string;
}

export interface LoginParams {
  username: string;
  password: string;
}

export interface AuthResult {
  identityHash: string;
  publicKey: string;
  sessionToken?: string;
}

export interface ChallengeResult {
  nonce: string;
  challengeId: string;
}

export interface SessionDTO {
  id: string;
  device_label: string;
  ip_hash: string;
  last_active_at: number;
  created_at: number;
  is_current: boolean;
}

export interface AuthPort {
  requestChallenge(identityHash: string): Promise<ChallengeResult>;
  register(wireBytes: Uint8Array, username?: string, displayName?: string, rememberMe?: boolean): Promise<{ session_token: string; user_id?: string; identity_hash?: string }>;
  verify(identityHash: string, challengeId: string, signature: string, sessionPublicKey: string, sessionSignature: string, sessionExpiresAt: number, rememberMe?: boolean): Promise<{ session_token: string; user_id?: string; identity_hash?: string }>;
  getWSTicket(): Promise<{ ticket: string }>;
  listSessions(): Promise<SessionDTO[]>;
  terminateSession(sessionId: string): Promise<void>;
  terminateOtherSessions(): Promise<void>;
}

// ─── CryptoPort ──────────────────────────────────────────────
export interface CryptoPort {
  init(username: string, password: string): Promise<AuthResult>;
  generateSessionKeys(): Promise<{ publicKey: string; sessionId: string }>;
  exportSessionKeys?(): Promise<{ publicKey: string; privateKey: string; sessionId: string }>;
  importSessionKeys?(keys: { publicKey: string; privateKey: string; sessionId?: string }): Promise<void>;
  importSessionKeyring?(keys: Array<{ publicKey: string; privateKey: string; sessionId?: string }>): Promise<void>;
  signSessionKey(sessionPK: string, expiresAt: number): Promise<{ signature: string; signatureHex: string }>;
  signLoginPayload(nonce: string, sessionPK: string, challengeId: string): Promise<{ signature: string }>;
  buildRegistrationWire(sessionPK: string, expiresAt: number): Promise<{ wireBytes: Uint8Array; wireLength: number }>;
  encrypt(params: EncryptParams): Promise<EncryptResult>;
  decrypt(params: DecryptParams): Promise<DecryptResult>;
  deriveVaultKey(username: string, password: string): Promise<void>;
  vaultEncrypt(plaintext: string): Promise<{ ciphertextHex: string; ivHex: string }>;
  vaultDecrypt(ciphertextHex: string, ivHex: string): Promise<{ plaintext: string }>;
  allocateSequence(): Promise<{ sequence: string }>;
  setOutgoingSequence?(sequence: string): Promise<{ sequence: string }>;
  persistKeys?(): Promise<void>;
  restoreKeys?(): Promise<{ identityHash: string; publicKey: string } | null>;
  clearKeys?(): Promise<void>;
  destroy(): Promise<void>;
}

export interface EncryptParams {
  plaintext: string;
  receiverSessionPK: string;
  senderHash: string;
  receiverHash: string;
  convIdHash: string;
  clientUuid: string;
}

export interface EncryptResult {
  ciphertextHex: string;
  sequence: string;
  ivHex: string;
}

export interface DecryptParams {
  ciphertextHex: string;
  senderSessionPK: string;
  senderSessionPKs?: string[];
  senderHash: string;
  receiverHash: string;
  convIdHash: string;
  clientUuid: string;
}

export interface DecryptResult {
  plaintext?: string;
  sequence?: string;
  dropped?: boolean;
  reason?: string;
}

// ─── MessagePort ─────────────────────────────────────────────
export interface MessagePort {
  insertIfAbsent(msg: StoredMessageDTO): Promise<boolean>;
  getByConversation(conversationId: string, limit: number, beforeCreatedAt?: number): Promise<StoredMessageDTO[]>;
  getById(id: string): Promise<StoredMessageDTO | undefined>;
  updatePlaintext(id: string, plaintext: string): Promise<void>;
  updateVaultCiphertext?(id: string, vault_ciphertext: string, vault_iv: string): Promise<void>;
  updateStatus?(id: string, status: StoredMessageDTO['status']): Promise<void>;
  updateGroupMessage?(id: string, updates: Partial<StoredMessageDTO>): Promise<void>;
  deleteMessage?(id: string): Promise<void>;
  deleteByConversation?(conversationId: string): Promise<void>;
}

export interface StoredMessageDTO {
  id: string;
  conversation_id: string;
  sender_id: string;
  ciphertext: string;
  plaintext?: string;
  vault_ciphertext?: string;
  vault_iv?: string;
  sequence_str: string;
  created_at: number;
  status: 'pending' | 'sent' | 'delivered' | 'seen' | 'failed';
  reply_to_id?: string;
  edited_at?: number;
  deleted_at?: number;
  server_id?: number;
}

// ─── DeliveryAckDTO ──────────────────────────────────────────
export interface DeliveryAckDTO {
  id: number;
  sender_id: string;
  request_id: string;
  created_at: number;
}

// ─── OutboxPort ──────────────────────────────────────────────
export interface OutboxPort {
  enqueue(entry: OutboxEntryDTO): Promise<void>;
  getQueued(limit: number): Promise<OutboxEntryDTO[]>;
  getById?(id: string): Promise<OutboxEntryDTO | undefined>;
  markInflight(id: string): Promise<void>;
  markSent(id: string): Promise<void>;
  markFailed(id: string): Promise<boolean | void>;
  removeCompleted?(): Promise<void>;
  hasInflightForReceiver(receiverId: string): Promise<boolean>;
  resetInflight?(): Promise<void>;
  resetInflightEntry?(id: string): Promise<void>;
  deleteByConversation?(conversationId: string): Promise<void>;
  delete?(id: string): Promise<void>;
  markPermanentFailed?(id: string): Promise<void>;
}

export interface OutboxEntryDTO {
  id: string;
  conversation_id: string;
  receiver_id: string;
  ciphertext_hex: string;
  sequence_str: string;
  created_at: number;
  retry_count: number;
  status: 'queued' | 'inflight' | 'sent' | 'failed';
  inflight_at?: number;
  plaintext?: string;
  reply_to_id?: string;
}

// ─── ConversationPort ────────────────────────────────────────
export interface ConversationDTO {
  id: string;
  type?: string;
  created_at: number;
  peer_id?: string;
  peer_user_id?: string;
  peer_identity_hash?: string;
  peer_username?: string;
  peer_display_name?: string;
  peer_last_name?: string;
  peer_online?: boolean;
  peer_last_seen_at?: number;
  name?: string;
  description?: string;
  created_by?: string;
  is_public?: boolean;
  username?: string;
  invite_code?: string;
  my_last_read_at?: number;
  peer_last_read_at?: number;
  peer_last_delivered_at?: number;
  unread_count?: number;
  last_message?: GroupMessageDTO | null;
  last_unread_message?: GroupMessageDTO | null;
  cleared_at?: number;
}

export interface ConversationMemberDTO {
  user_id: string;
  username?: string;
  display_name?: string;
  last_name?: string;
  identity_hash: string;
  role: string;
  joined_at: number;
  avatar_updated_at?: number;
}

export interface GroupMessageDTO {
  id: string;
  conversation_id: string;
  sender_id: string;
  content: string;
  reply_to_id?: string;
  edited_at?: number;
  deleted_at?: number;
  created_at: number;
  server_id: number;
}

export interface CreateGroupParams {
  type: 'GROUP' | 'CHANNEL';
  name: string;
  description?: string;
  member_usernames?: string[];
  participant_ids?: string[];
  is_public?: boolean;
  username?: string;
}

export interface HistoryItemDTO {
  id: string;
  user_id?: string;
  conversation_id?: string;
  sender_id: string;
  receiver_id?: string;
  encrypted_payload: string;
  vault_iv: string;
  sequence_number: number;
  created_at: number;
  updated_at?: number;
  deleted_at?: number;
}

export interface ConversationPort {
  list(cursor?: string, limit?: number): Promise<{ conversations: ConversationDTO[]; nextCursor?: string }>;
  create(peerId: string): Promise<ConversationDTO>;
  createSelf(): Promise<ConversationDTO>;
  createGroup(params: CreateGroupParams): Promise<ConversationDTO>;
  joinByInvite(code: string): Promise<ConversationDTO>;
  joinPublic(username: string): Promise<ConversationDTO>;
  searchPublic(query: string, limit?: number): Promise<ConversationDTO[]>;
  getMembers(conversationId: string): Promise<ConversationMemberDTO[]>;
  addMember(conversationId: string, member: { userId?: string; username?: string; role?: string }): Promise<void>;
  removeMember(conversationId: string, userId: string): Promise<void>;
  updateMemberRole(conversationId: string, userId: string, role: string): Promise<void>;
  listGroupMessages(conversationId: string, cursor?: number | string, limit?: number): Promise<GroupMessageDTO[]>;
  sendGroupMessage(conversationId: string, content: string, replyToId?: string, clientMsgId?: string): Promise<GroupMessageDTO>;
  editGroupMessage(conversationId: string, messageId: string, content: string): Promise<GroupMessageDTO>;
  deleteGroupMessage(conversationId: string, messageId: string): Promise<void>;
  getHistory(conversationId: string, cursor?: string | number, limit?: number): Promise<{ items: HistoryItemDTO[]; nextCursor?: string }>;
  postHistory(conversationId: string, items: HistoryItemDTO[]): Promise<void>;
  deleteHistoryMessage(conversationId: string, messageId: string, mode?: 'me' | 'both'): Promise<void>;
  clearHistory(conversationId: string, mode?: 'me' | 'both'): Promise<void>;
  deleteConversation(conversationId: string, mode?: 'me' | 'both'): Promise<void>;
  markRead?(conversationId: string, lastReadAt?: number): Promise<void>;
  getReadWatermarks?(): Promise<{ watermarks: Record<string, number>; peer_watermarks?: Record<string, number> } | Record<string, number>>;
  getDeliveryAcks?(cursor?: number, limit?: number): Promise<DeliveryAckDTO[]>;
}

// ─── DirectoryPort ───────────────────────────────────────────
export interface DirectoryPort {
  lookup(identityHash: string): Promise<PeerInfo>;
  invalidate?(key?: string): void;
}

export interface PeerInfo {
  userId: string;
  identityHash?: string;
  identityPublicKey: string;
  activeSession?: {
    sessionId: string;
    x25519PublicKey: string;
    sessionVersion: number;
  };
  sessions?: Array<{
    sessionId: string;
    x25519PublicKey: string;
    sessionVersion: number;
  }>;
}

// ─── MetadataPort ────────────────────────────────────────────
export interface MetadataPort {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  getByPrefix?(prefix: string): Promise<Record<string, string>>;
}

// ─── UserPort (Amendment RFC-0002-A: Username search & profile, Bundle 4: Avatar) ─
export interface UserSearchResult {
  user_id: string;
  username: string;
  identity_hash: string;
  display_name?: string | null;
  last_name?: string | null;
  avatar_updated_at?: number;
}

export interface UserProfile {
  user_id: string;
  identity_hash?: string;
  username?: string | null;
  display_name?: string | null;
  last_name?: string | null;
  bio?: string | null;
  status?: string;
  created_at?: number;
  avatar_updated_at?: number;
  online?: boolean;
  last_seen_at?: number;
}

export interface UserPort {
  search(query: string, limit?: number): Promise<UserSearchResult[]>;
  getMe(): Promise<UserProfile>;
  updateUsername(username: string | null): Promise<{ username: string | null }>;
  uploadAvatar(file: Blob | File): Promise<{ avatar_url: string; avatar_updated_at: number }>;
  deleteAvatar(): Promise<void>;
  getAvatarUrl(userId: string, updatedAt?: number): string;
  getProfile(userId: string): Promise<UserProfile>;
  updateProfile(data: { display_name?: string | null; last_name?: string | null; bio?: string | null }): Promise<UserProfile>;
}

// ─── ContactPort (Bundle 1.2: Local Dexie Contact Store) ──────
export interface ContactDTO {
  peer_user_id: string;
  identity_hash: string;
  nickname: string;
  added_at: number;
}

export interface ContactPort {
  getAll(): Promise<ContactDTO[]>;
  get(peerUserId: string): Promise<ContactDTO | undefined>;
  save(contact: ContactDTO): Promise<void>;
  delete(peerUserId: string): Promise<void>;
}

// ─── UnreadPort ──────────────────────────────────────────────
export interface UnreadPort {
  get(conversationId: string): Promise<number>;
  set(conversationId: string, count: number): Promise<void>;
  increment(conversationId: string): Promise<number>;
  clear(conversationId: string): Promise<void>;
  getAll(): Promise<Record<string, number>>;
}

// ─── VaultArchivePort (RFC-0006 §4.3) ─────────────────────────
export interface VaultMeta {
  month_year: string;
  schema_version: number;
  uploaded_at: number;
}

export interface VaultArchivePort {
  list(): Promise<VaultMeta[]>;
  download(monthYear: string): Promise<ArrayBuffer>;
  upload(monthYear: string, ciphertext: Uint8Array, hash: string, schemaVersion?: number): Promise<void>;
}

