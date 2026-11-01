import React, { useState } from 'react';

export interface RecoveryKeyModalProps {
  isOpen: boolean;
  recoveryKey: string;
  onClose: (skipped: boolean) => void;
}

export const RecoveryKeyModal: React.FC<RecoveryKeyModalProps> = ({
  isOpen,
  recoveryKey,
  onClose,
}) => {
  const [copied, setCopied] = useState(false);

  if (!isOpen) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(recoveryKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback or ignore
    }
  };

  return (
    <div id="recovery-key-modal" className="modal-backdrop" onClick={() => onClose(true)}>
      <div
        className="modal-card modal-card--narrow"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '440px', textAlign: 'center' }}
      >
        <div style={{ fontSize: '36px', marginBottom: 'var(--space-2)' }}>🔑</div>
        <h3 className="modal-title" style={{ marginBottom: 'var(--space-2)' }}>
          Your Account Recovery Key
        </h3>
        <p
          style={{
            fontSize: 'var(--font-sm)',
            color: 'var(--color-text-secondary)',
            marginBottom: 'var(--space-3)',
            lineHeight: 1.5,
          }}
        >
          Save your Recovery Key in a safe place. If you forget your password, your message history
          cannot be recovered without it.
        </p>

        <div
          id="recovery-key-display"
          style={{
            backgroundColor: 'var(--color-bg-tertiary, #1e293b)',
            padding: '12px',
            borderRadius: 'var(--radius-md, 8px)',
            fontFamily: 'monospace',
            fontSize: '12px',
            wordBreak: 'break-all',
            color: 'var(--color-text-primary, #f8fafc)',
            border: '1px solid var(--color-border, #334155)',
            marginBottom: 'var(--space-3)',
            userSelect: 'all',
          }}
        >
          {recoveryKey}
        </div>

        <button
          id="recovery-key-copy-btn"
          type="button"
          onClick={() => { void handleCopy(); }}
          className="modal-btn modal-btn--secondary"
          style={{
            width: '100%',
            marginBottom: 'var(--space-3)',
            padding: '8px',
            fontSize: 'var(--font-sm)',
          }}
        >
          {copied ? '✓ Copied to clipboard!' : '📋 Copy Recovery Key'}
        </button>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <button
            id="recovery-key-saved-btn"
            type="button"
            onClick={() => onClose(false)}
            className="auth-button"
            style={{ width: '100%', padding: '10px' }}
          >
            I have saved my Recovery Key
          </button>
          <button
            id="recovery-key-skip-btn"
            type="button"
            onClick={() => onClose(true)}
            className="auth-switch-btn"
            style={{ padding: '6px' }}
          >
            Skip for now (I understand the risk)
          </button>
        </div>
      </div>
    </div>
  );
};
