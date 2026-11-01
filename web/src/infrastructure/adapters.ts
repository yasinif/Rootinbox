/**
 * Composition root — wires infrastructure implementations to domain ports.
 * These adapters live in infrastructure but implement domain port interfaces.
 */

import { CryptoWorkerBridge } from './crypto/bridge';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete, apiPostBinary, apiPostBlob, apiPutBinary, apiGetBinary, setSessionInvalidatedCallback, setAuthToken } from './transport/rest/client';
import { WSClient } from './transport/websocket/client';
import { MessageRepository, OutboxRepository, MetadataRepository, ContactRepository, UnreadRepository } from './persistence';
import type {
  AuthPort, CryptoPort, MessagePort, OutboxPort,
  ConversationPort, DirectoryPort, MetadataPort,
  UserPort, UserSearchResult, UserProfile, ContactPort, ContactDTO,
  UnreadPort, VaultArchivePort, VaultMeta,
  EncryptParams, DecryptParams, StoredMessageDTO, OutboxEntryDTO,
  ConversationDTO, ConversationMemberDTO, GroupMessageDTO, CreateGroupParams,
  PeerInfo, HistoryItemDTO, SessionDTO, DeliveryAckDTO,
  KdfParamsDTO, ZKVaultDTO, ZKVaultPort, ZeroKnowledgeVaultPayload,
} from '../domain';
import sodium from 'libsodium-wrappers-sumo';
import {
  deriveMasterSeed,
  deriveAuthKeypair,
  deriveVaultKey as deriveStage1aVaultKey,
  deriveRecoveryKey,
  encryptZKVault,
  decryptZKVault,
  type AuthKeypairResult,
} from '../crypto';
import { mceDisplayText } from '../domain/protocol/content-envelope';

// ─── CryptoPort adapter (via Worker Bridge) ──────────────────
export function createCryptoPort(existingBridge?: CryptoWorkerBridge): CryptoPort {
  const bridge = existingBridge ?? new CryptoWorkerBridge();
  let cachedAuthKeypair: AuthKeypairResult | null = null;
  let cachedVaultKey: Uint8Array | null = null;

  return {
    async init(username: string, password: string) {
      const result = await bridge.call('init', { username, password }) as {
        identityHash: string; publicKey: string;
      };
      return { identityHash: result.identityHash, publicKey: result.publicKey };
    },
    async generateSessionKeys() {
      return bridge.call('generateSessionKeys') as Promise<{ publicKey: string; sessionId: string }>;
    },
    async exportSessionKeys() {
      return bridge.call('exportSessionKeys') as Promise<{ publicKey: string; privateKey: string; sessionId: string }>;
    },
    async importSessionKeys(keys: { publicKey: string; privateKey: string; sessionId?: string }) {
      await bridge.call('importSessionKeys', keys);
    },
    async importSessionKeyring(keys: Array<{ publicKey: string; privateKey: string; sessionId?: string }>) {
      await bridge.call('importSessionKeyring', keys);
    },
    async signSessionKey(sessionPK: string, expiresAt: number) {
      return bridge.call('signSessionKey', { sessionPK, expiresAt }) as Promise<{ signature: string; signatureHex: string }>;
    },
    async signLoginPayload(nonce: string, sessionPK: string, challengeId: string) {
      return bridge.call('signLoginPayload', { nonce, sessionPK, challengeId }) as Promise<{ signature: string }>;
    },
    async buildRegistrationWire(sessionPK: string, expiresAt: number) {
      return bridge.call('buildRegistrationWire', { sessionPK, expiresAt }) as Promise<{ wireBytes: Uint8Array; wireLength: number }>;
    },
    async encrypt(params: EncryptParams) {
      return bridge.call('encrypt', params) as Promise<{ ciphertextHex: string; sequence: string; ivHex: string }>;
    },
    async decrypt(params: DecryptParams) {
      return bridge.call('decrypt', params) as Promise<{ plaintext?: string; sequence?: string; dropped?: boolean; reason?: string }>;
    },
    async deriveVaultKey(username: string, password: string) {
      await bridge.call('deriveVaultKey', { username, password });
    },
    async vaultEncrypt(plaintext: string) {
      return bridge.call('vaultEncrypt', { plaintext }) as Promise<{ ciphertextHex: string; ivHex: string }>;
    },
    async vaultDecrypt(ciphertextHex: string, ivHex: string) {
      return bridge.call('vaultDecrypt', { ciphertextHex, ivHex }) as Promise<{ plaintext: string }>;
    },
    async allocateSequence() {
      return bridge.call('allocateSequence') as Promise<{ sequence: string }>;
    },
    async setOutgoingSequence(sequence: string) {
      return bridge.call('setOutgoingSequence', { sequence }) as Promise<{ sequence: string }>;
    },
    async persistKeys() {
      await bridge.call('persistKeys');
    },
    async restoreKeys() {
      const res = await bridge.call('restoreKeys') as { status: string; identityHash?: string; publicKey?: string };
      if (res && res.status === 'restored' && res.identityHash && res.publicKey) {
        return { identityHash: res.identityHash, publicKey: res.publicKey };
      }
      return null;
    },
    async clearKeys() {
      await bridge.call('clearKeys');
    },
    async deriveStage1aKeys(password: string, saltHexOrB64?: string) {
      await sodium.ready;
      let salt: Uint8Array;
      if (saltHexOrB64) {
        try {
          salt = sodium.from_hex(saltHexOrB64);
        } catch {
          try {
            salt = sodium.from_base64(saltHexOrB64, sodium.base64_variants.URLSAFE_NO_PADDING);
          } catch {
            salt = new TextEncoder().encode(saltHexOrB64);
          }
        }
      } else {
        salt = sodium.randombytes_buf(32);
      }

      const masterSeed = await deriveMasterSeed(password, { salt });
      const authKeypair = await deriveAuthKeypair(masterSeed);
      const vaultKey = await deriveStage1aVaultKey(masterSeed);
      const recoveryKey = await deriveRecoveryKey(masterSeed);

      cachedAuthKeypair = authKeypair;
      cachedVaultKey = vaultKey;

      return {
        authPubkey: authKeypair.authPublicKey,
        salt: sodium.to_hex(salt),
        recoveryKeyHex: sodium.to_hex(recoveryKey),
      };
    },
    async sealZKVault(payload: ZeroKnowledgeVaultPayload, version: number) {
      if (!cachedVaultKey || !cachedAuthKeypair) {
        throw new Error('Stage 1a keys not derived. Call deriveStage1aKeys first.');
      }
      const sealed = await encryptZKVault(payload, cachedVaultKey, cachedAuthKeypair.authPrivateKeyBytes, version);
      return {
        ciphertextHex: sealed.ciphertext,
        signatureHex: sealed.signature,
      };
    },
    async openZKVault(ciphertextHex: string, _signatureHex: string, version: number, userId: string) {
      if (!cachedVaultKey || !cachedAuthKeypair) {
        throw new Error('Stage 1a keys not derived. Call deriveStage1aKeys first.');
      }
      return decryptZKVault(ciphertextHex, cachedVaultKey, userId, version);
    },
    async destroy() {
      cachedAuthKeypair = null;
      cachedVaultKey = null;
      await bridge.call('destroy');
    },
  };
}

function hexToBase64Url(str: string): string {
  if (/^[0-9a-fA-F]{64}$/.test(str)) {
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(str.substring(i * 2, i * 2 + 2), 16);
    }
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      s += String.fromCharCode(bytes[i]);
    }
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  return str;
}

// ─── AuthPort adapter (REST) ─────────────────────────────────
export function createAuthPort(): AuthPort {
  return {
    async requestChallenge(identityHash: string) {
      const resp = await apiPost<{ nonce: string; challenge_id: string }>(
        '/api/v1/auth/challenge',
        { identity_hash: hexToBase64Url(identityHash) },
      );
      return { nonce: resp.data.nonce, challengeId: resp.data.challenge_id };
    },
    async getKdfParams(username: string): Promise<KdfParamsDTO> {
      const resp = await apiGet<KdfParamsDTO>(`/api/v1/auth/kdf-params?username=${encodeURIComponent(username)}`);
      return resp.data;
    },
    async register(
      wireBytes: Uint8Array,
      username?: string,
      displayName?: string,
      rememberMe?: boolean,
      authPubkey?: string,
      kdfSalt?: string,
    ) {
      const params = new URLSearchParams();
      if (username) params.set('username', username);
      if (displayName) params.set('display_name', displayName);
      if (rememberMe !== undefined) params.set('remember_me', String(rememberMe));
      const url = params.toString() ? `/api/v1/auth/register?${params.toString()}` : '/api/v1/auth/register';
      const headers: Record<string, string> = {};
      if (authPubkey) headers['X-Auth-Pubkey'] = authPubkey;
      if (kdfSalt) headers['X-KDF-Salt'] = kdfSalt;
      const resp = await apiPostBinary<{ user_id: string; session_id: string; session_token?: string; token?: string; identity_hash?: string }>(
        url,
        wireBytes,
        headers,
      );
      const token = resp.data.session_token || resp.data.token || resp.data.session_id;
      setAuthToken(token);
      return { session_token: token, user_id: resp.data.user_id, identity_hash: resp.data.identity_hash };
    },
    async verify(identityHash: string, challengeId: string, signature: string, sessionPublicKey: string, sessionSignature: string, sessionExpiresAt: number, rememberMe?: boolean) {
      const resp = await apiPost<{ user_id: string; session_id: string; session_token?: string; token?: string; identity_hash?: string }>(
        '/api/v1/auth/verify',
        {
          identity_hash: hexToBase64Url(identityHash),
          challenge_id: challengeId,
          signature,
          session_public_key: hexToBase64Url(sessionPublicKey),
          session_signature: hexToBase64Url(sessionSignature),
          session_expires_at: sessionExpiresAt,
          ...(rememberMe !== undefined ? { remember_me: rememberMe } : {}),
        },
      );
      const token = resp.data.session_token || resp.data.token || resp.data.session_id;
      setAuthToken(token);
      return { session_token: token, user_id: resp.data.user_id, identity_hash: resp.data.identity_hash };
    },
    async getWSTicket() {
      const resp = await apiGet<{ ticket: string }>('/api/v1/auth/ws-ticket');
      return resp.data;
    },
    async listSessions(): Promise<SessionDTO[]> {
      const resp = await apiGet<SessionDTO[]>('/api/v1/auth/sessions');
      return resp.data;
    },
    async terminateSession(sessionId: string): Promise<void> {
      await apiDelete(`/api/v1/auth/sessions/${encodeURIComponent(sessionId)}`);
    },
    async terminateOtherSessions(): Promise<void> {
      await apiPost('/api/v1/auth/sessions/terminate-others', {});
    },
  };
}

// ─── MessagePort adapter (Dexie) ─────────────────────────────
export function createMessagePort(): MessagePort {
  return {
    insertIfAbsent: (msg: StoredMessageDTO) => MessageRepository.insertIfAbsent(msg),
    getByConversation: (cid: string, limit: number, before?: number) => MessageRepository.getByConversation(cid, limit, before),
    getById: (id: string) => MessageRepository.getById(id),
    updatePlaintext: (id: string, pt: string) => MessageRepository.updatePlaintext(id, pt),
    updateVaultCiphertext: (id: string, ct: string, iv: string) => MessageRepository.updateVaultCiphertext(id, ct, iv),
    updateStatus: (id: string, status) => MessageRepository.updateStatus(id, status),
    updateGroupMessage: (id: string, updates) => MessageRepository.updateGroupMessage(id, updates),
    deleteMessage: (id: string) => MessageRepository.deleteMessage(id),
    deleteByConversation: (cid: string) => MessageRepository.deleteByConversation(cid),
  };
}

// ─── OutboxPort adapter (Dexie) ──────────────────────────────
export function createOutboxPort(): OutboxPort {
  return {
    enqueue: (entry: OutboxEntryDTO) => OutboxRepository.enqueue(entry),
    getQueued: (limit: number) => OutboxRepository.getQueued(limit),
    getById: (id: string) => OutboxRepository.getById(id),
    markInflight: (id: string) => OutboxRepository.markInflight(id),
    markSent: (id: string) => OutboxRepository.markSent(id),
    markFailed: (id: string) => OutboxRepository.markFailed(id),
    hasInflightForReceiver: (rid: string) => OutboxRepository.hasInflightForReceiver(rid),
    resetInflight: () => OutboxRepository.resetInflight(),
    resetInflightEntry: (id: string) => OutboxRepository.resetInflightEntry(id),
    deleteByConversation: (cid: string) => OutboxRepository.deleteByConversation(cid),
    delete: (id: string) => OutboxRepository.delete(id),
    markPermanentFailed: (id: string) => OutboxRepository.markPermanentFailed(id),
  };
}

// ─── ConversationPort adapter (REST) ─────────────────────────
export function createConversationPort(): ConversationPort {
  return {
    async list(cursor?: string, limit?: number) {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      if (limit) params.set('limit', String(limit));
      interface RawConversationItem {
        id?: string;
        conversation_id?: string;
        type?: string;
        created_at?: string | number;
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
        peer_last_read_at?: number;
        last_read_at?: number;
        my_last_read_at?: number;
        peer_last_delivered_at?: number;
        unread_count?: number;
        last_message?: unknown;
        last_unread_message?: unknown;
        cleared_at?: number;
      }
      interface ConversationListResponse {
        conversations?: RawConversationItem[];
      }
      const resp = await apiGet<RawConversationItem[] | ConversationListResponse>(
        `/api/v1/conversations${params.toString() ? `?${params}` : ''}`,
      );
      const rawList: RawConversationItem[] = Array.isArray(resp.data)
        ? resp.data
        : (resp.data as ConversationListResponse)?.conversations ?? [];

      const conversations: ConversationDTO[] = rawList.map((item: RawConversationItem) => {
        let createdAt = typeof item.created_at === 'number'
          ? item.created_at
          : (item.created_at ? Date.parse(item.created_at) || Date.now() : Date.now());
        if (createdAt < 10_000_000_000) {
          createdAt *= 1000;
        }
        let peerLastReadAt = item.peer_last_read_at;
        if (peerLastReadAt && peerLastReadAt < 10_000_000_000) {
          peerLastReadAt *= 1000;
        }
        let myLastReadAt = item.my_last_read_at ?? item.last_read_at;
        if (myLastReadAt && myLastReadAt < 10_000_000_000) {
          myLastReadAt *= 1000;
        }
        let peerLastDeliveredAt = item.peer_last_delivered_at;
        if (peerLastDeliveredAt && peerLastDeliveredAt < 10_000_000_000) {
          peerLastDeliveredAt *= 1000;
        }
        let clearedAt = item.cleared_at;
        if (clearedAt && clearedAt < 10_000_000_000) {
          clearedAt *= 1000;
        }

        const normalizeMsg = (m: unknown): GroupMessageDTO | null => {
          if (!m) return null;
          if (typeof m === 'string') {
            return {
              id: '',
              conversation_id: item.id ?? item.conversation_id ?? '',
              sender_id: '',
              content: mceDisplayText(m),
              created_at: createdAt,
              server_id: 0,
            };
          }
          if (typeof m === 'object' && m !== null) {
            const obj = m as Record<string, unknown>;
            const mTime = typeof obj.created_at === 'number'
              ? (obj.created_at < 10_000_000_000 ? obj.created_at * 1000 : obj.created_at)
              : (obj.created_at ? Date.parse(String(obj.created_at)) || createdAt : createdAt);
            const rawContent = String(obj.content ?? obj.text ?? '');
            return {
              id: String(obj.id ?? ''),
              conversation_id: String(obj.conversation_id ?? item.id ?? item.conversation_id ?? ''),
              sender_id: String(obj.sender_id ?? ''),
              content: mceDisplayText(rawContent),
              reply_to_id: obj.reply_to_id ? String(obj.reply_to_id) : undefined,
              created_at: mTime,
              server_id: typeof obj.server_id === 'number' ? obj.server_id : 0,
            };
          }
          return null;
        };

        return {
          id: item.id ?? item.conversation_id ?? '',
          type: item.type,
          created_at: createdAt,
          peer_id: item.peer_id,
          peer_identity_hash: item.peer_identity_hash,
          peer_username: item.peer_username,
          peer_display_name: item.peer_display_name,
          peer_last_name: item.peer_last_name,
          peer_user_id: item.peer_user_id,
          peer_online: item.peer_online,
          peer_last_seen_at: item.peer_last_seen_at && item.peer_last_seen_at < 10_000_000_000
            ? item.peer_last_seen_at * 1000
            : item.peer_last_seen_at,
          name: item.name,
          description: item.description,
          created_by: item.created_by,
          is_public: item.is_public,
          username: item.username,
          invite_code: item.invite_code,
          my_last_read_at: myLastReadAt,
          peer_last_read_at: peerLastReadAt,
          peer_last_delivered_at: peerLastDeliveredAt,
          unread_count: typeof item.unread_count === 'number' ? item.unread_count : undefined,
          last_message: normalizeMsg(item.last_message),
          last_unread_message: normalizeMsg(item.last_unread_message),
          cleared_at: clearedAt,
        };
      });

      const pagination = resp.meta?.pagination as { next_cursor?: string } | undefined;
      const nextCursor = pagination?.next_cursor;
      return {
        conversations,
        nextCursor: nextCursor ?? undefined,
      };
    },
    async create(peerIdentityHash: string) {
      const resp = await apiPost<{
        conversation_id?: string;
        id?: string;
        type?: string;
        created_at: number;
        peer_id?: string;
        peer_identity_hash?: string;
        peer_username?: string;
        peer_display_name?: string;
        peer_last_name?: string;
      }>(
        '/api/v1/conversations',
        { peer_identity_hash: peerIdentityHash },
      );
      const createdAt = resp.data.created_at < 10_000_000_000 ? resp.data.created_at * 1000 : resp.data.created_at;
      return {
        id: resp.data.conversation_id ?? resp.data.id ?? '',
        type: resp.data.type,
        created_at: createdAt,
        peer_id: resp.data.peer_id,
        peer_identity_hash: resp.data.peer_identity_hash,
        peer_username: resp.data.peer_username,
        peer_display_name: resp.data.peer_display_name,
        peer_last_name: resp.data.peer_last_name,
      };
    },
    async createSelf() {
      const resp = await apiPost<{
        conversation_id?: string;
        id?: string;
        type?: string;
        created_at: number;
        peer_id?: string;
        peer_identity_hash?: string;
      }>(
        '/api/v1/conversations/self',
      );
      const createdAt = resp.data.created_at < 10_000_000_000 ? resp.data.created_at * 1000 : resp.data.created_at;
      return {
        id: resp.data.conversation_id ?? resp.data.id ?? '',
        type: resp.data.type ?? 'SELF',
        created_at: createdAt,
        peer_id: resp.data.peer_id,
        peer_identity_hash: resp.data.peer_identity_hash,
      };
    },
    async createGroup(params: CreateGroupParams) {
      const resp = await apiPost<{
        conversation_id?: string;
        id?: string;
        type?: string;
        name?: string;
        description?: string;
        created_at: number;
        created_by?: string;
        is_public?: boolean;
        username?: string;
        invite_code?: string;
      }>(
        '/api/v1/conversations',
        {
          type: params.type,
          name: params.name,
          description: params.description,
          member_usernames: params.member_usernames,
          participant_ids: params.participant_ids,
          is_public: params.is_public,
          username: params.username,
        },
      );
      const createdAt = resp.data.created_at < 10_000_000_000 ? resp.data.created_at * 1000 : resp.data.created_at;
      return {
        id: resp.data.conversation_id ?? resp.data.id ?? '',
        type: resp.data.type,
        name: resp.data.name,
        description: resp.data.description,
        created_at: createdAt,
        created_by: resp.data.created_by,
        is_public: resp.data.is_public,
        username: resp.data.username,
        invite_code: resp.data.invite_code,
      };
    },
    async joinByInvite(code: string) {
      const resp = await apiPost<{
        conversation_id?: string;
        id?: string;
        type?: string;
        name?: string;
        description?: string;
        created_at: number;
        created_by?: string;
        is_public?: boolean;
        username?: string;
        invite_code?: string;
      }>(`/api/v1/invites/${encodeURIComponent(code)}/join`);
      const createdAt = resp.data.created_at < 10_000_000_000 ? resp.data.created_at * 1000 : resp.data.created_at;
      return {
        id: resp.data.conversation_id ?? resp.data.id ?? '',
        type: resp.data.type,
        name: resp.data.name,
        description: resp.data.description,
        created_at: createdAt,
        created_by: resp.data.created_by,
        is_public: resp.data.is_public,
        username: resp.data.username,
        invite_code: resp.data.invite_code,
      };
    },
    async joinPublic(username: string) {
      const clean = username.replace(/^@/, '');
      const resp = await apiPost<{
        conversation_id?: string;
        id?: string;
        type?: string;
        name?: string;
        description?: string;
        created_at: number;
        created_by?: string;
        is_public?: boolean;
        username?: string;
        invite_code?: string;
      }>(`/api/v1/public-conversations/${encodeURIComponent(clean)}/join`);
      const createdAt = resp.data.created_at < 10_000_000_000 ? resp.data.created_at * 1000 : resp.data.created_at;
      return {
        id: resp.data.conversation_id ?? resp.data.id ?? '',
        type: resp.data.type,
        name: resp.data.name,
        description: resp.data.description,
        created_at: createdAt,
        created_by: resp.data.created_by,
        is_public: resp.data.is_public,
        username: resp.data.username,
        invite_code: resp.data.invite_code,
      };
    },
    async searchPublic(query: string, limit = 20) {
      const resp = await apiGet<ConversationDTO[]>(
        `/api/v1/public-conversations/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      );
      const list = Array.isArray(resp.data) ? resp.data : [];
      return list.map((item) => ({
        ...item,
        created_at: item.created_at < 10_000_000_000 ? item.created_at * 1000 : item.created_at,
      }));
    },
    async getMembers(conversationId: string): Promise<ConversationMemberDTO[]> {
      const resp = await apiGet<ConversationMemberDTO[]>(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/members`,
      );
      return Array.isArray(resp.data) ? resp.data : [];
    },
    async addMember(conversationId: string, member: { userId?: string; username?: string; role?: string }): Promise<void> {
      await apiPost(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/members`,
        {
          user_id: member.userId,
          username: member.username,
          role: member.role,
        },
      );
    },
    async removeMember(conversationId: string, userId: string): Promise<void> {
      await apiDelete(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`,
      );
    },
    async updateMemberRole(conversationId: string, userId: string, role: string): Promise<void> {
      await apiPut(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/members/${encodeURIComponent(userId)}`,
        { role },
      );
    },
    async listGroupMessages(conversationId: string, cursor?: number | string, limit?: number): Promise<GroupMessageDTO[]> {
      const params = new URLSearchParams();
      if (cursor !== undefined && cursor !== null && cursor !== '') {
        params.set('cursor', String(cursor));
      }
      if (limit) {
        params.set('limit', String(limit));
      }
      const resp = await apiGet<GroupMessageDTO[]>(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages${params.toString() ? `?${params}` : ''}`,
      );
      return Array.isArray(resp.data) ? resp.data : [];
    },
    async sendGroupMessage(conversationId: string, content: string, replyToId?: string, clientMsgId?: string): Promise<GroupMessageDTO> {
      const resp = await apiPost<GroupMessageDTO>(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages`,
        { content, reply_to_id: replyToId, id: clientMsgId, request_id: clientMsgId },
      );
      return resp.data;
    },
    async editGroupMessage(conversationId: string, messageId: string, content: string): Promise<GroupMessageDTO> {
      const resp = await apiPatch<GroupMessageDTO>(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
        { content },
      );
      return resp.data;
    },
    async deleteGroupMessage(conversationId: string, messageId: string): Promise<void> {
      await apiDelete(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`,
      );
    },
    async getHistory(conversationId: string, cursor?: string | number, limit?: number) {
      const params = new URLSearchParams();
      if (cursor !== undefined && cursor !== null && cursor !== '') {
        params.set('cursor', String(cursor));
      }
      if (limit) {
        params.set('limit', String(limit));
      }
      const resp = await apiGet<HistoryItemDTO[]>(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/history${params.toString() ? `?${params}` : ''}`,
      );
      const pagination = resp.meta?.pagination as { next_cursor?: string } | undefined;
      return {
        items: Array.isArray(resp.data) ? resp.data : [],
        nextCursor: pagination?.next_cursor,
      };
    },
    async postHistory(conversationId: string, items: HistoryItemDTO[]) {
      await apiPost(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/history`,
        items,
      );
    },
    async deleteHistoryMessage(conversationId: string, messageId: string, mode?: 'me' | 'both') {
      const query = mode ? `?mode=${mode}` : '';
      await apiDelete(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/history/${encodeURIComponent(messageId)}${query}`,
      );
    },
    async clearHistory(conversationId: string, mode?: 'me' | 'both') {
      const scopeParam = mode || 'me';
      const query = `?scope=${scopeParam}&mode=${scopeParam}`;
      await apiDelete(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/history${query}`,
      );
    },
    async deleteConversation(conversationId: string, mode?: 'me' | 'both') {
      const scopeParam = mode || 'me';
      const query = `?scope=${scopeParam}&mode=${scopeParam}`;
      await apiDelete(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}${query}`,
      );
    },
    async markRead(conversationId: string, lastReadAt?: number) {
      await apiPost(
        `/api/v1/conversations/${encodeURIComponent(conversationId)}/read`,
        { last_read_at: lastReadAt || Date.now() },
      );
    },
    async getReadWatermarks(): Promise<{ watermarks: Record<string, number>; peer_watermarks?: Record<string, number> } | Record<string, number>> {
      try {
        const resp = await apiGet<{ watermarks?: Record<string, number>; peer_watermarks?: Record<string, number> }>('/api/v1/conversations/read-watermarks');
        return {
          watermarks: resp.data?.watermarks || {},
          peer_watermarks: resp.data?.peer_watermarks || {},
        };
      } catch {
        return { watermarks: {}, peer_watermarks: {} };
      }
    },
    async getDeliveryAcks(cursor?: number, limit = 100): Promise<DeliveryAckDTO[]> {
      try {
        const resp = await apiGet<DeliveryAckDTO[]>(
          `/api/v1/messages/delivery-acks?cursor=${cursor || 0}&limit=${limit}`,
        );
        return Array.isArray(resp.data) ? resp.data : [];
      } catch {
        return [];
      }
    },
  };
}

// ─── DirectoryPort adapter (REST with in-memory TTL cache) ───
export function createDirectoryPort(): DirectoryPort {
  const cache = new Map<string, { data: PeerInfo; expiresAt: number }>();
  const TTL_MS = 60_000; // 60 seconds TTL

  const invalidate = (key?: string) => {
    if (key) {
      const norm = key.trim().toLowerCase();
      cache.delete(norm);
    } else {
      cache.clear();
    }
  };

  return {
    invalidate,
    async lookup(identityHash: string): Promise<PeerInfo> {
      const now = Date.now();
      const normKey = identityHash.trim().toLowerCase();
      const cached = cache.get(normKey);
      if (cached && cached.expiresAt > now) {
        return cached.data;
      }

      try {
        const resp = await apiGet<{
          user_id: string;
          identity_hash?: string;
          identity_public_key: string;
          active_session?: {
            session_id: string;
            x25519_public_key: string;
            session_version: number;
          };
          sessions?: Array<{
            session_id: string;
            x25519_public_key: string;
            session_version: number;
          }>;
        }>(
          `/api/v1/directory/${identityHash}`,
        );

        const peerInfo: PeerInfo = {
          userId: resp.data.user_id,
          identityHash: resp.data.identity_hash,
          identityPublicKey: resp.data.identity_public_key,
          activeSession: resp.data.active_session ? {
            sessionId: resp.data.active_session.session_id,
            x25519PublicKey: resp.data.active_session.x25519_public_key,
            sessionVersion: resp.data.active_session.session_version,
          } : undefined,
          sessions: resp.data.sessions ? resp.data.sessions.map((s) => ({
            sessionId: s.session_id,
            x25519PublicKey: s.x25519_public_key,
            sessionVersion: s.session_version,
          })) : undefined,
        };

        const entry = { data: peerInfo, expiresAt: now + TTL_MS };
        cache.set(normKey, entry);
        if (resp.data.identity_hash) {
          cache.set(resp.data.identity_hash.trim().toLowerCase(), entry);
        }
        if (resp.data.user_id) {
          cache.set(resp.data.user_id.trim().toLowerCase(), entry);
        }

        return peerInfo;
      } catch (err) {
        // Invalidate cache on failure (404, session rotation, auth error)
        invalidate(normKey);
        throw err;
      }
    },
  };
}

export const createDirectoryAdapter = createDirectoryPort;

// ─── BASE64 DISCIPLINE Helpers ──────────────────────────────
/**
 * routing_id = base64URL-UNPADDED encoding of the UTF-8 bytes of receiver's user_id UUID string.
 * RFC-0005 §5.1 / Phase 12 precision rule.
 */
export function encodeRoutingId(receiverUserId: string): string {
  const bytes = new TextEncoder().encode(receiverUserId);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * payload = base64-STANDARD-WITH-PADDING of the ciphertext bytes.
 * RFC-0005 §5.1 / Phase 12 precision rule.
 */
export function hexToBase64StdPadded(hex: string): string {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex length');
  let binary = '';
  for (let i = 0; i < hex.length; i += 2) {
    binary += String.fromCharCode(parseInt(hex.substring(i, i + 2), 16));
  }
  return btoa(binary);
}

/**
 * Decode base64-STANDARD-WITH-PADDING payload from inbound WS frame to hex string.
 */
export function base64StdToHex(b64: string): string {
  const binary = atob(b64);
  let hex = '';
  for (let i = 0; i < binary.length; i++) {
    hex += binary.charCodeAt(i).toString(16).padStart(2, '0');
  }
  return hex;
}

// ─── MetadataPort adapter (Dexie) ────────────────────────────
export function createMetadataPort(): MetadataPort {
  return {
    get: (key: string) => MetadataRepository.get(key),
    set: (key: string, value: string) => MetadataRepository.set(key, value),
    delete: (key: string) => MetadataRepository.delete(key),
  };
}

// ─── UserPort adapter (REST) ─────────────────────────────────
export function createUserPort(): UserPort {
  return {
    async search(query: string, limit = 10): Promise<UserSearchResult[]> {
      const resp = await apiGet<UserSearchResult[]>(
        `/api/v1/users/search?q=${encodeURIComponent(query)}&limit=${limit}`,
      );
      return Array.isArray(resp.data) ? resp.data : [];
    },
    async getMe(): Promise<UserProfile> {
      const resp = await apiGet<UserProfile>('/api/v1/users/me');
      return resp.data;
    },
    async updateUsername(username: string | null): Promise<{ username: string | null }> {
      const resp = await apiPut<{ username: string | null }>('/api/v1/users/me/username', {
        username,
      });
      return resp.data;
    },
    async uploadAvatar(file: Blob | File): Promise<{ avatar_url: string; avatar_updated_at: number }> {
      const resp = await apiPostBlob<{ avatar_url: string; avatar_updated_at: number }>('/api/v1/users/me/avatar', file);
      return resp.data;
    },
    async deleteAvatar(): Promise<void> {
      await apiDelete('/api/v1/users/me/avatar');
    },
    getAvatarUrl(userId: string, updatedAt?: number): string {
      const base = `/api/v1/users/${encodeURIComponent(userId)}/avatar`;
      return updatedAt ? `${base}?t=${updatedAt}` : base;
    },
    async getProfile(userId: string): Promise<UserProfile> {
      const resp = await apiGet<UserProfile>(`/api/v1/users/${encodeURIComponent(userId)}/profile`);
      return resp.data;
    },
    async updateProfile(data: { display_name?: string | null; last_name?: string | null; bio?: string | null }): Promise<UserProfile> {
      const resp = await apiPut<UserProfile>('/api/v1/users/me/profile', data);
      return resp.data;
    },
  };
}

// ─── Vault REST Helpers (RFC-0006 §4.3) ──────────────────────
export async function uploadVaultArchive(monthYear: string, ciphertext: Uint8Array, hash: string, schemaVersion = 1): Promise<void> {
  await apiPutBinary(`/api/v1/vaults/${encodeURIComponent(monthYear)}`, ciphertext, {
    'X-Vault-Hash': hash,
    'X-Vault-Schema-Version': String(schemaVersion),
  });
}

export async function downloadVaultArchive(monthYear: string): Promise<ArrayBuffer> {
  return apiGetBinary(`/api/v1/vaults/${encodeURIComponent(monthYear)}`);
}

export async function listVaultArchives(): Promise<VaultMeta[]> {
  const resp = await apiGet<VaultMeta[]>('/api/v1/vaults');
  return Array.isArray(resp.data) ? resp.data : [];
}

// ─── VaultArchivePort adapter ────────────────────────────────
export function createVaultArchivePort(): VaultArchivePort {
  return {
    list: listVaultArchives,
    download: downloadVaultArchive,
    upload: uploadVaultArchive,
  };
}

// ─── ZKVaultPort adapter (Stage 1a) ──────────────────────────
export function createZKVaultPort(): ZKVaultPort {
  return {
    async getVault(): Promise<ZKVaultDTO | null> {
      try {
        const resp = await apiGet<ZKVaultDTO>('/api/v1/vault/current');
        return resp.data;
      } catch (err: unknown) {
        if (err && typeof err === 'object' && 'status' in err && (err as { status: number }).status === 404) {
          return null;
        }
        if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'VAULT_003') {
          return null;
        }
        throw err;
      }
    },
    async saveVault(expectedVersion: number, ciphertextHex: string, signatureHex: string): Promise<ZKVaultDTO> {
      const resp = await apiPut<ZKVaultDTO>('/api/v1/vault/current', {
        expected_version: expectedVersion,
        ciphertext: ciphertextHex,
        signature: signatureHex,
      });
      return resp.data;
    },
  };
}

// ─── ContactPort adapter (Dexie) ─────────────────────────────
export function createContactPort(): ContactPort {
  return {
    getAll: () => ContactRepository.getAll(),
    get: (peerUserId: string) => ContactRepository.get(peerUserId),
    save: (contact: ContactDTO) => ContactRepository.save(contact),
    delete: (peerUserId: string) => ContactRepository.delete(peerUserId),
  };
}

// ─── UnreadPort adapter (Dexie) ──────────────────────────────
export function createUnreadPort(): UnreadPort {
  return {
    get: (cid: string) => UnreadRepository.get(cid),
    set: (cid: string, count: number) => UnreadRepository.set(cid, count),
    increment: (cid: string) => UnreadRepository.increment(cid),
    clear: (cid: string) => UnreadRepository.clear(cid),
    getAll: () => UnreadRepository.getAll(),
  };
}

// ─── WSClient factory ────────────────────────────────────────
export { WSClient, setSessionInvalidatedCallback, setAuthToken };
export type { WSMessage } from './transport/websocket/client';
