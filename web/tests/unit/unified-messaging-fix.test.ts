import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatUseCase } from '../../src/usecase/chat';
import type { OutboxPort, MessagePort, MetadataPort, ConversationPort, UnreadPort, CryptoPort } from '../../src/domain';

describe('Unified Cloud Messaging Refactor & Architectural Fixes', () => {
  let chat: ChatUseCase;
  let mockOutbox: Record<string, any>;
  let mockMsgPort: Record<string, any>;
  let mockMetaPort: Record<string, any>;
  let mockConvPort: Record<string, any>;
  let mockUnreadPort: Record<string, any>;
  let mockCryptoPort: Record<string, any>;
  let mockSendFn: any;
  const metaMap = new Map<string, string>();

  beforeEach(() => {
    metaMap.clear();
    metaMap.set('user_id', 'alice-uuid');
    metaMap.set('identity_hash', 'alice-hash');
    metaMap.set('username', 'alice');

    mockOutbox = {
      getQueued: vi.fn().mockResolvedValue([]),
      getById: vi.fn(),
      hasInflightForReceiver: vi.fn(),
      markInflight: vi.fn(),
      markSent: vi.fn(),
      markFailed: vi.fn().mockResolvedValue(true),
      resetInflight: vi.fn(),
      resetInflightEntry: vi.fn(),
      enqueue: vi.fn(),
      deleteByConversation: vi.fn(),
    };

    mockMsgPort = {
      getByConversation: vi.fn().mockResolvedValue([]),
      getById: vi.fn(),
      insertIfAbsent: vi.fn(),
      updateStatus: vi.fn(),
      updateGroupMessage: vi.fn(),
      deleteMessage: vi.fn(),
      deleteByConversation: vi.fn(),
    };

    mockMetaPort = {
      get: vi.fn().mockImplementation(async (k: string) => metaMap.get(k) ?? null),
      set: vi.fn().mockImplementation(async (k: string, v: string) => { metaMap.set(k, v); }),
      delete: vi.fn().mockImplementation(async (k: string) => { metaMap.delete(k); }),
    };

    mockConvPort = {
      list: vi.fn().mockResolvedValue({ conversations: [] }),
      getReadWatermarks: vi.fn().mockResolvedValue({}),
      postHistory: vi.fn().mockResolvedValue(true),
      getHistory: vi.fn().mockResolvedValue({ items: [] }),
      markRead: vi.fn().mockResolvedValue(undefined),
      clearHistory: vi.fn().mockResolvedValue(undefined),
      deleteConversation: vi.fn().mockResolvedValue(undefined),
      editGroupMessage: vi.fn().mockResolvedValue({}),
      deleteGroupMessage: vi.fn().mockResolvedValue(undefined),
      listGroupMessages: vi.fn().mockResolvedValue([]),
    };

    const unreadMap = new Map<string, number>();
    mockUnreadPort = {
      get: vi.fn().mockImplementation(async (id: string) => unreadMap.get(id) ?? 0),
      set: vi.fn().mockImplementation(async (id: string, c: number) => { unreadMap.set(id, c); }),
      clear: vi.fn().mockImplementation(async (id: string) => { unreadMap.set(id, 0); }),
      increment: vi.fn().mockImplementation(async (id: string) => {
        const c = (unreadMap.get(id) ?? 0) + 1;
        unreadMap.set(id, c);
        return c;
      }),
      getAll: vi.fn().mockImplementation(async () => Object.fromEntries(unreadMap.entries())),
    };

    mockCryptoPort = {
      encrypt: vi.fn(),
      decrypt: vi.fn(),
      vaultEncrypt: vi.fn(),
      vaultDecrypt: vi.fn(),
    };

    mockSendFn = vi.fn();

    chat = new ChatUseCase(
      mockCryptoPort as unknown as CryptoPort,
      mockMsgPort as unknown as MessagePort,
      mockOutbox as unknown as OutboxPort,
      mockConvPort as unknown as ConversationPort,
      null as any,
      mockMetaPort as unknown as MetadataPort,
      mockUnreadPort as unknown as UnreadPort,
    );
    chat.setSendFn(mockSendFn);
  });

  describe('Phase 1: Zero Legacy E2EE & Outbox Calls in Message Editing/Deletion', () => {
    it('editMessage invokes REST editGroupMessage and updates Dexie without legacy E2EE outbox enqueue', async () => {
      const convId = 'conv-direct-1';
      const msgId = 'msg-1';
      const newText = 'Updated plaintext content';

      await chat.editMessage(convId, msgId, newText);

      expect(mockConvPort.editGroupMessage).toHaveBeenCalledWith(convId, msgId, newText);
      expect(mockMsgPort.updateGroupMessage).toHaveBeenCalledWith(msgId, expect.objectContaining({
        plaintext: newText,
      }));
      // MUST NOT encrypt or enqueue to outbox
      expect(mockCryptoPort.encrypt).not.toHaveBeenCalled();
      expect(mockOutbox.enqueue).not.toHaveBeenCalled();
    });

    it('deleteMessage (mode=both) invokes REST deleteGroupMessage without legacy E2EE outbox enqueue', async () => {
      const convId = 'conv-direct-1';
      const msgId = 'msg-2';

      await chat.deleteMessage(convId, msgId, 'both');

      expect(mockConvPort.deleteGroupMessage).toHaveBeenCalledWith(convId, msgId);
      expect(mockMsgPort.deleteMessage).toHaveBeenCalledWith(msgId);
      expect(mockCryptoPort.encrypt).not.toHaveBeenCalled();
      expect(mockOutbox.enqueue).not.toHaveBeenCalled();
    });

    it('deleteMessage (mode=me) only deletes locally in Dexie without calling backend or outbox', async () => {
      const convId = 'conv-direct-1';
      const msgId = 'msg-3';

      await chat.deleteMessage(convId, msgId, 'me');

      expect(mockMsgPort.deleteMessage).toHaveBeenCalledWith(msgId);
      expect(mockConvPort.deleteGroupMessage).not.toHaveBeenCalled();
      expect(mockOutbox.enqueue).not.toHaveBeenCalled();
    });
  });

  describe('Phase 2: Clear History & Delete Conversation Scopes', () => {
    it('clearHistory with mode=me invokes REST endpoint and clears local message cache', async () => {
      const convId = 'conv-clear-me';

      await chat.clearHistory(convId, 'me');

      expect(mockConvPort.clearHistory).toHaveBeenCalledWith(convId, 'me');
      expect(mockMsgPort.deleteByConversation).toHaveBeenCalledWith(convId);
      expect(mockOutbox.deleteByConversation).toHaveBeenCalledWith(convId);
    });

    it('clearHistory with mode=both invokes REST endpoint with both', async () => {
      const convId = 'conv-clear-both';

      await chat.clearHistory(convId, 'both');

      expect(mockConvPort.clearHistory).toHaveBeenCalledWith(convId, 'both');
      expect(mockMsgPort.deleteByConversation).toHaveBeenCalledWith(convId);
      expect(mockOutbox.deleteByConversation).toHaveBeenCalledWith(convId);
    });

    it('deleteConversation with mode=me and mode=both passes correct scope to port', async () => {
      const convId = 'conv-delete-1';

      await chat.deleteConversation(convId, 'me');
      expect(mockConvPort.deleteConversation).toHaveBeenCalledWith(convId, 'me');

      await chat.deleteConversation(convId, 'both');
      expect(mockConvPort.deleteConversation).toHaveBeenCalledWith(convId, 'both');
    });

    it('handleConvCleared and handleConvDeleted reactively update local store and active conversation', async () => {
      const convId = 'conv-event-1';
      chat['state'].activeConversationId = convId;
      chat['state'].conversations = [{
        id: convId,
        type: 'DIRECT',
        unreadCount: 5,
        lastMessage: 'Old message',
      } as any];

      await chat.handleConvCleared(convId, 'both', Date.now());

      expect(mockMsgPort.deleteByConversation).toHaveBeenCalledWith(convId);
      expect(chat['state'].messages).toEqual([]);
      expect(chat['state'].firstUnreadMessageId).toBeNull();
      expect(chat['state'].conversations.find((c) => c.id === convId)?.unreadCount).toBe(0);

      await chat.handleConvDeleted(convId, 'both');
      expect(chat['state'].conversations.some((c) => c.id === convId)).toBe(false);
      expect(chat['state'].activeConversationId).toBe('');
    });
  });

  describe('Phase 4: Unread Divider Strictly On Peer Messages (!isOwn)', () => {
    it('places firstUnreadMessageId strictly on incoming peer message and never on own outgoing message', async () => {
      const convId = 'conv-unread-divider';
      const myUserId = 'alice-uuid';
      const myHash = 'alice-hash';
      const peerHash = 'bob-hash';

      chat['state'].conversations = [{
        id: convId,
        type: 'DIRECT',
        unreadCount: 2,
        myLastReadAt: 1700000001000,
      } as any];

      // Stored messages:
      // Msg 1 (peer, old, <= watermark 1700000001000)
      // Msg 2 (alice, own outgoing message created at 1700000001500)
      // Msg 3 (bob, incoming peer message created at 1700000002000) -> THIS should get firstUnreadMessageId!
      // Msg 4 (bob, incoming peer message created at 1700000003000)
      mockMsgPort.getByConversation.mockResolvedValue([
        {
          id: 'msg-1-peer-read',
          conversation_id: convId,
          sender_id: peerHash,
          plaintext: 'Hello Alice (read)',
          created_at: 1700000001000,
          status: 'seen',
        },
        {
          id: 'msg-2-own-outgoing',
          conversation_id: convId,
          sender_id: myUserId,
          plaintext: 'Hi Bob! (my outgoing)',
          created_at: 1700000001500,
          status: 'sent',
          is_outgoing: true,
        },
        {
          id: 'msg-3-peer-unread-1',
          conversation_id: convId,
          sender_id: peerHash,
          plaintext: 'Are you free today?',
          created_at: 1700000002000,
          status: 'delivered',
        },
        {
          id: 'msg-4-peer-unread-2',
          conversation_id: convId,
          sender_id: peerHash,
          plaintext: 'Let me know!',
          created_at: 1700000003000,
          status: 'delivered',
        },
      ]);

      await chat.selectConversation(convId);

      // The unread divider MUST target msg-3-peer-unread-1, NEVER msg-2-own-outgoing!
      const snapshot = chat.getSnapshot();
      expect(snapshot.firstUnreadMessageId).toBe('msg-3-peer-unread-1');
    });

    it('sets firstUnreadMessageId to null if all messages after watermark are outgoing (own) messages', async () => {
      const convId = 'conv-only-own';
      const myUserId = 'alice-uuid';

      chat['state'].conversations = [{
        id: convId,
        type: 'DIRECT',
        unreadCount: 1,
        myLastReadAt: 1000,
      } as any];

      mockMsgPort.getByConversation.mockResolvedValue([
        {
          id: 'msg-own-1',
          conversation_id: convId,
          sender_id: myUserId,
          plaintext: 'I sent this after watermark',
          created_at: 2000,
          status: 'sent',
        },
      ]);

      await chat.selectConversation(convId);

      const snapshot = chat.getSnapshot();
      // MUST NOT place unread divider on own outgoing message!
      expect(snapshot.firstUnreadMessageId).toBeNull();
    });

    it('clears firstUnreadMessageId when sending a new message in the conversation', async () => {
      const convId = 'conv-send-clears-divider';
      chat['state'].activeConversationId = convId;
      chat['state'].firstUnreadMessageId = 'msg-old-unread';
      chat['state'].conversations = [{ id: convId, type: 'GROUP' } as any];

      mockConvPort.sendGroupMessage = vi.fn().mockResolvedValue({
        id: 'msg-sent-new',
        conversation_id: convId,
        content: 'Replying now',
        created_at: Date.now(),
        server_id: 10,
      });

      await chat.sendMessage(convId, 'Replying now');

      const snapshot = chat.getSnapshot();
      expect(snapshot.firstUnreadMessageId).toBeNull();
    });
  });

  describe('Storage Corruption Purging Logic', () => {
    it('detects corrupted replacement character and binary control bytes in message strings', () => {
      const isCorrupted = (plaintext?: string | null): boolean => {
        if (!plaintext) return false;
        return plaintext.includes('\uFFFD') || /[\x00-\x08\x0E-\x1F]/.test(plaintext);
      };

      expect(isCorrupted('Hello world')).toBe(false);
      expect(isCorrupted('سلام دنیا! متن فارسی')).toBe(false);
      expect(isCorrupted('Emoji 🚀 test \n with newlines and \t tabs')).toBe(false);

      expect(isCorrupted('Corrupted with replacement: \uFFFD')).toBe(true);
      expect(isCorrupted('\x019!M#binaryciphertextblob')).toBe(true);
      expect(isCorrupted('Text with null byte \x00')).toBe(true);
      expect(isCorrupted('Text with bell \x07')).toBe(true);
      expect(isCorrupted(null)).toBe(false);
      expect(isCorrupted('')).toBe(false);
    });
  });
});
