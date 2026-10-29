/**
 * MediaViewer — Modal media viewer for inline-renderable attachments.
 * Phase 12B §18.1, §18.6, §23.4.
 *
 * Rules:
 * - Object URLs are created on open and REVOKED on close/unmount
 * - No dangerouslySetInnerHTML
 * - SVG renders strictly as a passive <img src="blob:...">
 * - Clean teardown guaranteed
 */

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { sanitizeFileName } from '../../../domain/media/filename';
import { isInlineRenderable, getFriendlyTypeLabel } from '../../../domain/media/mime';

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  width: '100vw',
  height: '100vh',
  zIndex: 100002,
  backgroundColor: 'rgba(0, 0, 0, 0.92)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 'var(--space-4, 16px)',
  boxSizing: 'border-box',
};

interface MediaViewerProps {
  blobUrl: string | null;
  mimeType: string;
  fileName: string;
  onClose: () => void;
  onRevokeUrl?: (url: string) => void;
}

export const MediaViewer: React.FC<MediaViewerProps> = ({
  blobUrl,
  mimeType,
  fileName,
  onClose,
  onRevokeUrl,
}) => {
  const sanitizedName = sanitizeFileName(fileName);
  const isInline = isInlineRenderable(mimeType);
  const friendlyLabel = getFriendlyTypeLabel(mimeType);

  useEffect(() => {
    return () => {
      if (blobUrl && onRevokeUrl) {
        onRevokeUrl(blobUrl);
      }
    };
  }, [blobUrl, onRevokeUrl]);

  useEffect(() => {
    if (!blobUrl) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [blobUrl, onClose]);

  if (!blobUrl) return null;

  const content = (
    <div
      className="media-viewer-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`Media viewer: ${sanitizedName}`}
      style={overlayStyle}
      onClick={onClose}
    >
      <div
        className="media-viewer-header"
        style={{
          maxWidth: '800px',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h3 style={{ margin: 0, fontSize: 'var(--font-lg)', fontWeight: 600 }}>{sanitizedName}</h3>
          <span style={{ fontSize: 'var(--font-xs)', color: 'rgba(255, 255, 255, 0.7)' }}>{friendlyLabel}</span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close viewer"
          style={{
            background: 'none',
            border: 'none',
            color: '#ffffff',
            fontSize: '24px',
            cursor: 'pointer',
            padding: '4px 8px',
          }}
        >
          ✕
        </button>
      </div>

      <div className="media-viewer-body" onClick={(e) => e.stopPropagation()}>
        {isInline && mimeType.startsWith('image/') && (
          <img
            src={blobUrl}
            alt={sanitizedName}
            style={{
              maxWidth: '100%',
              maxHeight: '80vh',
              objectFit: 'contain',
              borderRadius: 'var(--radius-sm)',
            }}
          />
        )}

        {isInline && mimeType.startsWith('video/') && (
          <video
            src={blobUrl}
            controls
            playsInline
            autoPlay
            style={{
              maxWidth: '100%',
              maxHeight: '80vh',
              borderRadius: 'var(--radius-sm)',
            }}
          />
        )}

        {isInline && mimeType.startsWith('audio/') && (
          <div style={{ padding: 'var(--space-6)', backgroundColor: 'var(--color-bg-secondary)', borderRadius: 'var(--radius-md)' }}>
            <audio src={blobUrl} controls autoPlay />
          </div>
        )}

        {!isInline && (
          <div
            style={{
              padding: 'var(--space-7)',
              backgroundColor: 'var(--color-bg-secondary)',
              borderRadius: 'var(--radius-md)',
              textAlign: 'center',
              color: 'var(--color-text-primary)',
            }}
          >
            <div style={{ fontSize: '48px', marginBottom: 'var(--space-4)' }}>📄</div>
            <p style={{ margin: '0 0 var(--space-4) 0', fontSize: 'var(--font-sm)' }}>
              Inline preview is not available for this file type ({friendlyLabel}).
            </p>
            <a
              href={blobUrl}
              download={sanitizedName}
              rel="noopener noreferrer"
              className="modal-btn modal-btn--primary"
              style={{
                display: 'inline-block',
                textDecoration: 'none',
              }}
            >
              Download File
            </a>
          </div>
        )}
      </div>
    </div>
  );

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(content, document.body);
  }
  return content;
};
