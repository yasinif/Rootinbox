/**
 * Media Download Store — In-Memory Object URL Registry.
 * Phase 12B §17.1, §17.3 step 6, Row B-04.
 *
 * Rules:
 * - Decrypted media bytes are NEVER written to IndexedDB, localStorage, or sessionStorage (Row B-04).
 * - Object URLs are created on download and tracked in RAM only.
 * - Every registered URL can be explicitly revoked on component unmount or viewer close.
 */

import type { MediaDownloadStore as IMediaDownloadStore } from '../../domain/ports/media';

export interface DownloadedMediaRecord {
  fileId: string;
  blobUrl: string;
  mimeType: string;
  originalSize: number;
  createdAt: number;
}

export class MediaDownloadStore implements IMediaDownloadStore {
  private records = new Map<string, DownloadedMediaRecord>();

  register(fileId: string, blob: Blob, mimeType: string, originalSize: number): string {
    // Revoke existing URL if present for this fileId
    this.revoke(fileId);

    const blobUrl = URL.createObjectURL(blob);
    this.records.set(fileId, {
      fileId,
      blobUrl,
      mimeType,
      originalSize,
      createdAt: Date.now(),
    });
    return blobUrl;
  }

  get(fileId: string): DownloadedMediaRecord | null {
    return this.records.get(fileId) ?? null;
  }

  getUrl(fileId: string): string | null {
    return this.records.get(fileId)?.blobUrl ?? null;
  }

  revoke(fileId: string): void {
    const record = this.records.get(fileId);
    if (record) {
      URL.revokeObjectURL(record.blobUrl);
      this.records.delete(fileId);
    }
  }

  revokeAll(): void {
    for (const record of this.records.values()) {
      URL.revokeObjectURL(record.blobUrl);
    }
    this.records.clear();
  }

  getActiveCount(): number {
    return this.records.size;
  }
}

export const mediaDownloadStore = new MediaDownloadStore();
