/**
 * Phase 12B Unit Test — MIME Allowlist & Inline Rendering Policy.
 * §23.2, §17.5, ADR-P12B-38.
 *
 * Rules:
 * - Each allowlisted type renders inline:
 *   image/png, image/jpeg, image/webp, image/gif, image/svg+xml,
 *   video/mp4, video/webm, audio/mpeg, audio/ogg, audio/wav
 * - application/pdf, text/html, and unrecognized are download-only
 * - Blob type is set from the allowlist entry, never from raw peer string
 */

import { describe, it, expect } from 'vitest';
import {
  INLINE_MIME_ALLOWLIST,
  isInlineRenderable,
  getValidatedMimeType,
  getFriendlyTypeLabel,
  normalizeUploadMimeType,
} from '../../src/domain/media/mime';

describe('MIME Allowlist Unit Tests (§23.2, §17.5, ADR-P12B-38)', () => {
  it('allows all 10 specified inline types', () => {
    const expected = [
      'image/png',
      'image/jpeg',
      'image/webp',
      'image/gif',
      'image/svg+xml',
      'video/mp4',
      'video/webm',
      'audio/mpeg',
      'audio/ogg',
      'audio/wav',
    ];

    for (const mime of expected) {
      expect(isInlineRenderable(mime)).toBe(true);
      expect(getValidatedMimeType(mime)).toBe(mime);
    }
  });

  it('rejects application/pdf and text/html as inline renderable', () => {
    expect(isInlineRenderable('application/pdf')).toBe(false);
    expect(getValidatedMimeType('application/pdf')).toBe('application/octet-stream');

    expect(isInlineRenderable('text/html')).toBe(false);
    expect(getValidatedMimeType('text/html')).toBe('application/octet-stream');
  });

  it('rejects executable or script types', () => {
    expect(isInlineRenderable('application/javascript')).toBe(false);
    expect(isInlineRenderable('application/x-msdownload')).toBe(false);
    expect(getValidatedMimeType('application/x-msdownload')).toBe('application/octet-stream');
  });

  it('returns friendly type labels without raw peer strings', () => {
    expect(getFriendlyTypeLabel('image/png')).toBe('Image');
    expect(getFriendlyTypeLabel('video/mp4')).toBe('Video');
    expect(getFriendlyTypeLabel('audio/mpeg')).toBe('Audio');
    expect(getFriendlyTypeLabel('application/pdf')).toBe('PDF Document');
    expect(getFriendlyTypeLabel('application/octet-stream')).toBe('File');
    expect(getFriendlyTypeLabel('unknown/custom-format')).toBe('File');
    expect(getFriendlyTypeLabel('application/msword')).toBe('Word Document');
    expect(getFriendlyTypeLabel('application/vnd.ms-excel')).toBe('Spreadsheet');
    expect(getFriendlyTypeLabel('application/zip')).toBe('Archive');
    expect(getFriendlyTypeLabel('text/plain')).toBe('Text Document');
  });

  it('normalizes upload MIME types with fallback to application/octet-stream', () => {
    expect(normalizeUploadMimeType('image/jpeg')).toBe('image/jpeg');
    expect(normalizeUploadMimeType('audio/mp3')).toBe('audio/mp3');
    expect(normalizeUploadMimeType('application/pdf')).toBe('application/pdf');
    expect(normalizeUploadMimeType('application/zip')).toBe('application/zip');
    expect(normalizeUploadMimeType('')).toBe('application/octet-stream');
    expect(normalizeUploadMimeType('unknown/custom-file-type')).toBe('application/octet-stream');
    expect(normalizeUploadMimeType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(normalizeUploadMimeType('audio/ogg; codecs=opus')).toBe('audio/ogg');
    expect(isInlineRenderable('audio/webm;codecs=opus')).toBe(true);
    expect(isInlineRenderable('audio/ogg; codecs=opus')).toBe(true);
  });
});
