/**
 * AdminLogin — Dedicated authentication screen for RFC-0014 Admin Panel.
 * Validates the ADMIN_API_KEY via Bearer auth before granting session access.
 * Key is held strictly in volatile RAM memory and never stored in persistent storage.
 */

import React, { useState } from 'react';
import { ShieldIcon, KeyIcon } from '../common/Icons';
import { validateAdminKey } from './admin-api';

export interface AdminLoginProps {
  onLoginSuccess: (apiKey: string) => void;
}

export const AdminLogin: React.FC<AdminLoginProps> = ({ onLoginSuccess }) => {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = apiKey.trim();
    if (!trimmed) {
      setError('Please enter the administrative API key.');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      await validateAdminKey(trimmed);
      onLoginSuccess(trimmed);
    } catch (err: unknown) {
      const errObj = err as { status?: number; message?: string };
      if (errObj.status === 401 || errObj.message?.includes('401') || errObj.message?.includes('failed')) {
        setError('Invalid administrative API key. Access denied.');
      } else {
        setError(errObj.message || 'Failed to authenticate with administrative server.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="admin-login-wrapper">
      <div className="admin-login-card">
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: 'var(--space-2)' }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 'var(--radius-full)',
              backgroundColor: 'var(--color-reply-bg)',
              color: 'var(--color-accent)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 'var(--space-2)',
            }}
          >
            <ShieldIcon size={32} />
          </div>
          <h1 style={{ margin: 0, fontSize: 'var(--font-2xl)', fontWeight: 700, color: 'var(--color-text-primary)' }}>
            Admin Access
          </h1>
          <p style={{ margin: 0, fontSize: 'var(--font-sm)', color: 'var(--color-text-secondary)', lineHeight: 1.5 }}>
            Single Administrative Principal (RFC-0014). Key is stored in session memory only.
          </p>
        </div>

        {error && (
          <div
            data-testid="admin-login-error"
            className="admin-banner admin-banner--error"
            role="alert"
          >
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            <label
              htmlFor="admin-key-input"
              style={{ fontSize: 'var(--font-sm)', fontWeight: 600, color: 'var(--color-text-primary)' }}
            >
              Administrative API Key
            </label>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <input
                id="admin-key-input"
                data-testid="admin-login-input"
                type={showKey ? 'text' : 'password'}
                className="admin-input"
                placeholder="Enter ADMIN_API_KEY..."
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                disabled={loading}
                autoFocus
                autoComplete="off"
                spellCheck="false"
                style={{ paddingRight: '80px', fontFamily: showKey ? 'var(--font-mono)' : 'inherit' }}
              />
              <button
                type="button"
                onClick={() => setShowKey(!showKey)}
                tabIndex={-1}
                style={{
                  position: 'absolute',
                  right: 'var(--space-2)',
                  background: 'none',
                  border: 'none',
                  color: 'var(--color-text-secondary)',
                  fontSize: 'var(--font-xs)',
                  fontWeight: 600,
                  cursor: 'pointer',
                  padding: '4px 8px',
                  borderRadius: 'var(--radius-sm)',
                }}
              >
                {showKey ? 'HIDE' : 'SHOW'}
              </button>
            </div>
            <span className="admin-hint" style={{ fontSize: 'var(--font-xs)' }}>
              Configured via ADMIN_API_KEY whose SHA-256 hash matches the server token hash.
            </span>
          </div>

          <button
            type="submit"
            data-testid="admin-login-btn"
            className="admin-btn admin-btn--primary"
            disabled={loading || !apiKey.trim()}
            style={{ width: '100%', marginTop: 'var(--space-2)' }}
          >
            {loading ? (
              'Verifying Credentials...'
            ) : (
              <>
                <KeyIcon size={18} />
                Sign In
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
