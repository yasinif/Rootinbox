/**
 * ChatUseCase — send/receive messages, ACK, outbox, reactive store.
 * RFC-0010 §4.1: UseCase may import domain only.
 *
 * Send pipeline:
 * - Sequence allocated BEFORE encryption in one Dexie transaction with the outbox row
 * - Retries retransmit byte-identical persisted ciphertext (never re-encrypt)
 * - One in-flight per receiver
 *
 * Receive pipeline order:
 * - version check (0x01) → replay check → decrypt → (success only) Accept + atomic persist → ack.client
 * - ACK on stored/duplicate/replay-dropped/version-dropped/peer-unresolved
 * - NOT on quota-exceeded or transport-closed or decrypt-failed
 * - Failed decrypt: window unchanged, ciphertext retained
 */

import type {
  CryptoPort, MessagePort as MsgPort, OutboxPort,
  ConversationPort, DirectoryPort, MetadataPort,
  StoredMessageDTO, PeerInfo, DecryptResult,
  ConversationMemberDTO, UnreadPort, ConversationDTO,
  HistoryItemDTO, GroupMessageDTO,
} from '../domain';
import {
  encodeRoutingId, hexToBase64StdPadded, base64StdToHex, generateUUID, toMillis,
  mceEncodeText, mceEncodeEdit, mceEncodeDeleteForBoth, mceEncodeMedia, mceEncodeCall, mceDisplayText, mceDecode,
  type MediaMetadata, type MCECallData,
} from '../domain';
import type { UploadMediaUseCase } from './media/UploadMediaUseCase';
import type { MediaRestClient } from '../domain/ports/media';

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  plaintext: string;
  messageType?: 'text' | 'media' | 'call';
  mediaMetadata?: MediaMetadata;
  fileName?: string;
  callMetadata?: MCECallData;
  createdAt: number;
  sequence?: number;
  status: 'pending' | 'sent' | 'delivered' | 'seen' | 'failed';
  replyToId?: string;
  editedAt?: number;
  deletedAt?: number;
  serverId?: number;
  isOutgoing?: boolean;
  uploadProgress?: number;
  uploadProgressBytes?: number;
  uploadTotalBytes?: number;
  uploadError?: string;
}

export interface PendingRawMessage {
  client_uuid: string;
  sender_id: string;
  payload: string;
  sequence_number?: number;
  conversation_id?: string;
  created_at?: number;
  server_id?: number;
}

export interface InboundResult {
  stored: boolean;
  isUnread: boolean;
  conversationId?: string;
  shouldAck: boolean;
}

export interface ChatState {
  conversations: ConversationItem[];
  activeConversationId: string | null;
  messages: ChatMessage[];
  sending: boolean;
  firstUnreadMessageId?: string | null;
  unreadDividerTimestamp?: number | null;
}

export { toMillis };

export interface ConversationItem {
  id: string;
  type?: string;
  createdAt: number;
  peerId?: string;
  peerUserId?: string;
  peerIdentityHash?: string;
  peer_display_name?: string;
  peer_last_name?: string;
  peer_username?: string;
  peerOnline?: boolean;
  peerLastSeenAt?: number;
  lastMessage?: string;
  lastMessageTime?: number;
  lastMessageSenderId?: string;
  name?: string;
  description?: string;
  createdBy?: string;
  unreadCount?: number;
  isPublic?: boolean;
  username?: string;
  inviteCode?: string;
  peerLastReadAt?: number;
  peerLastDeliveredAt?: number;
  myLastReadAt?: number;
  lastUnreadMessage?: string;
}

type ChatListener = (state: ChatState) => void;

export type SendErrorKind = 'permanent' | 'transient';

/**
 * Classifies send and outbox transmission errors per H4 requirements.
 * Transient (retry with backoff + retry cap): network drops, timeouts, 5xx server errors, 429 rate limit.
 * Permanent (mark failed, enable visible retry/delete): 400 bad request, 401 unauthorized, 403 forbidden, 404 not found, 413 payload too large.
 */
export function classifySendError(err: unknown): SendErrorKind {
  if (err && typeof err === 'object') {
    const status = 'status' in err && typeof (err as { status: unknown }).status === 'number'
      ? (err as { status: number }).status
      : 0;

    if (status > 0) {
      if (status === 429) return 'transient';
      if (status === 408) return 'transient';
      if (status >= 500) return 'transient';
      if (status >= 400 && status < 500) return 'permanent';
    }

    const code = 'code' in err && typeof (err as { code: unknown }).code === 'string'
      ? (err as { code: string }).code
      : '';
    if (code === 'RATE_LIMITED') return 'transient';
    if (code.startsWith('AUTH_') || code.startsWith('VAL_') || code === 'MED_C04' || code === 'MED_C06') {
      return 'permanent';
    }
  }

  return 'transient';
}

export class ChatUseCase {
  private cryptoPort: CryptoPort;
  private msgPort: MsgPort;
  private outboxPort: OutboxPort;
  private convPort: ConversationPort;
  private dirPort: DirectoryPort;
  private metadataPort: MetadataPort;
  private unreadPort?: UnreadPort;
  private listeners = new Set<ChatListener>();
  private recordedCallIds = new Set<string>();
  private processingInboundUuids = new Set<string>();
  private lastMessageTime = 0;
  private inflightWatchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  private readWatermarks = new Map<string, number>();
  private inFlightUploads = new Map<string, { abortController: AbortController; fileId?: string }>();
  private mediaRestClient?: MediaRestClient;
  private loadConversationsPromise: Promise<void> | null = null;
  private peerDirCache = new Map<string, PeerInfo>();
  private isFlushingOutbox = false;
  private deletedMessageIds = new Set<string>();
  private state: ChatState = {
    conversations: [],
    activeConversationId: null,
    messages: [],
    sending: false,
    firstUnreadMessageId: null,
  };
  private sendFn: ((msg: { type: string; [key: string]: unknown }) => void) | null = null;

  constructor(
    cryptoPort: CryptoPort,
    msgPort: MsgPort,
    outboxPort: OutboxPort,
    convPort: ConversationPort,
    dirPort: DirectoryPort,
    metadataPort: MetadataPort,
    unreadPort?: UnreadPort,
  ) {
    this.cryptoPort = cryptoPort;
    this.msgPort = msgPort;
    this.outboxPort = outboxPort;
    this.convPort = convPort;
    this.dirPort = dirPort;
    this.metadataPort = metadataPort;
    this.unreadPort = unreadPort;
    this.setupVisibilityListener();
  }

  /**
   * Hydrates conversation read watermarks from local persistence and server.
   * Decoupled from network calls: local hydration succeeds 100% offline.
   */
  async syncReadWatermarks(): Promise<void> {
    // 1. Hydrate in-memory cache directly from local persistent Dexie metadata (offline-safe)
    try {
      if (this.metadataPort.getByPrefix) {
        const localWatermarks = await this.metadataPort.getByPrefix('read_watermark_');
        for (const [key, val] of Object.entries(localWatermarks)) {
          const convId = key.replace('read_watermark_', '');
          const ts = parseInt(val, 10);
          if (!isNaN(ts) && ts > (this.readWatermarks.get(convId) || 0)) {
            this.readWatermarks.set(convId, ts);
          }
        }
      } else {
        const unreads = (await this.unreadPort?.getAll()) ?? {};
        const convIds = new Set([
          ...this.state.conversations.map((c) => c.id),
          ...Object.keys(unreads),
        ]);
        for (const id of convIds) {
          const local = await this.metadataPort.get(`read_watermark_${id}`);
          if (local) {
            const ts = parseInt(local, 10);
            if (!isNaN(ts) && ts > (this.readWatermarks.get(id) || 0)) {
              this.readWatermarks.set(id, ts);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[ChatUseCase] Failed to hydrate local watermarks:', err);
    }

    // 2. Fetch authoritative watermarks from server only if online
    if (!this.convPort.getReadWatermarks) return;
    try {
      const resp = await this.convPort.getReadWatermarks();
      let serverWatermarks: Record<string, number> = {};
      let peerWatermarks: Record<string, number> = {};
      if (resp && 'watermarks' in resp && typeof resp.watermarks === 'object') {
        serverWatermarks = (resp as { watermarks: Record<string, number>; peer_watermarks?: Record<string, number> }).watermarks || {};
        peerWatermarks = (resp as { watermarks: Record<string, number>; peer_watermarks?: Record<string, number> }).peer_watermarks || {};
      } else if (resp) {
        serverWatermarks = resp as Record<string, number>;
      }

      for (const [convId, ts] of Object.entries(serverWatermarks)) {
        const normTs = toMillis(ts);
        const current = this.readWatermarks.get(convId) || 0;
        if (normTs > current) {
          this.readWatermarks.set(convId, normTs);
          await this.metadataPort.set(`read_watermark_${convId}`, String(normTs));
        }
      }

      for (const [convId, pwm] of Object.entries(peerWatermarks)) {
        if (pwm) {
          void this.handleAckRead(convId, pwm);
        }
      }
    } catch (err) {
      console.warn('[ChatUseCase] Failed to fetch server read watermarks (offline):', err);
    }
  }

  private setupVisibilityListener(): void {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && this.state.activeConversationId) {
          this.markConversationSeen(this.state.activeConversationId).catch(() => {});
        }
      });
    }
  }

  private refreshUnreadTimeout: ReturnType<typeof setTimeout> | null = null;
  private refreshUnreadPromise: Promise<void> | null = null;
  private refreshUnreadResolve: (() => void) | null = null;

  private async refreshUnreadState(): Promise<void> {
    if (!this.unreadPort) return;
    if (!this.refreshUnreadPromise) {
      this.refreshUnreadPromise = new Promise((resolve) => {
        this.refreshUnreadResolve = resolve;
      });
    }
    if (this.refreshUnreadTimeout) clearTimeout(this.refreshUnreadTimeout);
    this.refreshUnreadTimeout = setTimeout(async () => {
      const unreads = await this.unreadPort!.getAll();
      this.state.conversations = this.state.conversations.map((c) => ({
        ...c,
        unreadCount: unreads[c.id] || 0,
      }));
      this.debouncedEmitConversations();
      const resolve = this.refreshUnreadResolve;
      this.refreshUnreadPromise = null;
      this.refreshUnreadResolve = null;
      if (resolve) resolve();
    }, 50);
    return this.refreshUnreadPromise;
  }

  private emitConvsTimeout: ReturnType<typeof setTimeout> | null = null;
  private debouncedEmitConversations(): void {
    if (this.emitConvsTimeout) clearTimeout(this.emitConvsTimeout);
    this.emitConvsTimeout = setTimeout(() => {
      const convs = [...this.state.conversations];
      convs.sort((a, b) => {
        if (a.type === 'SELF') return -1;
        if (b.type === 'SELF') return 1;
        const timeA = toMillis(a.lastMessageTime || a.createdAt);
        const timeB = toMillis(b.lastMessageTime || b.createdAt);
        return timeB - timeA;
      });
      const totalUnread = convs.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
      if (typeof document !== 'undefined') {
        document.title = totalUnread > 0 ? `(${totalUnread}) RootInbox` : 'RootInbox';
      }
      this.state.conversations = convs;
      this.emit({ conversations: convs });
    }, 10);
  }

  private updateConversationActivity(
    conversationId: string,
    lastMessage: string,
    timestamp: number,
  ): void {
    const normTimestamp = toMillis(timestamp);
    this.state.conversations = this.state.conversations.map((c) => {
      if (c.id === conversationId) {
        return {
          ...c,
          lastMessage,
          lastMessageTime: normTimestamp,
        };
      }
      return c;
    });
    this.debouncedEmitConversations();
  }

  private getNextTimestamp(): number {
    const now = Math.max(Date.now(), this.lastMessageTime + 1);
    this.lastMessageTime = now;
    return now;
  }

  private sortMessages(messages: ChatMessage[]): ChatMessage[] {
    return [...messages].sort((a, b) => {
      // If both messages have a server-assigned sequence ID, server order is authoritative
      // This protects message ordering from client clock skew (Scenario 13)
      if (a.serverId !== undefined && b.serverId !== undefined && a.serverId !== b.serverId) {
        return a.serverId - b.serverId;
      }
      if (a.createdAt !== b.createdAt) {
        return a.createdAt - b.createdAt;
      }
      if (a.sequence !== undefined && b.sequence !== undefined && a.sequence !== b.sequence) {
        return a.sequence - b.sequence;
      }
      return a.id.localeCompare(b.id);
    });
  }

  async processPendingBatch(messages: PendingRawMessage[]): Promise<string[]> {
    if (!messages || messages.length === 0) return [];

    const ackIds: string[] = [];
    const unreadDeltas = new Map<string, number>();

    if (this.state.conversations.length === 0) {
      await this.loadConversations(true);
    }

    for (const msg of messages) {
      try {
        const result = await this.handleInboundRaw({
          request_id: msg.client_uuid,
          sender_id: msg.sender_id,
          payload: msg.payload,
          sequence_number: msg.sequence_number,
          conversation_id: msg.conversation_id,
          created_at: msg.created_at,
        }, true);

        // Strict acknowledgment condition: never ACK failed ingestions
        if (result.shouldAck) {
          ackIds.push(msg.client_uuid);
        }

        // Only genuine incoming text messages increment unread badges
        if (result.isUnread && result.conversationId && result.conversationId !== this.state.activeConversationId) {
          const convId = result.conversationId;
          unreadDeltas.set(convId, (unreadDeltas.get(convId) || 0) + 1);
        }
      } catch (err) {
        console.warn('[ChatUseCase] Batch message processing error:', err);
      }
    }

    // Atomic batch unread update: exactly one set() call per conversation
    for (const [convId, delta] of unreadDeltas.entries()) {
      const current = (await this.unreadPort?.get(convId)) || 0;
      await this.unreadPort?.set(convId, current + delta);
    }

    if (ackIds.length > 0) {
      await this.refreshUnreadState();
      await this.loadConversations(true);
      if (this.state.activeConversationId) {
        await this.loadMessages(this.state.activeConversationId);
      }
    }

    return ackIds;
  }

  subscribe(listener: ChatListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): ChatState { return this.state; }

  private emit(patch: Partial<ChatState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  setWsSendFn(fn: (msg: { type: string; [key: string]: unknown }) => void): void {
    this.sendFn = fn;
  }

  setSendFn(fn: (msg: { type: string; [key: string]: unknown }) => void): void {
    this.sendFn = fn;
  }

  resetState(): void {
    this.state = {
      conversations: [],
      activeConversationId: null,
      messages: [],
      sending: false,
      firstUnreadMessageId: null,
    };
    this.recordedCallIds.clear();
    this.processingInboundUuids.clear();
    this.lastMessageTime = 0;
    this.emit(this.state);
  }

  async loadConversations(_skipSync = false): Promise<void> {
    void _skipSync;
    if (this.loadConversationsPromise) {
      return this.loadConversationsPromise;
    }
    this.loadConversationsPromise = this._loadConversationsInternal().finally(() => {
      this.loadConversationsPromise = null;
    });
    return this.loadConversationsPromise;
  }

  private async _loadConversationsInternal(): Promise<void> {
    let rawList: ConversationDTO[];
    try {
      const result = await this.convPort.list();
      rawList = result.conversations;
    } catch (err) {
      console.warn('[ChatUseCase] Failed to list conversations from server (offline):', err);
      rawList = this.state.conversations.map((c) => ({
        id: c.id,
        type: c.type,
        created_at: c.createdAt,
        peer_id: c.peerId,
        peer_user_id: c.peerUserId,
        peer_identity_hash: c.peerIdentityHash,
        peer_display_name: c.peer_display_name,
        peer_last_name: c.peer_last_name,
        peer_username: c.peer_username,
        peer_online: c.peerOnline,
        peer_last_seen_at: c.peerLastSeenAt,
        name: c.name,
        description: c.description,
        created_by: c.createdBy,
        is_public: c.isPublic,
        username: c.username,
        invite_code: c.inviteCode,
      }));
    }

    const unreads = (await this.unreadPort?.getAll()) ?? {};
    const rawConvs: ConversationItem[] = rawList.map((c) => {
      const serverLastMsg = c.last_message;
      const serverLastUnread = c.last_unread_message;
      const previewText = serverLastMsg?.content ? mceDisplayText(serverLastMsg.content) : '';
      const unreadPreviewText = serverLastUnread?.content ? mceDisplayText(serverLastUnread.content) : '';
      const lastTime = serverLastMsg ? toMillis(serverLastMsg.created_at) : toMillis(c.created_at);

      return {
        id: c.id,
        type: c.type,
        createdAt: toMillis(c.created_at),
        peerId: c.peer_id,
        peerUserId: c.peer_user_id,
        peerIdentityHash: c.peer_identity_hash,
        peer_display_name: c.peer_display_name,
        peer_last_name: c.peer_last_name,
        peer_username: c.peer_username,
        peerOnline: c.peer_online,
        peerLastSeenAt: c.peer_last_seen_at ? toMillis(c.peer_last_seen_at) : undefined,
        name: c.name,
        description: c.description,
        createdBy: c.created_by,
        isPublic: c.is_public,
        username: c.username,
        inviteCode: c.invite_code,
        unreadCount: c.unread_count !== undefined ? c.unread_count : (unreads[c.id] || 0),
        peerLastReadAt: c.peer_last_read_at ? toMillis(c.peer_last_read_at) : undefined,
        peerLastDeliveredAt: c.peer_last_delivered_at ? toMillis(c.peer_last_delivered_at) : undefined,
        myLastReadAt: c.my_last_read_at ? toMillis(c.my_last_read_at) : undefined,
        lastMessage: previewText,
        lastUnreadMessage: unreadPreviewText,
        lastMessageTime: lastTime,
        lastMessageSenderId: serverLastMsg?.sender_id,
      };
    });

    for (const conv of rawConvs) {
      if (conv.myLastReadAt) {
        this.readWatermarks.set(conv.id, conv.myLastReadAt);
        await this.metadataPort.set(`read_watermark_${conv.id}`, String(conv.myLastReadAt));
      }
      if (conv.unreadCount !== undefined) {
        await this.unreadPort?.set(conv.id, conv.unreadCount);
      }
      if (conv.peerLastReadAt) {
        void this.handleAckRead(conv.id, conv.peerLastReadAt);
      }
    }

    // Step 1: Pre-populate lastMessageTime and lastMessage preview BEFORE deduplication
    // This guarantees deduplication evaluates actual conversation activity and never discards history!
    const myUserId = (await this.metadataPort.get('user_id')) ?? '';
    const myIdentityHash = (await this.metadataPort.get('identity_hash')) ?? '';
    if (this.msgPort?.getByConversation) {
      await Promise.all(
        rawConvs.map(async (conv) => {
          if (conv.lastMessage || (conv.unreadCount !== undefined && conv.unreadCount > 0)) {
            return;
          }
          try {
            if (conv.peerLastReadAt) {
              void this.handleAckRead(conv.id, conv.peerLastReadAt);
            }

            let watermark = this.readWatermarks.get(conv.id);
            if (watermark === undefined) {
              const local = await this.metadataPort.get(`read_watermark_${conv.id}`);
              watermark = local ? parseInt(local, 10) : 0;
              this.readWatermarks.set(conv.id, watermark);
            }
            const normWatermark = toMillis(watermark);

            // Fetch stored messages for unread calculation and preview
            const allStored = await this.msgPort.getByConversation(conv.id, 100);

            // Sort non-deleted messages from oldest to newest by normalized created_at
            const nonDeleted = allStored
              .filter((m) => !m.deleted_at)
              .sort((a, b) => toMillis(a.created_at) - toMillis(b.created_at));

            // Strictly count unread messages:
            // a) sender is not current user (neither myUserId nor myIdentityHash)
            // b) created_at > watermark.last_read_at (after timestamp normalization)
            // c) not deleted, status !== 'seen'
            const unreadMsgs = nonDeleted.filter((m) => {
              const isSelf = m.sender_id === myUserId || m.sender_id === myIdentityHash || (m as unknown as Record<string, unknown>).sender_identity_hash === myIdentityHash;
              return !isSelf && toMillis(m.created_at) > normWatermark && m.status !== 'seen';
            });
            const calculatedUnreads = unreadMsgs.length;
            conv.unreadCount = calculatedUnreads;
            await this.unreadPort?.set(conv.id, calculatedUnreads);

            // Preview logic:
            // If unreadCount > 0, display newest unread message.
            // If unreadCount === 0, display newest message in that chat.
            let targetMsg: StoredMessageDTO | undefined;
            if (calculatedUnreads > 0 && unreadMsgs.length > 0) {
              targetMsg = unreadMsgs[unreadMsgs.length - 1];
            } else if (nonDeleted.length > 0) {
              targetMsg = nonDeleted[nonDeleted.length - 1];
            }

            if (targetMsg) {
              let preview = targetMsg.plaintext ? mceDisplayText(targetMsg.plaintext) : '';
              if (!preview && targetMsg.vault_ciphertext && targetMsg.vault_iv && this.cryptoPort.vaultDecrypt) {
                try {
                  const dec = await this.cryptoPort.vaultDecrypt(targetMsg.vault_ciphertext, targetMsg.vault_iv);
                  if (dec?.plaintext) {
                    preview = mceDisplayText(dec.plaintext);
                    targetMsg.plaintext = dec.plaintext;
                    void this.msgPort.updateGroupMessage?.(targetMsg.id, { plaintext: dec.plaintext });
                  }
                } catch {
                  /* ignore decryption failures for previews */
                }
              }
              if (preview) {
                conv.lastMessage = preview;
                conv.lastMessageTime = toMillis(targetMsg.created_at);
                conv.lastMessageSenderId = targetMsg.sender_id;
              }
            } else {
              if (!conv.lastMessage) {
                conv.lastMessage = '';
                conv.lastMessageTime = toMillis(conv.createdAt);
              }
            }
          } catch {
            /* ignore processing error for individual conversation */
          }
        })
      );
    }

    // Step 2: Bidirectional Cross-Indexed Deduplication (Handles divergent peerId & peerIdentityHash)
    const byId = new Map<string, ConversationItem>();
    const byPeerHash = new Map<string, ConversationItem>();
    const byPeerId = new Map<string, ConversationItem>();
    let selfConv: ConversationItem | null = null;

    for (const c of rawConvs) {
      if (c.type === 'SELF') {
        if (!selfConv || toMillis(c.lastMessageTime) > toMillis(selfConv.lastMessageTime)) {
          selfConv = c;
        }
        continue;
      }

      if (c.type !== 'DIRECT') {
        byId.set(c.id, c);
        continue;
      }

      // DIRECT conversation: check cross-matches by hash or peer ID
      const normHash = c.peerIdentityHash ? c.peerIdentityHash.toLowerCase() : null;
      const normPeerId = c.peerId ? c.peerId.toLowerCase() : null;

      let existing: ConversationItem | undefined;
      if (normHash && byPeerHash.has(normHash)) {
        existing = byPeerHash.get(normHash);
      } else if (normPeerId && byPeerId.has(normPeerId)) {
        existing = byPeerId.get(normPeerId);
      }

      if (!existing) {
        byId.set(c.id, c);
        if (normHash) byPeerHash.set(normHash, c);
        if (normPeerId) byPeerId.set(normPeerId, c);
      } else {
        // Merge metadata between duplicates (e.g., fill missing hash or peerId)
        if (!existing.peerIdentityHash && c.peerIdentityHash) {
          existing.peerIdentityHash = c.peerIdentityHash;
          if (normHash) byPeerHash.set(normHash, existing);
        }
        if (!existing.peerId && c.peerId) {
          existing.peerId = c.peerId;
          if (normPeerId) byPeerId.set(normPeerId, existing);
        }
        if (!existing.peer_display_name && c.peer_display_name) existing.peer_display_name = c.peer_display_name;
        if (!existing.peer_last_name && c.peer_last_name) existing.peer_last_name = c.peer_last_name;
        if (!existing.peer_username && c.peer_username) existing.peer_username = c.peer_username;
        if (!existing.peerUserId && c.peerUserId) existing.peerUserId = c.peerUserId;
        if (c.peerOnline !== undefined) existing.peerOnline = c.peerOnline;
        if (c.peerLastSeenAt) existing.peerLastSeenAt = Math.max(existing.peerLastSeenAt || 0, c.peerLastSeenAt);

        // Selection Priority: Conversation with message history wins
        const existingMsgTime = toMillis(existing.lastMessageTime);
        const newMsgTime = toMillis(c.lastMessageTime);

        let replace = false;
        if (newMsgTime > existingMsgTime) {
          replace = true;
        } else if (newMsgTime === existingMsgTime) {
          if ((c.unreadCount || 0) > (existing.unreadCount || 0)) {
            replace = true;
          } else if ((c.unreadCount || 0) === (existing.unreadCount || 0) && toMillis(c.createdAt) > toMillis(existing.createdAt)) {
            replace = true;
          }
        }

        if (replace) {
          byId.delete(existing.id);
          byId.set(c.id, c);
          if (normHash) byPeerHash.set(normHash, c);
          if (normPeerId) byPeerId.set(normPeerId, c);
        }
      }
    }

    const convs: ConversationItem[] = [];
    if (selfConv) convs.push(selfConv);
    convs.push(...Array.from(byId.values()));

    // Auto-create SELF conversation if absent
    const hasSelf = convs.some((c) => c.type === 'SELF');
    if (!hasSelf && this.convPort.createSelf) {
      try {
        const createdSelf = await this.convPort.createSelf();
        if (!convs.some((c) => c.type === 'SELF')) {
          convs.push({
            id: createdSelf.id,
            type: createdSelf.type ?? 'SELF',
            createdAt: toMillis(createdSelf.created_at),
            peerId: createdSelf.peer_id,
            peerIdentityHash: createdSelf.peer_identity_hash,
            unreadCount: 0,
          });
        }
      } catch {
        /* ignore error creating self conversation */
      }
    }

    // Sorting: SELF pinned to top, then newest active
    convs.sort((a, b) => {
      if (a.type === 'SELF') return -1;
      if (b.type === 'SELF') return 1;
      const timeA = Math.max(toMillis(a.lastMessageTime), toMillis(a.createdAt));
      const timeB = Math.max(toMillis(b.lastMessageTime), toMillis(b.createdAt));
      return timeB - timeA;
    });

    const totalUnread = convs.reduce((sum, c) => sum + (c.unreadCount || 0), 0);
    if (typeof document !== 'undefined') {
      document.title = totalUnread > 0 ? `(${totalUnread}) RootInbox` : 'RootInbox';
    }

    this.state.conversations = convs;
    this.emit({ conversations: convs });
  }

  async selectConversation(conversationId: string): Promise<void> {
    if (conversationId.startsWith('draft:') || !conversationId) {
      this.emit({
        activeConversationId: conversationId,
        messages: [],
        firstUnreadMessageId: null,
        unreadDividerTimestamp: null,
      });
      return;
    }

    const conv = this.state.conversations.find((c) => c.id === conversationId);
    const hadUnread = (conv?.unreadCount || 0) > 0;
    const lockedTimestamp = toMillis(conv?.myLastReadAt ?? this.readWatermarks.get(conversationId) ?? 0);
    const unreadBoundary = lockedTimestamp;

    // Immediately reset unread_count and lastUnreadMessage in local state so sidebar preview and badges update instantaneously
    this.state.conversations = this.state.conversations.map((c) => {
      if (c.id === conversationId) {
        return {
          ...c,
          unreadCount: 0,
          lastUnreadMessage: undefined,
        };
      }
      return c;
    });
    this.debouncedEmitConversations();

    this.emit({ activeConversationId: conversationId });

    // Load unified messages directly from server / local cache
    await this.loadMessages(conversationId);

    // Step 2: Compute firstUnreadId strictly for peer messages newer than unreadBoundary
    const myUserId = (await this.metadataPort.get('user_id')) ?? '';
    const myIdentityHash = (await this.metadataPort.get('identity_hash')) ?? '';
    const myUsername = (await this.metadataPort.get('username')) ?? '';
    const myIdLower = myUserId.toLowerCase();
    const myHashLower = myIdentityHash.toLowerCase();
    const myUserLower = myUsername.toLowerCase();

    let firstUnreadId: string | null = null;
    if (hadUnread) {
      const candidate = this.state.messages.find((m) => {
        const sId = (m.senderId || '').toLowerCase();
        const isOwn =
          Boolean(m.isOutgoing) ||
          sId === 'self' ||
          (Boolean(sId) && Boolean(myIdLower) && sId === myIdLower) ||
          (Boolean(sId) && Boolean(myHashLower) && sId === myHashLower) ||
          (Boolean(sId) && Boolean(myUserLower) && sId === myUserLower);
        return !isOwn && toMillis(m.createdAt) > unreadBoundary;
      });
      if (candidate) {
        firstUnreadId = candidate.id;
      }
    }

    // Retain firstUnreadMessageId and locked unreadDividerTimestamp visible to user while viewing
    this.emit({
      firstUnreadMessageId: firstUnreadId,
      unreadDividerTimestamp: hadUnread ? lockedTimestamp : null,
    });

    // Step 3: Mark seen locally and on server while keeping unread divider stable (clearFirstUnreadMarker = false)
    await this.markConversationSeen(conversationId, false);
  }

  async syncConversationHistory(conversationId: string, internalCall = false): Promise<boolean> {
    if (!conversationId || conversationId.startsWith('draft:')) return false;
    const conv = this.state.conversations.find((c) => c.id === conversationId);
    if (conv?.type === 'GROUP' || conv?.type === 'CHANNEL') return false;
    if (!this.convPort.getHistory || !this.cryptoPort.vaultDecrypt) return false;

    const cursorKey = `history_sync_cursor_${conversationId}`;
    const savedCursor = await this.metadataPort.get(cursorKey);
    let currentCursor = savedCursor ? parseInt(savedCursor, 10) : 0;
    const myIdentityHash = (await this.metadataPort.get('identity_hash')) ?? '';
    const watermark = this.readWatermarks.get(conversationId) || 0;

    let anyChanged = false;
    let keepFetching = true;
    const mySeenIds = new Set<string>();
    const peerSeenIds = new Set<string>();

    while (keepFetching) {
      let historyResult: { items: HistoryItemDTO[]; nextCursor?: string } | undefined;
      try {
        historyResult = await this.convPort.getHistory(conversationId, currentCursor > 0 ? currentCursor : undefined, 100);
      } catch {
        break;
      }

      const items = historyResult?.items ?? [];
      if (items.length === 0) break;

      // Single pass decryption: Decrypt each item ONCE and cache result
      interface DecryptedRecord {
        plaintext?: string;
        isSysSeen?: boolean;
        replyToId?: string;
      }
      const decryptedMap = new Map<string, DecryptedRecord>();

      for (const item of items) {
        if (item.encrypted_payload && item.vault_iv && this.cryptoPort.vaultDecrypt) {
          try {
            const dec = await this.cryptoPort.vaultDecrypt(item.encrypted_payload, item.vault_iv);
            if (dec?.plaintext) {
              const env = mceDecode(dec.plaintext);
              if (env?.t === 'sys' && env.s && Array.isArray(env.s)) {
                if (item.sender_id === myIdentityHash) {
                  for (const sid of env.s) mySeenIds.add(sid);
                } else {
                  for (const sid of env.s) peerSeenIds.add(sid);
                }
                decryptedMap.set(item.id, { isSysSeen: true });
              } else if (env?.t === 'text' && env.e) {
                await this.msgPort.updateGroupMessage?.(env.e, {
                  plaintext: mceEncodeText(env.b),
                  edited_at: item.created_at,
                });
                anyChanged = true;
                decryptedMap.set(item.id, { isSysSeen: true });
              } else if (env?.t === 'sys' && env.d) {
                this.deletedMessageIds.add(env.d);
                this.emit({ messages: this.state.messages.filter((m) => m.id !== env.d) });
                await this.msgPort.deleteMessage?.(env.d);
                anyChanged = true;
                decryptedMap.set(item.id, { isSysSeen: true });
              } else {
                decryptedMap.set(item.id, {
                  plaintext: dec.plaintext,
                  replyToId: env?.t === 'text' ? env.r : undefined,
                });
              }
            }
          } catch {
            decryptedMap.set(item.id, {});
          }
        }
      }

      // CRITICAL FIX (Attack 1): Apply seen status to all previously stored messages in Dexie!
      for (const seenId of peerSeenIds) {
        await this.msgPort.updateStatus?.(seenId, 'seen');
        anyChanged = true;
      }
      for (const seenId of mySeenIds) {
        await this.msgPort.updateStatus?.(seenId, 'seen');
        anyChanged = true;
      }

      // Ingestion pass: apply insertions, edits, deletions using cached decrypted values
      let maxCursor = currentCursor;
      for (const item of items) {
        const itemSyncTime = Math.max(item.updated_at ?? 0, item.created_at ?? 0);
        if (itemSyncTime > maxCursor) maxCursor = itemSyncTime;

        if (item.deleted_at && item.deleted_at > 0) {
          await this.msgPort.deleteMessage?.(item.id);
          anyChanged = true;
          continue;
        }

        const cached = decryptedMap.get(item.id);
        if (cached?.isSysSeen) continue;

        const isMe = item.sender_id === myIdentityHash;
        let status: StoredMessageDTO['status'] = isMe ? 'sent' : 'delivered';

        if (isMe) {
          // Outgoing messages are ONLY marked 'seen' if an authoritative peer seen receipt exists
          if (peerSeenIds.has(item.id)) {
            status = 'seen';
          } else {
            // Cross-reference delivery ACK metadata cache
            const isDelivered = (await this.metadataPort.get(`delivered_${item.id}`)) === '1';
            if (isDelivered) {
              status = 'delivered';
            }
          }
        } else {
          // Inbound messages: marked seen if acknowledged by local user receipt or created_at <= local read watermark
          if (mySeenIds.has(item.id) || toMillis(item.created_at) <= watermark) {
            status = 'seen';
          }
        }

        const existing = await this.msgPort.getById(item.id);
        const plaintextToSave = cached?.plaintext ?? existing?.plaintext;
        const replyToId = cached?.replyToId ?? existing?.reply_to_id;

        if (existing) {
          await this.msgPort.updateGroupMessage?.(item.id, {
            plaintext: plaintextToSave,
            reply_to_id: replyToId,
            status,
            vault_ciphertext: item.encrypted_payload,
            vault_iv: item.vault_iv,
          });
          anyChanged = true;
        } else {
          const storedMsg: StoredMessageDTO = {
            id: item.id,
            conversation_id: conversationId,
            sender_id: item.sender_id,
            ciphertext: '',
            plaintext: plaintextToSave,
            vault_ciphertext: item.encrypted_payload,
            vault_iv: item.vault_iv,
            sequence_str: String(item.sequence_number ?? 0),
            created_at: toMillis(item.created_at),
            status,
            reply_to_id: replyToId,
          };
          const inserted = await this.msgPort.insertIfAbsent(storedMsg);
          if (inserted) {
            anyChanged = true;
          }
        }
      }

      currentCursor = maxCursor;
      await this.metadataPort.set(cursorKey, String(currentCursor));

      if (items.length < 100) {
        keepFetching = false;
      }
    }

    // Update in-memory messages if active conversation
    const allSeenIds = new Set([...peerSeenIds, ...mySeenIds]);
    if (allSeenIds.size > 0 && this.state.activeConversationId === conversationId) {
      const updated = this.state.messages.map((m) =>
        allSeenIds.has(m.id) ? { ...m, status: 'seen' as const } : m
      );
      this.emit({ messages: updated });
    }

    // Update unread badge counter in unreadPort if not currently active conversation
    if (anyChanged && conversationId !== this.state.activeConversationId) {
      const stored = await this.msgPort.getByConversation(conversationId, 100);
      const unreadCount = stored.filter(
        (m) => m.sender_id !== myIdentityHash && m.status !== 'seen' && (toMillis(m.created_at) > watermark)
      ).length;
      await this.unreadPort?.set(conversationId, unreadCount);
      await this.refreshUnreadState();
    }

    if (anyChanged) {
      if (this.state.activeConversationId === conversationId && !internalCall) {
        await this.loadMessages(conversationId);
      }
      if (!internalCall) {
        await this.loadConversations(true);
      }
    }

    return anyChanged;
  }

  async syncAllConversationsHistory(): Promise<void> {
    if (!this.convPort.getHistory || !this.cryptoPort.vaultDecrypt) return;
    try {
      const convList = await this.convPort.list();
      for (const conv of convList.conversations) {
        if (conv.type === 'DIRECT' || conv.type === 'SELF') {
          try {
            await this.syncConversationHistory(conv.id, true);
          } catch (err) {
            console.warn(`[ChatUseCase] Failed to sync history for ${conv.id}:`, err);
          }
        }
      }
    } catch (err) {
      console.warn('[ChatUseCase] Failed to list conversations for history sync:', err);
    }
  }

  async markConversationSeen(conversationId: string, clearFirstUnreadMarker = true): Promise<void> {
    if (!conversationId) return;
    const now = Date.now();

    // 1. Persist locally in RAM and Dexie metadata
    this.readWatermarks.set(conversationId, now);
    await this.metadataPort.set(`read_watermark_${conversationId}`, String(now));

    // 2. Record on server (dispatches ack.read to participants without binary E2EE spam)
    if (this.convPort.markRead) {
      void Promise.resolve(this.convPort.markRead(conversationId, now)).catch(() => {});
    }

    // 3. Clear unread store (explicitly sets count: 0)
    await this.unreadPort?.clear(conversationId);
    await this.refreshUnreadState();

    // 4. Mark all local unread messages as 'seen'
    const myIdentityHash = (await this.metadataPort.get('identity_hash')) ?? '';
    const myUserId = (await this.metadataPort.get('user_id')) ?? '';
    const stored = await this.msgPort.getByConversation(conversationId, 100);
    const unseenIncoming = stored.filter(
      (m) => m.sender_id !== myIdentityHash && m.sender_id !== myUserId && m.status !== 'seen'
    );

    if (unseenIncoming.length > 0) {
      const ids: string[] = [];
      for (const m of unseenIncoming) {
        ids.push(m.id);
        await this.msgPort.updateStatus?.(m.id, 'seen');
      }

      if (this.state.activeConversationId === conversationId) {
        const updated = this.state.messages.map((m) =>
          ids.includes(m.id) ? { ...m, status: 'seen' as const } : m
        );
        this.emit({
          messages: updated,
          ...(clearFirstUnreadMarker ? { firstUnreadMessageId: null } : {}),
        });
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async sendSeenReceipt(_conversationId: string, _messageIds: string[], _peerIdentityHash?: string): Promise<void> {
    // Obsolete: read status is managed by read watermarks and convPort.markRead REST endpoint.
    // E2EE seen receipt frames over outbox are disabled to prevent binary message transmission.
  }

  async loadMessages(conversationId: string, beforeCreatedAt?: number): Promise<void> {
    let serverMessages: GroupMessageDTO[] | undefined;
    if (this.convPort.listGroupMessages && !conversationId.startsWith('draft:')) {
      try {
        serverMessages = await this.convPort.listGroupMessages(conversationId);
        const myUserId = (await this.metadataPort.get('user_id')) ?? '';
        const myIdentityHash = (await this.metadataPort.get('identity_hash')) ?? '';
        const conv = this.state.conversations.find((c) => c.id === conversationId);
        const isGroupOrChannel = conv?.type === 'GROUP' || conv?.type === 'CHANNEL';
        for (const gm of serverMessages) {
          const createdAt = toMillis(gm.created_at);
          const isDeleted = Boolean(gm.deleted_at && gm.deleted_at > 0);
          const isFromMe = Boolean(gm.sender_id && (gm.sender_id === myUserId || gm.sender_id === myIdentityHash));
          const storedMsg: StoredMessageDTO = {
            id: gm.id,
            conversation_id: gm.conversation_id,
            sender_id: gm.sender_id,
            ciphertext: '',
            plaintext: gm.content,
            sequence_str: '0',
            created_at: createdAt,
            status: isGroupOrChannel ? 'delivered' : (isFromMe ? 'sent' : 'delivered'),
            reply_to_id: gm.reply_to_id,
            edited_at: gm.edited_at ? toMillis(gm.edited_at) : undefined,
            deleted_at: isDeleted ? toMillis(gm.deleted_at!) : undefined,
            server_id: gm.server_id,
          };
          const inserted = await this.msgPort.insertIfAbsent(storedMsg);
          if (!inserted && (gm.edited_at || gm.deleted_at)) {
            await this.msgPort.updateGroupMessage?.(gm.id, {
              plaintext: gm.content,
              edited_at: gm.edited_at ? toMillis(gm.edited_at) : undefined,
              deleted_at: isDeleted ? toMillis(gm.deleted_at!) : undefined,
            });
          }
        }
      } catch (err) {
        console.warn('[ChatUseCase] listGroupMessages failed, using cached messages:', err);
      }
    }

    const stored = await this.msgPort.getByConversation(conversationId, 60, beforeCreatedAt);
    if (!beforeCreatedAt && serverMessages && serverMessages.length > 0) {
      const storedIds = new Set(stored.map((m) => m.id));
      const myUserId = (await this.metadataPort.get('user_id')) ?? '';
      const myIdentityHash = (await this.metadataPort.get('identity_hash')) ?? '';
      const conv = this.state.conversations.find((c) => c.id === conversationId);
      const isGroupOrChannel = conv?.type === 'GROUP' || conv?.type === 'CHANNEL';
      for (const gm of serverMessages) {
        if (!storedIds.has(gm.id)) {
          const createdAt = toMillis(gm.created_at);
          const isDeleted = Boolean(gm.deleted_at && gm.deleted_at > 0);
          const isFromMe = Boolean(gm.sender_id && (gm.sender_id === myUserId || gm.sender_id === myIdentityHash));
          stored.push({
            id: gm.id,
            conversation_id: gm.conversation_id,
            sender_id: gm.sender_id,
            ciphertext: '',
            plaintext: gm.content,
            sequence_str: '0',
            created_at: createdAt,
            status: isGroupOrChannel ? 'delivered' : (isFromMe ? 'sent' : 'delivered'),
            reply_to_id: gm.reply_to_id,
            edited_at: gm.edited_at ? toMillis(gm.edited_at) : undefined,
            deleted_at: isDeleted ? toMillis(gm.deleted_at!) : undefined,
            server_id: gm.server_id,
          });
          storedIds.add(gm.id);
        }
      }
    }
    const watermark = this.readWatermarks.get(conversationId) || 0;
    const myIdentityHash = (await this.metadataPort.get('identity_hash')) ?? '';
    const myUserId = (await this.metadataPort.get('user_id')) ?? '';
    const peerWatermarkStr = await this.metadataPort.get(`peer_read_watermark_${conversationId}`);
    const peerWatermark = peerWatermarkStr ? parseInt(peerWatermarkStr, 10) : 0;

    // Stage 1 & 2: Decrypt local vault copies if plaintext is missing
    for (const m of stored) {
      if ((!m.plaintext || m.plaintext === '') && m.vault_ciphertext && m.vault_iv && this.cryptoPort.vaultDecrypt) {
        try {
          const dec = await this.cryptoPort.vaultDecrypt(m.vault_ciphertext, m.vault_iv);
          if (dec?.plaintext) {
            m.plaintext = dec.plaintext;
            const isIncoming = m.sender_id !== myIdentityHash;
            const isAlreadySeen = m.status === 'seen';
            // Only incoming messages can be marked seen by the local watermark!
            const isSeenByWatermark = isIncoming && watermark > 0 && toMillis(m.created_at) <= watermark;
            const targetStatus = (isAlreadySeen || isSeenByWatermark) ? 'seen' : (m.status || 'delivered');
            m.status = targetStatus;
            await this.msgPort.updateGroupMessage?.(m.id, {
              plaintext: dec.plaintext,
              status: targetStatus,
            });
          }
        } catch {
          // Local vault decrypt failed
        }
      }
    }

    // Stage 3: Server vault consultation for any messages still missing plaintext
    const missingPlaintext = stored.filter((m) => !m.plaintext || m.plaintext === '');
    if (missingPlaintext.length > 0 && this.convPort.getHistory && this.cryptoPort.vaultDecrypt) {
      try {
        const { items } = await this.convPort.getHistory(conversationId, 0, 100);
        if (items && items.length > 0) {
          const itemMap = new Map(items.map((it) => [it.id, it]));
          for (const m of missingPlaintext) {
            const serverItem = itemMap.get(m.id);
            if (serverItem?.encrypted_payload && serverItem.vault_iv) {
              try {
                const dec = await this.cryptoPort.vaultDecrypt(serverItem.encrypted_payload, serverItem.vault_iv);
                if (dec?.plaintext) {
                  m.plaintext = dec.plaintext;
                  m.vault_ciphertext = serverItem.encrypted_payload;
                  m.vault_iv = serverItem.vault_iv;
                  const isIncoming = m.sender_id !== myIdentityHash;
                  const isAlreadySeen = m.status === 'seen';
                  // Only incoming messages can be marked seen by the local watermark!
                  const isSeenByWatermark = isIncoming && watermark > 0 && toMillis(m.created_at) <= watermark;
                  const targetStatus = (isAlreadySeen || isSeenByWatermark) ? 'seen' : (m.status || 'delivered');
                  m.status = targetStatus;
                  await this.msgPort.updateGroupMessage?.(m.id, {
                    plaintext: dec.plaintext,
                    vault_ciphertext: serverItem.encrypted_payload,
                    vault_iv: serverItem.vault_iv,
                    status: targetStatus,
                  });
                }
              } catch {
                // Server vault decrypt failed
              }
            }
          }
        }
      } catch {
        // Best effort server history consultation
      }
    }

    // Deduplicate call messages by callId
    const seenCallIds = new Set<string>();

    const messages: ChatMessage[] = [];
    for (const m of stored) {
      const envelope = m.plaintext ? mceDecode(m.plaintext) : null;
      const isMedia = envelope?.t === 'media';
      const isCall = envelope?.t === 'call';

      if (isCall && envelope?.c?.callId) {
        if (seenCallIds.has(envelope.c.callId)) {
          continue;
        }
        seenCallIds.add(envelope.c.callId);
      }

      let displayContent: string;
      if (m.plaintext) {
        displayContent = mceDisplayText(m.plaintext);
      } else if (m.vault_ciphertext) {
        displayContent = '[encrypted]';
      } else {
        // Ephemeral transport packet (such as a delete signal or receipt) that was never a vault chat message
        continue;
      }

      const replyToId = m.reply_to_id || (envelope?.t === 'text' ? envelope.r : undefined);
      const isOutgoing = Boolean(m.sender_id && (m.sender_id === myIdentityHash || m.sender_id === myUserId));
      let effectiveStatus = m.status;
      if (isOutgoing && effectiveStatus !== 'seen' && peerWatermark > 0 && toMillis(m.created_at) <= peerWatermark) {
        effectiveStatus = 'seen';
        void this.msgPort.updateStatus?.(m.id, 'seen');
      }

      messages.push({
        id: m.id,
        conversationId: m.conversation_id,
        senderId: m.sender_id,
        plaintext: displayContent,
        messageType: isMedia ? 'media' : isCall ? 'call' : 'text',
        mediaMetadata: isMedia ? envelope.m : undefined,
        fileName: isMedia ? envelope.f : undefined,
        callMetadata: isCall ? envelope.c : undefined,
        createdAt: toMillis(m.created_at),
        sequence: m.sequence_str ? Number(m.sequence_str) : undefined,
        status: effectiveStatus,
        replyToId,
        editedAt: m.edited_at ? toMillis(m.edited_at) : undefined,
        deletedAt: (m.deleted_at && m.deleted_at > 0) ? toMillis(m.deleted_at) : undefined,
        serverId: m.server_id,
        isOutgoing,
      });
    }

    // Preserve any live in-memory messages for this conversation received while loadMessages was in-flight,
    // excluding messages that were explicitly deleted
    const existingIds = new Set(messages.map((m) => m.id));
    for (const cur of this.state.messages) {
      if (cur.conversationId === conversationId && !existingIds.has(cur.id) && !this.deletedMessageIds.has(cur.id)) {
        messages.push(cur);
        existingIds.add(cur.id);
      }
    }

    const sorted = this.sortMessages(messages);
    if (sorted.length > 0) {
      const maxTime = Math.max(...sorted.map((m) => m.createdAt));
      if (maxTime > this.lastMessageTime) {
        this.lastMessageTime = maxTime;
      }
    }
    this.emit({ messages: sorted });
  }

  async loadEarlierMessages(conversationId: string): Promise<boolean> {
    if (!conversationId || conversationId.startsWith('draft:')) return false;

    const currentMessages = this.state.messages.filter((m) => m.conversationId === conversationId);
    if (currentMessages.length === 0) {
      await this.loadMessages(conversationId);
      return this.state.messages.filter((m) => m.conversationId === conversationId).length > 0;
    }

    const oldest = currentMessages.reduce(
      (prev, curr) => (curr.createdAt < prev.createdAt ? curr : prev),
      currentMessages[0],
    );
    const oldestCreatedAt = oldest.createdAt;
    const oldestServerId = oldest.serverId;

    // 1. Fetch earlier messages from local IndexedDB
    let earlierStored = await this.msgPort.getByConversation(conversationId, 50, oldestCreatedAt);

    // 2. If fewer than 50 in local, query server cursor
    if (earlierStored.length < 50 && this.convPort.listGroupMessages && oldestServerId && oldestServerId > 1) {
      try {
        const serverMessages = await this.convPort.listGroupMessages(conversationId, oldestServerId, 50);
        const myUserId = (await this.metadataPort.get('user_id')) ?? '';
        const myIdentityHash = (await this.metadataPort.get('identity_hash')) ?? '';
        const conv = this.state.conversations.find((c) => c.id === conversationId);
        const isGroupOrChannel = conv?.type === 'GROUP' || conv?.type === 'CHANNEL';

        for (const gm of serverMessages) {
          const createdAt = toMillis(gm.created_at);
          const isDeleted = Boolean(gm.deleted_at && gm.deleted_at > 0);
          const isFromMe = Boolean(gm.sender_id && (gm.sender_id === myUserId || gm.sender_id === myIdentityHash));
          const storedMsg: StoredMessageDTO = {
            id: gm.id,
            conversation_id: gm.conversation_id,
            sender_id: gm.sender_id,
            ciphertext: '',
            plaintext: gm.content,
            sequence_str: '0',
            created_at: createdAt,
            status: isGroupOrChannel ? 'delivered' : (isFromMe ? 'sent' : 'delivered'),
            reply_to_id: gm.reply_to_id,
            edited_at: gm.edited_at ? toMillis(gm.edited_at) : undefined,
            deleted_at: isDeleted ? toMillis(gm.deleted_at!) : undefined,
            server_id: gm.server_id,
          };
          await this.msgPort.insertIfAbsent(storedMsg);
        }

        earlierStored = await this.msgPort.getByConversation(conversationId, 50, oldestCreatedAt);
      } catch (err) {
        console.warn('[ChatUseCase] loadEarlierMessages server fetch failed:', err);
      }
    }

    if (earlierStored.length === 0) {
      return false;
    }

    const myIdentityHash = (await this.metadataPort.get('identity_hash')) ?? '';
    const myUserId = (await this.metadataPort.get('user_id')) ?? '';
    const peerWatermarkStr = await this.metadataPort.get(`peer_read_watermark_${conversationId}`);
    const peerWatermark = peerWatermarkStr ? parseInt(peerWatermarkStr, 10) : 0;

    const newChatMessages: ChatMessage[] = [];
    const existingIds = new Set(this.state.messages.map((m) => m.id));

    for (const m of earlierStored) {
      if (existingIds.has(m.id)) continue;
      const envelope = m.plaintext ? mceDecode(m.plaintext) : null;
      const isMedia = envelope?.t === 'media';
      const isCall = envelope?.t === 'call';
      const replyToId = m.reply_to_id || (envelope?.t === 'text' ? envelope.r : undefined);
      const isOutgoing = Boolean(m.sender_id && (m.sender_id === myIdentityHash || m.sender_id === myUserId));
      let effectiveStatus = m.status;
      if (isOutgoing && effectiveStatus !== 'seen' && peerWatermark > 0 && toMillis(m.created_at) <= peerWatermark) {
        effectiveStatus = 'seen';
      }

      newChatMessages.push({
        id: m.id,
        conversationId: m.conversation_id,
        senderId: m.sender_id,
        plaintext: m.plaintext ? mceDisplayText(m.plaintext) : '[encrypted]',
        messageType: isMedia ? 'media' : isCall ? 'call' : 'text',
        mediaMetadata: isMedia ? envelope.m : undefined,
        fileName: isMedia ? envelope.f : undefined,
        callMetadata: isCall ? envelope.c : undefined,
        createdAt: toMillis(m.created_at),
        sequence: m.sequence_str ? Number(m.sequence_str) : undefined,
        status: effectiveStatus,
        replyToId,
        editedAt: m.edited_at ? toMillis(m.edited_at) : undefined,
        deletedAt: (m.deleted_at && m.deleted_at > 0) ? toMillis(m.deleted_at) : undefined,
        serverId: m.server_id,
        isOutgoing,
      });
    }

    if (newChatMessages.length === 0) return false;

    const all = this.sortMessages([...this.state.messages, ...newChatMessages]);
    this.emit({ messages: all });
    return true;
  }

  private async ensureSessionKeys(): Promise<void> {
    try {
      const saved = await this.metadataPort.get('active_session_keypair');
      if (saved && this.cryptoPort.importSessionKeys) {
        const parsed = JSON.parse(saved);
        if (parsed.publicKey && parsed.privateKey) {
          await this.cryptoPort.importSessionKeys({
            publicKey: parsed.publicKey,
            privateKey: parsed.privateKey,
            sessionId: parsed.sessionId,
          });
        }
      }

      const savedKeyring = await this.metadataPort.get('session_keyring');
      if (savedKeyring && this.cryptoPort.importSessionKeyring) {
        const parsedKeyring = JSON.parse(savedKeyring);
        if (Array.isArray(parsedKeyring) && parsedKeyring.length > 0) {
          await this.cryptoPort.importSessionKeyring(parsedKeyring);
        }
      }

      const savedSeq = await this.metadataPort.get('outgoing_sequence');
      if (savedSeq && this.cryptoPort.setOutgoingSequence) {
        await this.cryptoPort.setOutgoingSequence(savedSeq);
      }
    } catch {
      // Session key restore best effort
    }
  }

  /**
   * Send a message.
   * Phase 1 & 7: Unified Cloud Messaging Pipeline for all conversation types (DIRECT, SELF, GROUP, CHANNEL).
   * Level-2 Security: Server AES-256-GCM encryption-at-rest.
   */
  async sendMessage(
    conversationId: string,
    plaintext: string,
    _peerIdentityHash?: string,
    replyToId?: string,
  ): Promise<void> {
    this.emit({ sending: true });
    try {
      let targetConvId = conversationId;
      if (conversationId.startsWith('draft:')) {
        const hash = conversationId.slice(6);
        targetConvId = await this.createConversation(hash, true);
      }

      const myHash = (await this.metadataPort.get('identity_hash')) ?? '';
      const myUserId = (await this.metadataPort.get('user_id')) ?? '';

      const conv = this.state.conversations.find((c) => c.id === targetConvId);
      const isGroupOrChannel = conv?.type === 'GROUP' || conv?.type === 'CHANNEL';

      // For direct/self conversations: encode text envelope with MCE v1 unless already MCE
      // For group/channel conversations: retain raw content string
      const storedContent = isGroupOrChannel
        ? plaintext
        : (plaintext.startsWith('{"v":1,') ? plaintext : mceEncodeText(plaintext, replyToId));

      let groupMsg: GroupMessageDTO | undefined;
      let sendFailed = false;
      let sendErrorKind: SendErrorKind = 'transient';
      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        sendFailed = true;
        sendErrorKind = 'transient';
      } else if (this.convPort.sendGroupMessage) {
        try {
          groupMsg = await this.convPort.sendGroupMessage(targetConvId, plaintext, replyToId);
        } catch (err) {
          sendFailed = true;
          sendErrorKind = classifySendError(err);
          console.warn(`[ChatUseCase] sendGroupMessage failed (${sendErrorKind}):`, err);
        }
      } else {
        sendFailed = true;
        sendErrorKind = 'transient';
      }

      const msgId = groupMsg?.id || generateUUID();
      const createdAt = (groupMsg?.created_at ? toMillis(groupMsg.created_at) : undefined) || this.getNextTimestamp();
      const initialStatus = sendFailed
        ? (sendErrorKind === 'permanent' ? 'failed' : 'pending')
        : (isGroupOrChannel ? 'delivered' : 'sent');
      const storedMsg: StoredMessageDTO = {
        id: msgId,
        conversation_id: targetConvId,
        sender_id: groupMsg?.sender_id || myUserId || myHash,
        ciphertext: '',
        plaintext: groupMsg?.content ? (isGroupOrChannel ? groupMsg.content : storedContent) : storedContent,
        sequence_str: '0',
        created_at: createdAt,
        status: initialStatus,
        reply_to_id: replyToId || groupMsg?.reply_to_id,
        server_id: groupMsg?.server_id,
      };
      await this.msgPort.insertIfAbsent(storedMsg);

      if (sendFailed) {
        await this.outboxPort.enqueue({
          id: msgId,
          conversation_id: targetConvId,
          receiver_id: conv?.peerId || conv?.peerUserId || targetConvId,
          ciphertext_hex: '',
          plaintext: plaintext,
          reply_to_id: replyToId,
          sequence_str: '0',
          created_at: createdAt,
          retry_count: 0,
          status: sendErrorKind === 'permanent' ? 'failed' : 'queued',
        });
      }

      this.updateConversationActivity(targetConvId, mceDisplayText(plaintext), createdAt);
      await this.loadMessages(targetConvId);
    } finally {
      this.emit({ sending: false, firstUnreadMessageId: null, unreadDividerTimestamp: null });
    }
  }

  /**
   * Send a media message.
   * Encodes MediaMetadata as MCE v1 JSON and routes through the unified message pipeline.
   */
  async sendMedia(
    conversationId: string,
    metadata: MediaMetadata,
    peerIdentityHash?: string,
    fileName?: string,
  ): Promise<void> {
    const mcePayload = mceEncodeMedia(metadata, fileName);
    await this.sendMessage(conversationId, mcePayload, peerIdentityHash);
  }

  /**
   * Optimistically inject a media message and upload in the background without blocking text input.
   */
  async uploadMediaMessage(
    conversationId: string,
    file: File | Blob,
    fileNameOrUploadUC?: string | UploadMediaUseCase,
    uploadUseCase?: UploadMediaUseCase,
    caption?: string,
    previewDataUrl?: string,
    mimeType?: string,
    existingMsgId?: string,
  ): Promise<void> {
    if (!file || file.size <= 0) {
      console.warn('[ChatUseCase] uploadMediaMessage: cannot upload empty file');
      return;
    }

    let fileName = (file as File).name || 'upload.bin';
    let effectiveUploadUC = uploadUseCase;

    if (typeof fileNameOrUploadUC === 'string') {
      fileName = fileNameOrUploadUC;
    } else if (fileNameOrUploadUC && 'execute' in fileNameOrUploadUC && typeof fileNameOrUploadUC.execute === 'function') {
      effectiveUploadUC = fileNameOrUploadUC;
    }

    if (!effectiveUploadUC) {
      effectiveUploadUC = (this as unknown as Record<string, unknown>).uploadMediaUC as UploadMediaUseCase | undefined;
      if (!effectiveUploadUC && import.meta.env.VITE_E2E === 'true' && typeof window !== 'undefined') {
        const globalObj = window as unknown as Record<string, unknown>;
        effectiveUploadUC = globalObj.__uploadMediaUC as UploadMediaUseCase | undefined;
      }
    }

    let targetConvId = conversationId;
    let targetPeerHash: string | undefined;
    if (conversationId.startsWith('draft:')) {
      targetPeerHash = conversationId.slice(6);
      targetConvId = await this.createConversation(targetPeerHash, true);
    }

    const targetMsgId = existingMsgId || generateUUID();
    const now = this.getNextTimestamp();
    let myHash = (await this.metadataPort.get('identity_hash')) ?? '';
    let myUserId = (await this.metadataPort.get('user_id')) ?? '';
    if (!myHash && typeof sessionStorage !== 'undefined') {
      myHash = sessionStorage.getItem('identity_hash') || '';
    }
    if (!myUserId && typeof sessionStorage !== 'undefined') {
      myUserId = sessionStorage.getItem('user_id') || '';
    }
    if (!myUserId && !myHash && this.dirPort && 'getMe' in this.dirPort) {
      try {
        const me = await (this.dirPort as { getMe?: () => Promise<{ user_id?: string; identity_hash?: string }> }).getMe?.();
        if (me?.user_id) {
          myUserId = me.user_id;
          await this.metadataPort.set('user_id', me.user_id);
        }
        if (me?.identity_hash) {
          myHash = me.identity_hash;
          await this.metadataPort.set('identity_hash', me.identity_hash);
        }
      } catch {
        // ignore best effort retrieval
      }
    }

    const effectiveMime = mimeType || (file instanceof File ? file.type : 'application/octet-stream') || 'application/octet-stream';

    // 1. Inject optimistic ChatMessage or reset existing failed message on retry
    const optimisticMsg: ChatMessage = {
      id: targetMsgId,
      conversationId: targetConvId,
      senderId: myUserId || myHash || 'me',
      plaintext: caption ? `[Media: ${fileName}] ${caption}` : `[Media: ${fileName}]`,
      messageType: 'media',
      mediaMetadata: {
        file_id: targetMsgId,
        media_key: '',
        file_iv_prefix: '',
        media_token: '',
        original_size: file.size,
        total_chunks: Math.ceil(file.size / 5242880) || 1,
        file_manifest_hash: '',
        mime_type: effectiveMime,
        inline_thumbnail: null,
        preview_data_url: previewDataUrl,
        caption: caption || undefined,
        file_name: fileName,
      },
      fileName,
      createdAt: now,
      status: 'pending',
      isOutgoing: true,
      uploadProgress: 0,
      uploadProgressBytes: 0,
      uploadTotalBytes: file.size,
    };

    if (this.state.activeConversationId === targetConvId) {
      const exists = this.state.messages.some((m) => m.id === targetMsgId);
      if (exists) {
        const updated = this.state.messages.map((m) =>
          m.id === targetMsgId
            ? {
                ...m,
                status: 'pending' as const,
                uploadProgress: 0,
                uploadProgressBytes: 0,
                uploadTotalBytes: file.size,
                uploadError: undefined,
              }
            : m,
        );
        this.emit({ messages: updated });
      } else {
        this.emit({
          messages: this.sortMessages([...this.state.messages, optimisticMsg]),
        });
      }
    }

    const abortController = new AbortController();
    this.inFlightUploads.set(targetMsgId, { abortController });

    // 2. Run upload in background (non-blocking!)
    void (async () => {
      try {
        if (!effectiveUploadUC && !uploadUseCase) {
          throw new Error('UploadMediaUseCase instance not available');
        }
        const metadata = await (effectiveUploadUC || uploadUseCase)!.execute({
          file,
          fileName,
          mimeType: effectiveMime,
          conversationId: targetConvId,
          direct: true,
          previewDataUrl,
          signal: abortController.signal,
          onFileIdAllocated: (fileId) => {
            const current = this.inFlightUploads.get(targetMsgId);
            if (current) current.fileId = fileId;
          },
          observer: {
            onProgress: (p) => {
              const pct = p.totalBytes > 0 ? Math.round((p.bytesUploaded / p.totalBytes) * 100) : 0;
              if (this.state.activeConversationId === targetConvId) {
                const updated = this.state.messages.map((m) =>
                  m.id === targetMsgId
                    ? {
                        ...m,
                        uploadProgress: pct,
                        uploadProgressBytes: p.bytesUploaded,
                        uploadTotalBytes: p.totalBytes,
                      }
                    : m,
                );
                this.emit({ messages: updated });
              }
            },
            onComplete: () => {},
            onError: (err) => {
              if (this.state.activeConversationId === targetConvId) {
                const updated = this.state.messages.map((m) =>
                  m.id === targetMsgId
                    ? {
                        ...m,
                        status: 'failed' as const,
                        uploadError: typeof err === 'string' ? err : 'Upload failed',
                      }
                    : m,
                );
                this.emit({ messages: updated });
              }
            },
          },
        });

        if (abortController.signal.aborted || !this.inFlightUploads.has(targetMsgId)) {
          console.log('[ChatUseCase] upload was cancelled/aborted, skipping sendMedia');
          return;
        }

        const finalizedMetadata: MediaMetadata = {
          ...metadata,
          preview_data_url: previewDataUrl,
          caption: caption || undefined,
          file_name: fileName,
        };

        if (abortController.signal.aborted || !this.inFlightUploads.has(targetMsgId)) {
          return;
        }

        // Complete message delivery FIRST before removing optimistic bubble
        await this.sendMedia(targetConvId, finalizedMetadata, targetPeerHash, fileName);

        if (this.state.activeConversationId === targetConvId) {
          this.emit({
            messages: this.state.messages.filter((m) => m.id !== targetMsgId),
          });
        }
      } catch (err) {
        const isAbort = abortController.signal.aborted ||
          (err && typeof err === 'object' && ('name' in err && (err as { name: string }).name === 'AbortError' || 'code' in err && (err as { code: string }).code === 'MED_UPLOAD_ABORTED'));
        if (isAbort) {
          console.log('[ChatUseCase] upload cancelled by user, removing bubble');
          if (this.state.activeConversationId === targetConvId) {
            this.emit({
              messages: this.state.messages.filter((m) => m.id !== targetMsgId),
            });
          }
          await this.outboxPort.delete?.(targetMsgId).catch(() => {});
          await this.msgPort.deleteMessage?.(targetMsgId).catch(() => {});
          return;
        }

        console.error('[ChatUseCase] uploadMediaMessage failed:', err);
        if (this.state.activeConversationId === targetConvId) {
          const updated = this.state.messages.map((m) =>
            m.id === targetMsgId
              ? {
                  ...m,
                  status: 'failed' as const,
                  uploadError: err instanceof Error ? err.message : 'Upload failed',
                }
              : m,
          );
          this.emit({ messages: updated });
        }
      } finally {
        this.inFlightUploads.delete(targetMsgId);
      }
    })();
  }

  /**
   * Process an inbound message from WebSocket.
   * RECEIVE PIPELINE ORDER:
   * 1. version check (0x01)
   * 2. replay check
   * 3. decrypt
   * 4. on SUCCESS ONLY: persist to Dexie
   * 5. send ack.client
   * On decrypt failure: replay window byte-for-byte unchanged, store ciphertext row, do NOT ack.
   */
  async handleInboundRaw(msg: {
    v?: number;
    type?: string;
    request_id?: string;
    client_uuid?: string;
    sender_id: string;
    payload?: string; // base64-standard-padded
    sequence_number?: number;
    conversation_id?: string;
    created_at?: number;
  }, skipUIUpdate = false): Promise<InboundResult> {
    const clientUuid = msg.request_id || msg.client_uuid || '';
    const ciphertextHex = msg.payload ? base64StdToHex(msg.payload) : '';
    const seqNum = msg.sequence_number ?? 0;
    const msgCreatedAt = msg.created_at ? toMillis(msg.created_at) : this.getNextTimestamp();

    const myUserId = (await this.metadataPort.get('user_id')) ?? '';
    const myIdentityHash = (await this.metadataPort.get('identity_hash')) ?? '';

    // If unauthenticated or no credentials, do NOT process or ACK message
    if (!myIdentityHash) {
      return { stored: false, isUnread: false, shouldAck: false };
    }

    // In-memory concurrent deduplication
    if (this.processingInboundUuids.has(clientUuid)) {
      return { stored: false, isUnread: false, shouldAck: false };
    }
    this.processingInboundUuids.add(clientUuid);

    try {
      // Local database deduplication
      const alreadyStored = await this.msgPort.getById(clientUuid);
      if (alreadyStored && alreadyStored.plaintext) {
        if (this.sendFn) {
          this.sendFn({
            v: 1,
            type: 'ack.client',
            request_id: clientUuid,
            sequence_number: seqNum,
          });
        }
        return { stored: true, isUnread: false, conversationId: alreadyStored.conversation_id, shouldAck: true };
      }

      await this.ensureSessionKeys();

      // Check if this is self-fanout (Alice sent from Browser B, arriving on Browser A)
      const isSelfFanout = Boolean(msg.sender_id && (msg.sender_id === myUserId || msg.sender_id === myIdentityHash));
      if (isSelfFanout) {
        // Suppress ack.client for self-fanout frames
        if (msg.conversation_id) {
          await this.syncConversationHistory(msg.conversation_id);
        } else {
          await this.syncAllConversationsHistory();
        }
        return { stored: false, isUnread: false, shouldAck: false };
      }

      if (!msg.payload) {
        const conversationId = msg.conversation_id || '';
        const watermark = this.readWatermarks.get(conversationId) || 0;
        const isSeenByWatermark = watermark > 0 && msgCreatedAt <= watermark;
        const isVisible = typeof document === 'undefined' || !document.hidden;
        const isActive = this.state.activeConversationId === conversationId;
        const isCurrentActiveAndVisible = isActive && isVisible && !skipUIUpdate;

        if (isCurrentActiveAndVisible && conversationId) {
          const newWatermark = Math.max(watermark, msgCreatedAt);
          this.readWatermarks.set(conversationId, newWatermark);
          await this.metadataPort.set(`read_watermark_${conversationId}`, String(newWatermark));
          void this.convPort.markRead?.(conversationId, newWatermark).catch(() => {});
          await this.unreadPort?.clear(conversationId);
          await this.refreshUnreadState();
        }

        const isUnread = !isSeenByWatermark && !isCurrentActiveAndVisible;
        if (isUnread && conversationId) {
          await this.unreadPort?.increment(conversationId);
          await this.refreshUnreadState();
        }

        if (this.sendFn) {
          this.sendFn({
            v: 1,
            type: 'ack.client',
            request_id: clientUuid,
            sequence_number: seqNum,
          });
        }

        return { stored: true, isUnread, shouldAck: true, conversationId };
      }

      // Cached peer lookup (prevents N+2 network cascade)
      let peer: PeerInfo | null = this.peerDirCache.get(msg.sender_id) || null;
      if (!peer && this.dirPort) {
        try {
          peer = await this.dirPort.lookup(msg.sender_id);
          if (peer) this.peerDirCache.set(msg.sender_id, peer);
        } catch {
          // Lookup failure: do NOT ack so message remains queued on server for retry
          return { stored: false, isUnread: false, shouldAck: false };
        }
      }

      const hasAnySession = Boolean(peer?.activeSession || (peer?.sessions && peer.sessions.length > 0));
      if (!peer || !hasAnySession) {
        return { stored: false, isUnread: false, shouldAck: false };
      }

      // Resolve conversation ID between caller and peer
      let conversationId = (msg.conversation_id as string) || '';
      if (!conversationId) {
        const matchConv = (c: ConversationItem) =>
          Boolean(
            (c.peerId && msg.sender_id && c.peerId.toLowerCase() === msg.sender_id.toLowerCase()) ||
            (peer?.identityHash && c.peerIdentityHash && c.peerIdentityHash.toLowerCase() === peer.identityHash.toLowerCase())
          );

        const conv = this.state.conversations.find(matchConv);
        if (conv) {
          conversationId = conv.id;
        } else {
          await this.loadConversations();
          const reloadedConv = this.state.conversations.find(matchConv);
          if (reloadedConv) {
            conversationId = reloadedConv.id;
          } else if (peer.identityHash) {
            conversationId = await this.createConversation(peer.identityHash, false);
          }
        }
      }

      if (!conversationId) {
        return { stored: false, isUnread: false, shouldAck: false };
      }

      const senderIdentityHash = peer.identityHash ?? peer.identityPublicKey;

      const candidateSenderPKs: string[] = [];
      if (peer.sessions && Array.isArray(peer.sessions)) {
        for (const s of peer.sessions) {
          if (s.x25519PublicKey && !candidateSenderPKs.includes(s.x25519PublicKey)) {
            candidateSenderPKs.push(s.x25519PublicKey);
          }
        }
      }
      const defaultSenderPK = peer.activeSession?.x25519PublicKey || candidateSenderPKs[0] || '';

      let decryptResult: DecryptResult;
      try {
        // Worker decrypt handles version check (0x01) -> replay check -> AES-GCM decrypt.
        decryptResult = await this.cryptoPort.decrypt({
          ciphertextHex,
          senderSessionPK: defaultSenderPK,
          senderSessionPKs: candidateSenderPKs,
          senderHash: senderIdentityHash,
          receiverHash: myIdentityHash,
          convIdHash: conversationId,
          clientUuid,
        });

        // If decrypt dropped/failed (other than replay), retry once with freshly refreshed directory info
        if (decryptResult.dropped && decryptResult.reason !== 'replay') {
          this.dirPort.invalidate?.(msg.sender_id);
          this.peerDirCache.delete(msg.sender_id);
          const freshPeer = await this.dirPort.lookup(msg.sender_id).catch(() => null);
          if (freshPeer) {
            this.peerDirCache.set(msg.sender_id, freshPeer);
            const freshCandidatePKs: string[] = [];
            if (freshPeer.sessions && Array.isArray(freshPeer.sessions)) {
              for (const s of freshPeer.sessions) {
                if (s.x25519PublicKey && !freshCandidatePKs.includes(s.x25519PublicKey)) {
                  freshCandidatePKs.push(s.x25519PublicKey);
                }
              }
            }
            const freshDefaultPK = freshPeer.activeSession?.x25519PublicKey || freshCandidatePKs[0] || defaultSenderPK;
            decryptResult = await this.cryptoPort.decrypt({
              ciphertextHex,
              senderSessionPK: freshDefaultPK,
              senderSessionPKs: freshCandidatePKs,
              senderHash: senderIdentityHash,
              receiverHash: myIdentityHash,
              convIdHash: conversationId,
              clientUuid,
            });
          }
        }
      } catch (err: unknown) {
        // Version mismatch or fatal crypto error: store ciphertext row, ack if permanent error
        const storedMsg: StoredMessageDTO = {
          id: clientUuid,
          conversation_id: conversationId,
          sender_id: senderIdentityHash,
          ciphertext: ciphertextHex,
          plaintext: undefined,
          sequence_str: seqNum.toString(),
          created_at: msgCreatedAt,
          status: 'failed',
        };
        await this.msgPort.insertIfAbsent(storedMsg);

        if (err instanceof Error && err.message.includes('Unsupported crypto suite version')) {
          if (this.sendFn) {
            this.sendFn({ v: 1, type: 'ack.client', request_id: clientUuid, sequence_number: seqNum });
          }
          return { stored: false, isUnread: false, conversationId, shouldAck: true };
        }
        if (conversationId) {
          void this.syncConversationHistory(conversationId);
        }
        return { stored: false, isUnread: false, conversationId, shouldAck: false };
      }

      if (decryptResult.dropped || !decryptResult.plaintext) {
        console.warn('[ChatUseCase] Inbound decrypt failed or dropped:', decryptResult, 'clientUuid:', clientUuid);
        // Decrypt failed or replay dropped:
        // Store ciphertext row, do NOT ack (unless replay-dropped)
        const storedMsg: StoredMessageDTO = {
          id: clientUuid,
          conversation_id: conversationId,
          sender_id: senderIdentityHash,
          ciphertext: ciphertextHex,
          plaintext: undefined,
          sequence_str: seqNum.toString(),
          created_at: msgCreatedAt,
          status: 'failed',
        };
        await this.msgPort.insertIfAbsent(storedMsg);

        if (decryptResult.reason === 'replay') {
          if (this.sendFn) {
            this.sendFn({ v: 1, type: 'ack.client', request_id: clientUuid, sequence_number: seqNum });
          }
          return { stored: false, isUnread: false, conversationId, shouldAck: true };
        }
        if (conversationId) {
          if (this.state.activeConversationId === `draft:${senderIdentityHash}`) {
            void this.selectConversation(conversationId);
          } else {
            void this.syncConversationHistory(conversationId);
          }
        }
        return { stored: false, isUnread: false, conversationId, shouldAck: false };
      }

      // ON SUCCESS ONLY:
      const envelope = mceDecode(decryptResult.plaintext);

      // 5.2 Edit in DIRECT E2EE: envelope flag "e" (target message UUID)
      if (envelope?.t === 'text' && envelope.e) {
        const targetId = envelope.e;
        const newMce = mceEncodeText(envelope.b);
        await this.msgPort.updateGroupMessage?.(targetId, {
          plaintext: newMce,
          edited_at: msgCreatedAt,
        });
        if (conversationId === this.state.activeConversationId && !skipUIUpdate) {
          await this.loadMessages(conversationId);
        }
        if (this.sendFn) {
          this.sendFn({
            v: 1,
            type: 'ack.client',
            request_id: clientUuid,
            sequence_number: seqNum,
          });
        }
        return { stored: false, isUnread: false, conversationId, shouldAck: true };
      }

      // 5.3 Delete-for-both in DIRECT E2EE: sealed sys control message {"v":1,"t":"sys","d":"<uuid>"}
      if (envelope?.t === 'sys' && envelope.d) {
        const targetId = envelope.d;
        this.deletedMessageIds.add(targetId);
        this.emit({ messages: this.state.messages.filter((m) => m.id !== targetId) });
        await this.msgPort.deleteMessage?.(targetId);
        if (conversationId === this.state.activeConversationId && !skipUIUpdate) {
          await this.loadMessages(conversationId);
        }
        if (this.sendFn) {
          this.sendFn({
            v: 1,
            type: 'ack.client',
            request_id: clientUuid,
            sequence_number: seqNum,
          });
        }
        return { stored: false, isUnread: false, conversationId, shouldAck: true };
      }

      // 5.4 Seen receipt in DIRECT E2EE: sealed sys control message {"v":1,"t":"sys","s":["<uuid>",...]}
      if (envelope?.t === 'sys' && envelope.s && Array.isArray(envelope.s)) {
        const seenIds = envelope.s;
        for (const targetId of seenIds) {
          const m = await this.msgPort.getById(targetId);
          if (m && m.sender_id === myIdentityHash) {
            await this.msgPort.updateStatus?.(targetId, 'seen');
          }
        }
        if (conversationId === this.state.activeConversationId && !skipUIUpdate) {
          const updated = this.state.messages.map((m) =>
            seenIds.includes(m.id) && m.isOutgoing ? { ...m, status: 'seen' as const } : m
          );
          this.emit({ messages: updated });
        }

        if (this.cryptoPort.vaultEncrypt && this.convPort.postHistory) {
          try {
            const sealed = await this.cryptoPort.vaultEncrypt(decryptResult.plaintext);
            this.convPort.postHistory(conversationId, [{
              id: clientUuid,
              sender_id: senderIdentityHash,
              encrypted_payload: sealed.ciphertextHex,
              vault_iv: sealed.ivHex,
              sequence_number: Number(decryptResult.sequence ?? seqNum),
              created_at: Date.now(),
            }]).catch(console.warn);
          } catch {
            /* ignore vault encrypt error on inbound message */
          }
        }

        if (this.sendFn) {
          this.sendFn({
            v: 1,
            type: 'ack.client',
            request_id: clientUuid,
            sequence_number: seqNum,
          });
        }
        return { stored: false, isUnread: false, conversationId, shouldAck: true };
      }

      const watermark = this.readWatermarks.get(conversationId) || 0;
      const isSeenByWatermark = watermark > 0 && msgCreatedAt <= watermark;
      const isVisible = typeof document === 'undefined' || !document.hidden;
      const isActive = this.state.activeConversationId === conversationId;
      const isCurrentActiveAndVisible = isActive && isVisible && !skipUIUpdate;
      const initialStatus = (isSeenByWatermark || isCurrentActiveAndVisible) ? 'seen' : 'delivered';

      // Active Inbound Watermark Persistence (Fixes Attack 4):
      // Advance local in-memory watermark, persist to Dexie metadata, clear unreadPort,
      // and record watermark on the server to prevent ghost unread badges across reloads.
      if (isCurrentActiveAndVisible && conversationId) {
        const newWatermark = Math.max(watermark, msgCreatedAt);
        this.readWatermarks.set(conversationId, newWatermark);
        await this.metadataPort.set(`read_watermark_${conversationId}`, String(newWatermark));
        void this.convPort.markRead?.(conversationId, newWatermark).catch(() => {});
        await this.unreadPort?.clear(conversationId);
        await this.refreshUnreadState();
      }

      let vaultCiphertext: string | undefined;
      let vaultIv: string | undefined;
      if (decryptResult.plaintext && this.cryptoPort.vaultEncrypt) {
        try {
          const sealed = await this.cryptoPort.vaultEncrypt(decryptResult.plaintext);
          vaultCiphertext = sealed.ciphertextHex;
          vaultIv = sealed.ivHex;
        } catch {
          /* best effort vault encryption */
        }
      }

      // 1. Persist to Dexie (with reply_to_id if present)
      const replyToId = envelope?.t === 'text' ? envelope.r : undefined;
      const storedMsg: StoredMessageDTO = {
        id: clientUuid,
        conversation_id: conversationId,
        sender_id: senderIdentityHash,
        ciphertext: ciphertextHex,
        plaintext: decryptResult.plaintext,
        vault_ciphertext: vaultCiphertext,
        vault_iv: vaultIv,
        sequence_str: decryptResult.sequence ?? seqNum.toString(),
        created_at: msgCreatedAt,
        status: initialStatus,
        reply_to_id: replyToId,
      };
      await this.msgPort.insertIfAbsent(storedMsg);

      // Post receiver sealed vault copy to server history
      if (vaultCiphertext && vaultIv) {
        this.convPort.postHistory(conversationId, [{
          id: clientUuid,
          sender_id: senderIdentityHash,
          encrypted_payload: vaultCiphertext,
          vault_iv: vaultIv,
          sequence_number: Number(decryptResult.sequence ?? seqNum),
          created_at: storedMsg.created_at,
        }]).catch((err) => console.warn('[ChatUseCase] postHistory inbound failed:', err));
      }

      const isUnread = !isSeenByWatermark && !isCurrentActiveAndVisible;

      // 2. Update UI — IMMEDIATE reactive injection into state.
      // This guarantees the message appears in the UI right away, even if the
      // follow-up loadMessages (vault decrypt, server fetch) fails or is slow.
      if (!skipUIUpdate) {
        const isMedia = envelope?.t === 'media';
        const isCall = envelope?.t === 'call';
        const inboundChatMsg: ChatMessage = {
          id: clientUuid,
          conversationId,
          senderId: senderIdentityHash,
          plaintext: mceDisplayText(decryptResult.plaintext!),
          messageType: isMedia ? 'media' : isCall ? 'call' : 'text',
          mediaMetadata: isMedia ? envelope.m : undefined,
          fileName: isMedia ? envelope.f : undefined,
          callMetadata: isCall ? envelope.c : undefined,
          createdAt: storedMsg.created_at,
          sequence: Number(decryptResult.sequence ?? seqNum),
          status: initialStatus,
          replyToId,
          isOutgoing: false,
        };

        const currentActiveId = this.state.activeConversationId;
        let isDraftForPeer = false;
        if (currentActiveId && currentActiveId.startsWith('draft:')) {
          const draftHash = currentActiveId.slice(6).toLowerCase();
          if (senderIdentityHash && draftHash === senderIdentityHash.toLowerCase()) {
            isDraftForPeer = true;
          } else {
            const conv = this.state.conversations.find((c) => c.id === conversationId);
            if (conv && conv.peerIdentityHash && conv.peerIdentityHash.toLowerCase() === draftHash) {
              isDraftForPeer = true;
            }
          }
        }

        if (conversationId === this.state.activeConversationId) {
          // Immediate injection: deduplicate and merge into current messages
          const deduped = this.state.messages.filter((m) => m.id !== inboundChatMsg.id);
          this.emit({ messages: this.sortMessages([...deduped, inboundChatMsg]) });
          this.updateConversationActivity(
            conversationId,
            inboundChatMsg.plaintext,
            storedMsg.created_at
          );

          if (isVisible) {
            this.sendSeenReceipt(conversationId, [clientUuid], senderIdentityHash).catch(console.error);
          }
          void this.loadConversations();
        } else if (isDraftForPeer) {
          await this.selectConversation(conversationId);
          if (isVisible) {
            this.sendSeenReceipt(conversationId, [clientUuid], senderIdentityHash).catch(console.error);
          }
        } else {
          if (isUnread) {
            await this.unreadPort?.increment(conversationId);
          }
          this.updateConversationActivity(
            conversationId,
            inboundChatMsg.plaintext,
            storedMsg.created_at,
          );
          await this.refreshUnreadState();
        }
      }

      // 3. Send ack.client to server
      if (this.sendFn) {
        this.sendFn({
          v: 1,
          type: 'ack.client',
          request_id: clientUuid,
          sequence_number: seqNum,
        });
      }

      return { stored: true, isUnread, conversationId, shouldAck: true };
    } finally {
      this.processingInboundUuids.delete(clientUuid);
    }
  }

  /**
   * Flush outbox messages.
   * Retains entry in 'inflight' awaiting genuine ack.server frame.
   * Enforces per-message isolated watchdog timer (Fixes Attack 2).
   * Transitions message to 'failed' (✗) upon terminal outbox failure (Fixes Attack 7).
   */
  async flushOutbox(): Promise<void> {
    if (this.isFlushingOutbox) return;
    this.isFlushingOutbox = true;
    try {
      const queued = (await this.outboxPort.getQueued(100)) || [];
      for (const entry of queued) {
        if (entry.status && entry.status !== 'queued') continue;
        const hasInflight = await this.outboxPort.hasInflightForReceiver(entry.receiver_id);
        if (hasInflight) continue;

        if (entry.plaintext !== undefined && this.convPort.sendGroupMessage) {
          await this.outboxPort.markInflight(entry.id);
          try {
            const groupMsg = await this.convPort.sendGroupMessage(
              entry.conversation_id,
              entry.plaintext,
              entry.reply_to_id,
              entry.id,
            );
            await this.outboxPort.markSent(entry.id);
            await this.msgPort.updateStatus?.(entry.id, 'sent');
            const updated = this.state.messages.map((m) =>
              m.id === entry.id
                ? {
                    ...m,
                    status: 'sent' as const,
                    serverId: groupMsg?.server_id ?? m.serverId,
                    createdAt: groupMsg?.created_at ? toMillis(groupMsg.created_at) : m.createdAt,
                  }
                : m,
            );
            this.emit({ messages: updated });
          } catch (err) {
          const errorKind = classifySendError(err);
          console.warn(`[ChatUseCase] outbox sendGroupMessage failed (${errorKind}):`, err);

          if (errorKind === 'permanent') {
            await this.outboxPort.markPermanentFailed?.(entry.id);
            await this.msgPort.updateStatus?.(entry.id, 'failed');
            const updated = this.state.messages.map((m) =>
              m.id === entry.id ? { ...m, status: 'failed' as const } : m,
            );
            this.emit({ messages: updated });
          } else {
            const retryCount = (entry.retry_count || 0) + 1;
            const MAX_RETRIES = 10;
            if (retryCount >= MAX_RETRIES) {
              console.warn(`[ChatUseCase] outbox entry ${entry.id} reached max retry cap (${MAX_RETRIES})`);
              await this.outboxPort.markPermanentFailed?.(entry.id);
              await this.msgPort.updateStatus?.(entry.id, 'failed');
              const updated = this.state.messages.map((m) =>
                m.id === entry.id ? { ...m, status: 'failed' as const } : m,
              );
              this.emit({ messages: updated });
            } else {
              await this.outboxPort.resetInflightEntry?.(entry.id);
              if (this.outboxPort.getById) {
                const current = await this.outboxPort.getById(entry.id);
                if (current) current.retry_count = retryCount;
              }
              const backoffMs = Math.min(30000, Math.round(1000 * Math.pow(1.5, retryCount - 1)));
              setTimeout(() => {
                void this.flushOutbox();
              }, backoffMs);
            }
          }
        }
        continue;
      }

      if (!this.sendFn) continue;

      await this.outboxPort.markInflight(entry.id);

      try {
        const routingId = encodeRoutingId(entry.receiver_id);
        const payload = hexToBase64StdPadded(entry.ciphertext_hex);

        this.sendFn({
          v: 1,
          type: 'chat.msg',
          request_id: entry.id,
          routing_id: routingId,
          payload: payload,
          sequence_number: Number(entry.sequence_str),
          conversation_id: entry.conversation_id,
        });

        // Clear existing timer if any
        const existingTimer = this.inflightWatchdogs.get(entry.id);
        if (existingTimer) clearTimeout(existingTimer);

        // Per-Message Inflight Watchdog (Fixes Attack 2):
        // If ack.server is lost, reset ONLY this specific stuck entry after 5 seconds
        const timer = setTimeout(async () => {
          this.inflightWatchdogs.delete(entry.id);
          try {
            const current = await this.outboxPort.getById?.(entry.id);
            if (current && current.status === 'inflight') {
              await this.outboxPort.resetInflightEntry?.(entry.id);
              void this.flushOutbox();
            }
          } catch {
            // Watchdog inspection failed; safe to ignore
          }
        }, 5000);
        this.inflightWatchdogs.set(entry.id, timer);
      } catch (err) {
        const errorKind = classifySendError(err);
        if (errorKind === 'permanent') {
          await this.outboxPort.markPermanentFailed?.(entry.id);
          await this.msgPort.updateStatus?.(entry.id, 'failed');
          const updated = this.state.messages.map((m) =>
            m.id === entry.id ? { ...m, status: 'failed' as const } : m,
          );
          this.emit({ messages: updated });
        } else {
          // Transmission Exception (Fixes Attack 7 & H4):
          const isTerminal = await this.outboxPort.markFailed(entry.id);
          if (isTerminal) {
            await this.msgPort.updateStatus?.(entry.id, 'failed');
            const updated = this.state.messages.map((m) =>
              m.id === entry.id ? { ...m, status: 'failed' as const } : m,
            );
            this.emit({ messages: updated });
          } else {
            const retryCount = (entry.retry_count || 0) + 1;
            const backoffMs = Math.min(30000, Math.round(1000 * Math.pow(1.5, retryCount - 1)));
            setTimeout(() => {
              void this.flushOutbox();
            }, backoffMs);
          }
        }
      }
    }
    } finally {
      this.isFlushingOutbox = false;
    }
  }

  /**
   * Handle server acknowledgment for a sent message.
   * Cancels per-message watchdog timer (Fixes Attack 2).
   * Transitions outbox to 'sent', archives to vault history, and pumps outbox.
   * Strictly monotonic: never regresses 'delivered' or 'seen' back to 'sent'.
   */
  async handleAckServer(requestId: string): Promise<void> {
    // 1. Cancel per-message watchdog timer (Fixes Attack 2)
    const timer = this.inflightWatchdogs.get(requestId);
    if (timer) {
      clearTimeout(timer);
      this.inflightWatchdogs.delete(requestId);
    }

    // 2. Mark outbox entry as sent (clears inflight status for this receiver)
    await this.outboxPort.markSent(requestId);

    // 3. Monotonic local status update: only transition to 'sent' if currently 'pending'
    const stored = await this.msgPort.getById(requestId);
    if (!stored || stored.status === 'pending') {
      await this.msgPort.updateStatus?.(requestId, 'sent');
    }
    const updated = this.state.messages.map((m) =>
      m.id === requestId && m.status === 'pending' ? { ...m, status: 'sent' as const } : m,
    );
    this.emit({ messages: updated });

    // 4. Post to encrypted vault history for multi-device cross-sync
    if (stored && stored.vault_ciphertext && stored.vault_iv && stored.conversation_id) {
      this.convPort.postHistory(stored.conversation_id, [{
        id: stored.id,
        sender_id: stored.sender_id,
        encrypted_payload: stored.vault_ciphertext,
        vault_iv: stored.vault_iv,
        sequence_number: Number(stored.sequence_str || 0),
        created_at: stored.created_at,
      }]).catch(() => {});
    }

    // 5. Pump outbox pipeline to dispatch any queued messages waiting on this receiver
    void this.flushOutbox();
  }

  /**
   * Handle delivery confirmation from recipient device.
   * Caches receipt in metadata to prevent history-sync races.
   * Strictly monotonic: never regresses 'seen' back to 'delivered'.
   */
  async handleAckDelivered(requestId: string, conversationId?: string, deliveredAt?: number): Promise<void> {
    await this.metadataPort.set(`delivered_${requestId}`, '1');
    const normDeliveredAt = deliveredAt ? toMillis(deliveredAt) : Date.now();

    if (conversationId) {
      this.state.conversations = this.state.conversations.map((c) => {
        if (c.id === conversationId) {
          const prev = c.peerLastDeliveredAt || 0;
          return { ...c, peerLastDeliveredAt: Math.max(prev, normDeliveredAt) };
        }
        return c;
      });
      this.debouncedEmitConversations();
    }

    // 2. Update local Dexie store if message exists
    const stored = await this.msgPort.getById(requestId);
    if (!stored || (stored.status !== 'seen' && stored.status !== 'delivered')) {
      await this.msgPort.updateStatus?.(requestId, 'delivered');
    }
    const updated = this.state.messages.map((m) =>
      m.id === requestId && m.status !== 'seen' ? { ...m, status: 'delivered' as const } : m,
    );
    this.emit({ messages: updated });
  }

  /**
   * Handle read receipt from peer in a conversation.
   * Upgrades all outgoing messages in that conversation with created_at <= peerLastReadAt to 'seen'.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async handleAckRead(conversationId: string, peerLastReadAt: number, _readerId?: string): Promise<void> {
    const normLastRead = toMillis(peerLastReadAt);
    if (!conversationId || normLastRead <= 0) return;

    // Cache peer last read watermark
    await this.metadataPort.set(`peer_read_watermark_${conversationId}`, String(normLastRead));

    this.state.conversations = this.state.conversations.map((c) => {
      if (c.id === conversationId) {
        const prevRead = c.peerLastReadAt || 0;
        const prevDelivered = c.peerLastDeliveredAt || 0;
        return {
          ...c,
          peerLastReadAt: Math.max(prevRead, normLastRead),
          peerLastDeliveredAt: Math.max(prevDelivered, normLastRead),
        };
      }
      return c;
    });
    this.debouncedEmitConversations();

    // Update in-memory messages state if conversation is currently loaded
    let stateChanged = false;
    const updatedMessages = this.state.messages.map((m) => {
      if (m.conversationId === conversationId && m.isOutgoing && m.status !== 'seen') {
        const msgTime = toMillis(m.createdAt);
        if (msgTime <= normLastRead) {
          stateChanged = true;
          return { ...m, status: 'seen' as const };
        }
      }
      return m;
    });

    if (stateChanged) {
      this.emit({ messages: updatedMessages });
    }

    // Update in IndexedDB
    try {
      if (this.msgPort?.getByConversation) {
        const storedMsgs = await this.msgPort.getByConversation(conversationId, 100);
        for (const m of storedMsgs) {
          if (m.status !== 'seen') {
            const msgTime = toMillis(m.created_at);
            if (msgTime <= normLastRead) {
              await this.msgPort.updateStatus?.(m.id, 'seen');
            }
          }
        }
      }
    } catch (err) {
      console.warn('[ChatUseCase] Failed to update read status in IndexedDB:', err);
    }
  }

  /**
   * Handle user presence updates received via WebSocket.
   */
  handleUserPresence(userId: string, online: boolean, lastSeenAt: number): void {
    if (!userId) return;
    const normLastSeen = toMillis(lastSeenAt);
    let changed = false;
    this.state.conversations = this.state.conversations.map((c) => {
      if (c.peerUserId === userId || c.peerId === userId || c.peerIdentityHash === userId) {
        changed = true;
        return {
          ...c,
          peerOnline: online,
          peerLastSeenAt: normLastSeen > 0 ? normLastSeen : c.peerLastSeenAt,
        };
      }
      return c;
    });
    if (changed) {
      this.debouncedEmitConversations();
    }
  }

  /**
   * Catch up on delivery confirmations via Hexagonal ConversationPort (Fixes Attack 6).
   * Paginates without starvation so all recent delivery confirmations are processed (Fixes Attack 5).
   */
  async syncDeliveryAcks(): Promise<void> {
    if (!this.convPort.getDeliveryAcks) return;

    const cursorKey = 'delivery_acks_cursor';
    const lastCursorStr = await this.metadataPort.get(cursorKey);
    let cursor = lastCursorStr ? parseInt(lastCursorStr, 10) : 0;
    let keepFetching = true;
    let pagesFetched = 0;
    const MAX_PAGES = 50; // High safety ceiling (5,000 ACKs) to prevent infinite loops (Fixes Attack 5)

    try {
      while (keepFetching && pagesFetched < MAX_PAGES) {
        pagesFetched++;
        // Delegated strictly via domain port (Fixes Attack 6)
        const acks = await this.convPort.getDeliveryAcks(cursor, 100);
        if (!acks || acks.length === 0) {
          keepFetching = false;
          break;
        }

        let maxId = cursor;
        for (const ack of acks) {
          if (ack.id > maxId) maxId = ack.id;
          await this.handleAckDelivered(ack.request_id);
        }

        cursor = maxId;
        await this.metadataPort.set(cursorKey, String(cursor));

        if (acks.length < 100) {
          keepFetching = false;
        }
      }
    } catch (err) {
      console.warn('[ChatUseCase] Failed to sync delivery acks:', err);
    }
  }

  async createConversation(peerIdentityHash: string, autoSelect: boolean = true): Promise<string> {
    const conv = await this.convPort.create(peerIdentityHash);
    await this.loadConversations();
    if (autoSelect) {
      await this.selectConversation(conv.id);
    }
    return conv.id;
  }

  async getOrCreateSelfConversation(): Promise<string> {
    const existing = this.state.conversations.find((c) => c.type === 'SELF');
    if (existing) {
      await this.selectConversation(existing.id);
      return existing.id;
    }
    const conv = await this.convPort.createSelf();
    await this.loadConversations();
    await this.selectConversation(conv.id);
    return conv.id;
  }

  /**
   * Handle incoming group/channel plaintext message from WebSocket fanout.
   */
  async handleGroupMsg(msg: {
    id?: string;
    request_id?: string;
    conversation_id: string;
    sender_id: string;
    content: string;
    reply_to_id?: string;
    edited_at?: number;
    deleted_at?: number;
    created_at?: number;
    server_id?: number;
  }): Promise<void> {
    const msgId = msg.request_id || msg.id || generateUUID();
    const existing = await this.msgPort.getById(msgId);
    if (existing && existing.plaintext) {
      return; // Already processed, do not duplicate or re-increment unread
    }
    const createdAt = msg.created_at ? toMillis(msg.created_at) : this.getNextTimestamp();
    const myUserId = (await this.metadataPort.get('user_id')) ?? '';
    const myHash = (await this.metadataPort.get('identity_hash')) ?? '';
    const myUser = (await this.metadataPort.get('username')) ?? '';
    const senderLower = (msg.sender_id || '').toLowerCase();
    const isFromMe =
      senderLower === 'self' ||
      (Boolean(senderLower) && Boolean(myUserId) && senderLower === myUserId.toLowerCase()) ||
      (Boolean(senderLower) && Boolean(myHash) && senderLower === myHash.toLowerCase()) ||
      (Boolean(senderLower) && Boolean(myUser) && senderLower === myUser.toLowerCase());

    if (!isFromMe && this.sendFn) {
      this.sendFn({
        v: 1,
        type: 'ack.client',
        request_id: msgId,
        conversation_id: msg.conversation_id,
      });
    }

    const isDeleted = Boolean(msg.deleted_at && msg.deleted_at > 0);
    const storedMsg: StoredMessageDTO = {
      id: msgId,
      conversation_id: msg.conversation_id,
      sender_id: msg.sender_id,
      ciphertext: '',
      plaintext: msg.content,
      sequence_str: '0',
      created_at: createdAt,
      status: isFromMe ? 'sent' : 'delivered',
      reply_to_id: msg.reply_to_id,
      edited_at: msg.edited_at ? toMillis(msg.edited_at) : undefined,
      deleted_at: isDeleted ? toMillis(msg.deleted_at!) : undefined,
      server_id: msg.server_id,
    };
    await this.msgPort.insertIfAbsent(storedMsg);

    if (!this.state.conversations.some((c) => c.id === msg.conversation_id)) {
      await this.loadConversations();
    }

    const isActive = this.state.activeConversationId === msg.conversation_id;
    const isVisible = typeof document === 'undefined' || !document.hidden;

    // Immediate reactive injection — same ChatMessage shape as loadMessages produces
    const envelope = msg.content ? mceDecode(msg.content) : null;
    const isMedia = envelope?.t === 'media';
    const isCall = envelope?.t === 'call';
    const displayContent = msg.content ? mceDisplayText(msg.content) : '';

    if (isActive) {
      const groupChatMsg: ChatMessage = {
        id: msgId,
        conversationId: msg.conversation_id,
        senderId: msg.sender_id,
        plaintext: displayContent,
        messageType: isMedia ? 'media' : isCall ? 'call' : 'text',
        mediaMetadata: isMedia ? envelope?.m : undefined,
        fileName: isMedia ? envelope?.f : undefined,
        callMetadata: isCall ? envelope?.c : undefined,
        createdAt,
        sequence: undefined,
        status: isFromMe ? 'sent' : 'delivered',
        replyToId: msg.reply_to_id,
        editedAt: msg.edited_at ? toMillis(msg.edited_at) : undefined,
        deletedAt: isDeleted ? toMillis(msg.deleted_at!) : undefined,
        serverId: msg.server_id,
        isOutgoing: isFromMe,
      };
      const deduped = this.state.messages.filter((m) => m.id !== groupChatMsg.id);
      this.emit({ messages: this.sortMessages([...deduped, groupChatMsg]) });

      if (isVisible && !isFromMe && this.convPort.markRead) {
        void Promise.resolve(this.convPort.markRead(msg.conversation_id, createdAt)).catch(() => {});
      }
      this.updateConversationActivity(msg.conversation_id, displayContent, createdAt);
    } else {
      if (!isFromMe) {
        // Not active — increment unread badge and update sidebar preview
        await this.unreadPort?.increment(msg.conversation_id);
        this.state.conversations = this.state.conversations.map((c) => {
          if (c.id === msg.conversation_id) {
            return {
              ...c,
              lastMessage: displayContent,
              lastUnreadMessage: displayContent,
              lastMessageTime: createdAt,
              unreadCount: (c.unreadCount || 0) + 1,
            };
          }
          return c;
        });
        this.debouncedEmitConversations();
        await this.refreshUnreadState();
      } else {
        this.updateConversationActivity(msg.conversation_id, displayContent, createdAt);
      }
    }
  }

  /**
   * Handle incoming group/channel edit action from WebSocket.
   */
  async handleGroupEdit(action: {
    action?: string;
    id?: string;
    conversation_id?: string;
    content?: string;
    edited_at?: number;
    data?: { id: string; conversation_id: string; content: string; edited_at?: number };
  }): Promise<void> {
    const id = action.id || action.data?.id;
    const conversationId = action.conversation_id || action.data?.conversation_id;
    const content = action.content || action.data?.content;
    const editedAt = action.edited_at || action.data?.edited_at || Date.now();
    if (!id) return;
    await this.msgPort.updateGroupMessage?.(id, {
      plaintext: content || '',
      edited_at: editedAt,
    });
    if (conversationId && this.state.activeConversationId === conversationId) {
      await this.loadMessages(conversationId);
    }
  }

  /**
   * Handle incoming group/channel delete action from WebSocket.
   */
  async handleGroupDelete(action: {
    action?: string;
    id?: string;
    conversation_id?: string;
    deleted_at?: number;
    data?: { id: string; conversation_id: string; deleted_at?: number };
  }): Promise<void> {
    const id = action.id || action.data?.id;
    const conversationId = action.conversation_id || action.data?.conversation_id;
    const deletedAt = action.deleted_at || action.data?.deleted_at || Date.now();
    if (!id) return;
    await this.msgPort.updateGroupMessage?.(id, {
      plaintext: 'This message was deleted',
      deleted_at: deletedAt,
    });
    if (conversationId && this.state.activeConversationId === conversationId) {
      await this.loadMessages(conversationId);
    }
  }

  async createGroup(name: string, description?: string, memberUsernames?: string[], isPublic?: boolean, username?: string): Promise<string> {
    const conv = await this.convPort.createGroup({
      type: 'GROUP',
      name,
      description,
      member_usernames: memberUsernames,
      is_public: isPublic,
      username,
    });
    await this.loadConversations();
    await this.selectConversation(conv.id);
    return conv.id;
  }

  async createChannel(name: string, description?: string, memberUsernames?: string[], isPublic?: boolean, username?: string): Promise<string> {
    const conv = await this.convPort.createGroup({
      type: 'CHANNEL',
      name,
      description,
      member_usernames: memberUsernames,
      is_public: isPublic,
      username,
    });
    await this.loadConversations();
    await this.selectConversation(conv.id);
    return conv.id;
  }

  async joinByInvite(code: string): Promise<string> {
    const conv = await this.convPort.joinByInvite(code);
    await this.loadConversations();
    await this.selectConversation(conv.id);
    return conv.id;
  }

  async joinPublic(username: string): Promise<string> {
    const conv = await this.convPort.joinPublic(username);
    await this.loadConversations();
    await this.selectConversation(conv.id);
    return conv.id;
  }

  async searchPublicConversations(query: string): Promise<ConversationDTO[]> {
    return this.convPort.searchPublic(query);
  }

  async editGroupMessage(conversationId: string, messageId: string, content: string): Promise<void> {
    const updated = await this.convPort.editGroupMessage(conversationId, messageId, content);
    await this.msgPort.updateGroupMessage?.(messageId, {
      plaintext: updated.content,
      edited_at: updated.edited_at,
    });
    if (this.state.activeConversationId === conversationId) {
      await this.loadMessages(conversationId);
    }
  }

  async deleteGroupMessage(conversationId: string, messageId: string): Promise<void> {
    await this.convPort.deleteGroupMessage(conversationId, messageId);
    await this.msgPort.updateGroupMessage?.(messageId, {
      plaintext: 'This message was deleted',
      deleted_at: Date.now(),
    });
    if (this.state.activeConversationId === conversationId) {
      await this.loadMessages(conversationId);
    }
  }

  async getGroupMembers(conversationId: string): Promise<ConversationMemberDTO[]> {
    return this.convPort.getMembers(conversationId);
  }

  async addGroupMember(conversationId: string, member: { userId?: string; username?: string; role?: string }): Promise<void> {
    await this.convPort.addMember(conversationId, member);
  }

  async removeGroupMember(conversationId: string, userId: string): Promise<void> {
    await this.convPort.removeMember(conversationId, userId);
  }

  async updateGroupMemberRole(conversationId: string, userId: string, role: string): Promise<void> {
    await this.convPort.updateMemberRole(conversationId, userId, role);
  }

  async editDirectMessage(conversationId: string, messageId: string, newText: string): Promise<void> {
    const conv = this.state.conversations.find((c) => c.id === conversationId);
    await this.msgPort.updateGroupMessage?.(messageId, {
      plaintext: newText,
      edited_at: Date.now(),
    });

    if (conv?.type !== 'SELF') {
      let targetPeerHash = conv?.peerIdentityHash;
      if (!targetPeerHash) {
        await this.loadConversations();
        const reloaded = this.state.conversations.find((c) => c.id === conversationId);
        targetPeerHash = reloaded?.peerIdentityHash;
      }
      if (targetPeerHash && this.dirPort) {
        try {
          const peer = await this.dirPort.lookup(targetPeerHash);
          if (peer?.activeSession) {
            const senderHash = (await this.metadataPort.get('identity_hash')) ?? '';
            const clientUuid = generateUUID();
            const editPayload = mceEncodeEdit(messageId, newText);
            await this.ensureSessionKeys();
            const result = await this.cryptoPort.encrypt({
              plaintext: editPayload,
              receiverSessionPK: peer.activeSession.x25519PublicKey,
              senderHash,
              receiverHash: targetPeerHash,
              convIdHash: conversationId,
              clientUuid,
            });
            const now = this.getNextTimestamp();
            await this.outboxPort.enqueue({
              id: clientUuid,
              conversation_id: conversationId,
              receiver_id: peer.userId,
              ciphertext_hex: result.ciphertextHex,
              sequence_str: result.sequence,
              created_at: now,
              retry_count: 0,
              status: 'queued',
            });
            await this.flushOutbox();
          }
        } catch (err) {
          console.error('[ChatUseCase] editDirectMessage peer send failed:', err);
        }
      }
    }

    if (this.state.activeConversationId === conversationId) {
      await this.loadMessages(conversationId);
    }
  }

  async editMessage(conversationId: string, messageId: string, content: string): Promise<void> {
    const conv = this.state.conversations.find((c) => c.id === conversationId);
    if (this.convPort.editGroupMessage) {
      try {
        await this.convPort.editGroupMessage(conversationId, messageId, content);
      } catch (err) {
        console.warn('[ChatUseCase] editGroupMessage failed:', err);
      }
    }
    if (conv?.type === 'GROUP' || conv?.type === 'CHANNEL') {
      await this.editGroupMessage(conversationId, messageId, content);
    } else {
      await this.editDirectMessage(conversationId, messageId, content);
    }
  }

  async deleteMessageForMe(conversationId: string, messageId: string): Promise<void> {
    this.deletedMessageIds.add(messageId);
    this.emit({ messages: this.state.messages.filter((m) => m.id !== messageId) });
    await this.msgPort.deleteMessage?.(messageId);
    if (this.state.activeConversationId === conversationId) {
      await this.loadMessages(conversationId);
    }
  }

  async deleteDirectMessageForBoth(conversationId: string, messageId: string): Promise<void> {
    this.deletedMessageIds.add(messageId);
    this.emit({ messages: this.state.messages.filter((m) => m.id !== messageId) });
    const conv = this.state.conversations.find((c) => c.id === conversationId);
    await this.msgPort.deleteMessage?.(messageId);

    if (conv?.type !== 'SELF') {
      let targetPeerHash = conv?.peerIdentityHash;
      if (!targetPeerHash) {
        await this.loadConversations();
        const reloaded = this.state.conversations.find((c) => c.id === conversationId);
        targetPeerHash = reloaded?.peerIdentityHash;
      }
      if (targetPeerHash && this.dirPort) {
        try {
          const peer = await this.dirPort.lookup(targetPeerHash);
          if (peer?.activeSession) {
            const senderHash = (await this.metadataPort.get('identity_hash')) ?? '';
            const clientUuid = generateUUID();
            const delPayload = mceEncodeDeleteForBoth(messageId);
            await this.ensureSessionKeys();
            const result = await this.cryptoPort.encrypt({
              plaintext: delPayload,
              receiverSessionPK: peer.activeSession.x25519PublicKey,
              senderHash,
              receiverHash: targetPeerHash,
              convIdHash: conversationId,
              clientUuid,
            });
            const now = this.getNextTimestamp();
            await this.outboxPort.enqueue({
              id: clientUuid,
              conversation_id: conversationId,
              receiver_id: peer.userId,
              ciphertext_hex: result.ciphertextHex,
              sequence_str: result.sequence,
              created_at: now,
              retry_count: 0,
              status: 'queued',
            });
            await this.flushOutbox();
          }
        } catch (err) {
          console.error('[ChatUseCase] deleteDirectMessageForBoth peer send failed:', err);
        }
      }
    }

    if (this.state.activeConversationId === conversationId) {
      await this.loadMessages(conversationId);
    }
  }

  async deleteMessage(conversationId: string, messageId: string, mode: 'me' | 'both' = 'me'): Promise<void> {
    const conv = this.state.conversations.find((c) => c.id === conversationId);
    if (conv?.type === 'GROUP' || conv?.type === 'CHANNEL') {
      if (mode === 'both') {
        await this.deleteGroupMessage(conversationId, messageId);
      } else {
        this.deletedMessageIds.add(messageId);
        this.emit({ messages: this.state.messages.filter((m) => m.id !== messageId) });
        await this.msgPort.deleteMessage?.(messageId);
        if (this.state.activeConversationId === conversationId) {
          await this.loadMessages(conversationId);
        }
      }
      return;
    }

    if (mode === 'both') {
      if (this.convPort.deleteGroupMessage) {
        try {
          await this.convPort.deleteGroupMessage(conversationId, messageId);
        } catch (err) {
          console.warn('[ChatUseCase] deleteGroupMessage failed:', err);
        }
      }
      await this.deleteDirectMessageForBoth(conversationId, messageId);
    } else {
      await this.deleteMessageForMe(conversationId, messageId);
    }
  }

  async forwardMessage(targetConversationId: string, message: ChatMessage): Promise<void> {
    const targetConv = this.state.conversations.find((c) => c.id === targetConversationId);
    if (message.messageType === 'media' && message.mediaMetadata) {
      if (targetConv?.type === 'GROUP' || targetConv?.type === 'CHANNEL') {
        const mcePayload = mceEncodeMedia(message.mediaMetadata);
        await this.sendMessage(targetConversationId, mcePayload);
      } else {
        await this.sendMedia(targetConversationId, message.mediaMetadata, targetConv?.peerIdentityHash, message.fileName);
      }
    } else {
      // Brand-new message, zero-knowledge: NO forwarded-from label
      await this.sendMessage(targetConversationId, message.plaintext, targetConv?.peerIdentityHash);
    }
  }

  async clearHistory(conversationId: string, mode: 'me' | 'both' = 'me'): Promise<void> {
    if (this.convPort.clearHistory) {
      try {
        await this.convPort.clearHistory(conversationId, mode);
      } catch (err) {
        console.warn('[ChatUseCase] clearHistory failed:', err);
      }
    }
    await this.msgPort.deleteByConversation?.(conversationId);
    await this.outboxPort.deleteByConversation?.(conversationId);
    if (this.state.activeConversationId === conversationId) {
      this.emit({ messages: [], firstUnreadMessageId: null });
    }
    this.state.conversations = this.state.conversations.map((c) => {
      if (c.id === conversationId) {
        return {
          ...c,
          lastMessage: '',
          lastUnreadMessage: undefined,
          unreadCount: 0,
        };
      }
      return c;
    });
    this.debouncedEmitConversations();
  }

  async deleteConversation(conversationId: string, mode: 'me' | 'both' = 'me'): Promise<void> {
    if (this.convPort.deleteConversation) {
      try {
        await this.convPort.deleteConversation(conversationId, mode);
      } catch (err) {
        console.warn('[ChatUseCase] deleteConversation failed:', err);
      }
    }
    await this.msgPort.deleteByConversation?.(conversationId);
    await this.outboxPort.deleteByConversation?.(conversationId);
    const updatedConvs = this.state.conversations.filter((c) => c.id !== conversationId);
    const wasActive = this.state.activeConversationId === conversationId;
    this.emit({
      conversations: updatedConvs,
      activeConversationId: wasActive ? '' : this.state.activeConversationId,
      messages: wasActive ? [] : this.state.messages,
      firstUnreadMessageId: wasActive ? null : this.state.firstUnreadMessageId,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async handleConvCleared(conversationId: string, _scope?: string, _clearedAt?: number): Promise<void> {
    await this.msgPort.deleteByConversation?.(conversationId);
    await this.outboxPort.deleteByConversation?.(conversationId);
    if (this.state.activeConversationId === conversationId) {
      this.emit({ messages: [], firstUnreadMessageId: null });
    }
    this.state.conversations = this.state.conversations.map((c) => {
      if (c.id === conversationId) {
        return {
          ...c,
          lastMessage: '',
          lastUnreadMessage: undefined,
          unreadCount: 0,
        };
      }
      return c;
    });
    this.debouncedEmitConversations();
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async handleConvDeleted(conversationId: string, _scope?: string): Promise<void> {
    await this.msgPort.deleteByConversation?.(conversationId);
    await this.outboxPort.deleteByConversation?.(conversationId);
    const updatedConvs = this.state.conversations.filter((c) => c.id !== conversationId);
    const wasActive = this.state.activeConversationId === conversationId;
    this.emit({
      conversations: updatedConvs,
      activeConversationId: wasActive ? '' : this.state.activeConversationId,
      messages: wasActive ? [] : this.state.messages,
      firstUnreadMessageId: wasActive ? null : this.state.firstUnreadMessageId,
    });
  }

  /**
   * Record call event into chat history as an MCE call envelope message.
   */
  async recordCallHistory(record: import('./call/CallSessionMachine').CallHistoryRecord): Promise<void> {
    if (!record || !record.callId) return;
    if (this.recordedCallIds.has(record.callId)) return;
    this.recordedCallIds.add(record.callId);

    try {
      const myIdentityHash = (await this.metadataPort.get('identity_hash')) ?? '';
      const isCaller = record.role === 'caller';

      // Find direct conversation with this peer
      const targetHash = record.peerIdentityHash || record.peerId;
      let conv = this.state.conversations.find((c) =>
        (record.peerIdentityHash && c.peerIdentityHash === record.peerIdentityHash) ||
        c.peerId === record.peerId ||
        c.peerIdentityHash === record.peerId
      );

      // If conversation doesn't exist, create it or look up peer identity hash
      if (!conv) {
        let peerHash = targetHash;
        if (!record.peerIdentityHash) {
          const peerLookup = await this.dirPort.lookup(record.peerId).catch(() => null);
          if (peerLookup?.identityHash) {
            peerHash = peerLookup.identityHash;
          }
        }
        conv = this.state.conversations.find((c) => c.peerIdentityHash === peerHash);
        if (!conv) {
          try {
            await this.convPort.create(peerHash);
            await this.loadConversations();
            conv = this.state.conversations.find((c) => c.peerIdentityHash === peerHash);
          } catch {
            // failed to create conversation
          }
        }
      }

      if (!conv) return;

      const callData: MCECallData = {
        callId: record.callId,
        callType: record.callType,
        direction: isCaller ? 'outgoing' : 'incoming',
        status: record.status,
        duration: record.duration,
      };

      const mcePayload = mceEncodeCall(callData);

      let vaultCiphertext: string | undefined;
      let vaultIv: string | undefined;
      if (this.cryptoPort.vaultEncrypt) {
        try {
          const sealed = await this.cryptoPort.vaultEncrypt(mcePayload);
          vaultCiphertext = sealed.ciphertextHex;
          vaultIv = sealed.ivHex;
        } catch {
          /* best effort vault encryption */
        }
      }

      await this.msgPort.insertIfAbsent({
        id: `call_${record.callId}`,
        conversation_id: conv.id,
        sender_id: isCaller ? myIdentityHash : (conv.peerIdentityHash ?? record.peerId),
        ciphertext: '',
        plaintext: mcePayload,
        vault_ciphertext: vaultCiphertext,
        vault_iv: vaultIv,
        sequence_str: '0',
        created_at: record.timestamp,
        status: 'delivered',
      });

      const mins = Math.floor((record.duration || 0) / 60);
      const secs = (record.duration || 0) % 60;
      const durStr = `${mins}:${secs.toString().padStart(2, '0')}`;
      const isVideo = record.callType === 'video';
      const label = isVideo ? 'تصویری' : 'صوتی';
      const summaryText = record.status === 'completed'
        ? `تماس ${label} (${durStr})`
        : record.status === 'missed'
          ? `تماس ${label} بی‌پاسخ`
          : `تماس ${label} رد شده`;

      this.updateConversationActivity(conv.id, summaryText, record.timestamp);

      if (this.state.activeConversationId === conv.id) {
        await this.loadMessages(conv.id);
      }

      if (record.status === 'missed' && !isCaller) {
        await this.unreadPort?.increment(conv.id);
        await this.refreshUnreadState();
      }
    } catch (err) {
      console.warn('[ChatUseCase] Failed to record call history:', err);
    }
  }

  /**
   * Fetch missed calls from backend and record any that occurred while offline.
   */
  async fetchMissedCalls(): Promise<void> {
    try {
      const token = await this.metadataPort.get('session_token');
      if (!token) return;

      const res = await fetch('/api/v1/calls/missed', {
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });

      if (!res.ok) return;
      const data = await res.json() as { data?: Array<{ id: string; caller_id: string; type: string; created_at: number }> };
      if (!data?.data || !Array.isArray(data.data)) return;

      for (const item of data.data) {
        if (!this.recordedCallIds.has(item.id)) {
          await this.recordCallHistory({
            callId: item.id,
            peerId: item.caller_id,
            peerDisplayName: '',
            role: 'callee',
            callType: item.type === 'VIDEO' ? 'video' : 'audio',
            status: 'missed',
            duration: 0,
            timestamp: item.created_at * 1000,
          });
        }
      }
    } catch (err) {
      console.warn('[ChatUseCase] fetchMissedCalls failed:', err);
    }
  }

  setMediaRestClient(client: MediaRestClient): void {
    this.mediaRestClient = client;
  }

  /**
   * Cancels an in-progress send or upload (H5).
   * - Aborts network request & chunk upload (AbortController)
   * - Instructs server to delete partial upload chunks and free reserved quota
   * - Removes optimistic bubble from UI
   * - Deletes outbox entry if queued/inflight
   * - Deletes message from local DB
   * - Safe against race conditions (e.g. if upload just finished)
   */
  async cancelSending(messageId: string): Promise<void> {
    // 1. Abort media upload if active
    const inFlight = this.inFlightUploads.get(messageId);
    if (inFlight) {
      try {
        inFlight.abortController.abort();
      } catch {
        // ignore
      }
      if (inFlight.fileId && this.mediaRestClient?.deleteMedia) {
        void this.mediaRestClient.deleteMedia(inFlight.fileId).catch(() => {});
      }
      this.inFlightUploads.delete(messageId);
    }

    // 2. Delete outbox entry if queued/inflight
    try {
      await this.outboxPort.delete?.(messageId);
    } catch {
      // ignore
    }

    // 3. Delete from message repository
    try {
      await this.msgPort.deleteMessage?.(messageId);
    } catch {
      // ignore
    }

    // 4. Remove optimistic bubble from UI state
    this.emit({
      messages: this.state.messages.filter((m) => m.id !== messageId),
    });
  }

  /**
   * Retries sending a failed message (H4).
   * - Resets status to 'pending' in state and local DB
   * - Resets outbox entry to 'queued' with retry_count = 0
   * - Triggers flushOutbox()
   */
  async retryMessage(messageId: string): Promise<void> {
    const msg = this.state.messages.find((m) => m.id === messageId);
    if (!msg) return;

    try {
      await this.msgPort.updateStatus?.(messageId, 'pending');
    } catch {
      // ignore
    }
    const updated = this.state.messages.map((m) =>
      m.id === messageId ? { ...m, status: 'pending' as const, uploadError: undefined } : m,
    );
    this.emit({ messages: updated });

    const existingOutbox = await this.outboxPort.getById?.(messageId);
    if (existingOutbox) {
      existingOutbox.status = 'queued';
      existingOutbox.retry_count = 0;
      try {
        await this.outboxPort.resetInflightEntry?.(messageId);
      } catch {
        // ignore
      }
    } else if (msg.plaintext) {
      try {
        await this.outboxPort.enqueue({
          id: messageId,
          conversation_id: msg.conversationId,
          receiver_id: msg.conversationId,
          ciphertext_hex: '',
          plaintext: msg.plaintext,
          sequence_str: '0',
          created_at: toMillis(msg.createdAt),
          retry_count: 0,
          status: 'queued',
        });
      } catch {
        // ignore
      }
    }

    void this.flushOutbox();
  }

  /**
   * Deletes a permanently failed message (H4).
   * - Removes outbox entry
   * - Deletes from local DB
   * - Removes from UI state
   */
  async deleteFailedMessage(messageId: string): Promise<void> {
    try {
      await this.outboxPort.delete?.(messageId);
    } catch {
      // ignore
    }
    try {
      await this.msgPort.deleteMessage?.(messageId);
    } catch {
      // ignore
    }
    this.emit({
      messages: this.state.messages.filter((m) => m.id !== messageId),
    });
  }
}

