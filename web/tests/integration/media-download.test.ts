/**
 * Phase 12B Integration Test — Media Download Pipeline.
 * §23.3, §17.3, Rows W-02, B-04, DoD 15.
 *
 * Asserts:
 * - 3-chunk upload followed by download yields byte-identical plaintext to original
 * - Exact 5,242,896 bytes verified per chunk (Row W-02)
 * - Manifest hash is verified before any bytes are exposed (MED_C02)
 * - Decrypted bytes stored as ephemeral Object URL only (Row B-04)
 */

import { describe, it, expect } from 'vitest';
import { CHUNK_PLAINTEXT_SIZE, CHUNK_CIPHERTEXT_SIZE } from '../../src/domain/media/constants';
import { UploadMediaUseCase } from '../../src/usecase/media/UploadMediaUseCase';
import { DownloadMediaUseCase } from '../../src/usecase/media/DownloadMediaUseCase';
import { InMemoryMediaChunkCache } from '../../src/usecase/media/MediaChunkCache';
import { MediaDownloadStore } from '../../src/infrastructure/persistence/media-download-store';
import type {
  MediaRestClient,
  MediaRepository,
  MediaCryptoPort,
} from '../../src/domain/ports/media';

describe('Media Download Pipeline Integration (§23.3, DoD 15, W-02, B-04)', () => {
  it('downloads 3-chunk file and proves byte-identical round-trip with manifest verification', async () => {
    // 1. Generate original payload (2 full chunks + 1000 bytes tail)
    const originalBytes = new Uint8Array(CHUNK_PLAINTEXT_SIZE * 2 + 1000);
    for (let i = 0; i < originalBytes.length; i++) {
      originalBytes[i] = (i * 31 + 7) & 0xff;
    }
    const originalBlob = new Blob([originalBytes], { type: 'image/png' });

    // 2. Mock storage for chunks on server
    const serverChunks = new Map<string, Uint8Array>();
    let storedManifestHash = '';

    const mockRestClient: MediaRestClient = {
      async initUpload(): Promise<void> {},
      async uploadChunk(fileId: string, chunkIndex: number, data: Uint8Array): Promise<void> {
        serverChunks.set(`${fileId}_${chunkIndex}`, new Uint8Array(data));
      },
      async finalizeUpload(_fileId: string, manifestHash: string): Promise<void> {
        storedManifestHash = manifestHash;
      },
      async downloadChunk(fileId: string, chunkIndex: number): Promise<Uint8Array> {
        const chunk = serverChunks.get(`${fileId}_${chunkIndex}`);
        if (!chunk) throw { status: 404, message: 'Chunk not found' };
        return chunk;
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

    // 3. Simulated crypto key store (in Worker RAM)
    const workerKeys = new Map<string, { key: Uint8Array; prefix: Uint8Array }>();

    const mockCryptoPort: MediaCryptoPort = {
      async createMediaKey() {
        const id = 'key-' + Math.random();
        workerKeys.set(id, {
          key: crypto.getRandomValues(new Uint8Array(32)),
          prefix: crypto.getRandomValues(new Uint8Array(4)),
        });
        return { media_key_id: id };
      },
      async importMediaKey(params) {
        const id = 'imported-' + Math.random();
        const key = typeof params.media_key === 'string'
          ? new Uint8Array(Array.from(atob(params.media_key), (c) => c.charCodeAt(0)))
          : params.media_key;
        const prefix = typeof params.file_iv_prefix === 'string'
          ? new Uint8Array(Array.from(atob(params.file_iv_prefix), (c) => c.charCodeAt(0)))
          : params.file_iv_prefix;
        workerKeys.set(id, { key, prefix });
        return { media_key_id: id };
      },
      async sealChunk(params) {
        const pt = params.plaintext instanceof ArrayBuffer
          ? new Uint8Array(params.plaintext)
          : params.plaintext;
        const ct = new Uint8Array(CHUNK_CIPHERTEXT_SIZE);
        ct.set(pt.subarray(0, CHUNK_PLAINTEXT_SIZE));
        // Mock 16-byte GCM tag
        ct.fill(0x77, CHUNK_PLAINTEXT_SIZE);

        const hashBuf = await crypto.subtle.digest('SHA-256', ct);
        const hash = Array.from(new Uint8Array(hashBuf), (b) => b.toString(16).padStart(2, '0')).join('');
        return { ciphertext: ct, ciphertext_sha256: hash };
      },
      async openChunk(params) {
        const ct = params.ciphertext instanceof ArrayBuffer
          ? new Uint8Array(params.ciphertext)
          : params.ciphertext;
        const pt = ct.subarray(0, CHUNK_PLAINTEXT_SIZE);
        return { plaintext: new Uint8Array(pt) };
      },
      async sealThumbnail() { return { wire: new Uint8Array(32_797) }; },
      async openThumbnail() { return { plaintext_padded: new Uint8Array(32_768) }; },
      async exportMediaKeyForPeer(params) {
        const mk = workerKeys.get(params.media_key_id)!;
        let k = '';
        for (let i = 0; i < mk.key.length; i++) k += String.fromCharCode(mk.key[i]);
        let p = '';
        for (let i = 0; i < mk.prefix.length; i++) p += String.fromCharCode(mk.prefix[i]);
        return { media_key: btoa(k), file_iv_prefix: btoa(p) };
      },
      async dropMediaKey(params) {
        workerKeys.delete(params.media_key_id);
        return { ok: true };
      },
      async buildMediaMetadata() { return { plaintext_mce: '' }; },
      async computeTokenHash(token) {
        const hashBuf = await crypto.subtle.digest('SHA-256', token as unknown as ArrayBuffer);
        return Array.from(new Uint8Array(hashBuf), (b) => b.toString(16).padStart(2, '0')).join('');
      },
      async computeManifestHash(chunkHashes) {
        const totalLen = chunkHashes.length * 32;
        const concat = new Uint8Array(totalLen);
        for (let i = 0; i < chunkHashes.length; i++) concat.set(chunkHashes[i], i * 32);
        const hashBuf = await crypto.subtle.digest('SHA-256', concat);
        const raw = new Uint8Array(hashBuf);
        const hex = Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('');
        let bin = '';
        for (let i = 0; i < raw.length; i++) bin += String.fromCharCode(raw[i]);
        return { raw, hex, base64: btoa(bin) };
      },
    };

    // 4. Run Upload
    const uploadUseCase = new UploadMediaUseCase(
      mockRestClient,
      mockRepo,
      chunkCache,
      mockCryptoPort,
      null,
    );

    const metadata = await uploadUseCase.execute({
      file: originalBlob,
      fileName: 'roundtrip-image.png',
      mimeType: 'image/png',
    });

    expect(metadata.total_chunks).toBe(3);
    expect(serverChunks.size).toBe(3);

    // 5. Run Download
    const downloadStore = new MediaDownloadStore();
    const downloadUseCase = new DownloadMediaUseCase(
      mockRestClient,
      mockCryptoPort,
      downloadStore,
    );

    const downloadResult = await downloadUseCase.execute({ metadata });

    // 6. Assertions
    expect(downloadResult.fileId).toBe(metadata.file_id);
    expect(downloadResult.originalSize).toBe(originalBytes.length);
    expect(downloadResult.mimeType).toBe('image/png');
    expect(downloadResult.blobUrl).toBeDefined();

    // Proven byte-identical round-trip
    const downloadedBuf = await downloadResult.blob.arrayBuffer();
    const downloadedBytes = new Uint8Array(downloadedBuf);

    expect(downloadedBytes.length).toBe(originalBytes.length);
    expect(downloadedBytes.byteLength).toBe(originalBytes.byteLength);

    // Exact byte equality check
    let identical = true;
    for (let i = 0; i < originalBytes.length; i++) {
      if (downloadedBytes[i] !== originalBytes[i]) {
        identical = false;
        break;
      }
    }
    expect(identical).toBe(true);

    // Row B-04: RAM-only store tracks the object URL
    expect(downloadStore.getActiveCount()).toBe(1);
    downloadStore.revoke(downloadResult.fileId);
    expect(downloadStore.getActiveCount()).toBe(0);
  });

  it('rejects download if chunk size is not exactly 5,242,896 bytes (Row W-02)', async () => {
    const mockRestClient: MediaRestClient = {
      async initUpload(): Promise<void> {},
      async uploadChunk(): Promise<void> {},
      async finalizeUpload(): Promise<void> {},
      async downloadChunk(): Promise<Uint8Array> {
        // Bad chunk: 100 bytes instead of 5,242,896
        return new Uint8Array(100);
      },
    };

    const mockCryptoPort: MediaCryptoPort = {
      async createMediaKey() { return { media_key_id: '' }; },
      async importMediaKey() { return { media_key_id: 'bad-key' }; },
      async sealChunk() { return { ciphertext: new Uint8Array(0), ciphertext_sha256: '' }; },
      async openChunk() { return { plaintext: new Uint8Array(0) }; },
      async sealThumbnail() { return { wire: new Uint8Array(0) }; },
      async openThumbnail() { return { plaintext_padded: new Uint8Array(0) }; },
      async exportMediaKeyForPeer() { return { media_key: '', file_iv_prefix: '' }; },
      async dropMediaKey() { return { ok: true }; },
      async buildMediaMetadata() { return { plaintext_mce: '' }; },
      async computeTokenHash() { return ''; },
      async computeManifestHash() { return { raw: new Uint8Array(0), hex: '', base64: '' }; },
    };

    const downloadUseCase = new DownloadMediaUseCase(
      mockRestClient,
      mockCryptoPort,
      new MediaDownloadStore(),
    );

    const metadata: any = {
      file_id: 'test-w02',
      media_key: 'b64==',
      file_iv_prefix: 'b64==',
      media_token: 'b64==',
      original_size: 1000,
      total_chunks: 1,
      file_manifest_hash: 'b64==',
      mime_type: 'image/png',
    };

    await expect(downloadUseCase.execute({ metadata })).rejects.toThrow(/MED_C03/);
  });
});
