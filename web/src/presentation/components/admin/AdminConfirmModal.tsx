/**
 * AdminConfirmModal — Accessible confirmation dialog for destructive admin actions.
 * RFC-0014: All administrative actions (suspend, resume, tombstone, ban) require explicit confirmation.
 * Styled with native tokens and accessible ARIA attributes.
 */

import React, { useEffect, useRef } from 'react';
import { AlertTriangleIcon, CloseIcon } from '../common/Icons';

export interface AdminConfirmModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  isDestructive?: boolean;
  isLoading?: boolean;
  error?: string | null;
  /** Optional token to display (for tombstone actions) */
  token?: string | null;
  /** Optional verification text requirement (e.g. "CONFIRM") */
  requireInputMatch?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export const AdminConfirmModal: React.FC<AdminConfirmModalProps> = ({
  isOpen,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  isDestructive = true,
  isLoading = false,
  error = null,
  token = null,
  requireInputMatch,
  onConfirm,
  onCancel,
}) => {
  const [matchInput, setMatchInput] = React.useState('');
  const confirmBtnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOpen) {
      setMatchInput('');
      return;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isLoading) {
        onCancel();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isLoading, onCancel]);

  useEffect(() => {
    if (isOpen && !requireInputMatch) {
      confirmBtnRef.current?.focus();
    }
  }, [isOpen, requireInputMatch]);

  if (!isOpen) return null;

  const isConfirmDisabled =
    isLoading || (requireInputMatch ? matchInput.trim() !== requireInputMatch : false);

  return (
    <div
      className="modal-backdrop"
      onClick={isLoading ? undefined : onCancel}
      role="presentation"
    >
      <div
        className="modal-card"
        data-testid="admin-confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-confirm-title"
        aria-describedby="admin-confirm-desc"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '480px' }}
      >
        <div className="modal-header">
          <h2
            id="admin-confirm-title"
            className="modal-title"
            style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
          >
            {isDestructive && (
              <span style={{ color: 'var(--color-danger)', display: 'inline-flex' }}>
                <AlertTriangleIcon size={20} />
              </span>
            )}
            {title}
          </h2>
          <button
            type="button"
            className="modal-close-btn"
            onClick={onCancel}
            disabled={isLoading}
            aria-label="Close dialog"
          >
            <CloseIcon size={18} />
          </button>
        </div>

        {error && (
          <div className="admin-banner admin-banner--error" style={{ marginBottom: 'var(--space-3)' }}>
            {error}
          </div>
        )}

        <div id="admin-confirm-desc" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <p style={{ margin: 0, fontSize: 'var(--font-md)', lineHeight: 1.5, color: 'var(--color-text-primary)' }}>
            {message}
          </p>

          {token && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
              <span className="admin-hint">Confirmation Authorization Token:</span>
              <code className="admin-code" style={{ padding: '6px 10px', fontSize: 'var(--font-sm)' }}>
                {token}
              </code>
            </div>
          )}

          {requireInputMatch && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              <label
                htmlFor="admin-confirm-input"
                style={{ fontSize: 'var(--font-sm)', fontWeight: 500, color: 'var(--color-text-secondary)' }}
              >
                Type <strong>{requireInputMatch}</strong> to authorize:
              </label>
              <input
                id="admin-confirm-input"
                data-testid="admin-confirm-match-input"
                type="text"
                className="admin-input"
                value={matchInput}
                onChange={(e) => setMatchInput(e.target.value)}
                placeholder={requireInputMatch}
                disabled={isLoading}
                autoFocus
              />
            </div>
          )}
        </div>

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 'var(--space-2)',
            marginTop: 'var(--space-5)',
            borderTop: '1px solid var(--color-border-light)',
            paddingTop: 'var(--space-4)',
          }}
        >
          <button
            type="button"
            className="admin-btn admin-btn--secondary"
            data-testid="admin-cancel-btn"
            onClick={onCancel}
            disabled={isLoading}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            type="button"
            className={`admin-btn ${isDestructive ? 'admin-btn--danger' : 'admin-btn--primary'}`}
            data-testid="admin-confirm-btn"
            onClick={onConfirm}
            disabled={isConfirmDisabled}
          >
            {isLoading ? 'Processing...' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
};
