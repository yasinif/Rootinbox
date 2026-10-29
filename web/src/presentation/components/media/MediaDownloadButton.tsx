/**
 * MediaDownloadButton — Secure download trigger.
 * Phase 12B §18.4.
 *
 * Rules:
 * - <a download={sanitizedName} href={blobUrl}> created at click time and revoked after click
 * - No window.open, no target="_blank" without rel="noopener noreferrer"
 */

import React, { useState } from 'react';
import { sanitizeFileName } from '../../../domain/media/filename';
import type { MediaMetadata } from '../../../domain/media/types';
import type { DownloadMediaUseCase } from '../../../usecase/media/DownloadMediaUseCase';

interface MediaDownloadButtonProps {
  metadata: MediaMetadata;
  fileName: string;
  downloadUseCase: DownloadMediaUseCase | null;
  existingBlobUrl?: string | null;
  onError?: (err: Error) => void;
}

export const MediaDownloadButton: React.FC<MediaDownloadButtonProps> = ({
  metadata,
  fileName,
  downloadUseCase,
  existingBlobUrl = null,
  onError,
}) => {
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const sanitizedName = sanitizeFileName(fileName);

  const handleDownload = async () => {
    if (downloading) return;

    let blobUrl = existingBlobUrl;

    if (!blobUrl && downloadUseCase) {
      setDownloading(true);
      setDownloadProgress(0);
      setDownloadError(null);
      try {
        const res = await downloadUseCase.execute({
          metadata,
          observer: {
            onProgress(p) {
              const pct = p.totalBytes > 0 ? Math.round((p.bytesUploaded / p.totalBytes) * 100) : 0;
              setDownloadProgress(pct);
            },
            onComplete() {
              setDownloading(false);
            },
            onError(err) {
              setDownloading(false);
              const errMsg = typeof err === 'string' ? err : 'Download failed';
              setDownloadError(errMsg);
              onError?.(new Error(errMsg));
            },
          },
        });
        blobUrl = res.blobUrl;
      } catch (err) {
        console.error('Download failed:', err);
        setDownloading(false);
        const errorObj = err instanceof Error ? err : new Error(String(err));
        setDownloadError(errorObj.message);
        onError?.(errorObj);
        return;
      }
      setDownloading(false);
    }

    if (blobUrl) {
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = sanitizedName;
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
  };

  return (
    <button
      id="media-download-btn"
      data-testid="media-download-btn"
      type="button"
      onClick={handleDownload}
      disabled={downloading}
      className="btn-download"
    >
      <span>{downloadError ? '↻' : '⬇'}</span>
      <span>{downloading ? (downloadProgress > 0 ? `${downloadProgress}%` : 'Downloading...') : (downloadError ? 'Retry Download' : 'Download')}</span>
    </button>
  );
};
