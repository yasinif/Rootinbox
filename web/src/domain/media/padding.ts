/**
 * Media Chunk Padding & Count calculations.
 * Phase 12B §8.12 + M-11, M-12.
 * Pure domain functions, zero external dependencies.
 */

import { CHUNK_PLAINTEXT_SIZE, MAX_TOTAL_CHUNKS } from './constants';

/**
 * Compute the number of chunks required for a file.
 *
 * Rules:
 * - Empty file → 1 chunk (zero-padded)
 * - Exact multiple of CHUNK_PLAINTEXT_SIZE → no extra chunk
 * - Over MAX_TOTAL_CHUNKS × CHUNK_PLAINTEXT_SIZE → rejected (throws)
 *
 * @param originalSize File size in bytes
 * @returns Number of chunks (1 to MAX_TOTAL_CHUNKS)
 */
export function computeChunkCount(originalSize: number): number {
  if (originalSize < 0) throw new Error('File size cannot be negative');
  if (originalSize === 0) return 1;

  const chunks = Math.ceil(originalSize / CHUNK_PLAINTEXT_SIZE);
  if (chunks > MAX_TOTAL_CHUNKS) {
    throw new Error(`File requires ${chunks} chunks, exceeds maximum ${MAX_TOTAL_CHUNKS}`);
  }
  return chunks;
}

/**
 * Pad a chunk plaintext to exactly CHUNK_PLAINTEXT_SIZE bytes.
 * The last chunk may be shorter; pad with zeros.
 */
export function padChunkPlaintext(data: Uint8Array): Uint8Array {
  if (data.length === CHUNK_PLAINTEXT_SIZE) return data;
  if (data.length > CHUNK_PLAINTEXT_SIZE) {
    throw new Error(`Chunk data too large: ${data.length} > ${CHUNK_PLAINTEXT_SIZE}`);
  }
  const padded = new Uint8Array(CHUNK_PLAINTEXT_SIZE);
  padded.set(data, 0);
  return padded;
}

/**
 * Unpad a chunk plaintext — removes trailing zeros based on known original size
 * and chunk index.
 */
export function unpadChunkPlaintext(
  padded: Uint8Array,
  chunkIndex: number,
  totalChunks: number,
  originalSize: number,
): Uint8Array {
  if (chunkIndex < totalChunks - 1) {
    if (padded.length <= CHUNK_PLAINTEXT_SIZE) return padded;
    return padded.slice(0, CHUNK_PLAINTEXT_SIZE);
  }
  const lastChunkSize = originalSize - chunkIndex * CHUNK_PLAINTEXT_SIZE;
  if (lastChunkSize <= 0 || lastChunkSize > CHUNK_PLAINTEXT_SIZE) {
    return originalSize === 0 ? new Uint8Array(0) : padded;
  }
  if (padded.length === lastChunkSize) {
    return padded;
  }
  return padded.slice(0, lastChunkSize);
}
