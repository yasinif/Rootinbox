import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { UserProfileModal } from '../../src/presentation/components/user/UserProfileModal';
import { ChatScreen } from '../../src/presentation/components/ChatScreen';
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

describe('Web Push Notification Settings & Diagnostics Component Test', () => {
  let mockUserPort: any;
  let mockMetadataPort: any;
  let mockPushUC: any;
  let mockAuthUC: any;
  let mockChatUC: any;
  let mockSyncUC: any;
  let mockContactPort: any;
  let mockConversationPort: any;
  let mockCallMachine: any;

  beforeEach(() => {
    mockUserPort = {
      getMe: vi.fn().mockResolvedValue({
        id: 'test-user-id',
        user_id: 'test-user-id',
        username: 'testuser',
        display_name: 'Test User',
        identity_hash: 'test-hash-1234567890',
      }),
      updateProfile: vi.fn(),
      getAvatarUrl: vi.fn().mockReturnValue(''),
    };

    mockMetadataPort = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };

    mockPushUC = {
      isSupported: vi.fn().mockReturnValue(true),
      getPermission: vi.fn().mockReturnValue('default'),
      getCurrentSubscription: vi.fn().mockResolvedValue(null),
      getVapidPublicKey: vi.fn().mockResolvedValue('BEl62iUYgUivxIkv69yViEuiBIa...'),
      subscribe: vi.fn().mockResolvedValue(true),
      unsubscribe: vi.fn().mockResolvedValue(true),
    };

    const authSnapshot = {
      state: 'authenticated',
      identityHash: 'test-hash-1234567890',
      userId: 'test-user-id',
      username: 'testuser',
      displayName: 'Test User',
      error: null,
    };
    mockAuthUC = {
      subscribe: vi.fn((cb) => () => {}),
      getSnapshot: vi.fn(() => authSnapshot),
      logout: vi.fn(),
    };

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

    const syncSnapshot = { phase: 'ready', isOnline: true };
    mockSyncUC = {
      subscribe: vi.fn((cb) => () => {}),
      getSnapshot: vi.fn(() => syncSnapshot),
    };

    mockContactPort = {
      getAll: vi.fn().mockResolvedValue([]),
    };
    mockConversationPort = {
      getConversations: vi.fn().mockResolvedValue([]),
    };
    mockCallMachine = {
      getState: vi.fn(() => ({ status: 'idle' })),
    };

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

    // Notification API stub
    (window as any).Notification = {
      permission: 'default',
      requestPermission: vi.fn().mockResolvedValue('granted'),
    };
    Object.defineProperty(window, 'isSecureContext', {
      writable: true,
      value: true,
    });
  });

  it('renders Push Notification controls and diagnostics in UserProfileModal', async () => {
    const ctx: any = {
      userPort: mockUserPort,
      metadataPort: mockMetadataPort,
      pushUC: mockPushUC,
    };

    render(
      <AppContext.Provider value={ctx}>
        <UserProfileModal isOpen={true} onClose={() => {}} />
      </AppContext.Provider>
    );

    await waitFor(() => {
      expect(screen.getByText(/🔔 Web Push Notifications/i)).toBeDefined();
    });

    const toggleBtn = screen.getByTestId('toggle-push-btn');
    expect(toggleBtn.textContent).toContain('Enable Notifications');

    // Diagnostics details
    expect(screen.getByText(/Notification Diagnostics/i)).toBeDefined();
    expect(screen.getByText(/Secure Context:/i)).toBeDefined();
    expect(screen.getByText(/Cache Version:/i)).toBeDefined();
    expect(screen.getByText(/v6-cloud-attachment-push-20261019/i)).toBeDefined();
  });

  it('toggles subscription on Enable/Disable Notifications click in UserProfileModal', async () => {
    mockPushUC.subscribe = vi.fn().mockImplementation(async () => {
      mockPushUC.getCurrentSubscription.mockResolvedValue({
        endpoint: 'https://fcm.googleapis.com/fcm/send/fake-endpoint-1234567890',
      });
      return true;
    });

    const ctx: any = {
      userPort: mockUserPort,
      metadataPort: mockMetadataPort,
      pushUC: mockPushUC,
    };

    render(
      <AppContext.Provider value={ctx}>
        <UserProfileModal isOpen={true} onClose={() => {}} />
      </AppContext.Provider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('toggle-push-btn')).toBeDefined();
    });

    const toggleBtn = screen.getByTestId('toggle-push-btn');
    expect(toggleBtn.textContent).toContain('Enable Notifications');

    fireEvent.click(toggleBtn);

    await waitFor(() => {
      expect(mockPushUC.subscribe).toHaveBeenCalledTimes(1);
      expect(toggleBtn.textContent).toContain('Disable Notifications');
    });
  });

  it('renders push banner in ChatScreen when permission is default and dismisses to localStorage', async () => {
    const fakeStorage: Record<string, string> = {};
    Object.defineProperty(window, 'localStorage', {
      writable: true,
      value: {
        getItem: vi.fn((k: string) => fakeStorage[k] ?? null),
        setItem: vi.fn((k: string, v: string) => {
          fakeStorage[k] = v;
        }),
        removeItem: vi.fn((k: string) => {
          delete fakeStorage[k];
        }),
      },
    });

    const ctx: any = {
      authUC: mockAuthUC,
      chatUC: mockChatUC,
      syncUC: mockSyncUC,
      userPort: mockUserPort,
      metadataPort: mockMetadataPort,
      pushUC: mockPushUC,
      contactPort: mockContactPort,
      conversationPort: mockConversationPort,
      callMachine: mockCallMachine,
    };

    render(
      <AppContext.Provider value={ctx}>
        <ChatScreen />
      </AppContext.Provider>
    );

    await waitFor(() => {
      expect(screen.getByText(/Enable notifications for incoming calls and messages/i)).toBeDefined();
    });

    // Dismiss banner
    const dismissBtn = screen.getByRole('button', { name: /dismiss/i });
    fireEvent.click(dismissBtn);

    await waitFor(() => {
      expect(window.localStorage.setItem).toHaveBeenCalledWith('rootinbox_dismiss_push_banner', 'true');
      expect(screen.queryByText(/Enable notifications for incoming calls and messages/i)).toBeNull();
    });
  });

  it('copies sanitized diagnostics without full endpoint or secret tokens', async () => {
    mockPushUC.getCurrentSubscription.mockResolvedValue({
      endpoint: 'https://fcm.googleapis.com/fcm/send/secret-device-token-1234567890',
    });

    let copiedText = '';
    Object.defineProperty(navigator, 'clipboard', {
      writable: true,
      value: {
        writeText: vi.fn(async (text: string) => {
          copiedText = text;
        }),
      },
    });

    const ctx: any = {
      userPort: mockUserPort,
      metadataPort: mockMetadataPort,
      pushUC: mockPushUC,
    };

    render(
      <AppContext.Provider value={ctx}>
        <UserProfileModal isOpen={true} onClose={() => {}} />
      </AppContext.Provider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('copy-diagnostics-btn')).toBeDefined();
    });

    const copyBtn = screen.getByTestId('copy-diagnostics-btn');
    fireEvent.click(copyBtn);

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(1);
    });

    expect(copiedText).toContain('RootInbox Notification Diagnostics');
    expect(copiedText).toContain('Display Mode:');
    expect(copiedText).toContain('Push Host: fcm.googleapis.com');
    // Ensure the sensitive endpoint path / token is NOT present in copied diagnostics
    expect(copiedText).not.toContain('secret-device-token-1234567890');
    expect(copiedText).not.toContain('/fcm/send/');
  });

  it('hides push banner in ChatScreen when server push is disabled (PUSH_ENABLED=false / 404)', async () => {
    mockPushUC.isAvailable = vi.fn().mockResolvedValue(false);

    const ctx: any = {
      authUC: mockAuthUC,
      chatUC: mockChatUC,
      syncUC: mockSyncUC,
      userPort: mockUserPort,
      metadataPort: mockMetadataPort,
      pushUC: mockPushUC,
      contactPort: mockContactPort,
      conversationPort: mockConversationPort,
      callMachine: mockCallMachine,
    };

    render(
      <AppContext.Provider value={ctx}>
        <ChatScreen />
      </AppContext.Provider>
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByText(/Enable notifications for incoming calls and messages/i)).toBeNull();
  });

  it('renders "Push is not enabled on the server" in UserProfileModal when push is disabled server-side', async () => {
    mockPushUC.isAvailable = vi.fn().mockResolvedValue(false);

    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockResolvedValue({
      status: 404,
      statusText: 'Not Found',
      ok: false,
    } as any);

    try {
      const ctx: any = {
        userPort: mockUserPort,
        metadataPort: mockMetadataPort,
        pushUC: mockPushUC,
      };

      render(
        <AppContext.Provider value={ctx}>
          <UserProfileModal isOpen={true} onClose={() => {}} />
        </AppContext.Provider>
      );

      await waitFor(() => {
        expect(screen.getByText('Push is not enabled on the server')).toBeDefined();
      });

      expect(screen.queryByTestId('toggle-push-btn')).toBeNull();
    } finally {
      global.fetch = originalFetch;
    }
  });
});
