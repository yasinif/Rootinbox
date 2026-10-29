/**
 * CallSessionMachine — FSM for 1:1 call lifecycle.
 * Phase 12B Task 10 (§13.2, §13.6, §13.7, §13.9).
 *
 * Implements:
 * - Local state transitions: idle -> outgoing_ringing/incoming_ringing -> connecting -> connected -> ended
 * - Reconnecting state with 20s grace timer (Flag B / Option B2)
 * - 45s ring timer for inbound and outbound calls (§13.7)
 * - Terminal cleanup (single code path, idempotent) (§13.9)
 * - Clean architecture: imports domain only
 */

import type {
  CallStatus,
  CallEndReason,
  CallSessionState,
  CallType,
  CallRole,
} from '../../domain/call/types';
import {
  CALL_CONTROL_PLANE_GRACE_MS,
} from '../../domain/call/constants';
import type {
  CallMediaSession,
  CallMediaSessionFactory,
  CallStateProbe,
  CallRepository,
} from '../../domain/ports/call';

export type CallStateListener = (state: CallSessionState) => void;

export interface CallHistoryRecord {
  callId: string;
  peerId: string;
  peerIdentityHash?: string;
  peerDisplayName: string;
  role: CallRole;
  callType: CallType;
  status: 'completed' | 'missed' | 'rejected' | 'busy' | 'failed';
  duration: number;
  timestamp: number;
}

export type CallHistoryListener = (record: CallHistoryRecord) => void;

const IDLE_STATE: CallSessionState = Object.freeze({
  callId: '',
  peerId: '',
  peerIdentityHash: '',
  peerDisplayName: '',
  role: 'caller',
  status: 'idle',
  endReason: null,
  startedAt: null,
  connectedAt: null,
  duration: 0,
  iceQuality: 'good',
  isMuted: false,
  isSpeakerOn: false,
  sasDigits: null,
  sasVerified: false,
  fingerprintVerified: false,
  callType: 'audio',
  isVideoEnabled: false,
  isScreenSharing: false,
  localVideoStream: null,
  remoteVideoStream: null,
  remoteStream: null,
});

export class CallSessionMachine {
  private currentState: CallSessionState = { ...IDLE_STATE };
  private mediaSession: CallMediaSession | null = null;
  private ringTimer: ReturnType<typeof setTimeout> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private glareTimer: ReturnType<typeof setTimeout> | null = null;
  private durationInterval: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<CallStateListener>();
  private historyListeners = new Set<CallHistoryListener>();
  private previousStatusBeforeDrop: CallStatus | null = null;
  private isEnding = false;

  private sessionFactory: CallMediaSessionFactory;
  private probe: CallStateProbe;
  private callRepo?: CallRepository;

  constructor(
    sessionFactory: CallMediaSessionFactory,
    probe: CallStateProbe,
    callRepo?: CallRepository,
  ) {
    this.sessionFactory = sessionFactory;
    this.probe = probe;
    this.callRepo = callRepo;
  }

  getState(): CallSessionState {
    return this.currentState;
  }

  subscribe(listener: CallStateListener): () => void {
    this.listeners.add(listener);
    listener(this.currentState);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(patch: Partial<CallSessionState>): void {
    this.currentState = Object.freeze({
      ...this.currentState,
      ...patch,
    });
    for (const listener of this.listeners) {
      try {
        listener(this.currentState);
      } catch {
        // Listener error must not derail state machine
      }
    }
  }

  getActiveMediaSession(): CallMediaSession | null {
    return this.mediaSession;
  }

  onCallEnded(listener: CallHistoryListener): () => void {
    this.historyListeners.add(listener);
    return () => {
      this.historyListeners.delete(listener);
    };
  }

  /**
   * Start an outbound call.
   */
  async startOutbound(params: {
    callId: string;
    peerId: string;
    peerDisplayName: string;
    localIdentityHash: string;
    peerIdentityHash: string;
    peerIdentityPublicKey: string;
    callType?: CallType;
  }): Promise<CallMediaSession> {
    if (this.currentState.status !== 'idle') {
      throw new Error(`Cannot place call: active call exists in state ${this.currentState.status}`);
    }

    this.cleanupTimers();

    const mediaSession = this.sessionFactory.createSession({
      callId: params.callId,
      role: 'caller',
      localIdentityHash: params.localIdentityHash,
      peerIdentityHash: params.peerIdentityHash,
      peerIdentityPublicKey: params.peerIdentityPublicKey,
      callType: params.callType,
      callbacks: {
        onStateChange: (patch) => {
          this.emit({
            ...(patch.iceQuality ? { iceQuality: patch.iceQuality } : {}),
            ...(patch.sasDigits !== undefined ? { sasDigits: patch.sasDigits } : {}),
            ...(patch.fingerprintVerified !== undefined ? { fingerprintVerified: patch.fingerprintVerified } : {}),
            ...(patch.isVideoEnabled !== undefined ? { isVideoEnabled: patch.isVideoEnabled } : {}),
            ...(patch.isScreenSharing !== undefined ? { isScreenSharing: patch.isScreenSharing } : {}),
            ...(patch.localVideoStream !== undefined ? { localVideoStream: patch.localVideoStream } : {}),
            ...(patch.remoteVideoStream !== undefined ? { remoteVideoStream: patch.remoteVideoStream } : {}),
            ...(patch.remoteStream !== undefined ? { remoteStream: patch.remoteStream } : {}),
            ...(patch.isRemoteVideoMuted !== undefined ? { isRemoteVideoMuted: patch.isRemoteVideoMuted } : {}),
          });
          if (patch.iceQuality === 'excellent' || patch.iceQuality === 'good') {
            if (this.currentState.status === 'connecting') {
              this.onConnected();
            }
          }
        },
        onEnded: (reason) => {
          const mappedReason: CallEndReason =
            reason === 'ice_failure' ? 'ice_failure' :
            reason === 'crypto_error' ? 'crypto_error' : 'remote_hangup';
          this.endCall(mappedReason);
        },
        onError: () => {
          this.endCall('crypto_error');
        },
      },
    });

    this.mediaSession = mediaSession;
    await this.callRepo?.setActiveCallId(params.callId);

    const isVideo = params.callType === 'video';
    this.emit({
      callId: params.callId,
      peerId: params.peerId,
      peerIdentityHash: params.peerIdentityHash,
      peerDisplayName: params.peerDisplayName,
      role: 'caller',
      status: 'outgoing_ringing',
      endReason: null,
      startedAt: Date.now(),
      connectedAt: null,
      duration: 0,
      iceQuality: 'good',
      isMuted: false,
      isSpeakerOn: false,
      sasDigits: null,
      sasVerified: false,
      fingerprintVerified: false,
      callType: params.callType ?? 'audio',
      isVideoEnabled: isVideo,
      isScreenSharing: false,
      isRemoteVideoMuted: false,
      localVideoStream: null,
      remoteVideoStream: null,
      remoteStream: null,
    });

    if (isVideo) {
      void mediaSession.enableVideo?.();
    }

    // 30s Ring timer
    this.ringTimer = setTimeout(() => {
      this.endCall('timeout');
    }, 30_000);

    return mediaSession;
  }

  /**
   * Start an inbound call.
   */
  startInbound(params: {
    callId: string;
    peerId: string;
    peerDisplayName: string;
    localIdentityHash: string;
    peerIdentityHash: string;
    peerIdentityPublicKey: string;
    callType?: CallType;
  }): CallMediaSession {
    if (this.currentState.status !== 'idle') {
      throw new Error(`Cannot receive call: existing call in state ${this.currentState.status}`);
    }

    this.cleanupTimers();

    const mediaSession = this.sessionFactory.createSession({
      callId: params.callId,
      role: 'callee',
      localIdentityHash: params.localIdentityHash,
      peerIdentityHash: params.peerIdentityHash,
      peerIdentityPublicKey: params.peerIdentityPublicKey,
      callType: params.callType,
      callbacks: {
        onStateChange: (patch) => {
          this.emit({
            ...(patch.iceQuality ? { iceQuality: patch.iceQuality } : {}),
            ...(patch.sasDigits !== undefined ? { sasDigits: patch.sasDigits } : {}),
            ...(patch.fingerprintVerified !== undefined ? { fingerprintVerified: patch.fingerprintVerified } : {}),
            ...(patch.isVideoEnabled !== undefined ? { isVideoEnabled: patch.isVideoEnabled } : {}),
            ...(patch.isScreenSharing !== undefined ? { isScreenSharing: patch.isScreenSharing } : {}),
            ...(patch.localVideoStream !== undefined ? { localVideoStream: patch.localVideoStream } : {}),
            ...(patch.remoteVideoStream !== undefined ? { remoteVideoStream: patch.remoteVideoStream } : {}),
            ...(patch.remoteStream !== undefined ? { remoteStream: patch.remoteStream } : {}),
            ...(patch.isRemoteVideoMuted !== undefined ? { isRemoteVideoMuted: patch.isRemoteVideoMuted } : {}),
          });
          if (patch.iceQuality === 'excellent' || patch.iceQuality === 'good') {
            if (this.currentState.status === 'connecting') {
              this.onConnected();
            }
          }
        },
        onEnded: (reason) => {
          const mappedReason: CallEndReason =
            reason === 'ice_failure' ? 'ice_failure' :
            reason === 'crypto_error' ? 'crypto_error' : 'remote_hangup';
          this.endCall(mappedReason);
        },
        onError: () => {
          this.endCall('crypto_error');
        },
      },
    });

    this.mediaSession = mediaSession;
    this.callRepo?.setActiveCallId(params.callId);

    const isVideo = params.callType === 'video';
    this.emit({
      callId: params.callId,
      peerId: params.peerId,
      peerIdentityHash: params.peerIdentityHash,
      peerDisplayName: params.peerDisplayName,
      role: 'callee',
      status: 'incoming_ringing',
      endReason: null,
      startedAt: Date.now(),
      connectedAt: null,
      duration: 0,
      iceQuality: 'good',
      isMuted: false,
      isSpeakerOn: false,
      sasDigits: null,
      sasVerified: false,
      fingerprintVerified: false,
      callType: params.callType ?? 'audio',
      isVideoEnabled: isVideo,
      isScreenSharing: false,
      isRemoteVideoMuted: false,
      localVideoStream: null,
      remoteVideoStream: null,
      remoteStream: null,
    });

    // 30s Ring timer
    this.ringTimer = setTimeout(() => {
      this.endCall('timeout');
    }, 30_000);

    return mediaSession;
  }

  /**
   * Callee accepts inbound ringing call -> connecting.
   */
  acceptCall(): void {
    if (this.currentState.status !== 'incoming_ringing') {
      throw new Error(`Cannot accept call in state ${this.currentState.status}`);
    }
    if (this.ringTimer) {
      clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }
    this.emit({ status: 'connecting' });
  }

  /**
   * Caller receives remote answer -> connecting.
   */
  remoteAnswered(): void {
    if (this.currentState.status !== 'outgoing_ringing') {
      return;
    }
    if (this.ringTimer) {
      clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }
    this.emit({ status: 'connecting' });
  }

  /**
   * Connection established (media/ICE connected) -> active.
   */
  onConnected(): void {
    if (this.currentState.status !== 'connecting' && this.currentState.status !== 'outgoing_ringing' && this.currentState.status !== 'incoming_ringing') {
      return;
    }
    if (this.ringTimer) {
      clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }

    const now = Date.now();
    this.emit({
      status: 'connected',
      connectedAt: now,
      duration: 0,
    });

    // Start duration ticker
    if (this.durationInterval) clearInterval(this.durationInterval);
    this.durationInterval = setInterval(() => {
      if (this.currentState.status === 'connected') {
        const dur = Math.floor((Date.now() - (this.currentState.connectedAt ?? now)) / 1000);
        this.emit({ duration: dur });
      }
    }, 1000);
  }

  /**
   * WebSocket dropped during CONNECTING or ACTIVE (§13.6).
   */
  handleWsDisconnect(): void {
    if (this.currentState.status === 'connecting' || this.currentState.status === 'connected') {
      this.previousStatusBeforeDrop = this.currentState.status;
      this.emit({ status: 'reconnecting' });

      if (this.graceTimer) clearTimeout(this.graceTimer);
      this.graceTimer = setTimeout(() => {
        // Grace timer expired (§13.6): CONTROL_PLANE_LOST
        this.graceTimer = null;
        this.endCall('ws_drop');
      }, CALL_CONTROL_PLANE_GRACE_MS);
    }
  }

  /**
   * WebSocket reconnected before grace timer expiry (§13.6).
   */
  async handleWsReconnect(localIdentityHash: string): Promise<void> {
    if (this.currentState.status === 'reconnecting') {
      if (this.graceTimer) {
        clearTimeout(this.graceTimer);
        this.graceTimer = null;
      }

      // Check probe seam
      const isAlive = await this.probe.isCallAlive(this.currentState.callId, localIdentityHash);
      if (isAlive || isAlive === undefined) {
        // Probe says alive (or 'unknown' which resolves true/alive)
        const targetStatus = this.previousStatusBeforeDrop ?? 'connected';
        this.previousStatusBeforeDrop = null;
        this.emit({ status: targetStatus });
      } else {
        this.endCall('ws_drop');
      }
    }
  }

  /**
   * Mute toggle.
   */
  setMuted(muted: boolean): void {
    this.mediaSession?.setMuted(muted);
    this.emit({ isMuted: muted });
  }

  /**
   * Speaker toggle.
   */
  setSpeaker(speaker: boolean): void {
    this.emit({ isSpeakerOn: speaker });
  }

  /**
   * User marks SAS verified.
   */
  verifySas(): void {
    this.emit({ sasVerified: true });
  }

  /**
   * Abandon losing outbound call in glare collision to immediately accept inbound canonical call (§14.5).
   */
  yieldToGlare(): void {
    this.cleanupTimers();
    if (this.mediaSession) {
      try {
        this.mediaSession.terminate('glare_yield');
      } catch {
        // ignore
      }
      this.mediaSession = null;
    }
    this.callRepo?.setActiveCallId(null);
    this.currentState = { ...IDLE_STATE };
    this.emit(IDLE_STATE);
  }

  /**
   * Toggle camera video stream.
   */
  async toggleVideo(): Promise<void> {
    if (!this.mediaSession) return;
    if (this.currentState.isVideoEnabled) {
      this.mediaSession.disableVideo?.();
      this.emit({
        isVideoEnabled: false,
        localVideoStream: this.currentState.isScreenSharing ? this.currentState.localVideoStream : null,
      });
    } else {
      const stream = await this.mediaSession.enableVideo?.();
      this.emit({
        isVideoEnabled: true,
        localVideoStream: stream,
      });
    }
  }

  /**
   * Toggle screen sharing stream.
   */
  async toggleScreenShare(): Promise<void> {
    if (!this.mediaSession) return;
    if (this.currentState.isScreenSharing) {
      await this.mediaSession.stopScreenShare?.();
      this.emit({
        isScreenSharing: false,
        localVideoStream: this.currentState.isVideoEnabled ? this.mediaSession.getLocalVideoStream?.() : null,
      });
    } else {
      const stream = await this.mediaSession.startScreenShare?.();
      if (stream) {
        this.emit({
          isScreenSharing: true,
          localVideoStream: stream,
        });
      }
    }
  }

  /**
   * Switch camera (front/back) on mobile or multi-camera devices.
   */
  async switchCamera(): Promise<void> {
    if (!this.mediaSession) return;
    await this.mediaSession.switchCamera?.();
  }

  /**
   * Terminal cleanup (§13.9).
   * Single code path, always executed, idempotent.
   */
  endCall(reason: CallEndReason = 'local_hangup'): void {
    if (this.currentState.status === 'ended' || this.isEnding) {
      return; // Idempotent under multiple calls & prevents re-entrancy
    }
    this.isEnding = true;

    try {
      const finalDuration = this.currentState.duration;
      const finalRole = this.currentState.role;
      const finalCallType = this.currentState.callType ?? 'audio';
      const finalPeerId = this.currentState.peerId;
      const finalPeerHash = this.currentState.peerIdentityHash;
      const finalPeerName = this.currentState.peerDisplayName;
      const finalCallId = this.currentState.callId;
      const wasConnected = !!this.currentState.connectedAt;

      // Mark ended immediately to block any re-entrant calls
      this.currentState = Object.freeze({
        ...this.currentState,
        status: 'ended',
        endReason: reason,
      });

      let callHistStatus: 'completed' | 'missed' | 'rejected' | 'busy' | 'failed';
      if (wasConnected) {
        callHistStatus = 'completed';
      } else if (reason === 'remote_reject') {
        callHistStatus = 'rejected';
      } else if (reason === 'remote_busy') {
        callHistStatus = 'busy';
      } else if (reason === 'timeout' || reason === 'remote_hangup' || reason === 'local_hangup') {
        callHistStatus = 'missed';
      } else {
        callHistStatus = 'failed';
      }

      if (finalCallId && finalPeerId) {
        const record: CallHistoryRecord = {
          callId: finalCallId,
          peerId: finalPeerId,
          peerIdentityHash: finalPeerHash,
          peerDisplayName: finalPeerName,
          role: finalRole,
          callType: finalCallType,
          status: callHistStatus,
          duration: finalDuration,
          timestamp: Date.now(),
        };
        for (const hl of this.historyListeners) {
          try {
            hl(record);
          } catch {
            // ignore listener errors
          }
        }
      }

      this.cleanupTimers();

      if (this.mediaSession) {
        try {
          this.mediaSession.terminate(reason);
        } catch {
          // Ignore termination errors
        }
        this.mediaSession = null;
      }

      this.callRepo?.setActiveCallId(null);

      this.emit({
        status: 'ended',
        endReason: reason,
        remoteStream: null,
        remoteVideoStream: null,
        localVideoStream: null,
        isRemoteVideoMuted: false,
      });
    } finally {
      this.isEnding = false;
    }
  }

  /**
   * Return to IDLE after viewing ended screen.
   */
  resetToIdle(): void {
    this.cleanupTimers();
    this.currentState = { ...IDLE_STATE };
    this.emit(IDLE_STATE);
  }

  private cleanupTimers(): void {
    if (this.ringTimer) {
      clearTimeout(this.ringTimer);
      this.ringTimer = null;
    }
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    if (this.glareTimer) {
      clearTimeout(this.glareTimer);
      this.glareTimer = null;
    }
    if (this.durationInterval) {
      clearInterval(this.durationInterval);
      this.durationInterval = null;
    }
  }
}
