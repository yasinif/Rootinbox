import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ChatUseCase, classifySendError } from '../../src/usecase/chat';
import type { OutboxPort, MsgPort, MetadataPort, ConversationPort, UnreadPort, CryptoPort } from '../../src/domain/ports';
import type { MediaRestClient } from '../../src/domain/ports/media';

describe('H4: Outbox Robustness & Error Classification', () => {
  it('distinguishes permanent from transient HTTP errors', () => {
    // Permanent errors: 400, 401, 403, 404, 413
    expect(classifySendError({ status: 400 })).toBe('permanent');
    expect(classifySendError({ status: 401 })).toBe('permanent');
    expect(classifySendError({ status: 403 })).toBe('permanent');
    expect(classifySendError({ status: 404 })).toBe('permanent');
    expect(classifySendError({ status: 413 })).toBe('permanent');

    // Transient errors: 408 (timeout), 429 (rate limit), 5xx server errors
    expect(classifySendError({ status: 408 })).toBe('transient');
    expect(classifySendError({ status: 429 })).toBe('transient');
    expect(classifySendError({ status: 500 })).toBe('transient');
    expect(classifySendError({ status: 502 })).toBe('transient');
    expect(classifySendError({ status: 503 })).toBe('transient');
    expect(classifySendError({ status: 504 })).toBe('transient');

    // Network / generic errors
    expect(classifySendError(new Error('Network offline'))).toBe('transient');
    expect(classifySendError(new TypeError('Failed to fetch'))).toBe('transient');
    expect(classifySendError({ code: 'RATE_LIMITED' })).toBe('transient');
    expect(classifySendError({ code: 'AUTH_EXPIRED' })).toBe('permanent');
    expect(classifySendError({ code: 'VAL_PAYLOAD_TOO_LARGE' })).toBe('permanent');
    expect(classifySendError({ code: 'MED_C04' })).toBe('permanent');
  });

  describe('Outbox State Machine & Actions (H4)', () => {
    let chat: ChatUseCase;
    let mockOutbox: Record<string, any>;
    let mockMsgPort: Record<string, any>;
    let mockMetaPort: Record<string, any>;
    let mockConvPort: Record<string, any>;
    let mockUnreadPort: Record<string, any>;
    let mockCryptoPort: Record<string, any>;
    let mockSendFn: any;

    beforeEach(() => {
      vi.useFakeTimers();

      mockOutbox = {
        getQueued: vi.fn().mockResolvedValue([]),
        getById: vi.fn(),
        hasInflightForReceiver: vi.fn().mockResolvedValue(false),
        markInflight: vi.fn(),
        markSent: vi.fn(),
        markFailed: vi.fn().mockResolvedValue(true),
        markPermanentFailed: vi.fn().mockResolvedValue(undefined),
        resetInflight: vi.fn(),
        resetInflightEntry: vi.fn(),
        enqueue: vi.fn(),
        delete: vi.fn().mockResolvedValue(undefined),
      };

      mockMsgPort = {
        getByConversation: vi.fn().mockResolvedValue([]),
        getById: vi.fn(),
        insertIfAbsent: vi.fn(),
        updateStatus: vi.fn().mockResolvedValue(undefined),
        deleteMessage: vi.fn().mockResolvedValue(undefined),
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
        sendGroupMessage: vi.fn(),
      };

      mockUnreadPort = {
        get: vi.fn().mockResolvedValue(0),
        set: vi.fn(),
        clear: vi.fn(),
        increment: vi.fn().mockResolvedValue(1),
        getAll: vi.fn().mockResolvedValue({}),
      };

      mockCryptoPort = {
        vaultDecrypt: vi.fn(),
      };

      mockSendFn = vi.fn();

      chat = new ChatUseCase(
        mockCryptoPort as unknown as CryptoPort,
        mockMsgPort as unknown as MsgPort,
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

    it('marks message and outbox entry permanently failed on 400/403/404 without endless retries', async () => {
      const outboxEntry = {
        id: 'msg-perm-fail',
        conversation_id: 'conv-1',
        receiver_id: 'conv-1',
        ciphertext_hex: 'aabb',
        plaintext: 'Hello fail',
        sequence_str: '1',
        created_at: 1000,
        retry_count: 0,
        status: 'queued',
      };

      mockOutbox.getQueued.mockResolvedValueOnce([outboxEntry]).mockResolvedValue([]);
      mockConvPort.sendGroupMessage.mockRejectedValue({ status: 403, message: 'Forbidden' });

      await chat.flushOutbox();

      expect(mockOutbox.markPermanentFailed).toHaveBeenCalledWith('msg-perm-fail');
      expect(mockMsgPort.updateStatus).toHaveBeenCalledWith('msg-perm-fail', 'failed');
      expect(mockOutbox.resetInflightEntry).not.toHaveBeenCalled();
    });

    it('retries transient errors with backoff and marks failed when reaching retry cap (10)', async () => {
      const outboxEntry = {
        id: 'msg-transient-fail',
        conversation_id: 'conv-1',
        receiver_id: 'conv-1',
        ciphertext_hex: 'aabb',
        plaintext: 'Hello transient',
        sequence_str: '1',
        created_at: 1000,
        retry_count: 9, // already at 9 retries, next attempt is 10th
        status: 'queued',
      };

      mockOutbox.getQueued.mockResolvedValueOnce([outboxEntry]).mockResolvedValue([]);
      mockConvPort.sendGroupMessage.mockRejectedValue(new Error('Network offline'));

      await chat.flushOutbox();

      expect(mockOutbox.markPermanentFailed).toHaveBeenCalledWith('msg-transient-fail');
      expect(mockMsgPort.updateStatus).toHaveBeenCalledWith('msg-transient-fail', 'failed');
    });

    it('retryMessage transitions failed message back to pending and triggers flushOutbox', async () => {
      const existingEntry = {
        id: 'msg-to-retry',
        conversation_id: 'conv-1',
        receiver_id: 'conv-1',
        ciphertext_hex: 'aabb',
        plaintext: 'Retry me',
        sequence_str: '1',
        created_at: 1000,
        retry_count: 5,
        status: 'failed',
      };

      // Populate in-memory state
      chat.emit({
        messages: [{
          id: 'msg-to-retry',
          conversationId: 'conv-1',
          senderId: 'alice_user_id',
          plaintext: 'Retry me',
          createdAt: 1000,
          status: 'failed',
        }],
      });

      mockOutbox.getById.mockResolvedValue(existingEntry);
      mockOutbox.getQueued.mockResolvedValueOnce([existingEntry]).mockResolvedValue([]);
      mockConvPort.sendGroupMessage.mockResolvedValue({ id: 'msg-to-retry', sequence: 2 });

      await chat.retryMessage('msg-to-retry');

      expect(mockMsgPort.updateStatus).toHaveBeenCalledWith('msg-to-retry', 'pending');
      expect(mockOutbox.resetInflightEntry).toHaveBeenCalledWith('msg-to-retry');
      expect(existingEntry.status).toBe('queued');
      expect(existingEntry.retry_count).toBe(0);
    });

    it('deleteFailedMessage removes outbox entry and local message record', async () => {
      chat.emit({
        messages: [{
          id: 'msg-to-delete',
          conversationId: 'conv-1',
          senderId: 'alice_user_id',
          plaintext: 'Delete me',
          createdAt: 1000,
          status: 'failed',
        }],
      });

      await chat.deleteFailedMessage('msg-to-delete');

      expect(mockOutbox.delete).toHaveBeenCalledWith('msg-to-delete');
      expect(mockMsgPort.deleteMessage).toHaveBeenCalledWith('msg-to-delete');
      expect(chat.getSnapshot().messages.some((m) => m.id === 'msg-to-delete')).toBe(false);
    });
  });
});

describe('H5: Cancel Sending (Text & Media Uploads)', () => {
  let chat: ChatUseCase;
  let mockOutbox: Record<string, any>;
  let mockMsgPort: Record<string, any>;
  let mockMetaPort: Record<string, any>;
  let mockMediaClient: Partial<MediaRestClient>;

  beforeEach(() => {
    mockOutbox = {
      getQueued: vi.fn().mockResolvedValue([]),
      getById: vi.fn(),
      hasInflightForReceiver: vi.fn().mockResolvedValue(false),
      markInflight: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn().mockResolvedValue(undefined),
      markPermanentFailed: vi.fn().mockResolvedValue(undefined),
    };

    mockMsgPort = {
      getByConversation: vi.fn().mockResolvedValue([]),
      getById: vi.fn(),
      insertIfAbsent: vi.fn(),
      updateStatus: vi.fn(),
      deleteMessage: vi.fn().mockResolvedValue(undefined),
    };

    mockMetaPort = {
      get: vi.fn().mockResolvedValue('alice_user_id'),
      set: vi.fn(),
      getByPrefix: vi.fn().mockResolvedValue({}),
    };

    mockMediaClient = {
      uploadChunk: vi.fn(),
      finalizeUpload: vi.fn(),
      deleteMedia: vi.fn().mockResolvedValue(undefined),
    };

    chat = new ChatUseCase(
      {} as any,
      mockMsgPort as unknown as MsgPort,
      mockOutbox as unknown as OutboxPort,
      { list: vi.fn().mockResolvedValue({ conversations: [] }) } as any,
      null as any,
      mockMetaPort as unknown as MetadataPort,
      { get: vi.fn().mockResolvedValue(0), getAll: vi.fn().mockResolvedValue({}) } as any,
    );
    chat.setMediaRestClient(mockMediaClient as MediaRestClient);
  });

  it('cancelling a queued text message deletes outbox entry and removes message from UI', async () => {
    const textMsgId = 'text-cancel-1';
    chat.emit({
      messages: [{
        id: textMsgId,
        conversationId: 'conv-1',
        senderId: 'alice_user_id',
        plaintext: 'Queued text to cancel',
        createdAt: 1000,
        status: 'pending',
      }],
    });

    await chat.cancelSending(textMsgId);

    expect(mockOutbox.delete).toHaveBeenCalledWith(textMsgId);
    expect(mockMsgPort.deleteMessage).toHaveBeenCalledWith(textMsgId);
    expect(chat.getSnapshot().messages.find((m) => m.id === textMsgId)).toBeUndefined();
  });

  it('cancelling an in-flight media upload triggers AbortController, calls server deleteMedia, and purges outbox', async () => {
    const mediaMsgId = 'media-cancel-1';
    const fakeFileId = 'server-file-uuid-123';

    chat.emit({
      activeConversationId: 'conv-1',
      messages: [{
        id: mediaMsgId,
        conversationId: 'conv-1',
        senderId: 'alice_user_id',
        messageType: 'file',
        fileName: 'large-video.mp4',
        createdAt: 1000,
        status: 'pending',
      }],
    });

    // Simulate in-flight upload registered in ChatUseCase
    const abortController = new AbortController();
    (chat as any).inFlightUploads.set(mediaMsgId, {
      abortController,
      fileId: fakeFileId,
    });

    await chat.cancelSending(mediaMsgId);

    // Assert abort signal fired
    expect(abortController.signal.aborted).toBe(true);

    // Assert server-side cleanup called to prevent orphaned chunks and free quota
    expect(mockMediaClient.deleteMedia).toHaveBeenCalledWith(fakeFileId);

    // Assert local DB & outbox cleaned
    expect(mockOutbox.delete).toHaveBeenCalledWith(mediaMsgId);
    expect(mockMsgPort.deleteMessage).toHaveBeenCalledWith(mediaMsgId);

    // Assert optimistic bubble removed from UI
    expect(chat.getSnapshot().messages.find((m) => m.id === mediaMsgId)).toBeUndefined();
  });

  it('race condition safety: cancelling when upload just finished or is inactive does not throw and allows subsequent sends', async () => {
    const completedMsgId = 'media-already-done';

    // No inFlight entry exists (upload just finished)
    await expect(chat.cancelSending(completedMsgId)).resolves.not.toThrow();

    // Subsequent text message can be queued and sent without corruption
    await chat.sendMessage('conv-1', 'Subsequent message after cancel');
    expect(mockOutbox.enqueue).toHaveBeenCalled();
  });

  it('idempotent double-cancel: calling cancelSending twice for the same message is safe', async () => {
    const msgId = 'double-cancel-msg';
    chat.emit({
      messages: [{
        id: msgId,
        conversationId: 'conv-1',
        senderId: 'alice_user_id',
        plaintext: 'Cancel twice',
        createdAt: 1000,
        status: 'pending',
      }],
    });

    await expect(chat.cancelSending(msgId)).resolves.not.toThrow();
    await expect(chat.cancelSending(msgId)).resolves.not.toThrow();
    expect(chat.getSnapshot().messages.find((m) => m.id === msgId)).toBeUndefined();
  });

  it('handles 401 unauthorized and 413 payload too large as permanent failures', async () => {
    expect(classifySendError({ status: 401 })).toBe('permanent');
    expect(classifySendError({ status: 413 })).toBe('permanent');

    const entry401 = {
      id: 'msg-401',
      conversation_id: 'conv-1',
      receiver_id: 'conv-1',
      ciphertext_hex: '1122',
      plaintext: 'Unauthorized message',
      sequence_str: '1',
      created_at: 1000,
      retry_count: 0,
      status: 'queued',
    };

    mockOutbox.getQueued.mockResolvedValueOnce([entry401]).mockResolvedValue([]);
    // Setup chat with mockConvPort
    (chat as any).convPort = {
      sendGroupMessage: vi.fn().mockRejectedValue({ status: 401, message: 'Unauthorized' }),
    };

    await chat.flushOutbox();
    expect(mockOutbox.markPermanentFailed).toHaveBeenCalledWith('msg-401');
    expect(mockMsgPort.updateStatus).toHaveBeenCalledWith('msg-401', 'failed');
  });
});

