/**
 * Media Chunk Cache.
 * Phase 12B Task 13 (§16.1, §16.2).
 */

import type { MediaChunkCache } from '../../domain/ports/media';

export type { MediaChunkCache };

/**
 * In-memory implementation of MediaChunkCache for memory-constrained or test environments.
 */
export class InMemoryMediaChunkCache implements MediaChunkCache {
  private chunks = new Map<string, { data: Uint8Array; hash?: string }>();

  async putChunk(
    fileId: string,
    chunkIndex: number,
    data: Uint8Array,
    chunkHash?: string,
  ): Promise<void> {
    this.chunks.set(`${fileId}_${chunkIndex}`, { data, hash: chunkHash });
  }

  async getChunk(fileId: string, chunkIndex: number): Promise<Uint8Array | null> {
    const entry = this.chunks.get(`${fileId}_${chunkIndex}`);
    return entry ? entry.data : null;
  }

  async getChunkHash(fileId: string, chunkIndex: number): Promise<string | null> {
    const entry = this.chunks.get(`${fileId}_${chunkIndex}`);
    return entry?.hash ?? null;
  }

  async deleteFile(fileId: string): Promise<void> {
    const prefix = `${fileId}_`;
    for (const key of this.chunks.keys()) {
      if (key.startsWith(prefix)) {
        this.chunks.delete(key);
      }
    }
  }
}
