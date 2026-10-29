/**
 * Unit tests for Bundle 3: Groups & Channels.
 * Verifies:
 * - Non-E2EE plaintext pipeline for GROUP & CHANNEL (RFC-0007-B)
 * - Strict preservation of E2EE for DIRECT conversations
 * - Group/Channel creation, member management, and message operations
 * - WebSocket inbound fanout handling (group.msg, group.edit, group.delete)
 * - Reply/Edit/Delete message lifecycles
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChatUseCase } from '../../src/usecase/chat';
import type {
  CryptoPort,
  MessagePort as MsgPort,
  OutboxPort,
  ConversationPort,
  DirectoryPort,
  MetadataPort,
  StoredMessageDTO,
  ConversationDTO,
  GroupMessageDTO,
  ConversationMemberDTO,
} from '../../src/domain';

describe('Bundle 3: Groups & Channels UseCase Tests', () => {
  let mockCryptoPort: CryptoPort;
  let mockMsgPort: MsgPort;
  let mockOutboxPort: OutboxPort;
  let mockConvPort: ConversationPort;
  let mockDirPort: DirectoryPort;
  let mockMetadataPort: MetadataPort;
  let chatUC: ChatUseCase;

  let storedMessages: StoredMessageDTO[] = [];
  let conversations: ConversationDTO[] = [];

  beforeEach(() => {
    storedMessages = [];
    conversations = [];

    mockCryptoPort = {
      init: vi.fn(),
      generateSessionKeys: vi.fn(),
      signSessionKey: vi.fn(),
      signLoginPayload: vi.fn(),
      buildRegistrationWire: vi.fn(),
      encrypt: vi.fn(),
      decrypt: vi.fn(),
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
      updateGroupMessage: vi.fn().mockImplementation(async (id: string, updates: Partial<StoredMessageDTO>) => {
        const idx = storedMessages.findIndex((m) => m.id === id);
        if (idx !== -1) {
          storedMessages[idx] = { ...storedMessages[idx], ...updates };
        }
      }),
    };

    mockOutboxPort = {
      enqueue: vi.fn(),
      getQueued: vi.fn().mockResolvedValue([]),
      markInflight: vi.fn(),
      markSent: vi.fn(),
      markFailed: vi.fn(),
      hasInflightForReceiver: vi.fn().mockResolvedValue(false),
    };

    mockConvPort = {
      list: vi.fn().mockImplementation(async () => ({
        conversations: [...conversations],
      })),
      create: vi.fn(),
      createSelf: vi.fn(),
      createGroup: vi.fn().mockImplementation(async (params) => {
        const newConv: ConversationDTO = {
          id: `conv-${Date.now()}`,
          type: params.type,
          name: params.name,
          description: params.description,
          created_at: Date.now(),
          created_by: 'me-user-id',
        };
        conversations.push(newConv);
        return newConv;
      }),
      getMembers: vi.fn().mockResolvedValue([]),
      addMember: vi.fn().mockResolvedValue(undefined),
      removeMember: vi.fn().mockResolvedValue(undefined),
      updateMemberRole: vi.fn().mockResolvedValue(undefined),
      listGroupMessages: vi.fn().mockResolvedValue([]),
      sendGroupMessage: vi.fn().mockImplementation(async (convId, content, replyToId) => {
        const gm: GroupMessageDTO = {
          id: `gmsg-${Date.now()}`,
          conversation_id: convId,
          sender_id: 'my-identity-hash',
          content,
          reply_to_id: replyToId,
          created_at: Date.now(),
          server_id: 101,
        };
        return gm;
      }),
      editGroupMessage: vi.fn().mockImplementation(async (convId, msgId, content) => {
        return {
          id: msgId,
          conversation_id: convId,
          sender_id: 'my-identity-hash',
          content,
          edited_at: Date.now(),
          created_at: 1000,
          server_id: 101,
        };
      }),
      deleteGroupMessage: vi.fn().mockResolvedValue(undefined),
      joinByInvite: vi.fn(),
      joinPublic: vi.fn(),
      searchPublic: vi.fn().mockResolvedValue([]),
      getHistory: vi.fn().mockResolvedValue({ items: [] }),
      postHistory: vi.fn(),
      deleteHistoryMessage: vi.fn(),
      clearHistory: vi.fn(),
      deleteConversation: vi.fn(),
    };

    mockDirPort = {
      lookup: vi.fn(),
    };

    mockMetadataPort = {
      get: vi.fn().mockImplementation(async (key: string) => {
        if (key === 'identity_hash') return 'my-identity-hash';
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
  });

  it('creates a GROUP conversation and selects it', async () => {
    const convId = await chatUC.createGroup('Engineering Team', 'All devs', ['alice', 'bob']);

    expect(mockConvPort.createGroup).toHaveBeenCalledWith({
      type: 'GROUP',
      name: 'Engineering Team',
      description: 'All devs',
      member_usernames: ['alice', 'bob'],
    });
    expect(convId).toBeDefined();
    expect(chatUC.getSnapshot().activeConversationId).toBe(convId);
    expect(chatUC.getSnapshot().conversations.some((c) => c.id === convId && c.type === 'GROUP')).toBe(true);
  });

  it('creates a CHANNEL conversation and selects it', async () => {
    const convId = await chatUC.createChannel('Announcements', 'Broadcast only', ['sub1']);

    expect(mockConvPort.createGroup).toHaveBeenCalledWith({
      type: 'CHANNEL',
      name: 'Announcements',
      description: 'Broadcast only',
      member_usernames: ['sub1'],
    });
    expect(convId).toBeDefined();
    expect(chatUC.getSnapshot().activeConversationId).toBe(convId);
  });

  it('sends plaintext messages in GROUP without calling cryptoPort.encrypt or outbox', async () => {
    const convId = await chatUC.createGroup('Engineering Team');

    await chatUC.sendMessage(convId, 'Hello everyone, plaintext over TLS!');

    // Strictly verify non-E2EE behavior per RFC-0007-B:
    expect(mockConvPort.sendGroupMessage).toHaveBeenCalledWith(convId, 'Hello everyone, plaintext over TLS!', undefined);
    expect(mockCryptoPort.encrypt).not.toHaveBeenCalled();
    expect(mockOutboxPort.enqueue).not.toHaveBeenCalled();

    // Verify message stored locally in Dexie
    expect(storedMessages.length).toBe(1);
    expect(storedMessages[0].plaintext).toBe('Hello everyone, plaintext over TLS!');
    expect(storedMessages[0].status).toBe('delivered');
  });

  it('supports reply_to_id in group messages', async () => {
    const convId = await chatUC.createGroup('Engineering Team');

    await chatUC.sendMessage(convId, 'This is a reply', undefined, 'parent-msg-123');

    expect(mockConvPort.sendGroupMessage).toHaveBeenCalledWith(convId, 'This is a reply', 'parent-msg-123');
    expect(storedMessages[0].reply_to_id).toBe('parent-msg-123');
  });

  it('handles incoming group.msg envelope from WebSocket fanout', async () => {
    const convId = await chatUC.createGroup('Engineering Team');

    await chatUC.handleGroupMsg({
      id: 'gmsg-ws-1',
      conversation_id: convId,
      sender_id: 'alice-hash',
      content: 'Live fanout from Alice!',
      created_at: 1234567,
      server_id: 102,
    });

    expect(storedMessages.some((m) => m.id === 'gmsg-ws-1' && m.plaintext === 'Live fanout from Alice!')).toBe(true);
    expect(chatUC.getSnapshot().messages.some((m) => m.id === 'gmsg-ws-1')).toBe(true);
  });

  it('handles edit and delete actions on group messages', async () => {
    const convId = await chatUC.createGroup('Engineering Team');

    // Send original message
    await chatUC.sendMessage(convId, 'Original message');
    const msgId = storedMessages[0].id;

    // Edit message
    await chatUC.editGroupMessage(convId, msgId, 'Edited message text');
    expect(mockConvPort.editGroupMessage).toHaveBeenCalledWith(convId, msgId, 'Edited message text');
    expect(storedMessages[0].plaintext).toBe('Edited message text');
    expect(storedMessages[0].edited_at).toBeDefined();

    // Delete message
    await chatUC.deleteGroupMessage(convId, msgId);
    expect(mockConvPort.deleteGroupMessage).toHaveBeenCalledWith(convId, msgId);
    expect(storedMessages[0].deleted_at).toBeDefined();
  });

  it('handles incoming group.edit and group.delete actions via WebSocket', async () => {
    const convId = await chatUC.createGroup('Engineering Team');

    storedMessages.push({
      id: 'msg-remote-1',
      conversation_id: convId,
      sender_id: 'bob-hash',
      ciphertext: '',
      plaintext: 'Bob message',
      sequence_str: '0',
      created_at: 1000,
      status: 'delivered',
    });

    // Inbound edit action
    await chatUC.handleGroupEdit({
      action: 'edit',
      data: {
        id: 'msg-remote-1',
        conversation_id: convId,
        content: 'Bob updated message',
        edited_at: 2000,
      },
    });
    expect(storedMessages.find((m) => m.id === 'msg-remote-1')?.plaintext).toBe('Bob updated message');

    // Inbound delete action
    await chatUC.handleGroupDelete({
      action: 'delete',
      data: {
        id: 'msg-remote-1',
        conversation_id: convId,
        deleted_at: 3000,
      },
    });
    expect(storedMessages.find((m) => m.id === 'msg-remote-1')?.deleted_at).toBe(3000);
  });

  it('delegates member management calls to conversationPort', async () => {
    const convId = 'conv-test-members';
    const mockMembers: ConversationMemberDTO[] = [
      { user_id: 'u1', username: 'owner_user', identity_hash: 'h1', role: 'OWNER', joined_at: 100 },
      { user_id: 'u2', username: 'member_user', identity_hash: 'h2', role: 'MEMBER', joined_at: 200 },
    ];
    (mockConvPort.getMembers as ReturnType<typeof vi.fn>).mockResolvedValueOnce(mockMembers);

    const members = await chatUC.getGroupMembers(convId);
    expect(members).toEqual(mockMembers);

    await chatUC.addGroupMember(convId, { username: 'charlie', role: 'MEMBER' });
    expect(mockConvPort.addMember).toHaveBeenCalledWith(convId, { username: 'charlie', role: 'MEMBER' });

    await chatUC.updateGroupMemberRole(convId, 'u2', 'ADMIN');
    expect(mockConvPort.updateMemberRole).toHaveBeenCalledWith(convId, 'u2', 'ADMIN');

    await chatUC.removeGroupMember(convId, 'u2');
    expect(mockConvPort.removeMember).toHaveBeenCalledWith(convId, 'u2');
  });
});
