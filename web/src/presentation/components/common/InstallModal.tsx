import React from 'react';
import { usePwaInstall } from '../../hooks';

export interface InstallModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const InstallModal: React.FC<InstallModalProps> = ({ isOpen, onClose }) => {
  const { isInstalled, hasNativePrompt, promptInstall } = usePwaInstall();

  if (!isOpen) return null;

  const handleInstallClick = async () => {
    if (hasNativePrompt) {
      const installed = await promptInstall();
      if (installed) {
        onClose();
      }
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card modal-card--narrow"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: '420px', textAlign: 'center' }}
      >
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 'var(--space-3)' }}>
          <img
            src="/icon-192x192.png"
            alt="RootInbox"
            style={{ width: '72px', height: '72px', borderRadius: '16px', boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}
          />
        </div>

        <h3 className="modal-title" style={{ marginBottom: 'var(--space-2)' }}>
          Install RootInbox
        </h3>
        <p style={{ fontSize: 'var(--font-sm)', color: 'var(--color-text-secondary)', marginBottom: 'var(--space-4)', lineHeight: 1.5 }}>
          Install RootInbox on your mobile or desktop device for fast, standalone access, encrypted offline storage, and push notifications.
        </p>

        {isInstalled ? (
          <div
            style={{
              padding: 'var(--space-3)',
              backgroundColor: 'var(--color-success-bg)',
              color: 'var(--color-success)',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--font-sm)',
              fontWeight: 600,
              marginBottom: 'var(--space-4)',
            }}
          >
            ✓ RootInbox is already installed on this device!
          </div>
        ) : hasNativePrompt ? (
          <button
            id="pwa-native-install-btn"
            type="button"
            className="modal-btn modal-btn--primary"
            onClick={() => void handleInstallClick()}
            style={{ marginBottom: 'var(--space-4)', width: '100%', padding: '12px', fontSize: 'var(--font-base)', fontWeight: 600 }}
          >
            📲 Install Now
          </button>
        ) : null}

        {/* Step-by-step instructions for browsers */}
        <div
          style={{
            textAlign: 'left',
            backgroundColor: 'var(--color-bg-secondary)',
            border: '1px solid var(--color-border)',
            borderRadius: 'var(--radius-md)',
            padding: 'var(--space-3) var(--space-4)',
            marginBottom: 'var(--space-4)',
            fontSize: 'var(--font-xs)',
            lineHeight: 1.6,
          }}
        >
          <div style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: '6px' }}>
            📱 On Android (Chrome / Edge):
          </div>
          <div style={{ color: 'var(--color-text-secondary)', marginBottom: '10px' }}>
            Tap the <strong>⋮</strong> menu in the top right &gt; Select <strong>Install app</strong> or <strong>Add to Home screen</strong>.
          </div>

          <div style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: '6px' }}>
            💻 On Desktop (Chrome / Edge / Windows / Mac):
          </div>
          <div style={{ color: 'var(--color-text-secondary)', marginBottom: '10px' }}>
            Click the <strong>Install</strong> icon in the browser address bar &gt; Click <strong>Install RootInbox</strong>.
          </div>

          <div style={{ fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: '6px' }}>
            🍎 On iOS (iPhone / iPad Safari):
          </div>
          <div style={{ color: 'var(--color-text-secondary)' }}>
            Tap the <strong>Share</strong> button (⎋) at the bottom &gt; Select <strong>Add to Home Screen</strong>.
          </div>
        </div>

        <button
          type="button"
          className="modal-btn modal-btn--secondary"
          onClick={onClose}
          style={{ width: '100%' }}
        >
          Close
        </button>
      </div>
    </div>
  );
};
