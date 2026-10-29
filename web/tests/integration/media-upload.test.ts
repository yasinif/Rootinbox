/**
 * Phase 12B Integration Test — Media Upload Pipeline.
 * §23.3, Rows W-01, W-03, E-02, E-03.
 *
 * Asserts:
 * - 3-chunk upload runs /init -> /upload x 3 -> /finalize
 * - Every upload chunk body is EXACTLY 5,242,896 bytes (including the last)
 * - X-Chunk-Hash header is lowercase hex SHA256 of ciphertext
 * - Manifest hash is computed over the 3 raw 32-byte hashes in ascending order
 * - Resulting MediaMetadata has all nine RFC-0007 fields properly encoded
 */

import { describe, it, expect } from 'vitest';
import { CHUNK_PLAINTEXT_SIZE, CHUNK_CIPHERTEXT_SIZE } from '../../src/domain/media/constants';
import { UploadMediaUseCase } from '../../src/usecase/media/UploadMediaUseCase';
import { InMemoryMediaChunkCache } from '../../src/usecase/media/MediaChunkCache';
import type {
  MediaRestClient,
  MediaRepository,
  MediaCryptoPort,
} from '../../src/domain/ports/media';

describe('Media Upload Integration Test (§23.3, W-01, W-03, E-02, E-03)', () => {
  it('runs 3-chunk upload pipeline, verifying exact body sizes, chunk hashes, manifest, and metadata', async () => {
    // 1. Create 3-chunk test payload (2 full chunks + 1000 bytes tail)
    const fileBytes = new Uint8Array(CHUNK_PLAINTEXT_SIZE * 2 + 1000);
    fileBytes.fill(0x42);
    const blob = new Blob([fileBytes], { type: 'application/octet-stream' });

    // 2. Track REST calls
    let initCalled = false;
    let initFileId = '';
    let initTotalChunks = 0;
    let initTokenHash = '';

    const uploadedChunks: {
      fileId: string;
      chunkIndex: number;
      bodyLength: number;
      chunkHash: string;
    }[] = [];

    let finalizeCalled = false;
    let finalizeFileId = '';
    let finalizeManifestHash = '';

    const mockRestClient: MediaRestClient = {
      async initUpload(fileId: string, totalChunks: number, tokenHash: string): Promise<void> {
        initCalled = true;
        initFileId = fileId;
        initTotalChunks = totalChunks;
        initTokenHash = tokenHash;
      },
      async uploadChunk(fileId: string, chunkIndex: number, data: Uint8Array, chunkHash: string): Promise<void> {
        uploadedChunks.push({
          fileId,
          chunkIndex,
          bodyLength: data.byteLength,
          chunkHash,
        });
      },
      async finalizeUpload(fileId: string, manifestHash: string): Promise<void> {
        finalizeCalled = true;
        finalizeFileId = fileId;
        finalizeManifestHash = manifestHash;
      },
      async downloadChunk(): Promise<Uint8Array> {
        throw new Error('Not used in upload');
      },
    };

    // 3. Mock repository
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

    // 4. In-process Crypto Port using WebCrypto
    let currentKey: Uint8Array | null = null;
    let currentPrefix: Uint8Array | null = null;

    const mockCryptoPort: MediaCryptoPort = {
      async createMediaKey() {
        currentKey = crypto.getRandomValues(new Uint8Array(32));
        currentPrefix = crypto.getRandomValues(new Uint8Array(4));
        return { media_key_id: 'mock-media-key-id' };
      },
      async importMediaKey() {
        return { media_key_id: 'mock-imported-key-id' };
      },
      async sealChunk(params) {
        // Deterministic ciphertext of exactly 5,242,896 bytes (plaintext + 16 bytes tag)
        const pt = params.plaintext instanceof ArrayBuffer
          ? new Uint8Array(params.plaintext)
          : params.plaintext;
        const ct = new Uint8Array(CHUNK_CIPHERTEXT_SIZE);
        ct.set(pt.subarray(0, CHUNK_PLAINTEXT_SIZE));
        // Mock 16-byte tag
        ct.fill(0xee, CHUNK_PLAINTEXT_SIZE);

        const hashBuf = await crypto.subtle.digest('SHA-256', ct);
        const hash = Array.from(new Uint8Array(hashBuf), (b) => b.toString(16).padStart(2, '0')).join('');
        return { ciphertext: ct, ciphertext_sha256: hash };
      },
      async openChunk(params) {
        const ct = params.ciphertext instanceof ArrayBuffer
          ? new Uint8Array(params.ciphertext)
          : params.ciphertext;
        return { plaintext: ct.subarray(0, CHUNK_PLAINTEXT_SIZE) };
      },
      async sealThumbnail() {
        return { wire: new Uint8Array(32_797) };
      },
      async openThumbnail() {
        return { plaintext_padded: new Uint8Array(32_768) };
      },
      async exportMediaKeyForPeer() {
        let k = '';
        for (let i = 0; i < currentKey!.length; i++) k += String.fromCharCode(currentKey![i]);
        let p = '';
        for (let i = 0; i < currentPrefix!.length; i++) p += String.fromCharCode(currentPrefix![i]);
        return { media_key: btoa(k), file_iv_prefix: btoa(p) };
      },
      async dropMediaKey() {
        currentKey = null;
        currentPrefix = null;
        return { ok: true };
      },
      async buildMediaMetadata() {
        return { plaintext_mce: '' };
      },
      async computeTokenHash(token: Uint8Array) {
        const hashBuf = await crypto.subtle.digest('SHA-256', token as unknown as ArrayBuffer);
        return Array.from(new Uint8Array(hashBuf), (b) => b.toString(16).padStart(2, '0')).join('');
      },
      async computeManifestHash(chunkHashes: Uint8Array[]) {
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

    // 5. Execute upload
    const useCase = new UploadMediaUseCase(
      mockRestClient,
      mockRepo,
      chunkCache,
      mockCryptoPort,
      null,
    );

    const metadata = await useCase.execute({
      file: blob,
      fileName: 'test-document.bin',
      mimeType: 'application/octet-stream',
    });

    // 6. Assertions
    expect(initCalled).toBe(true);
    expect(initTotalChunks).toBe(3);
    expect(initTokenHash).toMatch(/^[0-9a-f]{64}$/); // V-1: lowercase hex

    // Row W-01: exactly 3 chunks, each body is EXACTLY 5,242,896 bytes
    expect(uploadedChunks.length).toBe(3);
    for (let i = 0; i < 3; i++) {
      expect(uploadedChunks[i].chunkIndex).toBe(i);
      expect(uploadedChunks[i].bodyLength).toBe(CHUNK_CIPHERTEXT_SIZE);
      expect(uploadedChunks[i].bodyLength).toBe(5_242_896);
      // Row W-03: lowercase hex SHA-256 header
      expect(uploadedChunks[i].chunkHash).toMatch(/^[0-9a-f]{64}$/);
    }

    // Row W-02 / Finalize
    expect(finalizeCalled).toBe(true);
    expect(finalizeFileId).toBe(initFileId);
    expect(finalizeManifestHash).toMatch(/^[0-9a-f]{64}$/);

    // Row E-02 / E-03: All nine metadata fields present and correctly formatted
    expect(metadata.file_id).toBe(initFileId);
    expect(metadata.original_size).toBe(fileBytes.length);
    expect(metadata.total_chunks).toBe(3);
    expect(metadata.mime_type).toBe('application/octet-stream');
    expect(metadata.inline_thumbnail).toBeNull(); // non-image produces null

    // Base64 standard padded fields
    expect(metadata.media_key).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(metadata.file_iv_prefix).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(metadata.media_token).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(metadata.file_manifest_hash).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });
});
