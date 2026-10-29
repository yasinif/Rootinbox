import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatUseCase } from '../../src/usecase/chat';
import { toMillis } from '../../src/domain/timestamp';

describe('Messenger Cycle, Timestamp Normalization & Unread Logic Tests', () => {
  describe('Task 1: Timestamp Normalization', () => {
    it('normalizes 10-digit seconds to 13-digit milliseconds', () => {
      expect(toMillis(1700000000)).toBe(1700000000000);
      expect(toMillis('1700000000')).toBe(1700000000000);
    });

    it('leaves 13-digit milliseconds unchanged', () => {
      expect(toMillis(1700000000123)).toBe(1700000000123);
      expect(toMillis('1700000000123')).toBe(1700000000123);
    });

    it('returns 0 for falsy or invalid values', () => {
      expect(toMillis(null)).toBe(0);
      expect(toMillis(undefined)).toBe(0);
      expect(toMillis(0)).toBe(0);
      expect(toMillis('')).toBe(0);
      expect(toMillis('abc')).toBe(0);
    });
  });

  describe('Task 3: Unread Counter & Last Message Preview', () => {
    let chat: ChatUseCase;
    let mockMsgPort: Record<string, any>;
    let mockMetaPort: Record<string, any>;
    let mockConvPort: Record<string, any>;
    let mockUnreadPort: Record<string, any>;
    let mockCryptoPort: Record<string, any>;

    beforeEach(() => {
      mockMsgPort = {
        getByConversation: vi.fn(),
        getById: vi.fn(),
        insertIfAbsent: vi.fn(),
        updateStatus: vi.fn(),
        updateGroupMessage: vi.fn(),
      };
      const metaMap = new Map<string, string>();
      metaMap.set('user_id', 'alice_uuid');
      metaMap.set('identity_hash', 'alice_identity_hash');

      mockMetaPort = {
        get: vi.fn().mockImplementation(async (k: string) => metaMap.get(k) ?? null),
        set: vi.fn().mockImplementation(async (k: string, v: string) => { metaMap.set(k, v); }),
      };
      mockConvPort = {
        list: vi.fn().mockResolvedValue({
          conversations: [
            { id: 'conv_1', type: 'DIRECT', created_at: 1700000000000, peer_id: 'bob_uuid', peer_identity_hash: 'bob_hash' },
          ],
        }),
        getReadWatermarks: vi.fn().mockResolvedValue({}),
      };
      mockUnreadPort = {
        get: vi.fn().mockResolvedValue(0),
        set: vi.fn().mockResolvedValue(undefined),
        getAll: vi.fn().mockResolvedValue({}),
        clear: vi.fn().mockResolvedValue(undefined),
        increment: vi.fn().mockResolvedValue(undefined),
      };
      mockCryptoPort = {
        vaultDecrypt: vi.fn(),
      };

      chat = new ChatUseCase(
        mockCryptoPort as any,
        mockMsgPort as any,
        { getQueued: vi.fn().mockResolvedValue([]) } as any,
        mockConvPort as any,
        { lookup: vi.fn() } as any,
        mockMetaPort as any,
        mockUnreadPort as any,
      );
    });

    it('calculates unread count strictly: excludes self messages, includes only created_at > watermark', async () => {
      // Watermark at t=1000
      (chat as any).readWatermarks.set('conv_1', 1700000001000);

      const messages = [
        // Outgoing message (self) at t=1500 - NOT unread
        { id: 'm1', conversation_id: 'conv_1', sender_id: 'alice_identity_hash', plaintext: 'Hi Bob', created_at: 1700000001500, status: 'sent' },
        // Outgoing message (self UUID) at t=1600 - NOT unread
        { id: 'm2', conversation_id: 'conv_1', sender_id: 'alice_uuid', plaintext: 'Are you there?', created_at: 1700000001600, status: 'sent' },
        // Inbound message older than watermark at t=900 - NOT unread
        { id: 'm3', conversation_id: 'conv_1', sender_id: 'bob_hash', plaintext: 'Old message', created_at: 1700000000900, status: 'delivered' },
        // Inbound message newer than watermark at t=2000 - IS UNREAD
        { id: 'm4', conversation_id: 'conv_1', sender_id: 'bob_hash', plaintext: 'Unread 1', created_at: 1700000002000, status: 'delivered' },
        // Inbound message newer than watermark at t=3000 - IS UNREAD
        { id: 'm5', conversation_id: 'conv_1', sender_id: 'bob_hash', plaintext: 'Unread 2', created_at: 1700000003000, status: 'delivered' },
        // Inbound message with deleted_at - NOT unread
        { id: 'm6', conversation_id: 'conv_1', sender_id: 'bob_hash', plaintext: 'Deleted', created_at: 1700000004000, status: 'delivered', deleted_at: 1700000005000 },
      ];
      mockMsgPort.getByConversation.mockResolvedValue(messages);

      await chat.loadConversations(true);

      const conv = (chat as any).state.conversations.find((c: any) => c.id === 'conv_1');
      expect(conv).toBeDefined();
      expect(conv.unreadCount).toBe(2);
      expect(mockUnreadPort.set).toHaveBeenCalledWith('conv_1', 2);

      // Rule: If unreadCount > 0, display newest unread message ("Unread 2")
      expect(conv.lastMessage).toBe('Unread 2');
      expect(conv.lastMessageTime).toBe(1700000003000);
    });

    it('shows newest message in conversation when unreadCount === 0', async () => {
      // Watermark at t=5000 (all messages read)
      (chat as any).readWatermarks.set('conv_1', 1700000005000);

      const messages = [
        { id: 'm1', conversation_id: 'conv_1', sender_id: 'bob_hash', plaintext: 'Hello', created_at: 1700000001000, status: 'seen' },
        { id: 'm2', conversation_id: 'conv_1', sender_id: 'alice_identity_hash', plaintext: 'Latest reply', created_at: 1700000002000, status: 'seen' },
      ];
      mockMsgPort.getByConversation.mockResolvedValue(messages);

      await chat.loadConversations(true);

      const conv = (chat as any).state.conversations.find((c: any) => c.id === 'conv_1');
      expect(conv.unreadCount).toBe(0);
      // Rule: If unreadCount === 0, show newest message ("Latest reply")
      expect(conv.lastMessage).toBe('Latest reply');
      expect(conv.lastMessageTime).toBe(1700000002000);
    });
  });

  describe('Task 4: Status Lifecycle and handleAckRead', () => {
    let chat: ChatUseCase;
    let mockMsgPort: Record<string, any>;
    let mockMetaPort: Record<string, any>;

    beforeEach(() => {
      mockMsgPort = {
        getByConversation: vi.fn(),
        getById: vi.fn(),
        insertIfAbsent: vi.fn(),
        updateStatus: vi.fn().mockResolvedValue(undefined),
        updateGroupMessage: vi.fn(),
      };
      const metaMap = new Map<string, string>();
      metaMap.set('user_id', 'alice_uuid');
      metaMap.set('identity_hash', 'alice_identity_hash');

      mockMetaPort = {
        get: vi.fn().mockImplementation(async (k: string) => metaMap.get(k) ?? null),
        set: vi.fn().mockImplementation(async (k: string, v: string) => { metaMap.set(k, v); }),
      };

      chat = new ChatUseCase(
        {} as any,
        mockMsgPort as any,
        { getQueued: vi.fn().mockResolvedValue([]) } as any,
        { list: vi.fn().mockResolvedValue({ conversations: [] }) } as any,
        { lookup: vi.fn() } as any,
        mockMetaPort as any,
      );
    });

    it('upgrades outgoing messages created <= peerLastReadAt to seen', async () => {
      (chat as any).state.activeConversationId = 'conv_1';
      (chat as any).state.messages = [
        { id: 'msg_1', conversationId: 'conv_1', isOutgoing: true, status: 'delivered', createdAt: 1700000001000 },
        { id: 'msg_2', conversationId: 'conv_1', isOutgoing: true, status: 'delivered', createdAt: 1700000002000 },
        { id: 'msg_3', conversationId: 'conv_1', isOutgoing: true, status: 'sent', createdAt: 1700000005000 },
      ];

      mockMsgPort.getByConversation.mockResolvedValue([
        { id: 'msg_1', created_at: 1700000001000, status: 'delivered' },
        { id: 'msg_2', created_at: 1700000002000, status: 'delivered' },
        { id: 'msg_3', created_at: 1700000005000, status: 'sent' },
      ]);

      // Peer read up to t=2000
      await chat.handleAckRead('conv_1', 1700000002000);

      // In-memory state: msg_1 and msg_2 should be 'seen', msg_3 remains 'sent'
      const msgs = (chat as any).state.messages;
      expect(msgs[0].status).toBe('seen');
      expect(msgs[1].status).toBe('seen');
      expect(msgs[2].status).toBe('sent');

      // IndexedDB updates
      expect(mockMsgPort.updateStatus).toHaveBeenCalledWith('msg_1', 'seen');
      expect(mockMsgPort.updateStatus).toHaveBeenCalledWith('msg_2', 'seen');
      expect(mockMsgPort.updateStatus).not.toHaveBeenCalledWith('msg_3', 'seen');
    });
  });
});
