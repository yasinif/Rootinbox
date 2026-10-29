/**
 * useMediaUpload — Hook for orchestrating media upload and outbox message sending.
 * Phase 12B §16.3, §18.1, §18.5.
 */

import { useState, useCallback } from 'react';
import type { ChunkProgress, MediaMetadata } from '../../domain/media/types';
import type { SendMediaMessageUseCase } from '../../usecase/media/SendMediaMessageUseCase';
import { useAppContext } from '../context';

export function useMediaUpload(sendMediaUseCase?: SendMediaMessageUseCase | null) {
  const ctx = useAppContext();
  const uc = sendMediaUseCase ?? ctx.sendMediaUC ?? null;
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState<ChunkProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploadedMetadata, setUploadedMetadata] = useState<MediaMetadata | null>(null);

  const uploadFile = useCallback(
    async (params: {
      conversationId: string;
      file: File | Blob;
      fileName: string;
      mimeType?: string;
      peerIdentityHash?: string;
    }): Promise<MediaMetadata | null> => {
      if (!uc) {
        setError('Upload service unavailable');
        return null;
      }

      setUploading(true);
      setError(null);
      setProgress(null);
      setUploadedMetadata(null);

      try {
        const { metadata } = await uc.execute({
          conversationId: params.conversationId,
          file: params.file,
          fileName: params.fileName,
          mimeType: params.mimeType,
          peerIdentityHash: params.peerIdentityHash,
          observer: {
            onProgress(p: ChunkProgress) {
              setProgress(p);
            },
            onComplete() {
              setUploading(false);
            },
            onError(_fileId: string, errStr: string) {
              setError(errStr);
              setUploading(false);
            },
          },
        });

        setUploadedMetadata(metadata);
        return metadata;
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return null;
      } finally {
        setUploading(false);
      }
    },
    [uc],
  );

  return {
    uploadFile,
    uploading,
    progress,
    error,
    uploadedMetadata,
  };
}
