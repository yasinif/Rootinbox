import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatUseCase } from '../../src/usecase/chat';
import { mceEncodeText } from '../../src/domain/protocol/content-envelope';
import type {
  CryptoPort,
  MessagePort as MsgPort,
  OutboxPort,
  ConversationPort,
  DirectoryPort,
  MetadataPort,
  StoredMessageDTO,
  ConversationDTO,
} from '../../src/domain';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const bytesToHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};
const hexToBase64Std = (hex: string): string => btoa(String.fromCharCode(...hexToBytes(hex)));

describe('Fix 2: Additive ConversationID & Graceful Fallback Matching', () => {
  const MY_HASH = 'my-identity-hash';
  const PEER_USER_ID = 'user-bob-uuid';
  const PEER_HASH = 'aabbcc112233445566778899aabbcc112233445566778899aabbcc1122334455';
  const CONV_ID = 'conv-direct-1234';

  let storedMessages: StoredMessageDTO[] = [];
  let convList: ConversationDTO[] = [];
  let mockCryptoPort: CryptoPort;
  let mockMsgPort: MsgPort;
  let mockOutboxPort: OutboxPort;
  let mockConvPort: ConversationPort;
  let mockDirPort: DirectoryPort;
  let mockMetaPort: MetadataPort;
  let chatUC: ChatUseCase;

  beforeEach(() => {
    storedMessages = [];
    convList = [
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
      updatePlaintext: vi.fn(),
      updateStatus: vi.fn(),
      deleteMessage: vi.fn(),
      deleteByConversation: vi.fn(),
    };

    mockOutboxPort = {
      enqueue: vi.fn(),
      getQueued: vi.fn().mockResolvedValue([]),
      updateStatus: vi.fn(),
      delete: vi.fn(),
      clear: vi.fn(),
      deleteByConversation: vi.fn(),
    };

    mockConvPort = {
      list: vi.fn().mockImplementation(async () => ({ conversations: convList })),
      create: vi.fn().mockResolvedValue({ id: 'new-conv-uuid' }),
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
      postHistory: vi.fn().mockResolvedValue(undefined),
      getHistory: vi.fn().mockResolvedValue({ items: [], next_cursor: null } as any),
      deleteHistoryMessage: vi.fn(),
      clearHistory: vi.fn(),
      deleteConversation: vi.fn(),
    };

    mockDirPort = {
      lookup: vi.fn().mockImplementation(async (query: string) => {
        if (query === PEER_USER_ID || query === PEER_HASH) {
          return {
            userId: PEER_USER_ID,
            identityHash: PEER_HASH,
            identityPublicKey: PEER_HASH,
            activeSession: {
              x25519PublicKey: 'peer-session-pk',
              sessionVersion: 1,
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            },
          };
        }
        return null;
      }),
    };

    mockMetaPort = {
      get: vi.fn().mockImplementation(async (k: string) => {
        if (k === 'identity_hash') return MY_HASH;
        if (k === 'user_id') return 'my-user-uuid';
        return null;
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
      mockMetaPort,
    );
  });

  it('directly uses conversation_id when present in the downstream envelope', async () => {
    await chatUC.loadConversations();
    await chatUC.selectConversation(CONV_ID);

    const plaintext = mceEncodeText('Hello with explicit conversation_id');
    const ciphertextHex = bytesToHex(encoder.encode(plaintext));
    const payloadBase64 = hexToBase64Std(ciphertextHex);

    await chatUC.handleInboundRaw({
      v: 1,
      type: 'chat.msg',
      request_id: 'msg-uuid-1',
      sender_id: PEER_USER_ID,
      payload: payloadBase64,
      sequence_number: 1,
      conversation_id: CONV_ID,
    });

    expect(storedMessages.length).toBe(1);
    expect(storedMessages[0].id).toBe('msg-uuid-1');
    expect(storedMessages[0].conversation_id).toBe(CONV_ID);
    expect(chatUC.state.messages.length).toBe(1);
    expect(chatUC.state.messages[0].id).toBe('msg-uuid-1');
  });

  it('falls back gracefully to peer identity-hash matching when conversation_id is absent', async () => {
    await chatUC.loadConversations();
    await chatUC.selectConversation(CONV_ID);

    const plaintext = mceEncodeText('Hello without conversation_id (legacy client/server)');
    const ciphertextHex = bytesToHex(encoder.encode(plaintext));
    const payloadBase64 = hexToBase64Std(ciphertextHex);

    // Notice: conversation_id is omitted (undefined)
    await chatUC.handleInboundRaw({
      v: 1,
      type: 'chat.msg',
      request_id: 'msg-uuid-2',
      sender_id: PEER_USER_ID,
      payload: payloadBase64,
      sequence_number: 2,
    });

    // Fallback must resolve to CONV_ID and store correctly
    expect(storedMessages.length).toBe(1);
    expect(storedMessages[0].id).toBe('msg-uuid-2');
    expect(storedMessages[0].conversation_id).toBe(CONV_ID);
    // Since CONV_ID was active, messages in state must be immediately updated
    expect(chatUC.state.messages.length).toBe(1);
    expect(chatUC.state.messages[0].id).toBe('msg-uuid-2');
  });

  it('promotes local draft chat to real conversation when incoming message arrives', async () => {
    await chatUC.loadConversations();
    // Simulate user having draft open: 'draft:' + PEER_HASH
    chatUC.selectConversation(`draft:${PEER_HASH}`);
    expect(chatUC.state.activeConversationId).toBe(`draft:${PEER_HASH}`);

    const plaintext = mceEncodeText('Incoming message while in draft');
    const ciphertextHex = bytesToHex(encoder.encode(plaintext));
    const payloadBase64 = hexToBase64Std(ciphertextHex);

    await chatUC.handleInboundRaw({
      v: 1,
      type: 'chat.msg',
      request_id: 'msg-uuid-3',
      sender_id: PEER_USER_ID,
      payload: payloadBase64,
      sequence_number: 3,
      conversation_id: CONV_ID,
    });

    // Active conversation must transition from draft to real CONV_ID and render messages
    expect(chatUC.state.activeConversationId).toBe(CONV_ID);
    expect(chatUC.state.messages.length).toBe(1);
    expect(chatUC.state.messages[0].id).toBe('msg-uuid-3');
  });
});
