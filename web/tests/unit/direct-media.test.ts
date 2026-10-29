import { describe, it, expect, vi } from 'vitest';
import { UploadMediaUseCase } from '../../src/usecase/media/UploadMediaUseCase';
import { DownloadMediaUseCase } from '../../src/usecase/media/DownloadMediaUseCase';
import { InMemoryMediaChunkCache } from '../../src/usecase/media/MediaChunkCache';
import type { MediaRestClient, MediaRepository, MediaCryptoPort, MediaDownloadStore, MediaUploadObserver } from '../../src/domain/ports/media';

describe('Worker-Free Direct Media Pipeline Tests (Phase 3 & Safeguard 1)', () => {
  it('UploadMediaUseCase with direct: true uploads unpadded chunks, computes SHA-256 hashes, and returns direct-v1 metadata', async () => {
    const fileBytes = new Uint8Array(1024 * 50); // 50KB test file
    fileBytes.fill(0x33);
    const testFile = new File([fileBytes], 'test-image.png', { type: 'image/png' });

    let initFileId = '';
    let initTotalChunks = 0;
    let initTokenHash = '';
    const uploadedChunks: { fileId: string; chunkIndex: number; bodyLength: number; chunkHash: string }[] = [];
    let finalizedFileId = '';
    let finalizedManifestHash = '';

    const mockRestClient: MediaRestClient = {
      async initUpload(fileId, totalChunks, tokenHash) {
        initFileId = fileId;
        initTotalChunks = totalChunks;
        initTokenHash = tokenHash;
      },
      async uploadChunk(fileId, chunkIndex, data, chunkHash, onProgress) {
        uploadedChunks.push({ fileId, chunkIndex, bodyLength: data.byteLength, chunkHash });
        onProgress?.(data.byteLength, data.byteLength);
      },
      async finalizeUpload(fileId, manifestHash) {
        finalizedFileId = fileId;
        finalizedManifestHash = manifestHash;
      },
      async downloadChunk() {
        throw new Error('Not used in upload');
      },
    };

    const mockRepo: MediaRepository = {
      async getUploadState() { return null; },
      async upsertUploadState() {},
      async deleteUploadState() {},
      async listPendingUploads() { return []; },
      async recordChunkUploaded() {},
      async markComplete() {},
      async markFailed() {},
    };

    const chunkCache = new InMemoryMediaChunkCache();

    // Throw if worker crypto is touched
    const mockCryptoPort: MediaCryptoPort = {
      async createMediaKey() { throw new Error('Worker createMediaKey must not be called in direct mode'); },
      async importMediaKey() { throw new Error('Worker importMediaKey must not be called in direct mode'); },
      async sealChunk() { throw new Error('Worker sealChunk must not be called in direct mode'); },
      async openChunk() { throw new Error('Worker openChunk must not be called in direct mode'); },
      async dropMediaKey() {},
      async computeTokenHash() { throw new Error('Worker computeTokenHash must not be called in direct mode'); },
      async computeManifestHash() { throw new Error('Worker computeManifestHash must not be called in direct mode'); },
      async sealThumbnail() { throw new Error('Worker sealThumbnail must not be called in direct mode'); },
      async openThumbnail() { throw new Error('Worker openThumbnail must not be called in direct mode'); },
      async exportMediaKeyForPeer() { throw new Error('Worker exportMediaKeyForPeer must not be called in direct mode'); },
    };

    const uc = new UploadMediaUseCase(mockRestClient, mockRepo, chunkCache, mockCryptoPort);

    const progressReports: number[] = [];
    const observer: MediaUploadObserver = {
      onProgress(p) {
        progressReports.push(p.bytesUploaded);
      },
      onComplete() {},
      onError() {},
    };

    const metadata = await uc.execute({
      file: testFile,
      fileName: 'test-image.png',
      direct: true,
      previewDataUrl: 'data:image/jpeg;base64,mockpreview',
      observer,
    });

    expect(initFileId).toBeTruthy();
    expect(initTotalChunks).toBe(1);
    expect(initTokenHash).toBeTruthy();
    expect(uploadedChunks.length).toBe(1);
    expect(uploadedChunks[0].bodyLength).toBe(50 * 1024);
    expect(finalizedFileId).toBe(initFileId);
    expect(finalizedManifestHash).toBeTruthy();

    expect(metadata.file_id).toBe(initFileId);
    expect(metadata.media_token).toBe('direct-v1');
    expect(metadata.media_key).toBe('direct-v1');
    expect(metadata.file_iv_prefix).toBe('direct-v1');
    expect(metadata.preview_data_url).toBe('data:image/jpeg;base64,mockpreview');
    expect(metadata.file_name).toBe('test-image.png');
    expect(progressReports.length).toBeGreaterThan(0);
  });

  it('DownloadMediaUseCase with media_token direct-v1 bypasses worker crypto and assembles Blob directly', async () => {
    const originalBytes = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const mockRestClient: MediaRestClient = {
      async initUpload() {},
      async uploadChunk() {},
      async finalizeUpload() {},
      async downloadChunk(fileId, chunkIndex, mediaToken, onProgress) {
        expect(fileId).toBe('file-direct-999');
        expect(mediaToken).toBe('direct-v1');
        onProgress?.(originalBytes.byteLength, originalBytes.byteLength);
        return originalBytes;
      },
    };

    const registeredBlobs = new Map<string, Blob>();
    const mockDownloadStore: MediaDownloadStore = {
      register(fileId, blob) {
        registeredBlobs.set(fileId, blob);
        return `blob:http://localhost/${fileId}`;
      },
      revoke() {},
      has() { return false; },
      get() { return null; },
    };

    const mockCryptoPort: MediaCryptoPort = {
      async createMediaKey() { throw new Error('Worker must not be called'); },
      async importMediaKey() { throw new Error('Worker must not be called'); },
      async sealChunk() { throw new Error('Worker must not be called'); },
      async openChunk() { throw new Error('Worker must not be called'); },
      async dropMediaKey() {},
      async computeTokenHash() { throw new Error('Worker must not be called'); },
      async computeManifestHash() { throw new Error('Worker must not be called'); },
      async sealThumbnail() { throw new Error('Worker must not be called'); },
      async openThumbnail() { throw new Error('Worker must not be called'); },
      async exportMediaKeyForPeer() { throw new Error('Worker must not be called'); },
    };

    const downloadUC = new DownloadMediaUseCase(mockRestClient, mockCryptoPort, mockDownloadStore);

    const result = await downloadUC.execute({
      metadata: {
        file_id: 'file-direct-999',
        media_token: 'direct-v1',
        media_key: 'direct-v1',
        file_iv_prefix: 'direct-v1',
        original_size: 6,
        total_chunks: 1,
        file_manifest_hash: 'mockhash',
        mime_type: 'image/png',
        inline_thumbnail: null,
      },
    });

    expect(result.fileId).toBe('file-direct-999');
    expect(result.blobUrl).toBe('blob:http://localhost/file-direct-999');
    expect(result.originalSize).toBe(6);
    expect(result.mimeType).toBe('image/png');
    expect(registeredBlobs.get('file-direct-999')).toBeDefined();
  });
});
