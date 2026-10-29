/**
 * Phase 12B Component Test — MediaAttachmentBubble (§23.4).
 *
 * Asserts:
 * - Thumbnail-present and thumbnail-absent paths
 * - PENDING_DECRYPT placeholder rendering (ADR-P12B-30)
 * - Sanitized filename rendering through escaped text
 * - Download affordance
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MediaAttachmentBubble } from '../../src/presentation/components/media/MediaAttachmentBubble';
import type { MediaMetadata } from '../../src/domain/media/types';

describe('MediaAttachmentBubble Component Test (§23.4)', () => {
  const baseMetadata: MediaMetadata = {
    file_id: 'test-uuid-1234',
    media_key: 'b64key==',
    file_iv_prefix: 'b64iv==',
    media_token: 'b64token==',
    original_size: 2048576,
    total_chunks: 1,
    file_manifest_hash: 'b64hash==',
    mime_type: 'image/png',
    inline_thumbnail: null,
  };

  it('renders PENDING_DECRYPT placeholder when isPendingDecrypt is true', () => {
    render(<MediaAttachmentBubble isPendingDecrypt={true} />);
    expect(screen.getByText(/Pending Decryption/i)).toBeDefined();
  });

  it('renders thumbnail-absent media attachment with sanitized filename and friendly label', () => {
    const rawMalicious = 'malicious\x00\x1f_file\u202Egpj.png';
    render(
      <MediaAttachmentBubble
        metadata={baseMetadata}
        fileName={rawMalicious}
      />,
    );

    // Sanitized: C0 controls and RLO bidi stripped -> malicious_filegpj.png
    expect(screen.getByText('malicious_filegpj.png')).toBeDefined();
    expect(screen.getByText(/Image/)).toBeDefined();
    expect(screen.getByText(/2.0 MB/)).toBeDefined();
    expect(screen.getByText('Download')).toBeDefined();
  });

  it('renders thumbnail container when inline_thumbnail is present', () => {
    const withThumbnail: MediaMetadata = {
      ...baseMetadata,
      inline_thumbnail: 'dGVzdC10aHVtYm5haWw=',
    };

    const mockThumbnailUC = {
      decodeThumbnail: vi.fn().mockImplementation(() => new Promise(() => {})),
    };

    const { container } = render(
      <MediaAttachmentBubble
        metadata={withThumbnail}
        fileName="photo.png"
        thumbnailUseCase={mockThumbnailUC as any}
        mediaKeyId="mock-key-id"
      />,
    );

    expect(screen.getByText('photo.png')).toBeDefined();
    expect(container.querySelector('.thumbnail-placeholder')).not.toBeNull();
  });

  it('renders visible cancel upload button while in-progress and triggers onCancelUpload on click (H5)', () => {
    const onCancelUpload = vi.fn();
    render(
      <MediaAttachmentBubble
        fileName="large_video.mp4"
        isUploading={true}
        uploadProgress={45}
        uploadProgressBytes={450000}
        uploadTotalBytes={1000000}
        onCancelUpload={onCancelUpload}
      />,
    );

    const cancelBtn = screen.getByTestId('media-cancel-upload-btn');
    expect(cancelBtn).toBeDefined();
    expect(cancelBtn.textContent).toContain('Cancel');

    cancelBtn.click();
    expect(onCancelUpload).toHaveBeenCalledTimes(1);
  });
});

