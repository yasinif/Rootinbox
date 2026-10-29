import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { PasscodeLockScreen } from '../../src/presentation/components/passcode/PasscodeLockScreen';
import { PasscodeLockOverlay } from '../../src/presentation/components/passcode/PasscodeLockOverlay';
import { PasscodeContext, type PasscodeContextValue } from '../../src/presentation/context/PasscodeContext';
import { AppContext } from '../../src/presentation/context';

describe('PasscodeLockScreen Component', () => {
  let mockAppContext: any;

  beforeEach(() => {
    const authSnapshot = {
      state: 'authenticated' as const,
      identityHash: 'ident-hash',
      userId: 'usr-1',
      username: 'alice',
      displayName: 'Alice Wonder',
      error: null,
    };
    const mockAuthUC: any = {
      subscribe: vi.fn((cb) => () => {}),
      getSnapshot: vi.fn(() => authSnapshot),
      login: vi.fn(),
      register: vi.fn(),
      unlock: vi.fn(),
      logout: vi.fn(),
    };
    mockAppContext = {
      authUC: mockAuthUC,
    };
  });

  const renderScreen = (props: React.ComponentProps<typeof PasscodeLockScreen>) => {
    return render(
      <AppContext.Provider value={mockAppContext}>
        <PasscodeLockScreen {...props} />
      </AppContext.Provider>,
    );
  };

  it('renders Telegram lock screen with title and 4 empty PIN dots', () => {
    const handleUnlock = vi.fn().mockResolvedValue(true);
    const handleUnlockPassword = vi.fn().mockResolvedValue(true);

    renderScreen({
      onUnlock: handleUnlock,
      onUnlockWithPassword: handleUnlockPassword,
      username: 'alice',
      displayName: 'Alice Wonder',
    });

    expect(screen.getByText('Alice Wonder')).toBeDefined();
    expect(screen.getByText('Enter 4-digit passcode')).toBeDefined();

    // 4 PIN dots
    const dots = document.querySelectorAll('.pin-dot');
    expect(dots.length).toBe(4);
    dots.forEach((dot) => {
      expect(dot.classList.contains('pin-dot--filled')).toBe(false);
    });
  });

  it('clicking numeric keypad buttons fills PIN dots and invokes onUnlock on 4th digit', async () => {
    const handleUnlock = vi.fn().mockResolvedValue(true);
    const handleUnlockPassword = vi.fn().mockResolvedValue(true);

    renderScreen({
      onUnlock: handleUnlock,
      onUnlockWithPassword: handleUnlockPassword,
      username: 'alice',
    });

    // Click keys '1', '2', '3'
    fireEvent.click(screen.getByRole('button', { name: /Digit 1/i }));
    fireEvent.click(screen.getByRole('button', { name: /Digit 2/i }));
    fireEvent.click(screen.getByRole('button', { name: /Digit 3/i }));

    const filledDots = document.querySelectorAll('.pin-dot--filled');
    expect(filledDots.length).toBe(3);

    // Click 4th key '4'
    fireEvent.click(screen.getByRole('button', { name: /Digit 4/i }));

    await waitFor(() => {
      expect(handleUnlock).toHaveBeenCalledWith('1234');
    });
  });

  it('shows error message and shake class when onUnlock returns false', async () => {
    const handleUnlock = vi.fn().mockResolvedValue(false);
    const handleUnlockPassword = vi.fn().mockResolvedValue(true);

    renderScreen({
      onUnlock: handleUnlock,
      onUnlockWithPassword: handleUnlockPassword,
    });

    // Enter wrong PIN 9999
    fireEvent.click(screen.getByRole('button', { name: /Digit 9/i }));
    fireEvent.click(screen.getByRole('button', { name: /Digit 9/i }));
    fireEvent.click(screen.getByRole('button', { name: /Digit 9/i }));
    fireEvent.click(screen.getByRole('button', { name: /Digit 9/i }));

    await waitFor(() => {
      expect(screen.getByText('Incorrect passcode')).toBeDefined();
    });

    const dotsContainer = document.querySelector('.pin-dots');
    expect(dotsContainer?.classList.contains('pin-dots--shake')).toBe(true);
  });

  it('supports backspace button to delete entered digits', () => {
    const handleUnlock = vi.fn().mockResolvedValue(true);
    const handleUnlockPassword = vi.fn().mockResolvedValue(true);

    renderScreen({
      onUnlock: handleUnlock,
      onUnlockWithPassword: handleUnlockPassword,
    });

    fireEvent.click(screen.getByRole('button', { name: /Digit 5/i }));
    fireEvent.click(screen.getByRole('button', { name: /Digit 6/i }));
    expect(document.querySelectorAll('.pin-dot--filled').length).toBe(2);

    const backspaceBtn = screen.getByRole('button', { name: /Delete last digit/i });
    fireEvent.click(backspaceBtn);
    expect(document.querySelectorAll('.pin-dot--filled').length).toBe(1);
  });

  it('toggles password fallback form when clicking forgot passcode link', async () => {
    const handleUnlock = vi.fn().mockResolvedValue(true);
    const handleUnlockPassword = vi.fn().mockResolvedValue(true);

    renderScreen({
      onUnlock: handleUnlock,
      onUnlockWithPassword: handleUnlockPassword,
    });

    const fallbackBtn = screen.getByRole('button', { name: /Forgot Passcode\? Unlock with Password/i });
    fireEvent.click(fallbackBtn);

    const passInput = screen.getByPlaceholderText(/Enter password/i);
    expect(passInput).toBeDefined();

    fireEvent.change(passInput, { target: { value: 'Secret123' } });
    fireEvent.click(screen.getByRole('button', { name: /^Unlock$/i }));

    await waitFor(() => {
      expect(handleUnlockPassword).toHaveBeenCalledWith('Secret123');
    });
  });

  it('handles physical keyboard input', async () => {
    const handleUnlock = vi.fn().mockResolvedValue(true);
    const handleUnlockPassword = vi.fn().mockResolvedValue(true);

    renderScreen({
      onUnlock: handleUnlock,
      onUnlockWithPassword: handleUnlockPassword,
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '7' }));
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '8' }));
    });

    expect(document.querySelectorAll('.pin-dot--filled').length).toBe(2);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace' }));
    });
    expect(document.querySelectorAll('.pin-dot--filled').length).toBe(1);
  });
});

describe('PasscodeLockOverlay Component', () => {
  let mockAppContext: any;

  beforeEach(() => {
    const authSnapshot = {
      state: 'authenticated' as const,
      identityHash: 'ident-hash',
      userId: 'usr-1',
      username: 'alice',
      displayName: 'Alice Wonder',
      error: null,
    };
    const mockAuthUC: any = {
      subscribe: vi.fn((cb) => () => {}),
      getSnapshot: vi.fn(() => authSnapshot),
      login: vi.fn(),
      register: vi.fn(),
      unlock: vi.fn(),
      logout: vi.fn(),
    };
    mockAppContext = {
      authUC: mockAuthUC,
    };
  });

  const createMockContext = (isLocked: boolean): PasscodeContextValue => ({
    isPasscodeEnabled: true,
    isLocked,
    isLoading: false,
    autoLockTimeout: '5m',
    unlock: vi.fn().mockResolvedValue(true),
    unlockWithMasterPassword: vi.fn().mockResolvedValue(true),
    lock: vi.fn(),
    setupPasscode: vi.fn().mockResolvedValue(undefined),
    changePasscode: vi.fn().mockResolvedValue(true),
    disablePasscode: vi.fn().mockResolvedValue(true),
    setAutoLockTimeout: vi.fn().mockResolvedValue(undefined),
  });

  it('renders children directly when not locked', () => {
    render(
      <AppContext.Provider value={mockAppContext}>
        <PasscodeContext.Provider value={createMockContext(false)}>
          <PasscodeLockOverlay>
            <div data-testid="chat-app-content">Active Chat App</div>
          </PasscodeLockOverlay>
        </PasscodeContext.Provider>
      </AppContext.Provider>,
    );

    expect(screen.getByTestId('chat-app-content')).toBeDefined();
    expect(screen.queryByText('Enter 4-digit passcode')).toBeNull();
    const wrapper = document.getElementById('app-content-wrapper');
    expect(wrapper?.style.display).toBe('contents');
  });

  it('renders PasscodeLockScreen overlay when locked and keeps children mounted but hidden', () => {
    render(
      <AppContext.Provider value={mockAppContext}>
        <PasscodeContext.Provider value={createMockContext(true)}>
          <PasscodeLockOverlay>
            <div data-testid="chat-app-content">Hidden Chat App</div>
          </PasscodeLockOverlay>
        </PasscodeContext.Provider>
      </AppContext.Provider>,
    );

    expect(screen.getByText('Enter 4-digit passcode')).toBeDefined();
    // App content remains mounted in React memory but visually hidden and aria-hidden
    const wrapper = document.getElementById('app-content-wrapper');
    expect(wrapper?.style.display).toBe('none');
    expect(wrapper?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('UserProfileModal Passcode Disable Security', () => {
  it('requires entering current passcode to disable lock and denies wrong passcode', async () => {
    const mockUserPort: any = {
      getMe: vi.fn().mockResolvedValue({
        user_id: 'usr-1',
        username: 'alice',
        display_name: 'Alice',
      }),
      updateProfile: vi.fn(),
      updateUsername: vi.fn(),
      uploadAvatar: vi.fn(),
      deleteAvatar: vi.fn(),
    };
    const mockMetaPort: any = {
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    const mockAuthUC: any = {
      subscribe: vi.fn(() => () => {}),
      getSnapshot: vi.fn(() => ({ state: 'authenticated', userId: 'usr-1' })),
    };
    const mockAppContext: any = {
      userPort: mockUserPort,
      metadataPort: mockMetaPort,
      authUC: mockAuthUC,
    };

    const mockDisable = vi.fn().mockImplementation((pin?: string) => {
      return Promise.resolve(pin === '1234');
    });

    const mockPasscodeCtx: PasscodeContextValue = {
      isPasscodeEnabled: true,
      isLocked: false,
      isLoading: false,
      autoLockTimeout: '5m',
      unlock: vi.fn().mockResolvedValue(true),
      unlockWithMasterPassword: vi.fn().mockResolvedValue(true),
      lock: vi.fn(),
      setupPasscode: vi.fn().mockResolvedValue(undefined),
      changePasscode: vi.fn().mockResolvedValue(true),
      disablePasscode: mockDisable,
      setAutoLockTimeout: vi.fn().mockResolvedValue(undefined),
    };

    const { UserProfileModal } = await import('../../src/presentation/components/user/UserProfileModal');

    render(
      <AppContext.Provider value={mockAppContext}>
        <PasscodeContext.Provider value={mockPasscodeCtx}>
          <UserProfileModal isOpen={true} onClose={() => {}} />
        </PasscodeContext.Provider>
      </AppContext.Provider>,
    );

    // Wait for profile to load
    await waitFor(() => {
      expect(screen.getByText('✓ Enabled')).toBeDefined();
    });

    // Click "Turn Off Passcode"
    fireEvent.click(screen.getByRole('button', { name: /Turn Off Passcode/i }));

    // Form asks for current passcode
    expect(screen.getByLabelText(/Enter Current 4-Digit Passcode to Turn Off/i)).toBeDefined();

    const pinInput = screen.getByLabelText(/Enter Current 4-Digit Passcode to Turn Off/i);

    // Enter wrong PIN 9999
    fireEvent.change(pinInput, { target: { value: '9999' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm Turn Off/i }));

    await waitFor(() => {
      expect(mockDisable).toHaveBeenCalledWith('9999');
      expect(screen.getByText('Incorrect passcode')).toBeDefined();
    });

    // Enter correct PIN 1234
    fireEvent.change(pinInput, { target: { value: '1234' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm Turn Off/i }));

    await waitFor(() => {
      expect(mockDisable).toHaveBeenCalledWith('1234');
      expect(screen.getByText('Passcode lock turned off')).toBeDefined();
    });
  });
});
