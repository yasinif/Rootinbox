import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { AuthScreen } from '../../src/presentation/components/AuthScreen';
import { AppContext } from '../../src/presentation/context';

describe('AuthScreen Remember Me Integration', () => {
  let mockAuthUC: any;
  let mockAppContext: any;

  beforeEach(() => {
    const authSnapshot = {
      state: 'idle' as const,
      identityHash: null,
      userId: null,
      username: null,
      displayName: null,
      error: null,
    };

    mockAuthUC = {
      subscribe: vi.fn((cb) => () => {}),
      getSnapshot: vi.fn(() => authSnapshot),
      login: vi.fn().mockResolvedValue(undefined),
      register: vi.fn().mockResolvedValue(undefined),
      unlock: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
    };

    mockAppContext = {
      authUC: mockAuthUC,
    };
  });

  it('renders Remember Me checkbox checked by default', () => {
    render(
      <AppContext.Provider value={mockAppContext}>
        <AuthScreen />
      </AppContext.Provider>,
    );

    const checkbox = document.getElementById('auth-remember-me') as HTMLInputElement;
    expect(checkbox).toBeDefined();
    expect(checkbox.checked).toBe(true);
    expect(screen.getByText(/Uncheck on public or shared computers/i)).toBeDefined();
  });

  it('passes rememberMe=true to login by default', async () => {
    render(
      <AppContext.Provider value={mockAppContext}>
        <AuthScreen />
      </AppContext.Provider>,
    );

    fireEvent.change(document.getElementById('auth-username')!, { target: { value: 'alice' } });
    fireEvent.change(document.getElementById('auth-password')!, { target: { value: 'password123' } });

    fireEvent.click(document.getElementById('auth-submit')!);

    await waitFor(() => {
      expect(mockAuthUC.login).toHaveBeenCalledWith('alice', 'password123', true);
    });
  });

  it('passes rememberMe=false to login when checkbox is unchecked', async () => {
    render(
      <AppContext.Provider value={mockAppContext}>
        <AuthScreen />
      </AppContext.Provider>,
    );

    const checkbox = document.getElementById('auth-remember-me') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);

    fireEvent.change(document.getElementById('auth-username')!, { target: { value: 'bob' } });
    fireEvent.change(document.getElementById('auth-password')!, { target: { value: 'password123' } });

    fireEvent.click(document.getElementById('auth-submit')!);

    await waitFor(() => {
      expect(mockAuthUC.login).toHaveBeenCalledWith('bob', 'password123', false);
    });
  });

  it('passes rememberMe=false to register in registration mode when unchecked', async () => {
    render(
      <AppContext.Provider value={mockAppContext}>
        <AuthScreen />
      </AppContext.Provider>,
    );

    // Switch to Register tab
    fireEvent.click(document.getElementById('auth-tab-register')!);

    const checkbox = document.getElementById('auth-remember-me') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);

    fireEvent.change(document.getElementById('auth-username')!, { target: { value: 'charlie' } });
    fireEvent.change(document.getElementById('auth-display-name')!, { target: { value: 'Charlie C' } });
    fireEvent.change(document.getElementById('auth-password')!, { target: { value: 'password123' } });

    fireEvent.click(document.getElementById('auth-submit')!);

    await waitFor(() => {
      expect(mockAuthUC.register).toHaveBeenCalledWith('charlie', 'password123', 'Charlie C', false);
    });
  });
});
