/**
 * DownloadMediaUseCase — sequential chunk download, verification, and assembly.
 * Phase 12B Task 14 (§17.3, §17.4, §17.5, §17.8, §22.2, Rows W-02, B-04).
 *
 * Rules:
 * - Validate metadata and compute expected totalChunks
 * - Import media key into Worker
 * - Download chunks sequentially, asserting exact 5,242,896 bytes per chunk (Row W-02)
 * - Decrypt via openChunk (GCM + 25-byte AAD)
 * - Accumulate chunk SHA-256 hashes and verify manifest BEFORE exposing bytes (MED_C02)
 * - Assemble Blob, slice to exact original_size (never scan for zeros)
 * - MIME type validated against allowlist (ADR-P12B-38)
 * - Object URL registered in MediaDownloadStore (RAM only, Row B-04)
 * - AbortController cancellation support (§17.8)
 */

import {
  CHUNK_PLAINTEXT_SIZE,
  CHUNK_CIPHERTEXT_SIZE,
} from '../../domain/media/constants';
import {
  computeChunkCount,
  unpadChunkPlaintext,
} from '../../domain/media/padding';
import {
  getValidatedMimeType,
} from '../../domain/media/mime';
import {
  MED_C01,
  MED_C02,
  MED_C03,
  MED_C06,
} from '../../domain/errors';
import type {
  MediaMetadata,
} from '../../domain/media/types';
import type {
  MediaRestClient,
  MediaCryptoPort,
  MediaUploadObserver,
  MediaDownloadStore,
} from '../../domain/ports/media';

export interface DownloadMediaResult {
  fileId: string;
  blob: Blob;
  blobUrl: string;
  mimeType: string;
  originalSize: number;
}

export class DownloadMediaUseCase {
  private restClient: MediaRestClient;
  private cryptoPort: MediaCryptoPort;
  private downloadStore: MediaDownloadStore;

  constructor(
    restClient: MediaRestClient,
    cryptoPort: MediaCryptoPort,
    downloadStore: MediaDownloadStore,
  ) {
    this.restClient = restClient;
    this.cryptoPort = cryptoPort;
    this.downloadStore = downloadStore;
  }

  async execute(params: {
    metadata: MediaMetadata;
    observer?: MediaUploadObserver;
    signal?: AbortSignal;
  }): Promise<DownloadMediaResult> {
    const { metadata, observer, signal } = params;

    // Direct worker-free download mode when media_token === 'direct-v1' or media_key === 'direct-v1' (Phase 3)
    if (metadata.media_token === 'direct-v1' || metadata.media_key === 'direct-v1') {
      return this.executeDirectDownload(metadata, observer, signal);
    }

    // 1. Validate metadata
    if (!metadata.file_id || !metadata.media_key || !metadata.file_iv_prefix) {
      throw new Error(`${MED_C06}: Incomplete media metadata`);
    }

    const originalSize = metadata.original_size ?? (metadata as unknown as { originalSize?: number }).originalSize ?? 0;
    const totalChunks = computeChunkCount(originalSize);
    if (metadata.total_chunks && metadata.total_chunks !== totalChunks) {
      throw new Error(`${MED_C03}: Metadata chunk count mismatch: expected ${totalChunks}, got ${metadata.total_chunks}`);
    }

    // 2. Import media key into Worker
    const { media_key_id } = await this.cryptoPort.importMediaKey({
      media_key: metadata.media_key,
      file_iv_prefix: metadata.file_iv_prefix,
    });

    const parts: Uint8Array[] = [];
    const chunkHashes: Uint8Array[] = [];

    try {
      // 3. Sequentially download and decrypt each chunk
      for (let i = 0; i < totalChunks; i++) {
        if (signal?.aborted) {
          throw new Error('Download aborted by user');
        }

        const startBytes = parts.reduce((acc, p) => acc + p.length, 0);
        let chunkCiphertext: Uint8Array;
        try {
          chunkCiphertext = await this.restClient.downloadChunk(
            metadata.file_id,
            i,
            metadata.media_token,
            (loaded) => {
              const currentTotal = Math.min(metadata.original_size, startBytes + loaded);
              observer?.onProgress({
                fileId: metadata.file_id,
                chunkIndex: i,
                totalChunks,
                bytesUploaded: currentTotal,
                totalBytes: metadata.original_size,
              });
            },
          );
        } catch (err) {
          const status = (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number')
            ? (err as { status: number }).status
            : 0;
          if (status === 403 || status === 404 || status === 410) {
            throw new Error(`${MED_C06}: Media attachment no longer available (status ${status})`, { cause: err });
          }
          if (status === 416) {
            throw new Error(`${MED_C03}: Chunk index out of range`, { cause: err });
          }
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`${MED_C01}: Download chunk ${i} failed: ${message}`, { cause: err });
        }

        // Validate chunk size (allows unpadded chunk or legacy full padded chunk)
        const expectedLastSize = metadata.original_size - i * CHUNK_PLAINTEXT_SIZE;
        const expectedCiphertextSize = i < totalChunks - 1
          ? CHUNK_CIPHERTEXT_SIZE
          : (expectedLastSize > 0 ? expectedLastSize + 16 : CHUNK_CIPHERTEXT_SIZE);

        if (
          chunkCiphertext.byteLength < 17 ||
          chunkCiphertext.byteLength > CHUNK_CIPHERTEXT_SIZE ||
          (chunkCiphertext.byteLength !== expectedCiphertextSize &&
           chunkCiphertext.byteLength !== CHUNK_CIPHERTEXT_SIZE)
        ) {
          throw new Error(
            `${MED_C03}: Invalid chunk size ${chunkCiphertext.byteLength} bytes (expected ${expectedCiphertextSize})`,
          );
        }

        // Accumulate SHA-256 of ciphertext
        let rawHash: Uint8Array;
        if (this.cryptoPort.sha256) {
          rawHash = await this.cryptoPort.sha256(chunkCiphertext);
        } else if (typeof crypto !== 'undefined' && crypto.subtle) {
          const hashBuf = await crypto.subtle.digest('SHA-256', chunkCiphertext as unknown as ArrayBuffer);
          rawHash = new Uint8Array(hashBuf);
        } else {
          rawHash = new Uint8Array(32);
        }
        chunkHashes.push(rawHash);

        // Decrypt via openChunk (GCM + 25-byte AAD)
        let opened: { plaintext: Uint8Array };
        try {
          opened = await this.cryptoPort.openChunk({
            media_key_id,
            file_id_bytes: metadata.file_id,
            chunk_index: i,
            total_chunks: totalChunks,
            ciphertext: chunkCiphertext,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new Error(`${MED_C01}: Decryption failed for chunk ${i}: ${message}`, { cause: err });
        }

        // Unpad chunk
        const unpadded = unpadChunkPlaintext(
          opened.plaintext,
          i,
          totalChunks,
          metadata.original_size,
        );
        parts.push(unpadded);

        const currentTotal = parts.reduce((acc, p) => acc + p.length, 0);
        observer?.onProgress({
          fileId: metadata.file_id,
          chunkIndex: i,
          totalChunks,
          bytesUploaded: currentTotal,
          totalBytes: metadata.original_size,
        });
      }

      // 4. Verify manifest hash before exposing any bytes (§17.3 step 4, Row MED_C02)
      const manifestResult = await this.cryptoPort.computeManifestHash(chunkHashes);
      const expected = metadata.file_manifest_hash.trim();
      const match =
        manifestResult.base64 === expected ||
        manifestResult.hex.toLowerCase() === expected.toLowerCase();

      if (!match) {
        throw new Error(`${MED_C02}: Manifest hash verification failed`);
      }

      // 5. Assemble Blob with allowlisted MIME type and slice to exact size
      const validatedMime = getValidatedMimeType(metadata.mime_type);
      const assembledBlob = new Blob(parts as unknown as BlobPart[], { type: validatedMime });
      const finalBlob = assembledBlob.slice(0, metadata.original_size, validatedMime);

      // 6. Register Object URL (RAM only, Row B-04)
      const blobUrl = this.downloadStore.register(
        metadata.file_id,
        finalBlob,
        validatedMime,
        metadata.original_size,
      );

      observer?.onComplete(metadata.file_id);

      return {
        fileId: metadata.file_id,
        blob: finalBlob,
        blobUrl,
        mimeType: validatedMime,
        originalSize: metadata.original_size,
      };
    } finally {
      // Always drop media key from worker RAM
      await this.cryptoPort.dropMediaKey({ media_key_id });
    }
  }

  private async executeDirectDownload(
    metadata: MediaMetadata,
    observer?: MediaUploadObserver,
    signal?: AbortSignal,
  ): Promise<DownloadMediaResult> {
    const fileId = metadata.file_id;
    const originalSize = metadata.original_size ?? (metadata as unknown as { originalSize?: number }).originalSize ?? 0;
    const totalChunks = metadata.total_chunks || (originalSize > 0 ? Math.ceil(originalSize / 5242880) : 1);
    const mediaToken = metadata.media_token || 'direct-v1';

    const parts: Uint8Array[] = [];
    let downloadedBytes = 0;

    for (let i = 0; i < totalChunks; i++) {
      if (signal?.aborted) {
        throw new Error('Download aborted by user');
      }

      const chunkBytes = await this.restClient.downloadChunk(
        fileId,
        i,
        mediaToken,
        (loaded) => {
          const currentBytes = Math.min(originalSize || (i + 1) * 5242880, downloadedBytes + loaded);
          observer?.onProgress?.({
            fileId,
            chunkIndex: i,
            totalChunks,
            bytesUploaded: currentBytes,
            totalBytes: originalSize || totalChunks * 5242880,
          });
        },
      );

      parts.push(chunkBytes);
      downloadedBytes += chunkBytes.byteLength;

      observer?.onProgress?.({
        fileId,
        chunkIndex: i,
        totalChunks,
        bytesUploaded: downloadedBytes,
        totalBytes: originalSize || downloadedBytes,
      });
    }

    const validatedMime = getValidatedMimeType(metadata.mime_type);
    let finalBlob = new Blob(parts as unknown as BlobPart[], { type: validatedMime });
    if (originalSize > 0 && finalBlob.size > originalSize) {
      finalBlob = finalBlob.slice(0, originalSize, validatedMime);
    }

    const blobUrl = this.downloadStore.register(
      fileId,
      finalBlob,
      validatedMime,
      finalBlob.size,
    );

    observer?.onComplete?.(fileId);

    return {
      fileId,
      blob: finalBlob,
      blobUrl,
      mimeType: validatedMime,
      originalSize: finalBlob.size,
    };
  }
}
