/**
 * MediaUploadProgress — Upload status and progress display.
 * Phase 12B §18.5.
 *
 * Rules:
 * - Shows chunk i of N
 * - Shows explicit note that large files are throttled by design (30 chunks/min)
 */

import React from 'react';
import type { ChunkProgress } from '../../../domain/media/types';

interface MediaUploadProgressProps {
  progress: ChunkProgress | null;
  error?: string | null;
  onCancel?: () => void;
}

export const MediaUploadProgress: React.FC<MediaUploadProgressProps> = ({
  progress,
  error,
  onCancel,
}) => {
  if (error) {
    return (
      <div className="upload-error" style={{ color: 'var(--color-danger)', fontSize: 'var(--font-xs)', marginTop: 'var(--space-1)' }}>
        <span>Upload failed: {error}</span>
      </div>
    );
  }

  if (!progress) {
    return (
      <div className="upload-progress-init" style={{ fontSize: 'var(--font-xs)', color: 'var(--color-text-tertiary)' }}>
        <span>Initializing upload...</span>
      </div>
    );
  }

  const currentChunk = progress.chunkIndex + 1;
  const percentage = Math.round((progress.bytesUploaded / (progress.totalBytes || 1)) * 100);

  return (
    <div
      className="media-upload-progress"
      style={{
        padding: 'var(--space-2)',
        backgroundColor: 'var(--color-bg-secondary)',
        borderRadius: 'var(--radius-sm)',
        marginTop: 'var(--space-1)',
        border: '1px solid var(--color-border-light)',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: 'var(--font-xs)',
          fontWeight: 500,
          color: 'var(--color-text-primary)',
        }}
      >
        <span>
          Uploading chunk {currentChunk} of {progress.totalChunks}
        </span>
        <span>{percentage}%</span>
      </div>

      <div
        style={{
          height: '4px',
          backgroundColor: 'var(--color-border)',
          borderRadius: '2px',
          overflow: 'hidden',
          marginTop: 'var(--space-1)',
          marginBottom: 'var(--space-1)',
        }}
      >
        <div
          style={{
            height: '100%',
            width: `${percentage}%`,
            backgroundColor: 'var(--color-accent)',
            transition: 'width 0.2s ease',
          }}
        />
      </div>

      <div
        style={{
          fontSize: '11px',
          color: 'var(--color-text-secondary)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <span>Large files are throttled (30 chunks/min) by design.</span>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--color-danger)',
              cursor: 'pointer',
              fontSize: '11px',
              padding: '0 var(--space-1)',
              fontWeight: 600,
            }}
          >
            Cancel
          </button>
        )}
      </div>
    </div>
  );
};
