/**
 * useThumbnail — Hook for decoding and displaying inline media thumbnails.
 * Phase 12B §17.7, §18.1.
 */

import { useState, useEffect } from 'react';
import type { ThumbnailUseCase } from '../../usecase/media/ThumbnailUseCase';

export function useThumbnail(
  thumbnailUseCase: ThumbnailUseCase | null,
  mediaKeyId: string | null,
  fileId: string | null,
  inlineThumbnail: string | Uint8Array | null,
) {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!thumbnailUseCase || !mediaKeyId || !fileId || !inlineThumbnail) {
      setThumbnailUrl(null);
      return;
    }

    let active = true;
    let createdUrl: string | null = null;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const bytes = await thumbnailUseCase!.decodeThumbnail({
          mediaKeyId: mediaKeyId!,
          fileId: fileId!,
          inlineThumbnail,
        });

        if (!active) return;

        if (bytes && bytes.length > 0) {
          const blob = new Blob([bytes as unknown as BlobPart], { type: 'image/webp' });
          createdUrl = URL.createObjectURL(blob);
          setThumbnailUrl(createdUrl);
        } else {
          setThumbnailUrl(null);
        }
      } catch (err) {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
        setThumbnailUrl(null);
      } finally {
        if (active) setLoading(false);
      }
    }

    load();

    return () => {
      active = false;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [thumbnailUseCase, mediaKeyId, fileId, inlineThumbnail]);

  return { thumbnailUrl, loading, error };
}
