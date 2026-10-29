import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

export interface AttachmentMenuProps {
  isOpen: boolean;
  onClose: () => void;
  anchorRect?: DOMRect | null;
  onSelectFile?: (file: File) => void;
  onTriggerGallery?: () => void;
  onTriggerCamera?: () => void;
  onTriggerFile?: () => void;
  onTriggerAudio?: () => void;
}

export const AttachmentMenu: React.FC<AttachmentMenuProps> = ({
  isOpen,
  onClose,
  onTriggerGallery,
  onTriggerCamera,
  onTriggerFile,
  onTriggerAudio,
}) => {
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

  if (!isOpen) return null;

  const handleSelectOption = (
    e: React.MouseEvent,
    triggerCallback?: () => void,
  ) => {
    e.stopPropagation();
    if (triggerCallback) {
      triggerCallback();
    }
    onClose();
  };

  const content = (
    <div
      id="attachment-menu-backdrop"
      data-testid="attachment-menu-backdrop"
      className="attachment-menu-overlay"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div
        id="attachment-menu"
        data-testid="attachment-menu"
        className="attachment-menu-card"
        role="menu"
        aria-label="Attachment options"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header with Title & Close ✕ Button */}
        <div className="attachment-menu-header">
          <span className="attachment-menu-title">
            Send Attachment
          </span>
          <button
            id="attachment-menu-close-btn"
            data-testid="attachment-menu-close-btn"
            type="button"
            onClick={onClose}
            className="attachment-menu-close-btn"
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* 1. Gallery */}
        <button
          id="attachment-opt-gallery"
          data-testid="attachment-opt-gallery"
          type="button"
          className="attachment-menu-item"
          role="menuitem"
          tabIndex={0}
          onClick={(e) => handleSelectOption(e, onTriggerGallery)}
        >
          <span className="attachment-menu-icon" aria-hidden="true">
            🖼️
          </span>
          <div className="attachment-menu-text-wrap">
            <span className="attachment-menu-label">
              Gallery
            </span>
            <span className="attachment-menu-desc">
              Photos & Videos
            </span>
          </div>
        </button>

        {/* 2. Camera */}
        <button
          id="attachment-opt-camera"
          data-testid="attachment-opt-camera"
          type="button"
          className="attachment-menu-item"
          role="menuitem"
          tabIndex={0}
          onClick={(e) => handleSelectOption(e, onTriggerCamera)}
        >
          <span className="attachment-menu-icon" aria-hidden="true">
            📷
          </span>
          <div className="attachment-menu-text-wrap">
            <span className="attachment-menu-label">
              Camera
            </span>
            <span className="attachment-menu-desc">
              Take Photo or Video
            </span>
          </div>
        </button>

        {/* 3. File / Document */}
        <button
          id="attachment-opt-file"
          data-testid="attachment-opt-file"
          type="button"
          className="attachment-menu-item"
          role="menuitem"
          tabIndex={0}
          onClick={(e) => handleSelectOption(e, onTriggerFile)}
        >
          <span className="attachment-menu-icon" aria-hidden="true">
            📁
          </span>
          <div className="attachment-menu-text-wrap">
            <span className="attachment-menu-label">
              File
            </span>
            <span className="attachment-menu-desc">
              Document or Any File
            </span>
          </div>
        </button>

        {/* 4. Audio */}
        <button
          id="attachment-opt-audio"
          data-testid="attachment-opt-audio"
          type="button"
          className="attachment-menu-item"
          role="menuitem"
          tabIndex={0}
          onClick={(e) => handleSelectOption(e, onTriggerAudio)}
        >
          <span className="attachment-menu-icon" aria-hidden="true">
            🎵
          </span>
          <div className="attachment-menu-text-wrap">
            <span className="attachment-menu-label">
              Audio
            </span>
            <span className="attachment-menu-desc">
              Audio or Music
            </span>
          </div>
        </button>
      </div>
    </div>
  );

  if (typeof document !== 'undefined' && document.body) {
    return createPortal(content, document.body);
  }
  return content;
};
