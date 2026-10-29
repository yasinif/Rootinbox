/**
 * Phase 12B Unit Test — Thumbnail Plaintext Sizing & Fit.
 * §23.2, §17.7, ADR-P12B-35, ADR-P12B-39, Rows M-17, M-18, M-22.
 */

import { describe, it, expect } from 'vitest';
import {
  THUMBNAIL_MAX_IMAGE_SIZE,
  THUMBNAIL_PADDED_SIZE,
} from '../../src/domain/media/constants';
import {
  formatThumbnailPlaintext,
  generateThumbnailPlaintext,
} from '../../src/workers/thumbnail.worker';
import { ThumbnailUseCase } from '../../src/usecase/media/ThumbnailUseCase';
import type { MediaCryptoPort } from '../../src/domain/ports/media';

describe('Thumbnail Fit & Decoding Unit Tests (§23.2, M-17, M-18, M-22)', () => {
  it('formats image <= 32,764 bytes into exactly 32,768-byte padded plaintext with 4-byte BE prefix', () => {
    const rawImage = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // 4 bytes
    const padded = formatThumbnailPlaintext(rawImage);

    expect(padded.length).toBe(THUMBNAIL_PADDED_SIZE);
    expect(padded.length).toBe(32_768);

    // Read 4-byte BE length prefix
    const view = new DataView(padded.buffer, padded.byteOffset, 4);
    expect(view.getUint32(0, false)).toBe(4);

    // Image bytes follow prefix
    expect(padded[4]).toBe(0xff);
    expect(padded[5]).toBe(0xd8);
    expect(padded[6]).toBe(0xff);
    expect(padded[7]).toBe(0xe0);

    // Trailing bytes are zero
    expect(padded[8]).toBe(0);
    expect(padded[32_767]).toBe(0);
  });

  it('32,764 bytes is exact fit with zero trailing padding', () => {
    const maxImage = new Uint8Array(THUMBNAIL_MAX_IMAGE_SIZE);
    maxImage.fill(0x55);
    const padded = formatThumbnailPlaintext(maxImage);

    expect(padded.length).toBe(32_768);
    const view = new DataView(padded.buffer, padded.byteOffset, 4);
    expect(view.getUint32(0, false)).toBe(THUMBNAIL_MAX_IMAGE_SIZE);
    expect(padded[4]).toBe(0x55);
    expect(padded[32_767]).toBe(0x55);
  });

  it('32,765 bytes is REJECTED with error (Row M-18)', () => {
    const oversize = new Uint8Array(THUMBNAIL_MAX_IMAGE_SIZE + 1);
    expect(() => formatThumbnailPlaintext(oversize)).toThrow();
  });

  it('non-image MIME produces null thumbnail (ADR-P12B-39)', async () => {
    const resultPdf = await generateThumbnailPlaintext(new Uint8Array(100), 'application/pdf');
    expect(resultPdf).toBeNull();

    const resultText = await generateThumbnailPlaintext(new Uint8Array(100), 'text/plain');
    expect(resultText).toBeNull();
  });

  it('ThumbnailUseCase decodes thumbnail wire by slicing prefix and rejecting version != 0x01 (Row M-22)', async () => {
    const mockCryptoPort: MediaCryptoPort = {
      async createMediaKey() { return { media_key_id: '' }; },
      async importMediaKey() { return { media_key_id: '' }; },
      async sealChunk() { return { ciphertext: new Uint8Array(0), ciphertext_sha256: '' }; },
      async openChunk() { return { plaintext: new Uint8Array(0) }; },
      async sealThumbnail() { return { wire: new Uint8Array(32_797) }; },
      async openThumbnail() {
        const padded = formatThumbnailPlaintext(new Uint8Array([1, 2, 3, 4, 5]));
        return { plaintext_padded: padded };
      },
      async exportMediaKeyForPeer() { return { media_key: '', file_iv_prefix: '' }; },
      async dropMediaKey() { return { ok: true }; },
      async buildMediaMetadata() { return { plaintext_mce: '' }; },
      async computeTokenHash() { return ''; },
      async computeManifestHash() { return { raw: new Uint8Array(0), hex: '', base64: '' }; },
    };

    const useCase = new ThumbnailUseCase(mockCryptoPort);

    // Wire with version 0x02 MUST be rejected without decrypt attempt (Row M-22)
    const badWire = new Uint8Array(32_797);
    badWire[0] = 0x02;
    const badResult = await useCase.decodeThumbnail({
      mediaKeyId: 'test',
      fileId: 'test-id',
      inlineThumbnail: badWire,
    });
    expect(badResult).toBeNull();

    // Wire with version 0x01 is accepted and sliced by length prefix
    const goodWire = new Uint8Array(32_797);
    goodWire[0] = 0x01;
    const goodResult = await useCase.decodeThumbnail({
      mediaKeyId: 'test',
      fileId: 'test-id',
      inlineThumbnail: goodWire,
    });
    expect(goodResult).not.toBeNull();
    expect(goodResult!.length).toBe(5);
    expect(Array.from(goodResult!)).toEqual([1, 2, 3, 4, 5]);
  });
});
