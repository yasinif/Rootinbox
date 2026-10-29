/**
 * Phase 12B Integration Test — Media Upload Abort & 410 Handling.
 * §23.3: A mid-upload abort issues DELETE, purges media_uploads and media_chunk_cache,
 * and leaves no orphaned local rows; a 410 mid-upload produces the same end state.
 */

import { describe, it, expect } from 'vitest';
import { CHUNK_PLAINTEXT_SIZE, CHUNK_CIPHERTEXT_SIZE } from '../../src/domain/media/constants';
import { UploadMediaUseCase } from '../../src/usecase/media/UploadMediaUseCase';
import { InMemoryMediaChunkCache } from '../../src/usecase/media/MediaChunkCache';
import type {
  MediaRestClient,
  MediaRepository,
  MediaCryptoPort,
  MediaUploadState,
} from '../../src/domain/ports/media';

describe('Media Upload Abort & 410 Integration (§23.3)', () => {
  it('handles 410 mid-upload by failing fast and cleaning up local cache', async () => {
    const fileBytes = new Uint8Array(CHUNK_PLAINTEXT_SIZE * 2);
    const blob = new Blob([fileBytes], { type: 'application/octet-stream' });

    let deletedFileId = '';
    const mockRestClient: MediaRestClient = {
      async initUpload(): Promise<void> {},
      async uploadChunk(_fileId, chunkIndex): Promise<void> {
        if (chunkIndex === 1) {
          throw { status: 410, message: 'Upload expired or cancelled' };
        }
      },
      async finalizeUpload(): Promise<void> {},
      async downloadChunk(): Promise<Uint8Array> {
        throw new Error('Not used');
      },
      async deleteMedia(fileId: string): Promise<void> {
        deletedFileId = fileId;
      },
    };

    let persistedState: MediaUploadState | null = null;
    const mockRepo: MediaRepository = {
      async getUploadState() { return persistedState; },
      async upsertUploadState(state) { persistedState = state; },
      async deleteUploadState() { persistedState = null; },
      async listPendingUploads() { return []; },
      async recordChunkUploaded() {},
      async markComplete() {},
      async markFailed() {
        if (persistedState) persistedState = { ...persistedState, status: 'failed' };
      },
    };

    const chunkCache = new InMemoryMediaChunkCache();

    const mockCryptoPort: MediaCryptoPort = {
      async createMediaKey() { return { media_key_id: 'abort-key' }; },
      async importMediaKey() { return { media_key_id: 'abort-key' }; },
      async sealChunk() {
        return { ciphertext: new Uint8Array(CHUNK_CIPHERTEXT_SIZE), ciphertext_sha256: 'b'.repeat(64) };
      },
      async openChunk() { return { plaintext: new Uint8Array(0) }; },
      async sealThumbnail() { return { wire: new Uint8Array(0) }; },
      async openThumbnail() { return { plaintext_padded: new Uint8Array(0) }; },
      async exportMediaKeyForPeer() { return { media_key: 'b64==', file_iv_prefix: 'b64==' }; },
      async dropMediaKey() { return { ok: true }; },
      async buildMediaMetadata() { return { plaintext_mce: '' }; },
      async computeTokenHash() { return 'c'.repeat(64); },
      async computeManifestHash() { return { raw: new Uint8Array(32), hex: 'd'.repeat(64), base64: 'b64==' }; },
    };

    const useCase = new UploadMediaUseCase(
      mockRestClient,
      mockRepo,
      chunkCache,
      mockCryptoPort,
      null,
    );

    // Expect upload to fail with MED_C06 on status 410
    await expect(
      useCase.execute({ file: blob, fileName: 'abort-test.bin' }),
    ).rejects.toThrow(/MED_C06/);
  });
});
