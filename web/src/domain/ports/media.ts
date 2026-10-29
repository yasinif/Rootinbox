/**
 * Media Domain Ports.
 * Phase 12B §7.8: Interfaces the use case layer depends on.
 */

import type { MediaUploadState, ChunkProgress, MediaMetadata } from '../media';

/** REST client for media upload/download endpoints. */
export interface MediaRestClient {
  /** POST /api/v1/media/init */
  initUpload(fileId: string, totalChunks: number, tokenHash: string): Promise<void>;
  /** PUT /api/v1/media/upload/{file_id}/{chunk_index} */
  uploadChunk(
    fileId: string,
    chunkIndex: number,
    data: Uint8Array,
    chunkHash: string,
    onProgress?: (loaded: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<void>;
  /** POST /api/v1/media/finalize */
  finalizeUpload(fileId: string, manifestHash: string): Promise<void>;
  /** GET /api/v1/media/download/{file_id}/{chunk_index} */
  downloadChunk(
    fileId: string,
    chunkIndex: number,
    mediaToken: string,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<Uint8Array>;
  /** DELETE /api/v1/media/{file_id} */
  deleteMedia?(fileId: string, mediaToken?: string): Promise<void>;
}

/** Dexie store for media upload state. */
export interface MediaRepository {
  getUploadState(fileId: string): Promise<MediaUploadState | null>;
  upsertUploadState(state: MediaUploadState): Promise<void>;
  deleteUploadState(fileId: string): Promise<void>;
  listPendingUploads(): Promise<MediaUploadState[]>;
  recordChunkUploaded?(fileId: string, chunkIndex: number): Promise<void>;
  markComplete?(fileId: string): Promise<void>;
  markFailed?(fileId: string): Promise<void>;
  reconcileBoot?(): Promise<void>;
}

/** In-memory or Dexie cache for encrypted chunk data. */
export interface MediaChunkCache {
  putChunk(fileId: string, chunkIndex: number, data: Uint8Array, chunkHash?: string): Promise<void>;
  getChunk(fileId: string, chunkIndex: number): Promise<Uint8Array | null>;
  getChunkHash?(fileId: string, chunkIndex: number): Promise<string | null>;
  deleteFile(fileId: string): Promise<void>;
}

/** Upload progress observer. */
export interface MediaUploadObserver {
  onProgress(progress: ChunkProgress): void;
  onComplete(fileId: string): void;
  onError(fileId: string, error: string): void;
}

/** Thumbnail generation port. */
export interface ThumbnailPort {
  /** Generate a padded thumbnail plaintext from a file or blob. */
  generateThumbnail(file: File | Blob): Promise<Uint8Array | null>;
}

/** Ephemeral Object URL store for downloaded media (RAM only). */
export interface MediaDownloadStore {
  register(fileId: string, blob: Blob, mimeType: string, originalSize: number): string;
  get(fileId: string): { fileId: string; blobUrl: string; mimeType: string; originalSize: number } | null;
  getUrl(fileId: string): string | null;
  revoke(fileId: string): void;
  revokeAll(): void;
  getActiveCount(): number;
}

/** Crypto Worker operations for media. */
export interface MediaCryptoPort {
  createMediaKey(): Promise<{ media_key_id: string }>;
  importMediaKey(params: {
    media_key: string | Uint8Array;
    file_iv_prefix: string | Uint8Array;
  }): Promise<{ media_key_id: string }>;
  sealChunk(
    params: {
      media_key_id: string;
      file_id_bytes: string | Uint8Array;
      chunk_index: number;
      total_chunks: number;
      plaintext: Uint8Array | ArrayBuffer;
    },
    transfer?: Transferable[],
  ): Promise<{ ciphertext: Uint8Array; ciphertext_sha256: string }>;
  openChunk(
    params: {
      media_key_id: string;
      file_id_bytes: string | Uint8Array;
      chunk_index: number;
      total_chunks: number;
      ciphertext: Uint8Array | ArrayBuffer;
    },
    transfer?: Transferable[],
  ): Promise<{ plaintext: Uint8Array }>;
  sealThumbnail(params: {
    media_key_id: string;
    file_id_bytes: string | Uint8Array;
    plaintext_padded: Uint8Array | ArrayBuffer;
  }): Promise<{ wire: Uint8Array }>;
  openThumbnail(params: {
    media_key_id: string;
    file_id_bytes: string | Uint8Array;
    wire: Uint8Array | ArrayBuffer;
  }): Promise<{ plaintext_padded: Uint8Array; image?: Uint8Array }>;
  exportMediaKeyForPeer(params: { media_key_id: string }): Promise<{
    media_key: string;
    file_iv_prefix: string;
  }>;
  dropMediaKey(params: { media_key_id: string }): Promise<{ ok: boolean }>;
  buildMediaMetadata(params: {
    media_key_id: string;
    fields: Omit<MediaMetadata, 'media_key' | 'file_iv_prefix'>;
  }): Promise<{ plaintext_mce: string }>;
  computeTokenHash(token: Uint8Array): Promise<string>;
  computeManifestHash(chunkHashes: Uint8Array[]): Promise<{ raw: Uint8Array; hex: string; base64: string }>;
  sha256?(data: Uint8Array): Promise<Uint8Array>;
}
