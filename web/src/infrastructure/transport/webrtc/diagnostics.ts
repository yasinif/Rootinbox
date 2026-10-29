/**
 * ICE Diagnostics & Safety Net.
 * Phase 12B §12.5 (Task 9).
 *
 * Rules:
 * - Subscribes to icecandidateerror on RTCPeerConnection.
 * - Tracks gathered candidate types.
 * - If no 'relay' candidate has been gathered within 5s AND every observed error carries errorCode === 701:
 *   surfaces CALL_C08 with fixed message "Cannot reach the call relay."
 * - Only records host:port and errorCode; NEVER credentials or full URLs.
 */

import { CALL_C08 } from '../../../domain/errors';

export interface RecordedIceError {
  hostPort: string;
  errorCode: number;
  errorText: string;
}

export class IceDiagnostics {
  private pc: RTCPeerConnection;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private hasRelayCandidate = false;
  private errors: RecordedIceError[] = [];
  private onRelayUnreachableCallback: ((err: Error) => void) | null = null;

  constructor(pc: RTCPeerConnection, onRelayUnreachable?: (err: Error) => void) {
    this.pc = pc;
    this.onRelayUnreachableCallback = onRelayUnreachable ?? null;
    this.attach();
  }

  private attach(): void {
    this.pc.addEventListener('icecandidate', (event: Event) => {
      const iceEvent = event as RTCPeerConnectionIceEvent;
      if (iceEvent.candidate && iceEvent.candidate.type === 'relay') {
        this.hasRelayCandidate = true;
      }
    });

    this.pc.addEventListener('icecandidateerror', (event: Event) => {
      const e = event as RTCPeerConnectionIceErrorEvent;
      const errorDetails = e as unknown as { host?: string; address?: string };
      const host = errorDetails.host ?? errorDetails.address ?? 'unknown';
      const hostPort = `${host}:${e.port ?? 0}`;
      this.errors.push({
        hostPort,
        errorCode: e.errorCode,
        errorText: e.errorText ?? '',
      });
    });

    this.timer = setTimeout(() => {
      this.evaluate();
    }, 5000);
  }

  private evaluate(): void {
    if (this.hasRelayCandidate) return;

    if (this.errors.length > 0 && this.errors.every((e) => e.errorCode === 701)) {
      const err = new Error(`${CALL_C08}: Cannot reach the call relay.`);
      this.onRelayUnreachableCallback?.(err);
    }
  }

  getErrors(): ReadonlyArray<RecordedIceError> {
    return this.errors;
  }

  destroy(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
