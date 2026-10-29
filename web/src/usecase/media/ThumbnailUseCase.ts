/**
 * ThumbnailUseCase — consumption and validation of media thumbnails.
 * Phase 12B §17.7, ADR-P12B-35, ADR-P12B-39, Rows M-17..M-22.
 *
 * Rules:
 * - Decode 32,797-byte wire
 * - Reject version byte other than 0x01 BEFORE decrypting (Row M-22)
 * - Decrypt via openThumbnail primitive
 * - Read 4-byte big-endian length prefix (ADR-P12B-35)
 * - Assert 1 <= length <= 32,764 (Row M-18)
 * - Slice exactly that many bytes (never scan for zeros)
 */

import {
  THUMBNAIL_WIRE_SIZE,
  THUMBNAIL_MAX_IMAGE_SIZE,
  MEDIA_CRYPTO_SUITE_V1,
} from '../../domain/media/constants';
import { MED_C07 } from '../../domain/errors';
import type { MediaCryptoPort } from '../../domain/ports/media';

function decodeBase64Std(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export class ThumbnailUseCase {
  private cryptoPort: MediaCryptoPort;

  constructor(cryptoPort: MediaCryptoPort) {
    this.cryptoPort = cryptoPort;
  }

  /**
   * Decode, verify, decrypt, and extract true image bytes from a thumbnail wire.
   *
   * @param params.mediaKeyId Active media_key_id in crypto worker
   * @param params.fileId Canonical UUID string of the media file
   * @param params.inlineThumbnail Base64 standard padded 32,797-byte wire or Uint8Array
   * @returns Raw image bytes (WebP/JPEG/PNG) or null if invalid/unavailable
   */
  async decodeThumbnail(params: {
    mediaKeyId: string;
    fileId: string;
    inlineThumbnail: string | Uint8Array | null;
  }): Promise<Uint8Array | null> {
    const { mediaKeyId, fileId, inlineThumbnail } = params;
    if (!inlineThumbnail) return null;

    const wire = typeof inlineThumbnail === 'string'
      ? decodeBase64Std(inlineThumbnail)
      : inlineThumbnail;

    // Row M-19: Must be exactly 32,797 bytes
    if (wire.length !== THUMBNAIL_WIRE_SIZE) {
      return null;
    }

    // Row M-22: Version byte MUST be 0x01; reject without decrypt attempt if other
    if (wire[0] !== MEDIA_CRYPTO_SUITE_V1) {
      return null;
    }

    try {
      const result = await this.cryptoPort.openThumbnail({
        media_key_id: mediaKeyId,
        file_id_bytes: fileId,
        wire,
      });

      if (result.image && result.image.length > 0) {
        if (result.image.length > THUMBNAIL_MAX_IMAGE_SIZE) {
          throw new Error(`${MED_C07}: Thumbnail image exceeds max size`);
        }
        return result.image;
      }

      const padded = result.plaintext_padded;
      if (!padded || padded.length < 4) {
        return null;
      }

      // ADR-P12B-35: Read 4-byte BE length prefix
      const view = new DataView(padded.buffer, padded.byteOffset, 4);
      const imageLength = view.getUint32(0, false);

      // Row M-18: 1 <= length <= 32,764
      if (imageLength < 1 || imageLength > THUMBNAIL_MAX_IMAGE_SIZE) {
        throw new Error(`${MED_C07}: Invalid thumbnail image length ${imageLength}`);
      }

      if (padded.length < 4 + imageLength) {
        return null;
      }

      return padded.subarray(4, 4 + imageLength);
    } catch {
      return null;
    }
  }
}
