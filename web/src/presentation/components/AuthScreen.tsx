/**
 * AuthScreen — register, login, and unlock forms.
 * RFC-0010 §4.2: Presentation layer, uses hooks only.
 * dangerouslySetInnerHTML FORBIDDEN anywhere.
 * Auth failures: single uniform message.
 */

import { useState, useEffect } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth, usePwaInstall } from '../hooks';
import { estimatePassphraseEntropy } from '../../domain';
import { InstallModal } from './common/InstallModal';

export function AuthScreen() {
  const { state, error, username: savedUsername, displayName: savedDisplayName, register, login, unlock, logout } = useAuth();
  const { isInstalled, hasNativePrompt, promptInstall } = usePwaInstall();
  const [showInstallModal, setShowInstallModal] = useState(false);
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [unlockPassword, setUnlockPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(true);
  const [localError, setLocalError] = useState<string | null>(null);
  const [wasLocked, setWasLocked] = useState(false);

  useEffect(() => {
    if (state === 'locked') {
      setWasLocked(true);
    } else if (state === 'idle' || state === 'authenticated') {
      setWasLocked(false);
    }
  }, [state]);

  if (state === 'authenticated') {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);

    const cleanUsername = username.trim().toLowerCase().replace(/^@/, '');
    if (!cleanUsername || !password) return;

    if (mode === 'register') {
      const cleanDisplay = displayName.trim();
      if (!cleanDisplay) {
        setLocalError('Display Name is required');
        return;
      }
      if (!/^[a-z0-9_]{3,32}$/.test(cleanUsername)) {
        setLocalError('Username must be 3-32 characters, lowercase alphanumeric or underscore');
        return;
      }
      await register(cleanUsername, password, cleanDisplay, rememberMe);
    } else {
      await login(cleanUsername, password, rememberMe);
    }
  };

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError(null);
    if (!unlockPassword) return;
    await unlock(unlockPassword);
  };

  const isLoading = state === 'loading';
  const displayedError = localError || error;

  // Render Unlock Screen when session exists on server but memory keys need password derivation
  const showUnlockScreen = state === 'locked' || (state === 'loading' && wasLocked);
  if (showUnlockScreen) {
    return (
      <div id="auth-screen" className="auth-container">
        <div className="auth-card">
          <div className="auth-logo-container">
            <div className="auth-logo">🔐</div>
            <h1 className="auth-title">Unlock RootInbox</h1>
            <p className="auth-subtitle">
              Welcome back, <strong>{savedDisplayName || savedUsername || 'User'}</strong>
            </p>
          </div>

          <form onSubmit={(e) => { void handleUnlock(e); }} className="auth-form">
            <div className="auth-input-group">
              <label htmlFor="auth-unlock-password" className="auth-label">
                Password to unlock vault & keys
              </label>
              <input
                id="auth-unlock-password"
                type="password"
                value={unlockPassword}
                onChange={(e) => setUnlockPassword(e.target.value)}
                placeholder="Enter password"
                className="auth-input"
                disabled={isLoading}
                autoFocus
                autoComplete="current-password"
              />
            </div>

            {displayedError && (
              <div id="auth-error" className="auth-error">
                {displayedError}
              </div>
            )}

            <button
              id="auth-unlock-submit"
              type="submit"
              className={isLoading ? 'auth-button--disabled' : 'auth-button'}
              disabled={isLoading || !unlockPassword}
            >
              {isLoading ? 'Unlocking...' : 'Unlock Vault'}
            </button>

            <button
              id="auth-switch-account-btn"
              type="button"
              className="auth-switch-btn"
              onClick={() => void logout()}
            >
              Log out / Switch account
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div id="auth-screen" className="auth-container">
      <div className="auth-card">
        <div className="auth-logo-container">
          <div className="auth-logo">🔒</div>
          <h1 className="auth-title">RootInbox</h1>
          <p className="auth-subtitle">Zero-Knowledge E2EE Messaging</p>
        </div>

        <div className="auth-tabs">
          <button
            id="auth-tab-login"
            type="button"
            className={mode === 'login' ? 'auth-tab--active' : 'auth-tab'}
            onClick={() => {
              setMode('login');
              setLocalError(null);
            }}
          >
            Sign In
          </button>
          <button
            id="auth-tab-register"
            type="button"
            className={mode === 'register' ? 'auth-tab--active' : 'auth-tab'}
            onClick={() => {
              setMode('register');
              setLocalError(null);
            }}
          >
            Register
          </button>
        </div>

        <form onSubmit={(e) => { void handleSubmit(e); }} className="auth-form">
          {mode === 'register' && (
            <div className="auth-input-group">
              <label htmlFor="auth-display-name" className="auth-label">
                Display Name <span style={{ color: 'var(--color-danger)' }}>*</span>
              </label>
              <input
                id="auth-display-name"
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g. Alice"
                className="auth-input"
                disabled={isLoading}
                required
                autoComplete="name"
              />
            </div>
          )}

          <div className="auth-input-group">
            <label htmlFor="auth-username" className="auth-label">
              Username {mode === 'register' && <span style={{ color: 'var(--color-danger)' }}>*</span>}
            </label>
            <div style={{ position: 'relative' }}>
              <span className="auth-prefix">@</span>
              <input
                id="auth-username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={mode === 'register' ? 'alice' : 'username'}
                className="auth-input auth-input--username"
                disabled={isLoading}
                required
                autoComplete="username"
              />
            </div>
            {mode === 'register' && (
              <span className="auth-hint">
                3-32 characters, lowercase letters, numbers, and underscores
              </span>
            )}
          </div>

          <div className="auth-input-group">
            <label htmlFor="auth-password" className="auth-label">Password</label>
            <input
              id="auth-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter password"
              className="auth-input"
              disabled={isLoading}
              required
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            />
            {mode === 'register' && password.length > 0 && (
              <span
                id="auth-password-strength"
                className="auth-hint"
                style={{
                  color: estimatePassphraseEntropy(password).isStrong
                    ? '#16a34a'
                    : '#d97706',
                  marginTop: '4px',
                  display: 'block',
                }}
              >
                {estimatePassphraseEntropy(password).isStrong
                  ? `Strong passphrase (~${estimatePassphraseEntropy(password).bits} bits entropy)`
                  : (estimatePassphraseEntropy(password).feedback || 'Passphrase too weak')}
              </span>
            )}
          </div>

          <div className="auth-checkbox-group">
            <label htmlFor="auth-remember-me" className="auth-checkbox-label">
              <input
                id="auth-remember-me"
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                disabled={isLoading}
                className="auth-checkbox-input"
              />
              <span className="auth-checkbox-box">
                {rememberMe && <span className="auth-checkbox-check">✓</span>}
              </span>
              <span className="auth-checkbox-text">
                <span className="auth-checkbox-title">Remember me</span>
                <span className="auth-checkbox-hint">Uncheck on public or shared computers</span>
              </span>
            </label>
          </div>

          {displayedError && (
            <div id="auth-error" className="auth-error">
              {displayedError}
            </div>
          )}

          <button
            id="auth-submit"
            type="submit"
            className={isLoading ? 'auth-button--disabled' : 'auth-button'}
            disabled={isLoading}
          >
            {isLoading ? 'Processing...' : (mode === 'register' ? 'Create Account' : 'Sign In')}
          </button>
        </form>

        <p className="auth-footer-text">
          {mode === 'login'
            ? 'Your credentials never leave this device. Keys are derived locally.'
            : 'Telegram-style handles. All chats are end-to-end encrypted.'}
        </p>

        {!isInstalled && (
          <div style={{ marginTop: 'var(--space-3)', borderTop: '1px solid var(--color-border)', paddingTop: 'var(--space-3)', textAlign: 'center' }}>
            <button
              id="auth-install-btn"
              type="button"
              onClick={async () => {
                if (hasNativePrompt) {
                  await promptInstall();
                } else {
                  setShowInstallModal(true);
                }
              }}
              className="modal-btn modal-btn--secondary"
              style={{
                width: '100%',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                padding: '8px 14px',
                fontSize: 'var(--font-xs)',
                fontWeight: 600,
                color: 'var(--color-accent)',
                borderColor: 'var(--color-accent)',
                cursor: 'pointer',
              }}
            >
              <span>📲</span>
              <span>Install RootInbox App</span>
            </button>
          </div>
        )}
      </div>

      <InstallModal
        isOpen={showInstallModal}
        onClose={() => setShowInstallModal(false)}
      />
    </div>
  );
}
