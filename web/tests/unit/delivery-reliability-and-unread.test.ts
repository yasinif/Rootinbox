import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatUseCase } from '../../src/usecase/chat';
import type { OutboxPort, MessagePort, MetadataPort, ConversationPort, UnreadPort, CryptoPort } from '../../src/domain';

describe('ChatUseCase Regression Test Suite (Attacks 1-7 Verification)', () => {
  let chat: ChatUseCase;
  let mockOutbox: Record<string, any>;
  let mockMsgPort: Record<string, any>;
  let mockMetaPort: Record<string, any>;
  let mockConvPort: Record<string, any>;
  let mockUnreadPort: Record<string, any>;
  let mockCryptoPort: Record<string, any>;
  let mockSendFn: any;

  beforeEach(() => {
    mockOutbox = {
      getQueued: vi.fn().mockResolvedValue([]),
      getById: vi.fn(),
      hasInflightForReceiver: vi.fn(),
      markInflight: vi.fn(),
      markSent: vi.fn(),
      markFailed: vi.fn().mockResolvedValue(true),
      resetInflight: vi.fn(),
      resetInflightEntry: vi.fn(),
    };
    mockMsgPort = {
      getByConversation: vi.fn().mockResolvedValue([]),
      getById: vi.fn(),
      insertIfAbsent: vi.fn(),
      updateStatus: vi.fn(),
      updateGroupMessage: vi.fn(),
    };
    const metaMap = new Map<string, string>();
    metaMap.set('user_id', 'alice_user_id');
    metaMap.set('identity_hash', 'alice_identity_hash');

    mockMetaPort = {
      get: vi.fn().mockImplementation(async (k: string) => metaMap.get(k) ?? null),
      set: vi.fn().mockImplementation(async (k: string, v: string) => { metaMap.set(k, v); }),
      getByPrefix: vi.fn().mockImplementation(async (prefix: string) => {
        const res: Record<string, string> = {};
        for (const [k, v] of metaMap.entries()) {
          if (k.startsWith(prefix)) res[k] = v;
        }
        return res;
      }),
    };
    mockConvPort = {
      list: vi.fn().mockResolvedValue({ conversations: [] }),
      getReadWatermarks: vi.fn().mockResolvedValue({}),
      postHistory: vi.fn().mockResolvedValue(true),
      getHistory: vi.fn().mockResolvedValue({ items: [] }),
      markRead: vi.fn().mockResolvedValue(undefined),
      getDeliveryAcks: vi.fn().mockResolvedValue([]),
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

  afterEach(() => {
    vi.useRealTimers();
  });

  // Verification for Attack 1 Fix:
  it('Attack 1 Fix: syncConversationHistory updates previously stored Dexie messages for peerSeenIds', async () => {
    const seenReceiptEnvelope = {
      id: 'receipt_envelope_1',
      sender_id: 'bob_identity_hash',
      encrypted_payload: 'enc',
      vault_iv: 'iv',
      created_at: 1500,
    };
    mockConvPort.getHistory.mockResolvedValue({ items: [seenReceiptEnvelope] });
    mockCryptoPort.vaultDecrypt.mockResolvedValue({
      plaintext: JSON.stringify({ v: 1, t: 'sys', s: ['msg_1_stored_earlier'] }),
    });

    await chat.syncConversationHistory('conv_1', true);

    // Verifies updateStatus was invoked on msg_1_stored_earlier
    expect(mockMsgPort.updateStatus).toHaveBeenCalledWith('msg_1_stored_earlier', 'seen');
  });

  // Verification for Attack 2 Fix:
  it('Attack 2 Fix: handleAckServer cancels watchdog timer and outbox does not reset unrelated inflight entries', async () => {
    vi.useFakeTimers();

    mockOutbox.getQueued.mockResolvedValue([{
      id: 'msg_a',
      receiver_id: 'bob',
      ciphertext_hex: '00',
      sequence_str: '1',
      conversation_id: 'conv_1',
    }]);
    mockOutbox.hasInflightForReceiver.mockResolvedValue(false);

    await chat.flushOutbox();
    expect(mockSendFn).toHaveBeenCalledWith(expect.objectContaining({ request_id: 'msg_a' }));

    // Acknowledge msg_a before 5 seconds
    await chat.handleAckServer('msg_a');

    // Advance timers past 5 seconds
    vi.advanceTimersByTime(6000);

    // resetInflightEntry should NOT have been called because timer was cancelled
    expect(mockOutbox.resetInflightEntry).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  // Verification for Attack 3 Fix:
  it('Attack 3 Fix: loadMessages NEVER marks outgoing messages as seen via local watermark', async () => {
    // Watermark is at t=10005 (user opened chat)
    mockMetaPort.set('read_watermark_conv_1', '10005');
    await chat.syncReadWatermarks();

    // Alice sent outgoing message at t=10000 (< watermark)
    const outgoingMsg = {
      id: 'outgoing_msg',
      conversation_id: 'conv_1',
      sender_id: 'alice_identity_hash', // IS ME
      vault_ciphertext: 'enc',
      vault_iv: 'iv',
      created_at: 10000,
      status: 'sent',
    };
    mockMsgPort.getByConversation.mockResolvedValue([outgoingMsg]);
    mockCryptoPort.vaultDecrypt.mockResolvedValue({
      plaintext: JSON.stringify({ v: 1, t: 'text', b: 'Hello Bob' }),
    });

    await chat.loadMessages('conv_1');

    // Outgoing message must remain 'sent', NEVER updated to 'seen' by local watermark
    expect(mockMsgPort.updateGroupMessage).toHaveBeenCalledWith('outgoing_msg', expect.objectContaining({
      status: 'sent',
    }));
  });

  // Verification for Attack 4 Fix:
  it('Attack 4 Fix: active inbound messages advance read watermark in metadata and call convPort.markRead', async () => {
    // User is active in conv_1
    (chat as any).state.activeConversationId = 'conv_1';

    const res = await chat.handleInboundRaw({
      request_id: 'inbound_m1',
      sender_id: 'bob_identity_hash',
      conversation_id: 'conv_1',
      created_at: 1700000000000,
    });

    expect(res.shouldAck).toBe(true);
    expect(await mockMetaPort.get('read_watermark_conv_1')).toBe('1700000000000');
    expect(mockConvPort.markRead).toHaveBeenCalledWith('conv_1', 1700000000000);
    expect(mockUnreadPort.clear).toHaveBeenCalledWith('conv_1');
  });

  // Verification for Attack 5 Fix:
  it('Attack 5 Fix: syncDeliveryAcks paginates past 5 pages without starving recent messages', async () => {
    // Simulate 6 pages of 100 ACKs (600 total ACKs)
    let callCount = 0;
    mockConvPort.getDeliveryAcks.mockImplementation(async (cursor: number, limit: number) => {
      callCount++;
      if (callCount <= 6) {
        const start = (callCount - 1) * 100 + 1;
        return Array.from({ length: 100 }, (_, i) => ({
          id: start + i,
          sender_id: 'alice_identity_hash',
          request_id: `msg_uuid_${start + i}`,
          created_at: 1000 + start + i,
        }));
      }
      return [];
    });

    await chat.syncDeliveryAcks();

    // Verifies all 600 ACKs were fetched and cursor reached 600
    expect(callCount).toBe(7); // 6 full pages + 1 empty termination page
    expect(await mockMetaPort.get('delivery_acks_cursor')).toBe('600');
  });

  // Verification for Attack 6 Fix:
  it('Attack 6 Fix: syncDeliveryAcks delegates through convPort.getDeliveryAcks (Hexagonal Architecture)', async () => {
    mockConvPort.getDeliveryAcks.mockResolvedValue([
      { id: 1, sender_id: 'alice_identity_hash', request_id: 'uuid_1', created_at: 100 },
    ]);

    await chat.syncDeliveryAcks();

    expect(mockConvPort.getDeliveryAcks).toHaveBeenCalledWith(0, 100);
    expect(await mockMetaPort.get('delivered_uuid_1')).toBe('1');
  });

  // Verification for Attack 7 Fix:
  it('Attack 7 Fix: transmission failure transitions message to failed (✗) in Dexie and UI state', async () => {
    mockOutbox.getQueued.mockResolvedValue([{
      id: 'failing_msg',
      receiver_id: 'bob',
      ciphertext_hex: '00',
      sequence_str: '1',
      conversation_id: 'conv_1',
    }]);
    mockOutbox.hasInflightForReceiver.mockResolvedValue(false);
    mockSendFn.mockImplementation(() => {
      throw new Error('WebSocket send failed');
    });

    // Outbox indicates terminal failure
    mockOutbox.markFailed.mockResolvedValue(true);

    let emittedMessages: any[] = [];
    chat.subscribe((state) => {
      emittedMessages = state.messages;
    });

    await chat.flushOutbox();

    expect(mockMsgPort.updateStatus).toHaveBeenCalledWith('failing_msg', 'failed');
    const msg = emittedMessages.find((m) => m.id === 'failing_msg');
    if (msg) {
      expect(msg.status).toBe('failed');
    }
  });

  // Verification of Monotonic Status Progression:
  it('Monotonic Status: delayed ack.server does NOT clobber delivered or seen status', async () => {
    mockMsgPort.getById.mockResolvedValue({
      id: 'msg_1',
      status: 'delivered',
    });

    await chat.handleAckServer('msg_1');

    // updateStatus should NOT be called with 'sent' because current status is 'delivered'
    expect(mockMsgPort.updateStatus).not.toHaveBeenCalledWith('msg_1', 'sent');
  });
});
