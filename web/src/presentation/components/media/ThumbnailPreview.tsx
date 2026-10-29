/**
 * ThumbnailPreview — Passive thumbnail image preview component.
 * Phase 12B §17.7, §18.1.
 */

import React from 'react';
import { useThumbnail } from '../../hooks/useThumbnail';
import type { ThumbnailUseCase } from '../../../usecase/media/ThumbnailUseCase';

interface ThumbnailPreviewProps {
  thumbnailUseCase: ThumbnailUseCase | null;
  mediaKeyId: string | null;
  fileId: string | null;
  inlineThumbnail: string | Uint8Array | null;
  altText?: string;
  onClick?: () => void;
}

export const ThumbnailPreview: React.FC<ThumbnailPreviewProps> = ({
  thumbnailUseCase,
  mediaKeyId,
  fileId,
  inlineThumbnail,
  altText = '',
  onClick,
}) => {
  const { thumbnailUrl, loading } = useThumbnail(
    thumbnailUseCase,
    mediaKeyId,
    fileId,
    inlineThumbnail,
  );

  if (loading) {
    return (
      <div
        className="thumbnail-placeholder skeleton"
        style={{
          width: '160px',
          height: '120px',
          borderRadius: 'var(--radius-sm)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 'var(--font-xs)',
          color: 'var(--color-text-tertiary)',
        }}
      >
        Loading...
      </div>
    );
  }

  if (!thumbnailUrl) {
    return null;
  }

  return (
    <div
      className="thumbnail-preview-container"
      onClick={onClick}
      style={{
        cursor: onClick ? 'pointer' : 'default',
        display: 'inline-block',
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden',
        maxWidth: '240px',
        maxHeight: '180px',
      }}
    >
      <img
        src={thumbnailUrl}
        alt={altText}
        style={{
          display: 'block',
          maxWidth: '100%',
          maxHeight: '180px',
          objectFit: 'cover',
        }}
      />
    </div>
  );
};
