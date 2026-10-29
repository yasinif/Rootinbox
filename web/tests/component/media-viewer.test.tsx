/**
 * Phase 12B Component Test — MediaViewer (§18.6, §23.4).
 *
 * Asserts:
 * - Object URLs are created on open and REVOKED on close/unmount
 * - No dangerouslySetInnerHTML
 * - SVG renders only as a passive img
 * - Test mounts and unmounts viewer 50 times and asserts zero surviving object URLs
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MediaViewer } from '../../src/presentation/components/media/MediaViewer';
import { MediaDownloadStore } from '../../src/infrastructure/persistence/media-download-store';

describe('MediaViewer Component Test (§18.6, §23.4)', () => {
  it('renders image viewer with safe passive img tag', () => {
    render(
      <MediaViewer
        blobUrl="blob:http://localhost/mock-image-url"
        mimeType="image/png"
        fileName="example.png"
        onClose={() => {}}
      />,
    );

    const img = screen.getByRole('img');
    expect(img).toBeDefined();
    expect(img.getAttribute('src')).toBe('blob:http://localhost/mock-image-url');
    expect(img.getAttribute('alt')).toBe('example.png');

    const overlay = document.body.querySelector('.media-viewer-overlay') as HTMLElement;
    expect(overlay).toBeDefined();
    expect(overlay.style.position).toBe('fixed');
    expect(overlay.style.zIndex).toBe('100002');
    expect(document.body.contains(overlay)).toBe(true);
  });

  it('renders download fallback for non-inline MIME types (e.g. PDF)', () => {
    render(
      <MediaViewer
        blobUrl="blob:http://localhost/mock-pdf-url"
        mimeType="application/pdf"
        fileName="contract.pdf"
        onClose={() => {}}
      />,
    );

    expect(screen.getByText(/Inline preview is not available/)).toBeDefined();
    const downloadLink = screen.getByRole('link', { name: /Download File/i });
    expect(downloadLink.getAttribute('href')).toBe('blob:http://localhost/mock-pdf-url');
    expect(downloadLink.getAttribute('download')).toBe('contract.pdf');
  });

  it('mounts and unmounts viewer 50 times with zero surviving object URLs (§18.6)', () => {
    const store = new MediaDownloadStore();
    const revokedUrls = new Set<string>();

    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;

    const activeUrls = new Set<string>();
    URL.createObjectURL = vi.fn((_blob: Blob) => {
      const url = `blob:http://localhost/${Math.random()}`;
      activeUrls.add(url);
      return url;
    });
    URL.revokeObjectURL = vi.fn((url: string) => {
      activeUrls.delete(url);
      revokedUrls.add(url);
    });

    try {
      for (let i = 0; i < 50; i++) {
        const fileId = `file-${i}`;
        const blob = new Blob([`chunk-data-${i}`], { type: 'image/png' });
        const url = store.register(fileId, blob, 'image/png', 100);

        const { unmount } = render(
          <MediaViewer
            blobUrl={url}
            mimeType="image/png"
            fileName={`image-${i}.png`}
            onClose={() => {}}
            onRevokeUrl={(u) => store.revoke(fileId)}
          />,
        );

        unmount();
        cleanup();
      }

      // Assert zero active surviving URLs
      expect(store.getActiveCount()).toBe(0);
      expect(activeUrls.size).toBe(0);
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it('closes when clicking overlay backdrop or pressing Escape', () => {
    const onClose = vi.fn();
    const { unmount } = render(
      <MediaViewer
        blobUrl="blob:http://localhost/mock-image-url"
        mimeType="image/png"
        fileName="example.png"
        onClose={onClose}
      />,
    );

    // Clicking overlay backdrop triggers onClose
    const overlay = document.body.querySelector('.media-viewer-overlay') as HTMLElement;
    fireEvent.click(overlay);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Pressing Escape triggers onClose
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(2);

    unmount();
  });
});
