/**
 * useMediaDownload — Hook for orchestrating chunk download and object URL lifecycle.
 * Phase 12B §17.3, §18.1, §18.6.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import type { MediaMetadata, ChunkProgress } from '../../domain/media/types';
import type { DownloadMediaUseCase, DownloadMediaResult } from '../../usecase/media/DownloadMediaUseCase';

export function useMediaDownload(downloadUseCase: DownloadMediaUseCase | null) {
  const [downloading, setDownloading] = useState(false);
  const [progress, setProgress] = useState<ChunkProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DownloadMediaResult | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeUrlRef = useRef<string | null>(null);

  const startDownload = useCallback(
    async (metadata: MediaMetadata): Promise<DownloadMediaResult | null> => {
      if (!downloadUseCase) {
        setError('Download service unavailable');
        return null;
      }

      setDownloading(true);
      setError(null);
      setProgress(null);

      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const res = await downloadUseCase.execute({
          metadata,
          signal: controller.signal,
          observer: {
            onProgress(p) {
              setProgress(p);
            },
            onComplete() {
              setDownloading(false);
            },
            onError(_fileId, errStr) {
              setError(errStr);
              setDownloading(false);
            },
          },
        });

        activeUrlRef.current = res.blobUrl;
        setResult(res);
        return res;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setDownloading(false);
      }
    },
    [downloadUseCase],
  );

  const cancel = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setDownloading(false);
  }, []);

  useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
      if (activeUrlRef.current) {
        URL.revokeObjectURL(activeUrlRef.current);
        activeUrlRef.current = null;
      }
    };
  }, []);

  return {
    startDownload,
    cancel,
    downloading,
    progress,
    error,
    result,
    blobUrl: result?.blobUrl ?? null,
  };
}
