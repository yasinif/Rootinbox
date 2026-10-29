/**
 * Media Chunk AAD.
 * Phase 12B §8.7: 25-byte AAD for media chunk encryption.
 * Layout: version(1) || file_id(16) || chunk_index(4, BE) || total_chunks(4, BE) = 25 bytes.
 */

import { CHUNK_AAD_LENGTH, MEDIA_CRYPTO_SUITE_V1 } from '../../../domain/media/constants';

/**
 * Build a 25-byte AAD for a media chunk.
 */
export function buildChunkAAD(
  fileId: Uint8Array,    // 16 bytes
  chunkIndex: number,
  totalChunks: number,
): Uint8Array {
  const aad = new Uint8Array(CHUNK_AAD_LENGTH);
  aad[0] = MEDIA_CRYPTO_SUITE_V1;
  aad.set(fileId, 1);
  const view = new DataView(aad.buffer, aad.byteOffset);
  view.setUint32(17, chunkIndex, false);
  view.setUint32(21, totalChunks, false);
  return aad;
}
