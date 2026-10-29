/**
 * Unit tests for Bundle 5: Message Management.
 * Verifies:
 * - 5.1 Reply: MCE v1 "r" flag, bidirectional reply linking, fallback when quoted message missing.
 * - 5.2 Edit: MCE v1 "e" flag, sealed edit message relay in DIRECT E2EE, local store update, idempotent re-decrypt.
 * - 5.3 Delete:
 *     - "Delete for me": device-local Dexie removal.
 *     - "Delete for both": sealed sys control envelope {"v":1,"t":"sys","d":"<uuid>"}, receiver local removal.
 * - 5.4 Forward: Brand-new re-encrypted message, NO forwarded-from label/metadata.
 * - 5.5 Delete entire conversation: local-only Dexie purge (messages + outbox rows).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatUseCase } from '../../src/usecase/chat';
import {
  mceEncodeText,
  mceEncodeEdit,
  mceEncodeDeleteForBoth,
  mceDecode,
  mceDisplayText,
} from '../../src/domain/protocol/content-envelope';
import type {
  CryptoPort,
  MessagePort as MsgPort,
  OutboxPort,
  ConversationPort,
  DirectoryPort,
  MetadataPort,
  StoredMessageDTO,
  OutboxEntryDTO,
  ConversationDTO,
} from '../../src/domain';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytesToHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const hexToBytes = (hex: string): Uint8Array => { const out = new Uint8Array(hex.length / 2); for (let i = 0; i < out.length; i++) { out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16); } return out; };
const utf8ToBase64 = (s: string): string => btoa(String.fromCharCode(...encoder.encode(s)));

describe('Bundle 5: MCE Protocol Envelopes', () => {
  it('encodes plain text without r when replyToId is omitted', () => {
    const encoded = mceEncodeText('Hello World');
    expect(encoded).toBe('{"v":1,"t":"text","b":"Hello World"}');
    const decoded = mceDecode(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.t).toBe('text');
    if (decoded?.t === 'text') {
      expect(decoded.b).toBe('Hello World');
      expect(decoded.r).toBeUndefined();
    }
  });

  it('encodes reply with "r" flag matching target client uuid', () => {
    const encoded = mceEncodeText('I agree', 'target-uuid-123');
    expect(encoded).toBe('{"v":1,"t":"text","b":"I agree","r":"target-uuid-123"}');
    const decoded = mceDecode(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.t).toBe('text');
    if (decoded?.t === 'text') {
      expect(decoded.b).toBe('I agree');
      expect(decoded.r).toBe('target-uuid-123');
    }
  });

  it('encodes edit with "e" flag and new text in "b"', () => {
    const encoded = mceEncodeEdit('orig-uuid-456', 'Updated text content');
    expect(encoded).toBe('{"v":1,"t":"text","b":"Updated text content","e":"orig-uuid-456"}');
    const decoded = mceDecode(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.t).toBe('text');
    if (decoded?.t === 'text') {
      expect(decoded.b).toBe('Updated text content');
      expect(decoded.e).toBe('orig-uuid-456');
    }
  });

  it('encodes delete-for-both as sealed sys message {"v":1,"t":"sys","d":"<uuid>"}', () => {
    const encoded = mceEncodeDeleteForBoth('del-uuid-789');
    expect(encoded).toBe('{"v":1,"t":"sys","d":"del-uuid-789"}');
    const decoded = mceDecode(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.t).toBe('sys');
    if (decoded?.t === 'sys') {
      expect(decoded.d).toBe('del-uuid-789');
    }
  });

  it('mceDisplayText extracts text, handles sys envelope, and supports legacy fallback', () => {
    expect(mceDisplayText('{"v":1,"t":"text","b":"Active msg"}')).toBe('Active msg');
    expect(mceDisplayText('{"v":1,"t":"sys","d":"xyz"}')).toBe('This message was deleted');
    expect(mceDisplayText('Raw legacy plaintext')).toBe('Raw legacy plaintext');
  });
});

describe('Bundle 5: Direct E2EE Message Management UseCase Tests', () => {
  let mockCryptoPort: CryptoPort;
  let mockMsgPort: MsgPort;
  let mockOutboxPort: OutboxPort;
  let mockConvPort: ConversationPort;
  let mockDirPort: DirectoryPort;
  let mockMetadataPort: MetadataPort;
  let chatUC: ChatUseCase;

  let storedMessages: StoredMessageDTO[] = [];
  let outboxEntries: OutboxEntryDTO[] = [];
  let conversations: ConversationDTO[] = [];
  let wsSentMessages: Array<{ type: string; [key: string]: unknown }> = [];

  const MY_HASH = 'my-identity-hash-1111';
  const PEER_HASH = 'peer-identity-hash-2222';
  const PEER_USER_ID = 'peer-user-uuid-9999';
  const CONV_ID = 'conv-direct-1';

  beforeEach(() => {
    storedMessages = [];
    outboxEntries = [];
    wsSentMessages = [];
    conversations = [
      {
        id: CONV_ID,
        type: 'DIRECT',
        created_at: 1000,
        peer_id: PEER_USER_ID,
        peer_identity_hash: PEER_HASH,
      },
    ];

    mockCryptoPort = {
      init: vi.fn(),
      generateSessionKeys: vi.fn(),
      signSessionKey: vi.fn(),
      signLoginPayload: vi.fn(),
      buildRegistrationWire: vi.fn(),
      encrypt: vi.fn().mockImplementation(async (params) => ({
        ciphertextHex: bytesToHex(encoder.encode(params.plaintext)),
        sequence: '1',
        ivHex: '00'.repeat(12),
      })),
      decrypt: vi.fn().mockImplementation(async (params) => ({
        plaintext: decoder.decode(hexToBytes(params.ciphertextHex)),
        sequence: '1',
      })),
      deriveVaultKey: vi.fn(),
      vaultEncrypt: vi.fn(),
      vaultDecrypt: vi.fn(),
      allocateSequence: vi.fn().mockResolvedValue({ sequence: '1' }),
      destroy: vi.fn(),
    };

    mockMsgPort = {
      insertIfAbsent: vi.fn().mockImplementation(async (msg: StoredMessageDTO) => {
        const exists = storedMessages.some((m) => m.id === msg.id);
        if (exists) return false;
        storedMessages.push(msg);
        return true;
      }),
      getByConversation: vi.fn().mockImplementation(async (cid: string) => {
        return storedMessages.filter((m) => m.conversation_id === cid);
      }),
      getById: vi.fn().mockImplementation(async (id: string) => {
        return storedMessages.find((m) => m.id === id);
      }),
      updatePlaintext: vi.fn().mockImplementation(async (id: string, plaintext: string) => {
        const m = storedMessages.find((x) => x.id === id);
        if (m) m.plaintext = plaintext;
      }),
      updateStatus: vi.fn().mockImplementation(async (id: string, status: StoredMessageDTO['status']) => {
        const m = storedMessages.find((x) => x.id === id);
        if (m) m.status = status;
      }),
      updateGroupMessage: vi.fn().mockImplementation(async (id: string, updates: Partial<StoredMessageDTO>) => {
        const idx = storedMessages.findIndex((m) => m.id === id);
        if (idx !== -1) {
          storedMessages[idx] = { ...storedMessages[idx], ...updates };
        }
      }),
      deleteMessage: vi.fn().mockImplementation(async (id: string) => {
        storedMessages = storedMessages.filter((m) => m.id !== id);
      }),
      deleteByConversation: vi.fn().mockImplementation(async (cid: string) => {
        storedMessages = storedMessages.filter((m) => m.conversation_id !== cid);
      }),
    };

    mockOutboxPort = {
      enqueue: vi.fn().mockImplementation(async (entry: OutboxEntryDTO) => {
        outboxEntries.push(entry);
      }),
      getQueued: vi.fn().mockImplementation(async () => {
        return outboxEntries.filter((e) => e.status === 'queued');
      }),
      markInflight: vi.fn().mockImplementation(async (id: string) => {
        const e = outboxEntries.find((x) => x.id === id);
        if (e) e.status = 'inflight';
      }),
      markSent: vi.fn().mockImplementation(async (id: string) => {
        const e = outboxEntries.find((x) => x.id === id);
        if (e) e.status = 'sent';
      }),
      markFailed: vi.fn().mockImplementation(async (id: string) => {
        const e = outboxEntries.find((x) => x.id === id);
        if (e) e.status = 'failed';
      }),
      hasInflightForReceiver: vi.fn().mockResolvedValue(false),
      deleteByConversation: vi.fn().mockImplementation(async (cid: string) => {
        outboxEntries = outboxEntries.filter((e) => e.conversation_id !== cid);
      }),
    };

    mockConvPort = {
      list: vi.fn().mockImplementation(async () => ({ conversations: [...conversations] })),
      create: vi.fn(),
      createSelf: vi.fn(),
      createGroup: vi.fn(),
      joinByInvite: vi.fn(),
      joinPublic: vi.fn(),
      searchPublic: vi.fn().mockResolvedValue([]),
      getMembers: vi.fn().mockResolvedValue([]),
      addMember: vi.fn(),
      removeMember: vi.fn(),
      updateMemberRole: vi.fn(),
      listGroupMessages: vi.fn().mockResolvedValue([]),
      sendGroupMessage: vi.fn(),
      editGroupMessage: vi.fn(),
      deleteGroupMessage: vi.fn(),
      getHistory: vi.fn().mockResolvedValue({ items: [] }),
      postHistory: vi.fn(),
      deleteHistoryMessage: vi.fn(),
      clearHistory: vi.fn(),
      deleteConversation: vi.fn(),
    };

    mockDirPort = {
      lookup: vi.fn().mockResolvedValue({
        userId: PEER_USER_ID,
        identityHash: PEER_HASH,
        identityPublicKey: 'peer-pubkey',
        activeSession: {
          sessionId: 'session-1',
          x25519PublicKey: 'peer-x25519-pk',
          sessionVersion: 1,
        },
      }),
    };

    mockMetadataPort = {
      get: vi.fn().mockImplementation(async (key: string) => {
        if (key === 'identity_hash') return MY_HASH;
        return undefined;
      }),
      set: vi.fn(),
      delete: vi.fn(),
    };

    chatUC = new ChatUseCase(
      mockCryptoPort,
      mockMsgPort,
      mockOutboxPort,
      mockConvPort,
      mockDirPort,
      mockMetadataPort,
    );

    chatUC.setWsSendFn((msg) => {
      wsSentMessages.push(msg);
    });
  });

  // ─── 5.1 Reply in Direct Chat ──────────────────────────────
  it('5.1 sends reply message with "r" flag and stores reply_to_id', async () => {
    await chatUC.loadConversations();
    await chatUC.selectConversation(CONV_ID);

    // Send original message
    await chatUC.sendMessage(CONV_ID, 'Original question');
    const originalMsg = chatUC.getSnapshot().messages[0];
    expect(originalMsg).toBeDefined();

    // Reply to original message
    await chatUC.sendMessage(CONV_ID, 'Answer to your question', PEER_HASH, originalMsg.id);

    const messages = chatUC.getSnapshot().messages;
    expect(messages.length).toBe(2);
    const replyMsg = messages[1];
    expect(replyMsg.replyToId).toBe(originalMsg.id);

    // Verify stored in Dexie with reply_to_id
    const stored = storedMessages.find((m) => m.id === replyMsg.id);
    expect(stored?.reply_to_id).toBe(originalMsg.id);

    // Verify encrypted plaintext contains r
    const decoded = mceDecode(stored?.plaintext || '');
    expect(decoded?.t).toBe('text');
    if (decoded?.t === 'text') {
      expect(decoded.r).toBe(originalMsg.id);
    }
  });

  it('5.1 receives inbound reply message and extracts reply_to_id on decrypt', async () => {
    await chatUC.loadConversations();
    await chatUC.selectConversation(CONV_ID);

    const inboundMce = mceEncodeText('Inbound answer', 'quoted-msg-uuid');
    const base64Payload = utf8ToBase64(inboundMce);

    await chatUC.handleInboundRaw({
      v: 1,
      type: 'chat.msg',
      request_id: 'inbound-reply-uuid',
      sender_id: PEER_USER_ID,
      payload: base64Payload,
      sequence_number: 10,
    });

    const stored = storedMessages.find((m) => m.id === 'inbound-reply-uuid');
    expect(stored).toBeDefined();
    expect(stored?.reply_to_id).toBe('quoted-msg-uuid');

    const uiMessages = chatUC.getSnapshot().messages;
    const uiMsg = uiMessages.find((m) => m.id === 'inbound-reply-uuid');
    expect(uiMsg?.replyToId).toBe('quoted-msg-uuid');
  });

  // ─── 5.2 Edit in Direct Chat ───────────────────────────────
  it('5.2 edits direct message locally and transmits sealed edit envelope with "e" flag to peer', async () => {
    await chatUC.loadConversations();
    await chatUC.selectConversation(CONV_ID);

    await chatUC.sendMessage(CONV_ID, 'Typo in text');
    const msgId = chatUC.getSnapshot().messages[0].id;

    // Sender edits message
    await chatUC.editMessage(CONV_ID, msgId, 'Corrected text');

    // Local Dexie updated
    const updated = storedMessages.find((m) => m.id === msgId);
    expect(updated?.edited_at).toBeGreaterThan(0);
    expect(mceDisplayText(updated?.plaintext || '')).toBe('Corrected text');

    // UI updated
    const uiMsg = chatUC.getSnapshot().messages.find((m) => m.id === msgId);
    expect(uiMsg?.plaintext).toBe('Corrected text');
    expect(uiMsg?.editedAt).toBeGreaterThan(0);

    // Outbox queued the sealed edit envelope
    const editOutbox = outboxEntries.find((e) => e.receiver_id === PEER_USER_ID && e.id !== msgId);
    expect(editOutbox).toBeDefined();
    const editPayload = decoder.decode(hexToBytes(editOutbox!.ciphertext_hex));
    const decodedEdit = mceDecode(editPayload);
    expect(decodedEdit?.t).toBe('text');
    if (decodedEdit?.t === 'text') {
      expect(decodedEdit.e).toBe(msgId);
      expect(decodedEdit.b).toBe('Corrected text');
    }
  });

  it('5.2 receiver updates target message when receiving sealed edit envelope without creating duplicate bubble', async () => {
    await chatUC.loadConversations();
    await chatUC.selectConversation(CONV_ID);

    // Pre-populate target message from peer
    const origMce = mceEncodeText('Hello friend');
    storedMessages.push({
      id: 'target-msg-uuid-1',
      conversation_id: CONV_ID,
      sender_id: PEER_HASH,
      ciphertext: '00',
      plaintext: origMce,
      sequence_str: '1',
      created_at: 2000,
      status: 'delivered',
    });
    await chatUC.loadMessages(CONV_ID);
    expect(chatUC.getSnapshot().messages.length).toBe(1);

    // Inbound sealed edit envelope
    const editMce = mceEncodeEdit('target-msg-uuid-1', 'Hello my best friend');
    const base64Payload = utf8ToBase64(editMce);

    await chatUC.handleInboundRaw({
      v: 1,
      type: 'chat.msg',
      request_id: 'edit-cmd-uuid',
      sender_id: PEER_USER_ID,
      payload: base64Payload,
      sequence_number: 11,
    });

    // Target message updated in Dexie
    const targetStored = storedMessages.find((m) => m.id === 'target-msg-uuid-1');
    expect(targetStored?.edited_at).toBeGreaterThan(0);
    expect(mceDisplayText(targetStored?.plaintext || '')).toBe('Hello my best friend');

    // UI updated: still only 1 message, no duplicate bubble!
    const messages = chatUC.getSnapshot().messages;
    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe('target-msg-uuid-1');
    expect(messages[0].plaintext).toBe('Hello my best friend');
    expect(messages[0].editedAt).toBeGreaterThan(0);
  });

  // ─── 5.3 Delete in Direct Chat ─────────────────────────────
  it('5.3 delete for me removes the message row from local Dexie only', async () => {
    await chatUC.loadConversations();
    await chatUC.selectConversation(CONV_ID);

    await chatUC.sendMessage(CONV_ID, 'Private note to delete');
    const msgId = chatUC.getSnapshot().messages[0].id;
    expect(storedMessages.length).toBe(1);

    // Delete for me
    await chatUC.deleteMessage(CONV_ID, msgId, 'me');

    expect(storedMessages.length).toBe(0);
    expect(chatUC.getSnapshot().messages.length).toBe(0);
  });

  it('5.3 delete for both removes local row and transmits sealed sys message {"v":1,"t":"sys","d":"<uuid>"}', async () => {
    await chatUC.loadConversations();
    await chatUC.selectConversation(CONV_ID);

    await chatUC.sendMessage(CONV_ID, 'Accidental text to delete for both');
    const msgId = chatUC.getSnapshot().messages[0].id;

    // Delete for both
    await chatUC.deleteMessage(CONV_ID, msgId, 'both');

    // Local row deleted
    expect(storedMessages.find((m) => m.id === msgId)).toBeUndefined();
    expect(chatUC.getSnapshot().messages.length).toBe(0);

    // Outbox queued the sealed sys delete envelope
    const delOutbox = outboxEntries.find((e) => e.receiver_id === PEER_USER_ID && e.id !== msgId);
    expect(delOutbox).toBeDefined();
    const delPayload = decoder.decode(hexToBytes(delOutbox!.ciphertext_hex));
    const decodedDel = mceDecode(delPayload);
    expect(decodedDel?.t).toBe('sys');
    if (decodedDel?.t === 'sys') {
      expect(decodedDel.d).toBe(msgId);
    }
  });

  it('5.3 receiver deletes referenced message on receipt of sealed sys delete envelope', async () => {
    await chatUC.loadConversations();
    await chatUC.selectConversation(CONV_ID);

    // Target message exists in Dexie
    storedMessages.push({
      id: 'target-to-delete-uuid',
      conversation_id: CONV_ID,
      sender_id: PEER_HASH,
      ciphertext: '00',
      plaintext: mceEncodeText('Secret message'),
      sequence_str: '1',
      created_at: 3000,
      status: 'delivered',
    });
    await chatUC.loadMessages(CONV_ID);
    expect(chatUC.getSnapshot().messages.length).toBe(1);

    // Inbound sealed sys delete envelope
    const sysDelMce = mceEncodeDeleteForBoth('target-to-delete-uuid');
    const base64Payload = utf8ToBase64(sysDelMce);

    await chatUC.handleInboundRaw({
      v: 1,
      type: 'chat.msg',
      request_id: 'sys-del-cmd-uuid',
      sender_id: PEER_USER_ID,
      payload: base64Payload,
      sequence_number: 12,
    });

    // Target message removed from Dexie and UI
    expect(storedMessages.find((m) => m.id === 'target-to-delete-uuid')).toBeUndefined();
    expect(chatUC.getSnapshot().messages.length).toBe(0);
  });

  // ─── 5.4 Forward ───────────────────────────────────────────
  it('5.4 forwards message as a brand-new message without any forwarded-from metadata', async () => {
    const TARGET_CONV_ID = 'conv-direct-target';
    conversations.push({
      id: TARGET_CONV_ID,
      type: 'DIRECT',
      created_at: 4000,
      peer_id: 'target-peer-uuid',
      peer_identity_hash: 'target-peer-hash',
    });

    await chatUC.loadConversations();
    await chatUC.selectConversation(CONV_ID);

    const sourceMsg = {
      id: 'original-msg-123',
      conversationId: CONV_ID,
      senderId: PEER_HASH,
      plaintext: 'Interesting information to share',
      createdAt: 5000,
      status: 'delivered' as const,
    };

    // Forward message to TARGET_CONV_ID
    await chatUC.forwardMessage(TARGET_CONV_ID, sourceMsg);

    // Target conversation received brand-new message
    const forwardedStored = storedMessages.find((m) => m.conversation_id === TARGET_CONV_ID);
    expect(forwardedStored).toBeDefined();
    expect(forwardedStored?.id).not.toBe(sourceMsg.id); // Brand new UUID!

    // Plaintext in MCE is clean: NO forwarded_from metadata
    const decoded = mceDecode(forwardedStored?.plaintext || '');
    expect(decoded?.t).toBe('text');
    if (decoded?.t === 'text') {
      expect(decoded.b).toBe('Interesting information to share');
      expect('forwarded_from' in (decoded as object)).toBe(false);
    }
  });

  // ─── 5.5 Delete Conversation ───────────────────────────────
  it('5.5 deletes entire conversation locally from Dexie (messages and outbox rows)', async () => {
    await chatUC.loadConversations();
    await chatUC.selectConversation(CONV_ID);

    await chatUC.sendMessage(CONV_ID, 'Message 1');
    await chatUC.sendMessage(CONV_ID, 'Message 2');
    expect(storedMessages.length).toBe(2);

    await chatUC.deleteConversation(CONV_ID);

    // Dexie messages & outbox purged
    expect(mockMsgPort.deleteByConversation).toHaveBeenCalledWith(CONV_ID);
    expect(mockOutboxPort.deleteByConversation).toHaveBeenCalledWith(CONV_ID);
    expect(storedMessages.length).toBe(0);

    // Conversation removed from active view and activeConversationId reset to empty (Fix 4)
    const state = chatUC.getSnapshot();
    expect(state.conversations.some((c) => c.id === CONV_ID)).toBe(false);
    expect(state.activeConversationId).toBe('');
    expect(state.messages.length).toBe(0);
  });

  // ─── 5.6 Reset Chat State on Logout ─────────────────────────
  it('5.6 resetState clears activeConversationId, conversations, and messages on logout', async () => {
    await chatUC.loadConversations();
    await chatUC.selectConversation(CONV_ID);
    await chatUC.sendMessage(CONV_ID, 'Logout test');
    expect(chatUC.getSnapshot().activeConversationId).toBe(CONV_ID);
    expect(chatUC.getSnapshot().messages.length).toBeGreaterThan(0);

    chatUC.resetState();

    const snapshot = chatUC.getSnapshot();
    expect(snapshot.activeConversationId).toBeNull();
    expect(snapshot.conversations).toEqual([]);
    expect(snapshot.messages).toEqual([]);
    expect(snapshot.sending).toBe(false);
  });
});
