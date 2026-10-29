import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { ChatScreen } from '../../src/presentation/components/ChatScreen';
import { MessageList } from '../../src/presentation/components/MessageList';
import { AppContext } from '../../src/presentation/context';

vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data, itemContent }: any) => (
    <div data-testid="virtuoso-container">
      {(data || []).map((item: any, index: number) => (
        <div key={item.id ?? index}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
}));

describe('Mobile Bugfixes & UI Refinements', () => {
  let mockAuthUC: any;
  let mockChatUC: any;
  let mockSyncUC: any;
  let mockMetadataPort: any;
  let mockUserPort: any;
  let mockContactPort: any;
  let mockConversationPort: any;
  let mockCallMachine: any;

  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query) => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    const authSnapshot = {
      state: 'authenticated',
      identityHash: 'my-identity-hash',
      userId: 'my-user-id',
      username: 'myuser',
      displayName: 'My Name',
      error: null,
    };
    mockAuthUC = {
      subscribe: vi.fn((cb) => () => {}),
      getSnapshot: vi.fn(() => authSnapshot),
      logout: vi.fn(),
    };

    const syncSnapshot = {
      phase: 'ready',
      isOnline: true,
      error: null,
    };
    mockSyncUC = {
      subscribe: vi.fn((cb) => () => {}),
      getSnapshot: vi.fn(() => syncSnapshot),
    };

    mockMetadataPort = {
      get: vi.fn(async (key: string) => {
        if (key === 'user_id') return 'my-user-id';
        if (key === 'identity_hash') return 'my-identity-hash';
        if (key === 'username') return 'myuser';
        return null;
      }),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    mockUserPort = {
      getMe: vi.fn().mockResolvedValue({ id: 'my-user-id', username: 'myuser', display_name: 'My Name' }),
      getProfile: vi.fn().mockResolvedValue(null),
      search: vi.fn().mockResolvedValue([]),
      getAvatarUrl: vi.fn().mockReturnValue(''),
    };

    mockContactPort = {
      getAll: vi.fn().mockResolvedValue([]),
      get: vi.fn().mockResolvedValue(undefined),
      save: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    mockConversationPort = {
      getConversations: vi.fn().mockResolvedValue([]),
    };

    const callMachineState = {
      status: 'idle',
      callId: null,
      peerId: null,
      peerDisplayName: null,
      callType: null,
    };
    mockCallMachine = {
      subscribe: vi.fn((cb) => () => {}),
      getState: vi.fn(() => callMachineState),
      getSnapshot: vi.fn(() => callMachineState),
    };
  });

  it('ChatScreen removes top sync banner and keeps sidebar sync-badge', () => {
    const chatSnapshot = {
      conversations: [],
      activeConversationId: null,
      messages: [],
      sending: false,
    };
    mockChatUC = {
      subscribe: vi.fn((cb) => () => {}),
      getSnapshot: vi.fn(() => chatSnapshot),
      loadConversations: vi.fn().mockResolvedValue(undefined),
      selectConversation: vi.fn().mockResolvedValue(undefined),
    };

    const ctx: any = {
      authUC: mockAuthUC,
      chatUC: mockChatUC,
      syncUC: mockSyncUC,
      callMachine: mockCallMachine,
      placeCallUC: {} as any,
      answerCallUC: {} as any,
      endCallUC: {} as any,
      metadataPort: mockMetadataPort,
      userPort: mockUserPort,
      contactPort: mockContactPort,
      conversationPort: mockConversationPort,
    };

    const { container } = render(
      <AppContext.Provider value={ctx}>
        <ChatScreen />
      </AppContext.Provider>
    );

    // Top banner must NOT be present
    expect(container.querySelector('.sync-status-banner')).toBeNull();
    expect(screen.queryByText(/Up to date \/ Synced/i)).toBeNull();

    // Sidebar sync badge MUST be present with Synced text
    const syncBadge = container.querySelector('.sync-badge');
    expect(syncBadge).not.toBeNull();
    expect(syncBadge?.textContent).toContain('🟢 Synced');
  });

  it('ChatScreen group/channel button is disabled with (Coming Soon)', () => {
    const chatSnapshot = {
      conversations: [],
      activeConversationId: null,
      messages: [],
      sending: false,
    };
    mockChatUC = {
      subscribe: vi.fn((cb) => () => {}),
      getSnapshot: vi.fn(() => chatSnapshot),
      loadConversations: vi.fn().mockResolvedValue(undefined),
    };

    const ctx: any = {
      authUC: mockAuthUC,
      chatUC: mockChatUC,
      syncUC: mockSyncUC,
      callMachine: mockCallMachine,
      placeCallUC: {} as any,
      answerCallUC: {} as any,
      endCallUC: {} as any,
      metadataPort: mockMetadataPort,
      userPort: mockUserPort,
      contactPort: mockContactPort,
      conversationPort: mockConversationPort,
    };

    render(
      <AppContext.Provider value={ctx}>
        <ChatScreen />
      </AppContext.Provider>
    );

    const groupBtn = screen.getByRole('button', { name: /group \/ channel/i });
    expect(groupBtn).toBeDefined();
    expect(groupBtn.getAttribute('disabled')).not.toBeNull();
    expect(groupBtn.textContent).toContain('Coming Soon');

    // Click should not open modal
    fireEvent.click(groupBtn);
    expect(screen.queryByText(/Create Group or Channel/i)).toBeNull();
  });

  it('MessageList in My Notes renders messages with own bubble and no peer avatar', async () => {
    const selfConv = {
      id: 'self-conv-1',
      type: 'SELF',
      createdAt: 1000,
    };

    const selfMsg = {
      id: 'msg-1',
      conversationId: 'self-conv-1',
      senderId: 'my-identity-hash',
      plaintext: 'vb note test',
      createdAt: 2000,
      status: 'seen' as const,
      isOutgoing: true,
    };

    const chatSnapshot = {
      conversations: [selfConv],
      activeConversationId: 'self-conv-1',
      messages: [selfMsg],
      sending: false,
    };

    mockChatUC = {
      subscribe: vi.fn((cb) => () => {}),
      getSnapshot: vi.fn(() => chatSnapshot),
      loadConversations: vi.fn().mockResolvedValue(undefined),
      selectConversation: vi.fn().mockResolvedValue(undefined),
      getGroupMembers: vi.fn().mockResolvedValue([]),
    };

    const ctx: any = {
      authUC: mockAuthUC,
      chatUC: mockChatUC,
      syncUC: mockSyncUC,
      callMachine: mockCallMachine,
      placeCallUC: {} as any,
      answerCallUC: {} as any,
      endCallUC: {} as any,
      metadataPort: mockMetadataPort,
      userPort: mockUserPort,
      contactPort: mockContactPort,
      conversationPort: mockConversationPort,
    };

    const { container } = render(
      <AppContext.Provider value={ctx}>
        <MessageList conversationId="self-conv-1" />
      </AppContext.Provider>
    );

    // Header says My Notes
    expect(screen.getByText('📝 My Notes')).toBeDefined();

    // Message bubble should be own bubble
    const bubble = container.querySelector('.bubble');
    expect(bubble).not.toBeNull();
    expect(bubble?.classList.contains('bubble--own')).toBe(true);
    expect(bubble?.classList.contains('bubble--peer')).toBe(false);

    // No peer avatar column
    expect(container.querySelector('.msg-avatar-col')).toBeNull();
    // No sender label
    expect(container.querySelector('.sender-label')).toBeNull();

    // Mobile back button has SVG
    const backBtn = container.querySelector('#chat-mobile-back-btn');
    expect(backBtn).not.toBeNull();
    expect(backBtn?.querySelector('svg')).not.toBeNull();
  });

  it('MessageList in direct conversation renders peer display name and avatar initials correctly', async () => {
    const directConv = {
      id: 'conv-fixture-1',
      type: 'DIRECT',
      peerIdentityHash: 'peer-hash-fixture',
      peer_display_name: 'یاسین',
      peer_username: 'fixture_user',
      createdAt: 1000,
    };

    const chatSnapshot = {
      conversations: [directConv],
      activeConversationId: 'conv-fixture-1',
      messages: [],
      sending: false,
    };

    mockChatUC = {
      subscribe: vi.fn((cb) => () => {}),
      getSnapshot: vi.fn(() => chatSnapshot),
      loadConversations: vi.fn().mockResolvedValue(undefined),
      selectConversation: vi.fn().mockResolvedValue(undefined),
      getGroupMembers: vi.fn().mockResolvedValue([]),
    };

    const ctx: any = {
      authUC: mockAuthUC,
      chatUC: mockChatUC,
      syncUC: mockSyncUC,
      callMachine: mockCallMachine,
      placeCallUC: {} as any,
      answerCallUC: {} as any,
      endCallUC: {} as any,
      metadataPort: mockMetadataPort,
      userPort: mockUserPort,
      contactPort: mockContactPort,
      conversationPort: mockConversationPort,
    };

    const { container } = render(
      <AppContext.Provider value={ctx}>
        <MessageList conversationId="conv-fixture-1" />
      </AppContext.Provider>
    );

    // Header title must be "یاسین", NOT "Direct Message"
    expect(screen.getByText('یاسین')).toBeDefined();
    expect(screen.queryByText('Direct Message')).toBeNull();

    // Avatar must NOT be "DM"
    const avatarFallback = container.querySelector('#chat-header-user-info [data-testid="avatar-fallback"]');
    expect(avatarFallback).not.toBeNull();
    expect(avatarFallback?.textContent).not.toBe('DM');
    expect(avatarFallback?.textContent).toBe('یا');
  });

  it('MessageList in draft conversation preserves peer metadata and avoids falling back to Direct Message', async () => {
    mockMetadataPort.get.mockImplementation(async (key: string) => {
      if (key === 'user_id') return 'my-user-id';
      if (key === 'identity_hash') return 'my-identity-hash';
      if (key === 'username') return 'myuser';
      if (key === 'peer_name_draft-peer-hash') return 'Alice In Wonderland';
      if (key === 'peer_user_draft-peer-hash') return 'alice_wonder';
      if (key === 'peer_id_draft-peer-hash') return 'alice-user-id';
      return null;
    });

    const chatSnapshot = {
      conversations: [],
      activeConversationId: 'draft:draft-peer-hash',
      messages: [],
      sending: false,
    };

    mockChatUC = {
      subscribe: vi.fn((cb) => () => {}),
      getSnapshot: vi.fn(() => chatSnapshot),
      loadConversations: vi.fn().mockResolvedValue(undefined),
      selectConversation: vi.fn().mockResolvedValue(undefined),
      getGroupMembers: vi.fn().mockResolvedValue([]),
    };

    const ctx: any = {
      authUC: mockAuthUC,
      chatUC: mockChatUC,
      syncUC: mockSyncUC,
      callMachine: mockCallMachine,
      placeCallUC: {} as any,
      answerCallUC: {} as any,
      endCallUC: {} as any,
      metadataPort: mockMetadataPort,
      userPort: mockUserPort,
      contactPort: mockContactPort,
      conversationPort: mockConversationPort,
    };

    const { container } = render(
      <AppContext.Provider value={ctx}>
        <MessageList conversationId="draft:draft-peer-hash" />
      </AppContext.Provider>
    );

    // Wait for metadata to resolve
    const headerTitle = await screen.findByText('Alice In Wonderland');
    expect(headerTitle).toBeDefined();
    expect(screen.queryByText('Direct Message')).toBeNull();

    const avatarFallback = container.querySelector('#chat-header-user-info [data-testid="avatar-fallback"]');
    expect(avatarFallback?.textContent).toBe('AI');
  });

  it('MessageList renders @username in header and generates initials without @ symbol in avatar', async () => {
    const directConv = {
      id: 'conv-handle-1',
      type: 'DIRECT',
      peerIdentityHash: 'peer-hash-bob',
      peer_username: 'bob_builder',
      createdAt: 1000,
    };

    const chatSnapshot = {
      conversations: [directConv],
      activeConversationId: 'conv-handle-1',
      messages: [],
      sending: false,
    };

    mockChatUC = {
      subscribe: vi.fn((cb) => () => {}),
      getSnapshot: vi.fn(() => chatSnapshot),
      loadConversations: vi.fn().mockResolvedValue(undefined),
      selectConversation: vi.fn().mockResolvedValue(undefined),
      getGroupMembers: vi.fn().mockResolvedValue([]),
    };

    const ctx: any = {
      authUC: mockAuthUC,
      chatUC: mockChatUC,
      syncUC: mockSyncUC,
      callMachine: mockCallMachine,
      placeCallUC: {} as any,
      answerCallUC: {} as any,
      endCallUC: {} as any,
      metadataPort: mockMetadataPort,
      userPort: mockUserPort,
      contactPort: mockContactPort,
      conversationPort: mockConversationPort,
    };

    const { container } = render(
      <AppContext.Provider value={ctx}>
        <MessageList conversationId="conv-handle-1" />
      </AppContext.Provider>
    );

    // Title should be @bob_builder
    expect(screen.getByText('@bob_builder')).toBeDefined();

    // Avatar initials must be "BO" or "BB", NOT "@B"
    const avatarFallback = container.querySelector('#chat-header-user-info [data-testid="avatar-fallback"]');
    expect(avatarFallback?.textContent).toBe('BB');
    expect(avatarFallback?.textContent).not.toContain('@');
  });
});
