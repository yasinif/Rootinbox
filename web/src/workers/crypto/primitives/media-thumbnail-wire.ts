/**
 * Thumbnail Wire Format.
 * Phase 12B §8.10 + ADR-P12B-35: Padded thumbnail plaintext and wire encoding.
 *
 * Plaintext layout (exactly 32,768 bytes):
 *   [4-byte BE image length][image bytes][zero padding]
 *
 * Maximum image payload: 32,764 bytes.
 *
 * Wire format (32,797 bytes):
 *   version(1) || IV(12) || AES-GCM(plaintext, AAD)
 *
 * Thumbnail AAD (17 bytes): version(1) || file_id(16).
 */

import {
  THUMBNAIL_PADDED_SIZE,
  THUMBNAIL_MAX_IMAGE_SIZE,
  THUMBNAIL_AAD_LENGTH,
  MEDIA_CRYPTO_SUITE_V1,
} from '../../../domain/media/constants';
import { aesGcmEncrypt, aesGcmDecrypt } from '../aes';

/**
 * Build the 17-byte thumbnail AAD.
 */
export function buildThumbnailAAD(fileId: Uint8Array): Uint8Array {
  const aad = new Uint8Array(THUMBNAIL_AAD_LENGTH);
  aad[0] = MEDIA_CRYPTO_SUITE_V1;
  aad.set(fileId, 1);
  return aad;
}

/**
 * Pad an image into the 32,768-byte thumbnail plaintext layout.
 * Throws if image exceeds 32,764 bytes.
 */
export function padThumbnailPlaintext(image: Uint8Array): Uint8Array {
  if (image.length > THUMBNAIL_MAX_IMAGE_SIZE) {
    throw new Error(`Thumbnail image too large: ${image.length} > ${THUMBNAIL_MAX_IMAGE_SIZE}`);
  }
  const padded = new Uint8Array(THUMBNAIL_PADDED_SIZE);
  const view = new DataView(padded.buffer);
  view.setUint32(0, image.length, false);
  padded.set(image, 4);
  // Remaining bytes are already zero.
  return padded;
}

/**
 * Unpad a 32,768-byte thumbnail plaintext to extract the image.
 * Throws if the length prefix is invalid or exceeds the maximum.
 */
export function unpadThumbnailPlaintext(padded: Uint8Array): Uint8Array {
  if (padded.length !== THUMBNAIL_PADDED_SIZE) {
    throw new Error(`Invalid padded thumbnail length: ${padded.length}`);
  }
  const view = new DataView(padded.buffer, padded.byteOffset);
  const imageLen = view.getUint32(0, false);
  if (imageLen > THUMBNAIL_MAX_IMAGE_SIZE) {
    throw new Error(`Thumbnail image length exceeds maximum: ${imageLen}`);
  }
  return padded.slice(4, 4 + imageLen);
}

/**
 * Seal a thumbnail into the 32,797-byte wire format.
 * @param mediaKey 32-byte media key
 * @param iv 12-byte IV
 * @param image Raw image bytes (≤ 32,764)
 * @param fileId 16-byte file ID
 * @returns Wire bytes: version(1) || IV(12) || ciphertext(32784)
 */
export async function sealThumbnail(
  mediaKey: Uint8Array,
  iv: Uint8Array,
  image: Uint8Array,
  fileId: Uint8Array,
): Promise<Uint8Array> {
  const padded = padThumbnailPlaintext(image);
  const aad = buildThumbnailAAD(fileId);
  const ciphertext = await aesGcmEncrypt(mediaKey, iv, padded, aad);

  // Wire: version || IV || ciphertext
  const wire = new Uint8Array(1 + 12 + ciphertext.length);
  wire[0] = MEDIA_CRYPTO_SUITE_V1;
  wire.set(iv, 1);
  wire.set(ciphertext, 13);
  return wire;
}

/**
 * Open a thumbnail from the wire format.
 * @param mediaKey 32-byte media key
 * @param wire 32,797-byte wire data
 * @param fileId 16-byte file ID
 * @returns Raw image bytes
 */
export async function openThumbnail(
  mediaKey: Uint8Array,
  wire: Uint8Array,
  fileId: Uint8Array,
): Promise<Uint8Array> {
  if (wire[0] !== MEDIA_CRYPTO_SUITE_V1) {
    throw new Error(`Unsupported thumbnail version: ${wire[0]}`);
  }
  const iv = wire.slice(1, 13);
  const ciphertext = wire.slice(13);
  const aad = buildThumbnailAAD(fileId);
  const padded = await aesGcmDecrypt(mediaKey, iv, ciphertext, aad);
  return unpadThumbnailPlaintext(padded);
}
