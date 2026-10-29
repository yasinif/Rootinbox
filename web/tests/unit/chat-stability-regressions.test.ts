import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatUseCase, type ChatMessage } from '../../src/usecase/chat';
import type { OutboxPort, MessagePort, MetadataPort, ConversationPort, UnreadPort, CryptoPort, DirectoryPort } from '../../src/domain';

describe('Chat Stability Regressions (Unit & Component Logic)', () => {
  let chat: ChatUseCase;
  let mockOutbox: OutboxPort;
  let mockMsgPort: MessagePort;
  let mockMetaPort: MetadataPort;
  let mockConvPort: ConversationPort;
  let mockUnreadPort: UnreadPort;
  let mockCryptoPort: CryptoPort;
  let mockDirPort: DirectoryPort;

  beforeEach(() => {
    const metaMap = new Map<string, string>();
    metaMap.set('user_id', 'user_123');
    metaMap.set('identity_hash', 'hash_123');

    mockMetaPort = {
      get: vi.fn().mockImplementation(async (k: string) => metaMap.get(k) ?? null),
      set: vi.fn().mockImplementation(async (k: string, v: string) => { metaMap.set(k, v); }),
      delete: vi.fn().mockImplementation(async (k: string) => { metaMap.delete(k); }),
      getByPrefix: vi.fn().mockResolvedValue({}),
    };

    const outboxQueue: any[] = [];
    mockOutbox = {
      enqueue: vi.fn().mockImplementation(async (entry) => { outboxQueue.push(entry); }),
      getQueued: vi.fn().mockImplementation(async () => [...outboxQueue]),
      markInflight: vi.fn().mockResolvedValue(undefined),
      markSent: vi.fn().mockImplementation(async (id) => {
        const idx = outboxQueue.findIndex((e) => e.id === id);
        if (idx !== -1) outboxQueue.splice(idx, 1);
      }),
      markFailed: vi.fn().mockResolvedValue(true),
      hasInflightForReceiver: vi.fn().mockResolvedValue(false),
      resetInflight: vi.fn().mockResolvedValue(undefined),
      resetInflightEntry: vi.fn().mockResolvedValue(undefined),
    };

    const storedMessages: any[] = [];
    mockMsgPort = {
      insertIfAbsent: vi.fn().mockImplementation(async (msg) => {
        if (storedMessages.some((m) => m.id === msg.id)) return false;
        storedMessages.push(msg);
        return true;
      }),
      getById: vi.fn().mockImplementation(async (id) => storedMessages.find((m) => m.id === id) || null),
      getByConversation: vi.fn().mockImplementation(async (cid, limit = 60, beforeCreatedAt) => {
        let filtered = storedMessages.filter((m) => m.conversation_id === cid);
        if (beforeCreatedAt) {
          filtered = filtered.filter((m) => m.created_at < beforeCreatedAt);
        }
        filtered.sort((a, b) => b.created_at - a.created_at);
        return filtered.slice(0, limit).reverse();
      }),
      updateStatus: vi.fn().mockImplementation(async (id, status) => {
        const m = storedMessages.find((x) => x.id === id);
        if (m) m.status = status;
      }),
      updateGroupMessage: vi.fn(),
      deleteById: vi.fn(),
      clearByConversation: vi.fn(),
    };

    mockConvPort = {
      list: vi.fn().mockResolvedValue({
        conversations: [{
          id: 'conv_1',
          type: 'DIRECT',
          peerIdentityHash: 'peer_hash',
          peerId: 'peer_user_id',
          createdAt: 1000,
          updatedAt: 1000,
        }],
      }),
      create: vi.fn(),
      createSelf: vi.fn(),
      getHistory: vi.fn().mockResolvedValue({ items: [] }),
      postHistory: vi.fn().mockResolvedValue(undefined),
      deleteHistoryMessage: vi.fn(),
      clearHistory: vi.fn(),
      deleteConversation: vi.fn(),
      markRead: vi.fn(),
      getReadWatermarks: vi.fn().mockResolvedValue({ watermarks: {}, peer_watermarks: {} }),
      getDeliveryAcks: vi.fn().mockResolvedValue([]),
      listGroupMessages: vi.fn().mockResolvedValue([]),
      sendGroupMessage: vi.fn().mockResolvedValue({
        id: 'msg_server_1',
        conversation_id: 'conv_1',
        sender_id: 'user_123',
        content: 'hello',
        server_id: 101,
        created_at: 2000,
      }),
    };

    mockUnreadPort = {
      get: vi.fn().mockResolvedValue(0),
      set: vi.fn().mockResolvedValue(undefined),
      increment: vi.fn().mockResolvedValue(1),
      clear: vi.fn().mockResolvedValue(undefined),
      getAll: vi.fn().mockResolvedValue({}),
    };

    mockCryptoPort = {} as any;
    mockDirPort = { lookup: vi.fn(), invalidate: vi.fn() } as any;

    chat = new ChatUseCase(
      mockCryptoPort,
      mockMsgPort,
      mockOutbox,
      mockConvPort,
      mockDirPort,
      mockMetaPort,
      mockUnreadPort,
    );
  });

  it('Scenario 13: sortMessages prioritizes serverId over skewed client createdAt timestamps', () => {
    // Message A was created with local clock at t=5000, but assigned server_id=1
    // Message B was created with skewed local clock at t=2000, but assigned server_id=2
    const msgA: ChatMessage = {
      id: 'msg_a',
      conversationId: 'conv_1',
      senderId: 'peer_1',
      plaintext: 'First causal message',
      createdAt: 5000,
      serverId: 1,
    };
    const msgB: ChatMessage = {
      id: 'msg_b',
      conversationId: 'conv_1',
      senderId: 'peer_2',
      plaintext: 'Second causal message',
      createdAt: 2000,
      serverId: 2,
    };

    const sorted = (chat as any).sortMessages([msgB, msgA]);
    expect(sorted[0].id).toBe('msg_a');
    expect(sorted[1].id).toBe('msg_b');
  });

  it('Scenario 3: 200 rapid messages arriving via handleGroupMsg are all preserved without truncation', async () => {
    await chat.selectConversation('conv_1');

    // Simulate 200 rapid incoming messages arriving via websocket handleGroupMsg
    for (let i = 1; i <= 200; i++) {
      await chat.handleGroupMsg({
        id: `burst_msg_${i}`,
        conversation_id: 'conv_1',
        sender_id: 'peer_user_id',
        content: `Rapid test message #${i}`,
        server_id: i,
        created_at: 10000 + i,
      });
    }

    const state = chat.getSnapshot();
    const convMessages = state.messages.filter((m) => m.conversationId === 'conv_1');
    expect(convMessages.length).toBe(200);
    expect(convMessages[0].plaintext).toBe('Rapid test message #1');
    expect(convMessages[199].plaintext).toBe('Rapid test message #200');
  });

  it('Scenario 9: Sending while offline enqueues to outbox and flushOutbox delivers message', async () => {
    await chat.selectConversation('conv_1');

    // 1. Simulate network failure when calling sendGroupMessage
    (mockConvPort.sendGroupMessage as any).mockRejectedValueOnce(new Error('Network offline'));

    await chat.sendMessage('conv_1', 'Hello offline world');

    // Message is saved locally with 'pending' status
    const state = chat.getSnapshot();
    const pendingMsg = state.messages.find((m) => m.plaintext === 'Hello offline world');
    expect(pendingMsg).toBeDefined();
    expect(pendingMsg?.status).toBe('pending');

    // Entry was queued in outbox
    expect(mockOutbox.enqueue).toHaveBeenCalledTimes(1);

    // 2. Restore network and flush outbox
    (mockConvPort.sendGroupMessage as any).mockResolvedValueOnce({
      id: pendingMsg!.id,
      conversation_id: 'conv_1',
      sender_id: 'user_123',
      content: 'Hello offline world',
      server_id: 300,
      created_at: Date.now(),
    });

    await chat.flushOutbox();

    // Outbox markSent should be called
    expect(mockOutbox.markSent).toHaveBeenCalledWith(pendingMsg!.id);
    const updatedState = chat.getSnapshot();
    const sentMsg = updatedState.messages.find((m) => m.id === pendingMsg!.id);
    expect(sentMsg?.status).toBe('sent');
    expect(sentMsg?.serverId).toBe(300);
  });

  it('Scenario 14: loadEarlierMessages pages older messages from server cursor into state', async () => {
    await chat.selectConversation('conv_1');

    // Populate 60 recent messages in state
    const baseTime = 1700000000000;
    const initialMessages: ChatMessage[] = [];
    for (let i = 101; i <= 160; i++) {
      initialMessages.push({
        id: `msg_${i}`,
        conversationId: 'conv_1',
        senderId: 'user_123',
        plaintext: `Message #${i}`,
        createdAt: baseTime + i * 1000,
        serverId: i,
        status: 'sent',
      });
    }
    (chat as any).state.messages = initialMessages;

    // Server returns 50 earlier messages (server_id 51 to 100)
    (mockConvPort.listGroupMessages as any).mockImplementation(async (_cid: string, beforeServerId: number, limit: number) => {
      const earlier: any[] = [];
      const start = Math.max(1, beforeServerId - limit);
      for (let i = start; i < beforeServerId; i++) {
        earlier.push({
          id: `msg_${i}`,
          conversation_id: 'conv_1',
          sender_id: 'user_123',
          content: `Message #${i}`,
          server_id: i,
          created_at: baseTime + i * 1000,
        });
      }
      return earlier;
    });

    const hasEarlier = await chat.loadEarlierMessages('conv_1');
    expect(hasEarlier).toBe(true);

    const afterState = chat.getSnapshot();
    expect(afterState.messages.length).toBeGreaterThan(60);
    // Oldest message loaded should have serverId 51
    expect(afterState.messages[0].serverId).toBe(51);
    expect(afterState.messages[0].plaintext).toBe('Message #51');
  });
});
