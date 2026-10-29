import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { SessionsPanel } from '../../src/presentation/components/SessionsPanel';
import { AppContext, type AppContextValue } from '../../src/presentation/context';
import type { SessionDTO } from '../../src/domain';

describe('SessionsPanel Component Test', () => {
  const mockSessions: SessionDTO[] = [
    {
      id: 'sess-current',
      device_label: 'Chrome on Windows',
      ip_hash: 'abc123def456',
      last_active_at: Math.floor(Date.now() / 1000) - 10,
      created_at: Math.floor(Date.now() / 1000) - 3600,
      is_current: true,
    },
    {
      id: 'sess-mobile',
      device_label: 'Safari on iPhone',
      ip_hash: 'fedcba654321',
      last_active_at: Math.floor(Date.now() / 1000) - 120,
      created_at: Math.floor(Date.now() / 1000) - 7200,
      is_current: false,
    },
    {
      id: 'sess-laptop',
      device_label: 'Firefox on macOS',
      ip_hash: '9876543210ab',
      last_active_at: Math.floor(Date.now() / 1000) - 3600,
      created_at: Math.floor(Date.now() / 1000) - 14400,
      is_current: false,
    },
  ];

  const createMockContext = (overrides?: Partial<AppContextValue>): AppContextValue => {
    return {
      authUC: {
        listSessions: vi.fn().mockResolvedValue(mockSessions),
        terminateSession: vi.fn().mockResolvedValue(undefined),
        terminateOtherSessions: vi.fn().mockResolvedValue(undefined),
      } as unknown as AppContextValue['authUC'],
      chatUC: {} as AppContextValue['chatUC'],
      syncUC: {} as AppContextValue['syncUC'],
      callMachine: {} as AppContextValue['callMachine'],
      placeCallUC: {} as AppContextValue['placeCallUC'],
      answerCallUC: {} as AppContextValue['answerCallUC'],
      endCallUC: {} as AppContextValue['endCallUC'],
      metadataPort: {} as AppContextValue['metadataPort'],
      userPort: {} as AppContextValue['userPort'],
      contactPort: {} as AppContextValue['contactPort'],
      conversationPort: {} as AppContextValue['conversationPort'],
      ...overrides,
    };
  };

  it('renders all active sessions with device labels, icons, and current device badge', async () => {
    const ctx = createMockContext();
    render(
      <AppContext.Provider value={ctx}>
        <SessionsPanel isOpen={true} onClose={vi.fn()} />
      </AppContext.Provider>
    );

    await waitFor(() => {
      expect(screen.getByText('Chrome on Windows')).toBeDefined();
    });

    expect(screen.getByText('Safari on iPhone')).toBeDefined();
    expect(screen.getByText('Firefox on macOS')).toBeDefined();
    expect(screen.getByText('Current Device')).toBeDefined();

    // Verify terminate buttons exist for the 2 other sessions
    expect(screen.getByText('Terminate All Other Sessions (2)')).toBeDefined();
    expect(document.getElementById('terminate-session-btn-sess-mobile')).toBeDefined();
    expect(document.getElementById('terminate-session-btn-sess-laptop')).toBeDefined();
    // Current session must NOT have a terminate button
    expect(document.getElementById('terminate-session-btn-sess-current')).toBeNull();
  });

  it('terminates an individual session and removes it from the list', async () => {
    const ctx = createMockContext();
    render(
      <AppContext.Provider value={ctx}>
        <SessionsPanel isOpen={true} onClose={vi.fn()} />
      </AppContext.Provider>
    );

    await waitFor(() => {
      expect(document.getElementById('terminate-session-btn-sess-mobile')).toBeDefined();
    });

    const terminateBtn = document.getElementById('terminate-session-btn-sess-mobile')!;
    fireEvent.click(terminateBtn);

    await waitFor(() => {
      expect(ctx.authUC.terminateSession).toHaveBeenCalledWith('sess-mobile');
      expect(screen.queryByText('Safari on iPhone')).toBeNull();
      expect(screen.getByText('Session terminated successfully')).toBeDefined();
    });
  });

  it('terminates all other sessions and keeps only the current session', async () => {
    const ctx = createMockContext();
    render(
      <AppContext.Provider value={ctx}>
        <SessionsPanel isOpen={true} onClose={vi.fn()} />
      </AppContext.Provider>
    );

    await waitFor(() => {
      expect(document.getElementById('terminate-all-others-btn')).toBeDefined();
    });

    const terminateAllBtn = document.getElementById('terminate-all-others-btn')!;
    fireEvent.click(terminateAllBtn);

    await waitFor(() => {
      expect(ctx.authUC.terminateOtherSessions).toHaveBeenCalled();
      expect(screen.queryByText('Safari on iPhone')).toBeNull();
      expect(screen.queryByText('Firefox on macOS')).toBeNull();
      expect(screen.getByText('Chrome on Windows')).toBeDefined();
      expect(screen.getByText('All other sessions terminated successfully')).toBeDefined();
    });
  });

  it('calls onClose when close button is clicked', async () => {
    const onClose = vi.fn();
    const ctx = createMockContext();
    render(
      <AppContext.Provider value={ctx}>
        <SessionsPanel isOpen={true} onClose={onClose} />
      </AppContext.Provider>
    );

    const closeBtn = document.getElementById('close-sessions-modal-btn')!;
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });
});
