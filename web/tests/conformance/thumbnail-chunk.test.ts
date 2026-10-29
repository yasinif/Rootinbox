/**
 * Phase 12B Conformance Tests — Thumbnail Wire Format.
 */

import { describe, it, expect } from 'vitest';
import vectors from '../../src/__vectors__/crypto-vectors-v2.json';
import {
  padThumbnailPlaintext, unpadThumbnailPlaintext, buildThumbnailAAD,
} from '../../src/workers/crypto/primitives/media-thumbnail-wire';
import { aesGcmEncrypt, aesGcmDecrypt } from '../../src/workers/crypto/aes';
import { buildChunkAAD } from '../../src/workers/crypto/primitives/media-aad';
import { buildChunkNonce } from '../../src/workers/crypto/primitives/media-nonce';
import { hexEncode, hexDecode } from '../../src/workers/crypto/encoding';
import {
  THUMBNAIL_PADDED_SIZE, THUMBNAIL_MAX_IMAGE_SIZE, THUMBNAIL_AAD_LENGTH,
} from '../../src/domain/media/constants';

const v = vectors.vectors;

describe('M-06: thumbnail_aad', () => {
  const vec = v.thumbnail_aad;

  it('builds 17-byte thumbnail AAD matching vector', () => {
    const fileId = hexDecode(vec.file_id_hex);
    const aad = buildThumbnailAAD(fileId);
    expect(aad.length).toBe(THUMBNAIL_AAD_LENGTH);
    expect(hexEncode(aad)).toBe(vec.aad_hex);
  });
});

describe('M-07: thumbnail_plain', () => {
  const vec = v.thumbnail_plain;

  it('pads image to exactly 32,768 bytes matching vector', () => {
    const image = hexDecode(vec.image_hex);
    const padded = padThumbnailPlaintext(image);
    expect(padded.length).toBe(THUMBNAIL_PADDED_SIZE);
    expect(hexEncode(padded)).toBe(vec.padded_hex);
  });

  it('round-trips: unpad(pad(image)) === image', () => {
    const image = hexDecode(vec.image_hex);
    const padded = padThumbnailPlaintext(image);
    const unpadded = unpadThumbnailPlaintext(padded);
    expect(hexEncode(unpadded)).toBe(vec.image_hex);
    expect(unpadded.length).toBe(vec.image_length);
  });

  it('rejects image exceeding max size', () => {
    const tooBig = new Uint8Array(THUMBNAIL_MAX_IMAGE_SIZE + 1);
    expect(() => padThumbnailPlaintext(tooBig)).toThrow();
  });

  it('accepts image at exact max size', () => {
    const maxImage = new Uint8Array(THUMBNAIL_MAX_IMAGE_SIZE);
    const padded = padThumbnailPlaintext(maxImage);
    expect(padded.length).toBe(THUMBNAIL_PADDED_SIZE);
  });
});

describe('M-08: chunk_sealed', () => {
  const vec = v.chunk_sealed;

  it('seals a chunk matching the vector ciphertext', async () => {
    const key = hexDecode(vec.media_key_hex);
    const nonce = hexDecode(vec.nonce_hex);
    const aad = hexDecode(vec.aad_hex);
    const plaintext = hexDecode(vec.plaintext_hex);

    const sealed = await aesGcmEncrypt(key, nonce, plaintext, aad);
    expect(hexEncode(sealed)).toBe(vec.ciphertext_hex);
  });

  it('round-trips: decrypt(encrypt(plain)) === plain', async () => {
    const key = hexDecode(vec.media_key_hex);
    const nonce = hexDecode(vec.nonce_hex);
    const aad = hexDecode(vec.aad_hex);
    const plaintext = hexDecode(vec.plaintext_hex);

    const sealed = await aesGcmEncrypt(key, nonce, plaintext, aad);
    const opened = await aesGcmDecrypt(key, nonce, sealed, aad);
    expect(hexEncode(opened)).toBe(vec.plaintext_hex);
  });
});
