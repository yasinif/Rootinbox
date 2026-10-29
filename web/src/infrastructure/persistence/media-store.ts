/**
 * Media persistence — Dexie v2 implementation.
 * Phase 12B Task 13 (§16.2, §16.7, ADR-P12B-37).
 *
 * Enforces ADR-P12B-37:
 * Neither media_uploads nor media_chunk_cache may contain:
 * - media_key
 * - media_token
 * - file_name
 * - mime_type
 * - original_size
 * - thumbnail bytes
 */

import { getDB, type MediaUploadRow, type MediaChunkCacheRow } from './index';
import type { MediaRepository, MediaChunkCache } from '../../domain/ports/media';
import type { MediaUploadState } from '../../domain/media';

export class DexieMediaRepository implements MediaRepository {
  async getUploadState(fileId: string): Promise<MediaUploadState | null> {
    const db = getDB();
    const row = await db.media_uploads.get(fileId);
    if (!row) return null;

    const statusMap: Record<string, MediaUploadState['status']> = {
      INITIALIZED: 'initializing',
      UPLOADING: 'uploading',
      FINALIZING: 'finalizing',
      COMPLETE: 'complete',
      FAILED: 'failed',
    };

    return {
      fileId: row.file_id,
      conversationId: '',
      fileName: '',
      mimeType: '',
      originalSize: 0,
      totalChunks: row.total_chunks,
      uploadedChunks: row.uploaded_indices.length,
      status: statusMap[row.state] || 'uploading',
      error: row.state === 'FAILED' ? 'Upload failed' : null,
      createdAt: row.created_at,
      updatedAt: row.created_at,
    };
  }

  async upsertUploadState(state: MediaUploadState): Promise<void> {
    const db = getDB();
    const stateEnumMap: Record<string, MediaUploadRow['state']> = {
      queued: 'INITIALIZED',
      initializing: 'INITIALIZED',
      uploading: 'UPLOADING',
      finalizing: 'FINALIZING',
      complete: 'COMPLETE',
      failed: 'FAILED',
    };

    const row: MediaUploadRow = {
      file_id: state.fileId,
      state: stateEnumMap[state.status] || 'UPLOADING',
      total_chunks: state.totalChunks,
      uploaded_indices: Array.from({ length: state.uploadedChunks }, (_, i) => i),
      client_uuid: '',
      created_at: state.createdAt || Date.now(),
    };

    await db.media_uploads.put(row);
  }

  async deleteUploadState(fileId: string): Promise<void> {
    const db = getDB();
    await db.media_uploads.delete(fileId);
  }

  async listPendingUploads(): Promise<MediaUploadState[]> {
    const db = getDB();
    const rows = await db.media_uploads
      .filter((r) => r.state !== 'COMPLETE' && r.state !== 'FAILED')
      .toArray();

    return rows.map((row) => ({
      fileId: row.file_id,
      conversationId: '',
      fileName: '',
      mimeType: '',
      originalSize: 0,
      totalChunks: row.total_chunks,
      uploadedChunks: row.uploaded_indices.length,
      status: 'uploading',
      error: null,
      createdAt: row.created_at,
      updatedAt: row.created_at,
    }));
  }

  async recordChunkUploaded(fileId: string, chunkIndex: number): Promise<void> {
    const db = getDB();
    await db.transaction('rw', db.media_uploads, async () => {
      const row = await db.media_uploads.get(fileId);
      if (row) {
        if (!row.uploaded_indices.includes(chunkIndex)) {
          row.uploaded_indices.push(chunkIndex);
          row.state = 'UPLOADING';
          await db.media_uploads.put(row);
        }
      }
    });
  }

  async markComplete(fileId: string): Promise<void> {
    const db = getDB();
    const row = await db.media_uploads.get(fileId);
    if (row) {
      row.state = 'COMPLETE';
      await db.media_uploads.put(row);
    }
  }

  async markFailed(fileId: string): Promise<void> {
    const db = getDB();
    const row = await db.media_uploads.get(fileId);
    if (row) {
      row.state = 'FAILED';
      await db.media_uploads.put(row);
    }
  }

  /**
   * Boot reconciliation (§16.7, ADR-P12B-36).
   * Every incomplete upload transitions to FAILED and chunk cache is purged.
   */
  async reconcileBoot(): Promise<void> {
    const db = getDB();
    await db.transaction('rw', db.media_uploads, db.media_chunk_cache, async () => {
      const nonComplete = await db.media_uploads
        .filter((r) => r.state !== 'COMPLETE')
        .toArray();

      for (const row of nonComplete) {
        row.state = 'FAILED';
        await db.media_uploads.put(row);
        await db.media_chunk_cache.where('file_id').equals(row.file_id).delete();
      }
    });
  }
}

export class DexieMediaChunkCache implements MediaChunkCache {
  async putChunk(
    fileId: string,
    chunkIndex: number,
    data: Uint8Array,
    chunkHash = '',
  ): Promise<void> {
    const db = getDB();
    const blob = new Blob([data as unknown as BlobPart], { type: 'application/octet-stream' });
    const row: MediaChunkCacheRow = {
      file_id: fileId,
      chunk_index: chunkIndex,
      ciphertext_blob: blob,
      chunk_hash: chunkHash,
    };
    await db.media_chunk_cache.put(row);
  }

  async getChunk(fileId: string, chunkIndex: number): Promise<Uint8Array | null> {
    const db = getDB();
    const row = await db.media_chunk_cache.get([fileId, chunkIndex]);
    if (!row || !row.ciphertext_blob) return null;
    const buf = await row.ciphertext_blob.arrayBuffer();
    return new Uint8Array(buf);
  }

  async getChunkHash(fileId: string, chunkIndex: number): Promise<string | null> {
    const db = getDB();
    const row = await db.media_chunk_cache.get([fileId, chunkIndex]);
    return row?.chunk_hash ?? null;
  }

  async deleteFile(fileId: string): Promise<void> {
    const db = getDB();
    await db.media_chunk_cache.where('file_id').equals(fileId).delete();
  }
}
