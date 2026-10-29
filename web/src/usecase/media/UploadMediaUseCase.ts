/**
 * UploadMediaUseCase — 9-step media upload pipeline.
 * Phase 12B Task 13 (§16.3, §16.4, §16.5, §22.1).
 *
 * Rules:
 * - Validate size <= 2GB (400 * 5,242,880) or reject with MED_C06
 * - Compute chunkCount(size); 1 <= totalChunks <= 400
 * - Fresh Media_Key and File_IV_Prefix per file (Worker)
 * - Sequential chunk processing with memory ceiling <= 12MB
 * - Status code matrix handling (§22.1)
 * - Finalize with manifest hash (lowercase hex to server)
 * - Generate & seal thumbnail for images
 * - Export media metadata in MCE v1 format
 * - Purge chunk cache on completion
 */

import {
  CHUNK_PLAINTEXT_SIZE,
  MAX_FILE_SIZE,
  MAX_TOTAL_CHUNKS,
} from '../../domain/media/constants';
import { computeChunkCount } from '../../domain/media/padding';
import { normalizeUploadMimeType } from '../../domain/media/mime';
import {
  MED_C01,
  MED_C02,
  MED_C04,
  MED_C05,
  MED_C06,
} from '../../domain/errors';
import type {
  MediaMetadata,
  MediaUploadState,
} from '../../domain/media/types';
import type {
  MediaRestClient,
  MediaRepository,
  MediaChunkCache,
  MediaUploadObserver,
  ThumbnailPort,
  MediaCryptoPort,
} from '../../domain/ports/media';

function pureTsSha256(data: Uint8Array): Uint8Array {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const l = data.length;
  const bitLen = l * 8;
  const padLen = (l % 64 < 56) ? 64 - (l % 64) : 128 - (l % 64);
  const padded = new Uint8Array(l + padLen);
  padded.set(data);
  padded[l] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLen >>> 0);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000));

  const w = new Uint32Array(64);
  for (let i = 0; i < padded.length; i += 64) {
    for (let t = 0; t < 16; t++) {
      w[t] = view.getUint32(i + t * 4);
    }
    for (let t = 16; t < 64; t++) {
      const s0 = ((w[t - 15] >>> 7) | (w[t - 15] << 25)) ^ ((w[t - 15] >>> 18) | (w[t - 15] << 14)) ^ (w[t - 15] >>> 3);
      const s1 = ((w[t - 2] >>> 17) | (w[t - 2] << 15)) ^ ((w[t - 2] >>> 19) | (w[t - 2] << 13)) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (let t = 0; t < 64; t++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0; h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  outView.setUint32(0, h0); outView.setUint32(4, h1);
  outView.setUint32(8, h2); outView.setUint32(12, h3);
  outView.setUint32(16, h4); outView.setUint32(20, h5);
  outView.setUint32(24, h6); outView.setUint32(28, h7);
  return out;
}

async function computeSha256(data: Uint8Array): Promise<Uint8Array> {
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', data as BufferSource);
    return new Uint8Array(buf);
  }
  return pureTsSha256(data);
}

function toHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export class UploadMediaUseCase {
  private restClient: MediaRestClient;
  private mediaRepo: MediaRepository;
  private chunkCache: MediaChunkCache;
  private cryptoPort: MediaCryptoPort;
  private thumbnailPort: ThumbnailPort | null;

  constructor(
    restClient: MediaRestClient,
    mediaRepo: MediaRepository,
    chunkCache: MediaChunkCache,
    cryptoPort: MediaCryptoPort,
    thumbnailPort: ThumbnailPort | null = null,
  ) {
    this.restClient = restClient;
    this.mediaRepo = mediaRepo;
    this.chunkCache = chunkCache;
    this.cryptoPort = cryptoPort;
    this.thumbnailPort = thumbnailPort;
  }

  async execute(params: {
    file: File | Blob;
    fileName: string;
    mimeType?: string;
    conversationId?: string;
    observer?: MediaUploadObserver;
    direct?: boolean;
    previewDataUrl?: string;
    signal?: AbortSignal;
    onFileIdAllocated?: (fileId: string) => void;
  }): Promise<MediaMetadata> {
    const { file, fileName, observer, direct, previewDataUrl, signal, onFileIdAllocated } = params;
    if (signal?.aborted) {
      throw new DOMException('Upload aborted by user', 'AbortError');
    }
    const mimeType = normalizeUploadMimeType(params.mimeType || (file as File).type);
    const conversationId = params.conversationId || '';

    // 1. Validate file size
    if (!file || file.size <= 0) {
      throw new Error(`${MED_C06}: File size cannot be empty (0 bytes)`);
    }
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`${MED_C06}: File size ${file.size} exceeds maximum ${MAX_FILE_SIZE} bytes`);
    }

    // Direct worker-free upload pipeline (Phase 3)
    if (direct) {
      return this.executeDirectUpload({
        file,
        fileName,
        mimeType,
        conversationId,
        observer,
        previewDataUrl,
        signal,
        onFileIdAllocated,
      });
    }

    // 2. Chunk count arithmetic
    const totalChunks = computeChunkCount(file.size);
    if (totalChunks < 1 || totalChunks > MAX_TOTAL_CHUNKS) {
      throw new Error(`${MED_C06}: Invalid chunk count ${totalChunks}`);
    }

    // 3. Worker: fresh Media_Key and File_IV_Prefix
    const { media_key_id } = await this.cryptoPort.createMediaKey();

    // Generate 32-byte Media_Token and lowercase hex token_hash (V-1)
    const mediaToken = crypto.getRandomValues(new Uint8Array(32));
    const tokenHash = await this.cryptoPort.computeTokenHash(mediaToken);

    // 4. Generate file_id (UUIDv4)
    const fileId = generateUUID();
    onFileIdAllocated?.(fileId);

    // Insert media_uploads row as INITIALIZED
    const uploadState: MediaUploadState = {
      fileId,
      conversationId,
      fileName,
      mimeType,
      originalSize: file.size,
      totalChunks,
      uploadedChunks: 0,
      status: 'initializing',
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.mediaRepo.upsertUploadState(uploadState);

    // 5. POST /media/init
    try {
      await this.restClient.initUpload(fileId, totalChunks, tokenHash);
    } catch (err) {
      const status = (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number')
        ? (err as { status: number }).status
        : 0;
      await this.mediaRepo.markFailed?.(fileId);
      if (status === 409 || status === 404) {
        throw new Error(`${MED_C05}: Upload init failed with status ${status}`, { cause: err });
      }
      if (status === 413) {
        throw new Error(`${MED_C04}: Upload quota exceeded`, { cause: err });
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${MED_C01}: Upload init failed: ${message}`, { cause: err });
    }

    // 6. Sequential chunk upload loop (concurrency = 1, memory ceiling <= 12MB)
    const chunkHashes: string[] = [];

    for (let i = 0; i < totalChunks; i++) {
      if (signal?.aborted) {
        if (this.restClient.deleteMedia) {
          void this.restClient.deleteMedia(fileId).catch(() => {});
        }
        await this.chunkCache.deleteFile(fileId).catch(() => {});
        await this.mediaRepo.markFailed?.(fileId).catch(() => {});
        throw new DOMException('Upload aborted by user', 'AbortError');
      }

      const start = i * CHUNK_PLAINTEXT_SIZE;
      const end = Math.min(file.size, (i + 1) * CHUNK_PLAINTEXT_SIZE);
      const slice = file.slice(start, end);
      const rawChunkBuf = await slice.arrayBuffer();

      const plainChunk = new Uint8Array(rawChunkBuf);

      const sealed = await this.cryptoPort.sealChunk({
        media_key_id,
        file_id_bytes: fileId,
        chunk_index: i,
        total_chunks: totalChunks,
        plaintext: plainChunk,
      });

      const hash = sealed.ciphertext_sha256;
      chunkHashes.push(hash);

      // Cache ciphertext Blob + hash
      await this.chunkCache.putChunk(fileId, i, sealed.ciphertext, hash);

      // Upload chunk with retry logic and live progress
      await this.uploadChunkWithRetry(fileId, i, sealed.ciphertext, hash, (loaded) => {
        const currentBytes = Math.min(file.size, start + loaded);
        observer?.onProgress({
          fileId,
          chunkIndex: i,
          totalChunks,
          bytesUploaded: currentBytes,
          totalBytes: file.size,
        });
      }, signal);

      await this.mediaRepo.recordChunkUploaded?.(fileId, i);
      observer?.onProgress({
        fileId,
        chunkIndex: i,
        totalChunks,
        bytesUploaded: end,
        totalBytes: file.size,
      });
    }

    // 7. Build manifest from hashes in ascending index order
    const rawHashes: Uint8Array[] = chunkHashes.map((h) => {
      const out = new Uint8Array(h.length / 2);
      for (let j = 0; j < out.length; j++) {
        out[j] = parseInt(h.substring(j * 2, j * 2 + 2), 16);
      }
      return out;
    });

    const manifestResult = await this.cryptoPort.computeManifestHash(rawHashes);

    // 8. POST /media/finalize
    try {
      await this.restClient.finalizeUpload(fileId, manifestResult.hex);
    } catch (err) {
      const status = (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number')
        ? (err as { status: number }).status
        : 0;
      if (status === 400) {
        if (this.restClient.deleteMedia) {
          try {
            await this.restClient.deleteMedia(fileId, manifestResult.hex);
          } catch {
            // ignore
          }
        }
        await this.chunkCache.deleteFile(fileId);
        await this.mediaRepo.markFailed?.(fileId);
        throw new Error(`${MED_C02}: Manifest mismatch on finalize`, { cause: err });
      }
      if (status === 409) {
        // retry finalize once
        try {
          await this.restClient.finalizeUpload(fileId, manifestResult.hex);
        } catch (retryErr) {
          await this.mediaRepo.markFailed?.(fileId);
          throw new Error(`${MED_C05}: Finalize conflict`, { cause: retryErr });
        }
      } else {
        await this.mediaRepo.markFailed?.(fileId);
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`${MED_C02}: Finalize failed: ${message}`, { cause: err });
      }
    }

    // 9. Generate thumbnail (sender, images only per ADR-P12B-39)
    let inlineThumbnailB64: string | null = null;
    if (mimeType.startsWith('image/') && this.thumbnailPort) {
      try {
        const paddedThumbnail = await this.thumbnailPort.generateThumbnail(file);
        if (paddedThumbnail) {
          const { wire } = await this.cryptoPort.sealThumbnail({
            media_key_id,
            file_id_bytes: fileId,
            plaintext_padded: paddedThumbnail,
          });
          let b = '';
          for (let k = 0; k < wire.length; k++) b += String.fromCharCode(wire[k]);
          inlineThumbnailB64 = btoa(b);
        }
      } catch {
        // Thumbnail failure => send with null inline_thumbnail (§17.7)
        inlineThumbnailB64 = null;
      }
    }

    // Export keys for peer (Base64 standard padded)
    const exportedKeys = await this.cryptoPort.exportMediaKeyForPeer({ media_key_id });
    let tokenB64 = '';
    for (let k = 0; k < mediaToken.length; k++) tokenB64 += String.fromCharCode(mediaToken[k]);
    tokenB64 = btoa(tokenB64);

    const metadata: MediaMetadata = {
      file_id: fileId,
      media_key: exportedKeys.media_key,
      file_iv_prefix: exportedKeys.file_iv_prefix,
      media_token: tokenB64,
      original_size: file.size,
      total_chunks: totalChunks,
      file_manifest_hash: manifestResult.base64,
      mime_type: mimeType,
      inline_thumbnail: inlineThumbnailB64,
    };

    // Teardown: drop media key from worker RAM, purge cache, mark complete
    await this.cryptoPort.dropMediaKey({ media_key_id });
    await this.chunkCache.deleteFile(fileId);
    await this.mediaRepo.markComplete?.(fileId);
    observer?.onComplete(fileId);

    return metadata;
  }

  private async uploadChunkWithRetry(
    fileId: string,
    chunkIndex: number,
    ciphertext: Uint8Array,
    chunkHash: string,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    let attempt = 0;
    while (attempt < 4) {
      if (signal?.aborted) {
        throw new DOMException('Upload aborted by user', 'AbortError');
      }
      try {
        await this.restClient.uploadChunk(fileId, chunkIndex, ciphertext, chunkHash, onProgress, signal);
        return;
      } catch (err) {
        if (signal?.aborted || (err && typeof err === 'object' && ('name' in err && (err as { name: string }).name === 'AbortError' || 'code' in err && (err as { code: string }).code === 'MED_UPLOAD_ABORTED'))) {
          throw new DOMException('Upload aborted by user', 'AbortError');
        }
        const status = (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number')
          ? (err as { status: number }).status
          : 0;
        if (status === 400) {
          if (attempt === 0) {
            const cached = await this.chunkCache.getChunk(fileId, chunkIndex);
            if (cached) ciphertext = cached;
            attempt++;
            continue;
          }
          throw new Error(`${MED_C01}: Chunk upload rejected (hash mismatch)`, { cause: err });
        }
        if (status === 409) {
          throw new Error(`${MED_C05}: Chunk conflict — different ciphertext already stored`, { cause: err });
        }
        if (status === 410) {
          throw new Error(`${MED_C06}: File upload row no longer pending`, { cause: err });
        }
        if (status === 429) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
          attempt++;
          continue;
        }
        if (status >= 500 || status === 0) {
          attempt++;
          if (attempt >= 4) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`${MED_C01}: Chunk upload failed after retries: ${message}`, { cause: err });
          }
          await new Promise((resolve) => setTimeout(resolve, 200 * Math.pow(2, attempt)));
          continue;
        }
        throw err;
      }
    }
  }

  private async executeDirectUpload(params: {
    file: File | Blob;
    fileName: string;
    mimeType: string;
    conversationId: string;
    observer?: MediaUploadObserver;
    previewDataUrl?: string;
    signal?: AbortSignal;
    onFileIdAllocated?: (fileId: string) => void;
  }): Promise<MediaMetadata> {
    const { file, fileName, mimeType, conversationId, observer, previewDataUrl, signal, onFileIdAllocated } = params;
    if (signal?.aborted) {
      throw new DOMException('Upload aborted by user', 'AbortError');
    }
    const CHUNK_SIZE = CHUNK_PLAINTEXT_SIZE;
    const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    if (totalChunks > MAX_TOTAL_CHUNKS) {
      throw new Error(`${MED_C06}: Invalid chunk count ${totalChunks}`);
    }

    const fileId = generateUUID();
    onFileIdAllocated?.(fileId);
    const mediaToken = 'direct-v1';
    const tokenHashBytes = await computeSha256(new TextEncoder().encode(mediaToken));
    const tokenHash = toHex(tokenHashBytes);

    const uploadState: MediaUploadState = {
      fileId,
      conversationId,
      fileName,
      mimeType,
      originalSize: file.size,
      totalChunks,
      uploadedChunks: 0,
      status: 'initializing',
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.mediaRepo.upsertUploadState(uploadState);

    try {
      await this.restClient.initUpload(fileId, totalChunks, tokenHash);
    } catch (err) {
      const status = (err && typeof err === 'object' && 'status' in err && typeof (err as { status: unknown }).status === 'number')
        ? (err as { status: number }).status
        : 0;
      await this.mediaRepo.markFailed?.(fileId);
      if (status === 409 || status === 404) {
        throw new Error(`${MED_C05}: Upload init failed with status ${status}`, { cause: err });
      }
      if (status === 413) {
        throw new Error(`${MED_C04}: Upload quota exceeded`, { cause: err });
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${MED_C01}: Upload init failed: ${message}`, { cause: err });
    }

    const rawHashes: Uint8Array[] = [];

    for (let i = 0; i < totalChunks; i++) {
      if (signal?.aborted) {
        if (this.restClient.deleteMedia) {
          void this.restClient.deleteMedia(fileId).catch(() => {});
        }
        await this.mediaRepo.markFailed?.(fileId).catch(() => {});
        throw new DOMException('Upload aborted by user', 'AbortError');
      }

      const start = i * CHUNK_SIZE;
      const end = Math.min(file.size, (i + 1) * CHUNK_SIZE);
      const slice = file.slice(start, end);
      const rawChunkBuf = await slice.arrayBuffer();
      const plainChunk = new Uint8Array(rawChunkBuf);

      const chunkHashBytes = await computeSha256(plainChunk);
      const chunkHashHex = toHex(chunkHashBytes);
      rawHashes.push(chunkHashBytes);

      await this.uploadChunkWithRetry(fileId, i, plainChunk, chunkHashHex, (loaded) => {
        const currentBytes = Math.min(file.size, start + loaded);
        observer?.onProgress({
          fileId,
          chunkIndex: i,
          totalChunks,
          bytesUploaded: currentBytes,
          totalBytes: file.size,
        });
      }, signal);

      await this.mediaRepo.recordChunkUploaded?.(fileId, i);
      observer?.onProgress({
        fileId,
        chunkIndex: i,
        totalChunks,
        bytesUploaded: end,
        totalBytes: file.size,
      });
    }

    const totalRawHashes = new Uint8Array(rawHashes.length * 32);
    for (let i = 0; i < rawHashes.length; i++) {
      totalRawHashes.set(rawHashes[i], i * 32);
    }
    const manifestHashBytes = await computeSha256(totalRawHashes);
    const manifestHex = toHex(manifestHashBytes);
    const manifestB64 = toBase64(manifestHashBytes);

    try {
      await this.restClient.finalizeUpload(fileId, manifestHex);
    } catch (err) {
      await this.mediaRepo.markFailed?.(fileId);
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${MED_C02}: Finalize failed: ${message}`, { cause: err });
    }

    const metadata: MediaMetadata = {
      file_id: fileId,
      media_key: 'direct-v1',
      file_iv_prefix: 'direct-v1',
      media_token: 'direct-v1',
      original_size: file.size,
      total_chunks: totalChunks,
      file_manifest_hash: manifestB64,
      mime_type: mimeType,
      inline_thumbnail: null,
      preview_data_url: previewDataUrl,
      file_name: fileName,
    };

    await this.mediaRepo.markComplete?.(fileId);
    observer?.onComplete(fileId);
    return metadata;
  }
}
