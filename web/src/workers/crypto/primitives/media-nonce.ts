/**
 * Media Chunk Nonce.
 * Phase 12B §8.8: 12-byte nonce = file_iv_prefix(4) || chunk_index(8, BE).
 * chunk_index is a uint64 to match the IV layout shared with call IVs.
 */

/**
 * Build a 12-byte nonce for a media chunk.
 */
export function buildChunkNonce(
  fileIVPrefix: Uint8Array,  // 4 bytes
  chunkIndex: number,
): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(fileIVPrefix, 0);
  const view = new DataView(nonce.buffer, nonce.byteOffset + 4, 8);
  view.setBigUint64(0, BigInt(chunkIndex), false);
  return nonce;
}
