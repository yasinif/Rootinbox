import React, { useState, useEffect, useCallback } from 'react';
import { usePasscodeLock } from '../../hooks';
import { useAuth } from '../../hooks';
import { Avatar } from '../common/Avatar';

export interface PasscodeLockScreenProps {
  onUnlock?: (pin: string) => Promise<boolean>;
  onUnlockWithPassword?: (password: string) => Promise<boolean>;
  username?: string | null;
  displayName?: string | null;
  userId?: string | null;
}

export const PasscodeLockScreen: React.FC<PasscodeLockScreenProps> = (props) => {
  const passcodeContext = usePasscodeLock();
  const authContext = useAuth();

  const unlock = props.onUnlock ?? passcodeContext.unlock;
  const unlockWithMasterPassword = props.onUnlockWithPassword ?? passcodeContext.unlockWithMasterPassword;
  const username = props.username ?? authContext.username;
  const displayName = props.displayName ?? authContext.displayName;
  const userId = props.userId ?? authContext.userId;
  const logout = authContext.logout;

  const [pin, setPin] = useState<string>('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isShaking, setIsShaking] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);

  // Fallback to master password mode
  const [usePasswordFallback, setUsePasswordFallback] = useState(false);
  const [masterPassword, setMasterPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isPasswordVerifying, setIsPasswordVerifying] = useState(false);

  // Verify PIN when 4 digits are entered
  const handleDigit = useCallback((digit: string) => {
    if (isVerifying) return;
    setErrorMsg(null);
    setPin((prev) => {
      if (prev.length >= 4) return prev;
      return prev + digit;
    });
  }, [isVerifying]);

  useEffect(() => {
    if (pin.length === 4 && !isVerifying) {
      setIsVerifying(true);
      void (async () => {
        try {
          const success = await unlock(pin);
          if (!success) {
            setIsShaking(true);
            setErrorMsg('Incorrect passcode');
            setTimeout(() => {
              setPin('');
              setIsShaking(false);
              setIsVerifying(false);
            }, 500);
          } else {
            setIsVerifying(false);
          }
        } catch {
          setIsShaking(true);
          setErrorMsg('Verification error');
          setTimeout(() => {
            setPin('');
            setIsShaking(false);
            setIsVerifying(false);
          }, 500);
        }
      })();
    }
  }, [pin, isVerifying, unlock]);

  const handleDelete = useCallback(() => {
    if (isVerifying) return;
    setErrorMsg(null);
    setPin((prev) => prev.slice(0, -1));
  }, [isVerifying]);

  const handleClear = useCallback(() => {
    if (isVerifying) return;
    setErrorMsg(null);
    setPin('');
  }, [isVerifying]);

  // Keyboard navigation
  useEffect(() => {
    if (usePasswordFallback) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key >= '0' && e.key <= '9') {
        void handleDigit(e.key);
      } else if (e.key === 'Backspace') {
        handleDelete();
      } else if (e.key === 'Escape') {
        handleClear();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleDigit, handleDelete, handleClear, usePasswordFallback]);

  const handleMasterPasswordSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!masterPassword || isPasswordVerifying) return;

    setPasswordError(null);
    setIsPasswordVerifying(true);
    try {
      const success = await unlockWithMasterPassword(masterPassword);
      if (!success) {
        setPasswordError('Invalid password. Please try again.');
      }
    } catch {
      setPasswordError('Invalid password. Please try again.');
    } finally {
      setIsPasswordVerifying(false);
    }
  };

  const primaryName = displayName || (username ? `@${username}` : 'RootInbox User');

  const keypadKeys: Array<{ num: string; sub?: string } | null> = [
    { num: '1' },
    { num: '2', sub: 'ABC' },
    { num: '3', sub: 'DEF' },
    { num: '4', sub: 'GHI' },
    { num: '5', sub: 'JKL' },
    { num: '6', sub: 'MNO' },
    { num: '7', sub: 'PQRS' },
    { num: '8', sub: 'TUV' },
    { num: '9', sub: 'WXYZ' },
    null, // Blank placeholder
    { num: '0' },
    { num: 'backspace' },
  ];

  return (
    <div id="passcode-lock-screen" className="passcode-container">
      <div className="passcode-card" role="region" aria-label="Passcode Lock">
        {/* User Info / Header */}
        <div className="passcode-header">
          <div className="passcode-avatar-wrapper">
            <Avatar userId={userId || undefined} name={primaryName} size="lg" />
            <span className="passcode-lock-badge" aria-hidden="true">🔒</span>
          </div>
          <h2 className="passcode-user-name">{primaryName}</h2>
          <p className="passcode-subtitle">
            {usePasswordFallback ? 'Unlock with Account Password' : 'Enter 4-digit passcode'}
          </p>
        </div>

        {usePasswordFallback ? (
          /* Master Password Fallback View */
          <form onSubmit={(e) => void handleMasterPasswordSubmit(e)} className="passcode-fallback-form">
            <div className="auth-input-group">
              <label htmlFor="master-password-input" className="auth-label">
                Account Master Password
              </label>
              <input
                id="master-password-input"
                type="password"
                value={masterPassword}
                onChange={(e) => setMasterPassword(e.target.value)}
                placeholder="Enter password"
                className="auth-input"
                disabled={isPasswordVerifying}
                autoFocus
                required
              />
            </div>

            {passwordError && (
              <div id="passcode-error" className="auth-error" style={{ marginBottom: 'var(--space-2)' }}>
                {passwordError}
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}>
              <button
                id="submit-master-password-btn"
                type="submit"
                className={isPasswordVerifying ? 'auth-button--disabled' : 'auth-button'}
                disabled={isPasswordVerifying || !masterPassword}
              >
                {isPasswordVerifying ? 'Verifying...' : 'Unlock'}
              </button>
              <button
                id="back-to-pin-btn"
                type="button"
                className="modal-btn modal-btn--secondary"
                onClick={() => {
                  setUsePasswordFallback(false);
                  setPasswordError(null);
                  setMasterPassword('');
                  setPin('');
                }}
              >
                ← Back to Passcode PIN
              </button>
            </div>
          </form>
        ) : (
          /* Numeric PIN Keypad View */
          <div className="passcode-pin-section">
            {/* 4 PIN Dots */}
            <div
              id="pin-dots-display"
              className={`pin-dots ${isShaking ? 'pin-dots--shake' : ''}`}
              aria-label={`${pin.length} of 4 digits entered`}
            >
              {[0, 1, 2, 3].map((idx) => {
                const filled = pin.length > idx;
                return (
                  <span
                    key={idx}
                    className={`pin-dot ${filled ? 'pin-dot--filled' : ''} ${isShaking ? 'pin-dot--error' : ''}`}
                    aria-hidden="true"
                  />
                );
              })}
            </div>

            {errorMsg && (
              <div id="passcode-error" className="passcode-error-text">
                {errorMsg}
              </div>
            )}

            {/* Numeric Keypad */}
            <div className="passcode-keypad" role="group" aria-label="Passcode Keypad">
              {keypadKeys.map((k, i) => {
                if (!k) {
                  return (
                    <button
                      key={`placeholder-${i}`}
                      type="button"
                      className="passcode-key passcode-key--text"
                      onClick={handleClear}
                      disabled={isVerifying || pin.length === 0}
                      title="Clear"
                    >
                      Clear
                    </button>
                  );
                }

                if (k.num === 'backspace') {
                  return (
                    <button
                      key="backspace"
                      id="pin-key-backspace"
                      type="button"
                      className="passcode-key passcode-key--icon"
                      onClick={handleDelete}
                      disabled={isVerifying || pin.length === 0}
                      title="Backspace"
                      aria-label="Delete last digit"
                    >
                      ⌫
                    </button>
                  );
                }

                return (
                  <button
                    key={k.num}
                    id={`pin-key-${k.num}`}
                    type="button"
                    className="passcode-key"
                    onClick={() => void handleDigit(k.num)}
                    disabled={isVerifying || pin.length >= 4}
                    aria-label={`Digit ${k.num}`}
                  >
                    <span className="passcode-key-num">{k.num}</span>
                    {k.sub && <span className="passcode-key-sub">{k.sub}</span>}
                  </button>
                );
              })}
            </div>

            {/* Fallback to account password */}
            <div className="passcode-actions">
              <button
                id="unlock-with-password-btn"
                type="button"
                className="passcode-fallback-btn"
                onClick={() => setUsePasswordFallback(true)}
              >
                Forgot Passcode? Unlock with Password
              </button>
            </div>
          </div>
        )}

        {/* Log Out Option */}
        <div className="passcode-footer">
          <button
            id="passcode-logout-btn"
            type="button"
            className="passcode-logout-link"
            onClick={() => void logout()}
          >
            Log Out / Switch Account
          </button>
        </div>
      </div>
    </div>
  );
};
