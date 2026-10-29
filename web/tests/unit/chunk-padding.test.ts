/**
 * Phase 12B Unit Test — Chunk Padding.
 * §23.2: Zero-byte padding; exact-multiple no-extra-chunk rule; original_size truncation authority.
 */

import { describe, it, expect } from 'vitest';
import {
  CHUNK_PLAINTEXT_SIZE,
} from '../../src/domain/media/constants';
import {
  computeChunkCount,
  padChunkPlaintext,
  unpadChunkPlaintext,
} from '../../src/domain/media/padding';

describe('Chunk Padding Unit Tests (§23.2, M-12)', () => {
  it('pads chunk shorter than 5,242,880 to exactly 5,242,880 with trailing zeros', () => {
    const raw = new Uint8Array([1, 2, 3, 4, 5]);
    const padded = padChunkPlaintext(raw);

    expect(padded.length).toBe(CHUNK_PLAINTEXT_SIZE);
    expect(padded[0]).toBe(1);
    expect(padded[4]).toBe(5);
    expect(padded[5]).toBe(0);
    expect(padded[CHUNK_PLAINTEXT_SIZE - 1]).toBe(0);
  });

  it('exact 5,242,880 bytes is returned as-is without extra padding', () => {
    const raw = new Uint8Array(CHUNK_PLAINTEXT_SIZE);
    raw.fill(0xaa);
    const padded = padChunkPlaintext(raw);

    expect(padded.length).toBe(CHUNK_PLAINTEXT_SIZE);
    expect(padded).toBe(raw); // Same reference when already exact
  });

  it('throws error if chunk exceeds 5,242,880 bytes', () => {
    const raw = new Uint8Array(CHUNK_PLAINTEXT_SIZE + 1);
    expect(() => padChunkPlaintext(raw)).toThrow();
  });

  it('unpads the final chunk correctly using original_size truncation authority', () => {
    const originalSize = CHUNK_PLAINTEXT_SIZE + 5; // 2 chunks, last chunk has 5 bytes
    const totalChunks = computeChunkCount(originalSize);
    expect(totalChunks).toBe(2);

    const chunk1Padded = padChunkPlaintext(new Uint8Array([10, 20, 30, 40, 50]));
    const unpadded = unpadChunkPlaintext(chunk1Padded, 1, totalChunks, originalSize);

    expect(unpadded.length).toBe(5);
    expect(Array.from(unpadded)).toEqual([10, 20, 30, 40, 50]);
  });

  it('non-final chunk unpads to full 5,242,880 bytes regardless of zero bytes inside data', () => {
    const originalSize = CHUNK_PLAINTEXT_SIZE * 2;
    const chunk0 = new Uint8Array(CHUNK_PLAINTEXT_SIZE);
    chunk0[100] = 0; // legitimate zero in payload
    chunk0[500] = 42;

    const unpadded = unpadChunkPlaintext(chunk0, 0, 2, originalSize);
    expect(unpadded.length).toBe(CHUNK_PLAINTEXT_SIZE);
    expect(unpadded[500]).toBe(42);
  });
});
