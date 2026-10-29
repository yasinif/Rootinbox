/**
 * useCallMedia hook.
 * Phase 12B Task 12 (§15.3).
 *
 * Imperatively binds MediaStream to audio/video elements via srcObject only.
 * Never uses src or Blob URL.
 */

import { useEffect, useRef, useState, useCallback } from 'react';

export function useCallMedia(stream: MediaStream | null) {
  const mediaRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);

  useEffect(() => {
    const el = mediaRef.current;
    if (!el) return;

    if (stream) {
      el.srcObject = stream;
      el.play().then(() => {
        setAutoplayBlocked(false);
      }).catch((err) => {
        if (err.name === 'NotAllowedError') {
          // Autoplay policy blocked audio playback (§15.3)
          setAutoplayBlocked(true);
        }
      });
    } else {
      el.srcObject = null;
    }

    return () => {
      if (el) {
        el.srcObject = null;
      }
    };
  }, [stream]);

  const retryPlay = useCallback(async () => {
    const el = mediaRef.current;
    if (el) {
      try {
        await el.play();
        setAutoplayBlocked(false);
      } catch {
        // Still blocked
      }
    }
  }, []);

  return { mediaRef, autoplayBlocked, retryPlay };
}
