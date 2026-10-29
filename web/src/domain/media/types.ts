/**
 * Media Domain Types.
 * Phase 12B §7.4: Pure types, zero imports outside domain.
 */

/** Media file upload status. */
export type MediaStatus = 'pending' | 'finalized' | 'deleting';

/** Client-side upload state (Dexie-persisted). */
export type MediaUploadStatus =
  | 'queued'
  | 'initializing'
  | 'uploading'
  | 'finalizing'
  | 'complete'
  | 'failed';

/** Client-side upload state record. */
export interface MediaUploadState {
  readonly fileId: string;
  readonly conversationId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly originalSize: number;
  readonly totalChunks: number;
  readonly uploadedChunks: number;
  readonly status: MediaUploadStatus;
  readonly error: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** RFC-0007 §4.4: Media metadata (9 fields). */
export interface MediaMetadata {
  readonly file_id: string;
  readonly media_key: string;        // Base64 standard padded
  readonly file_iv_prefix: string;   // Base64 standard padded
  readonly media_token: string;      // Base64 standard padded
  readonly original_size: number;
  readonly total_chunks: number;
  readonly file_manifest_hash: string; // lowercase hex
  readonly mime_type: string;
  readonly inline_thumbnail: string | null; // Base64 standard padded (thumbnail wire)
  readonly preview_data_url?: string;
  readonly width?: number;
  readonly height?: number;
  readonly duration?: number;
  readonly caption?: string;
  readonly file_name?: string;
  readonly waveform?: number[];
}

/** Chunk upload progress event. */
export interface ChunkProgress {
  readonly fileId: string;
  readonly chunkIndex: number;
  readonly totalChunks: number;
  readonly bytesUploaded: number;
  readonly totalBytes: number;
}
