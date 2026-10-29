/**
 * Phase 12B Conformance Tests — Media Chunk AAD, Nonce, Manifest.
 */

import { describe, it, expect } from 'vitest';
import vectors from '../../src/__vectors__/crypto-vectors-v2.json';
import { buildChunkAAD } from '../../src/workers/crypto/primitives/media-aad';
import { buildChunkNonce } from '../../src/workers/crypto/primitives/media-nonce';
import { computeManifestHash } from '../../src/workers/crypto/primitives/media-manifest';
import { computeTokenHash } from '../../src/workers/crypto/primitives/media-token';
import { computeChunkCount } from '../../src/workers/crypto/primitives/media-padding';
import { hexEncode, hexDecode } from '../../src/workers/crypto/encoding';
import { CHUNK_AAD_LENGTH } from '../../src/domain/media/constants';

const v = vectors.vectors;

describe('M-01: chunk_aad', () => {
  const vec = v.chunk_aad;

  it('builds 25-byte AADs matching vectors', () => {
    const fileId = hexDecode(vec.file_id_hex);
    for (const c of vec.cases) {
      const aad = buildChunkAAD(fileId, c.chunk_index, c.total_chunks);
      expect(aad.length).toBe(CHUNK_AAD_LENGTH);
      expect(hexEncode(aad)).toBe(c.aad_hex);
    }
  });
});

describe('M-02: chunk_nonce', () => {
  const vec = v.chunk_nonce;

  it('builds 12-byte nonces matching vectors', () => {
    const prefix = hexDecode(vec.file_iv_prefix_hex);
    for (const c of vec.cases) {
      const nonce = buildChunkNonce(prefix, Number(c.chunk_index));
      expect(nonce.length).toBe(12);
      expect(hexEncode(nonce)).toBe(c.nonce_hex);
    }
  });
});

describe('M-03: manifest', () => {
  const vec = v.manifest;

  it('computes manifest hash matching vector', async () => {
    const chunkHashes = vec.chunk_hashes_hex.map((h: string) => hexDecode(h));
    const hash = await computeManifestHash(chunkHashes);
    expect(hexEncode(hash)).toBe(vec.manifest_hash_hex);
  });

  it('swapped order produces different hash', async () => {
    const chunkHashes = vec.chunk_hashes_hex.map((h: string) => hexDecode(h));
    // Swap first two
    const swapped = [chunkHashes[1], chunkHashes[0], chunkHashes[2]];
    const hash = await computeManifestHash(swapped);
    expect(hexEncode(hash)).toBe(vec.swapped_hash_hex);
    expect(vec.swapped_hash_hex).not.toBe(vec.manifest_hash_hex);
  });
});

describe('M-04: media_token', () => {
  const vec = v.media_token;

  it('computes token_hash as lowercase hex matching vector', async () => {
    const token = hexDecode(vec.token_hex);
    const hash = await computeTokenHash(token);
    expect(hash).toBe(vec.token_hash_hex);
    // Verify it's lowercase hex, not Base64
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('M-05: chunk_padding', () => {
  const vec = v.chunk_padding;

  for (const c of vec.chunk_count_cases) {
    if (c.rejected) {
      it(`rejects file of size ${c.original_size}`, () => {
        expect(() => computeChunkCount(c.original_size)).toThrow();
      });
    } else {
      it(`computes ${c.chunks} chunks for size ${c.original_size}`, () => {
        expect(computeChunkCount(c.original_size)).toBe(c.chunks);
      });
    }
  }
});
