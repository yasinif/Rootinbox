/**
 * useCallRingtone — Synthesized Web Audio ringtone and haptic feedback for incoming calls.
 *
 * Requirements:
 * - 100% self-contained synthesized Web Audio API (OscillatorNode pattern, zero external assets / CDN).
 * - Autoplay policy compliance: handles suspended AudioContext, attaches unlock listeners on user interaction.
 * - Cadence: loops standard two-tone telephone chime while ringing.
 * - Stops immediately on accept, decline, timeout, or component unmount.
 * - Fallback: concurrent vibration (navigator.vibrate) and background notification when supported.
 */

import { useEffect, useRef } from 'react';

// Dual-frequency phone ring chime: 440 Hz (standard concert A) + 480 Hz
const INCOMING_FREQ_A = 440;
const INCOMING_FREQ_B = 480;
const INCOMING_CYCLE_MS = 3000;

// Dual-frequency ringback tone: 400 Hz + 450 Hz (standard telephone cadence)
const OUTGOING_FREQ_A = 400;
const OUTGOING_FREQ_B = 450;
const OUTGOING_CYCLE_MS = 4000;

export interface UseCallRingtoneOptions {
  incoming?: boolean;
  outgoing?: boolean;
}

export function useCallRingtone(config: boolean | UseCallRingtoneOptions): void {
  const isIncoming = typeof config === 'boolean' ? config : Boolean(config?.incoming);
  const isOutgoing = typeof config === 'boolean' ? false : Boolean(config?.outgoing);
  const isEnabled = isIncoming || isOutgoing;
  const mode: 'incoming' | 'outgoing' = isOutgoing ? 'outgoing' : 'incoming';

  const audioCtxRef = useRef<AudioContext | null>(null);
  const cycleTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeNodesRef = useRef<{
    oscillators: OscillatorNode[];
    gain: GainNode;
  }[]>([]);

  useEffect(() => {
    if (!isEnabled) {
      stopRingtone();
      return;
    }

    startRingtone(mode);

    return () => {
      stopRingtone();
    };
  }, [isEnabled, mode]);

  function stopRingtone() {
    // 1. Clear recurring cycle timer
    if (cycleTimeoutRef.current) {
      clearTimeout(cycleTimeoutRef.current);
      cycleTimeoutRef.current = null;
    }

    // 2. Stop and disconnect all active audio nodes
    activeNodesRef.current.forEach(({ oscillators, gain }) => {
      oscillators.forEach((osc) => {
        try {
          osc.stop();
          osc.disconnect();
        } catch {
          // Already stopped
        }
      });
      try {
        gain.disconnect();
      } catch {
        // Already disconnected
      }
    });
    activeNodesRef.current = [];

    // 3. Stop vibration
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(0);
      } catch {
        // Ignore vibration errors
      }
    }

    // 4. Suspend AudioContext to release hardware resources
    if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
      try {
        void audioCtxRef.current.suspend().catch(() => {});
      } catch {
        // Ignore suspend error
      }
    }
  }

  function startRingtone(currentMode: 'incoming' | 'outgoing') {
    // 1. Vibration: only for incoming calls (caller device should not vibrate when dialing out)
    if (currentMode === 'incoming' && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate([400, 200, 400, 2000]);
      } catch {
        // Ignore vibration errors
      }
    }

    // 2. Initialize Web Audio API context if supported
    const AudioContextClass = typeof window !== 'undefined'
      ? (window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;

    const cycleMs = currentMode === 'outgoing' ? OUTGOING_CYCLE_MS : INCOMING_CYCLE_MS;

    if (!AudioContextClass) {
      scheduleNextCycle(currentMode, cycleMs);
      return;
    }

    try {
      if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
        audioCtxRef.current = new AudioContextClass();
      }

      const ctx = audioCtxRef.current;

      // Autoplay unlock: resume if suspended
      if (ctx.state === 'suspended') {
        ctx.resume().catch(() => {
          // Autoplay policy prevented playback until user gesture
        });

        const unlockAudio = () => {
          if (ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
          }
          window.removeEventListener('click', unlockAudio);
          window.removeEventListener('touchstart', unlockAudio);
          window.removeEventListener('keydown', unlockAudio);
        };

        window.addEventListener('click', unlockAudio, { passive: true });
        window.addEventListener('touchstart', unlockAudio, { passive: true });
        window.addEventListener('keydown', unlockAudio, { passive: true });
      }

      if (currentMode === 'outgoing') {
        playRingbackPattern(ctx);
      } else {
        playRingPattern(ctx);
      }
    } catch {
      // AudioContext creation failed
    }

    scheduleNextCycle(currentMode, cycleMs);
  }

  function scheduleNextCycle(currentMode: 'incoming' | 'outgoing', cycleMs: number) {
    cycleTimeoutRef.current = setTimeout(() => {
      startRingtone(currentMode);
    }, cycleMs);
  }

  function playRingPattern(ctx: AudioContext) {
    if (ctx.state !== 'running') {
      return;
    }
    const now = ctx.currentTime;
    // Incoming phone ring: Burst 1 (0.4s), pause 0.2s, Burst 2 (0.4s)
    scheduleToneBurst(ctx, now, 0.4, INCOMING_FREQ_A, INCOMING_FREQ_B, 0.12);
    scheduleToneBurst(ctx, now + 0.6, 0.4, INCOMING_FREQ_A, INCOMING_FREQ_B, 0.12);
  }

  function playRingbackPattern(ctx: AudioContext) {
    if (ctx.state !== 'running') {
      return;
    }
    const now = ctx.currentTime;
    // Outgoing ringback: 1 continuous gentle tone burst (1.2s tone at 400Hz+450Hz)
    scheduleToneBurst(ctx, now, 1.2, OUTGOING_FREQ_A, OUTGOING_FREQ_B, 0.08);
  }

  function scheduleToneBurst(
    ctx: AudioContext,
    startTime: number,
    duration: number,
    freqA: number,
    freqB: number,
    peakGain: number,
  ) {
    try {
      const oscA = ctx.createOscillator();
      const oscB = ctx.createOscillator();
      const burstGain = ctx.createGain();

      oscA.type = 'sine';
      oscA.frequency.setValueAtTime(freqA, startTime);

      oscB.type = 'sine';
      oscB.frequency.setValueAtTime(freqB, startTime);

      // Volume envelope with smooth attack and release to avoid audio clicks
      burstGain.gain.setValueAtTime(0, startTime);
      burstGain.gain.linearRampToValueAtTime(peakGain, startTime + 0.03);
      burstGain.gain.setValueAtTime(peakGain, startTime + duration - 0.04);
      burstGain.gain.linearRampToValueAtTime(0, startTime + duration);

      oscA.connect(burstGain);
      oscB.connect(burstGain);
      burstGain.connect(ctx.destination);

      oscA.start(startTime);
      oscB.start(startTime);
      oscA.stop(startTime + duration);
      oscB.stop(startTime + duration);

      const nodeRecord = {
        oscillators: [oscA, oscB],
        gain: burstGain,
      };

      activeNodesRef.current.push(nodeRecord);

      oscA.onended = () => {
        try {
          oscA.disconnect();
          oscB.disconnect();
          burstGain.disconnect();
        } catch {
          // Already cleaned up
        }
        activeNodesRef.current = activeNodesRef.current.filter((n) => n !== nodeRecord);
      };
    } catch {
      // Ignored if audio scheduling fails
    }
  }
}
