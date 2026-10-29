import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { sanitizeFileName } from '../../../domain/media/filename';
import { getFriendlyTypeLabel } from '../../../domain/media/mime';

const modalBackdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  width: '100vw',
  height: '100vh',
  backgroundColor: 'rgba(0, 0, 0, 0.75)',
  backdropFilter: 'blur(4px)',
  WebkitBackdropFilter: 'blur(4px)',
  zIndex: 1000001,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '16px',
  boxSizing: 'border-box',
};

const modalCardStyle: React.CSSProperties = {
  position: 'relative',
  zIndex: 1000002,
  backgroundColor: '#1e293b',
  color: '#f8fafc',
  border: '1px solid rgba(255, 255, 255, 0.15)',
  borderRadius: '18px',
  padding: '20px',
  width: '100%',
  maxWidth: '440px',
  maxHeight: '85vh',
  overflowY: 'auto',
  boxShadow: '0 25px 50px rgba(0, 0, 0, 0.7)',
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  boxSizing: 'border-box',
};

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface SendMediaPreviewModalProps {
  isOpen: boolean;
  file: File | null;
  initialCaption?: string;
  onClose: () => void;
  onSend: (file: File, caption?: string, previewDataUrl?: string) => void;
}

export const SendMediaPreviewModal: React.FC<SendMediaPreviewModalProps> = ({
  isOpen,
  file,
  initialCaption = '',
  onClose,
  onSend,
}) => {
  const [caption, setCaption] = useState(initialCaption);
  const [previewDataUrl, setPreviewDataUrl] = useState<string | undefined>(undefined);

  // Sync caption when modal opens with a new file or initialCaption
  useEffect(() => {
    if (isOpen) {
      setCaption(initialCaption || '');
    }
  }, [isOpen, initialCaption, file]);

  // Close modal when Escape key is pressed
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const previewUrl = useMemo(() => {
    if (!file || typeof URL === 'undefined') return null;
    try {
      return URL.createObjectURL(file);
    } catch {
      return null;
    }
  }, [file]);

  // Generate lightweight thumbnail data URL for image preview if possible
  useEffect(() => {
    if (!file || !file.type.startsWith('image/') || typeof document === 'undefined') {
      setPreviewDataUrl(undefined);
      return;
    }

    let isMounted = true;
    const img = document.createElement('img');
    let objUrl: string | null = null;
    try {
      objUrl = URL.createObjectURL(file);
    } catch {
      return;
    }

    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        const maxDim = 120;
        let w = img.naturalWidth || img.width || 120;
        let h = img.naturalHeight || img.height || 120;
        if (w > h) {
          if (w > maxDim) {
            h = Math.round((h * maxDim) / w);
            w = maxDim;
          }
        } else {
          if (h > maxDim) {
            w = Math.round((w * maxDim) / h);
            h = maxDim;
          }
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, w, h);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.6);
          if (isMounted) setPreviewDataUrl(dataUrl);
        }
      } catch {
        // ignore thumbnail generation failure
      } finally {
        if (objUrl) URL.revokeObjectURL(objUrl);
      }
    };
    img.onerror = () => {
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
    img.src = objUrl;

    return () => {
      isMounted = false;
      if (objUrl) URL.revokeObjectURL(objUrl);
    };
  }, [file]);

  useEffect(() => {
    return () => {
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
      }
    };
  }, [previewUrl]);

  if (!isOpen || !file) return null;

  const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;
  const isZeroByte = file.size === 0;
  const isTooLarge = file.size > MAX_FILE_SIZE;
  const canSend = !isZeroByte && !isTooLarge;

  const sanitizedName = sanitizeFileName(file.name);
  const friendlyType = getFriendlyTypeLabel(file.type);
  const sizeFormatted = formatFileSize(file.size);
  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  const isAudio = file.type.startsWith('audio/');

  const handleSendClick = () => {
    if (!canSend) return;
    onSend(file, caption.trim() || undefined, previewDataUrl);
    setCaption('');
    onClose();
  };

  const modalContent = (
    <div
      id="media-preview-modal-backdrop"
      data-testid="media-preview-modal-backdrop"
      className="modal-backdrop media-preview-modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label="Send media preview"
      style={modalBackdropStyle}
      onClick={onClose}
    >
      <div
        id="send-media-preview-modal"
        data-testid="send-media-preview-modal"
        className="modal-card media-preview-modal"
        style={modalCardStyle}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="media-preview-header">
          <div className="media-preview-title">
            Send {friendlyType}
          </div>
          <button
            id="close-send-media-preview-btn"
            type="button"
            className="media-preview-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Media Preview Box */}
        <div className="media-preview-body">
          {isImage && previewUrl && (
            <img
              src={previewUrl}
              alt={sanitizedName}
              className="media-preview-img"
            />
          )}

          {isVideo && previewUrl && (
            <video
              src={previewUrl}
              controls
              playsInline
              className="media-preview-video"
            />
          )}

          {isAudio && previewUrl && (
            <div style={{ width: '100%', padding: '16px', textAlign: 'center' }}>
              <div style={{ fontSize: '36px', marginBottom: '8px' }}>🎵</div>
              <audio src={previewUrl} controls className="media-preview-audio" />
            </div>
          )}

          {!isImage && !isVideo && !isAudio && (
            <div className="media-preview-filecard">
              <div style={{ fontSize: '48px', marginBottom: '8px' }}>📄</div>
              <div style={{ fontWeight: 600, fontSize: 'var(--font-sm, 14px)', color: 'var(--color-text-primary)' }}>
                {sanitizedName}
              </div>
              <div style={{ fontSize: 'var(--font-xs, 12px)', color: 'var(--color-text-secondary)', marginTop: '4px' }}>
                {sizeFormatted}
              </div>
            </div>
          )}
        </div>

        {/* Media Info / Filename & Size */}
        {(isImage || isVideo || isAudio) && (
          <div className="media-preview-meta">
            <span className="media-preview-meta-name">
              {sanitizedName}
            </span>
            <span>{sizeFormatted}</span>
          </div>
        )}

        {/* Caption Input */}
        <div className="media-preview-caption-box">
          <input
            id="send-media-caption-input"
            data-testid="send-media-caption-input"
            type="text"
            placeholder="Add a caption..."
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSendClick();
              }
            }}
            className="media-preview-caption-input"
          />

          {isZeroByte && (
            <div
              id="send-media-size-error"
              style={{
                color: 'var(--color-danger, #ef4444)',
                fontSize: 'var(--font-xs, 12px)',
                marginTop: '6px',
                fontWeight: 500,
              }}
            >
              ⚠️ Empty files (0 bytes) cannot be sent.
            </div>
          )}
          {isTooLarge && (
            <div
              id="send-media-size-error"
              style={{
                color: 'var(--color-danger, #ef4444)',
                fontSize: 'var(--font-xs, 12px)',
                marginTop: '6px',
                fontWeight: 500,
              }}
            >
              ⚠️ File size exceeds maximum allowed 2GB limit.
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="media-preview-footer">
          <button
            id="cancel-send-media-btn"
            data-testid="cancel-send-media-btn"
            type="button"
            className="modal-btn modal-btn--cancel"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            id="confirm-send-media-btn"
            data-testid="confirm-send-media-btn"
            type="button"
            className="modal-btn modal-btn--primary"
            disabled={!canSend}
            style={{ opacity: canSend ? 1 : 0.5, cursor: canSend ? 'pointer' : 'not-allowed' }}
            onClick={handleSendClick}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(modalContent, document.body);
  }
  return modalContent;
};
