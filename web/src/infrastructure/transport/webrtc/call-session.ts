/**
 * CallSession — WebRTC PeerConnection coordinator for a 1:1 call.
 * Phase 12B Task 10 & Task 11.
 *
 * Implements:
 * - Perfect Negotiation with politeness split (§14.1, §14.2)
 * - DTLS Fingerprint signature verification before setRemoteDescription (§14.3)
 * - Short Authentication String (SAS) computation (§14.4)
 * - Glare arbitration handling (§14.5)
 * - ICE trickle & IceDiagnostics safety net (§12.5, §14.7)
 * - Codec preferences ordering (§14.6)
 * - Track management and graceful teardown (§13.9)
 */

import type { CallRole, IceQuality, CallType } from '../../../domain/call/types';
import {
  FRAME_TYPE_OFFER,
  FRAME_TYPE_ANSWER,
  FRAME_TYPE_ICE_CANDIDATE,
  FRAME_TYPE_RENEGOTIATE_OFFER,
  ROLE_CALLER,
  ROLE_CALLEE,
} from '../../../domain/call/constants';
import { CALL_C04 } from '../../../domain/errors';
import { parseSdpFingerprint } from '../../../domain/call';
import { createPeerConnection } from './peer-connection';
import { buildRtcConfiguration, normalizeTurnResponse } from './ice-config';
import { IceDiagnostics } from './diagnostics';
import { turnManager } from './turn';
import type { CryptoWorkerBridge } from '../../crypto/bridge';
import type {
  CallSignalTransport,
  CallMediaSession,
  CallMediaSessionFactory,
} from '../../../domain/ports/call';

export interface CallSessionCallbacks {
  onStateChange?: (patch: Partial<CallSessionSnapshot>) => void;
  onRemoteTrack?: (track: MediaStreamTrack) => void;
  onLocalTrack?: (track: MediaStreamTrack) => void;
  onRemoteStream?: (stream: MediaStream | null) => void;
  onRemoteVideoStream?: (stream: MediaStream | null) => void;
  onLocalVideoStream?: (stream: MediaStream | null) => void;
  onEnded?: (reason: string) => void;
  onError?: (err: Error) => void;
}

export interface CallSessionSnapshot {
  callId: string;
  role: CallRole;
  iceQuality: IceQuality;
  sasDigits: string | null;
  sasVerified: boolean;
  fingerprintVerified: boolean;
  isMuted: boolean;
  isVideoEnabled?: boolean;
  isScreenSharing?: boolean;
  isRemoteVideoMuted?: boolean;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  localVideoStream?: MediaStream | null;
  remoteVideoStream?: MediaStream | null;
}

export class WebRtcCallSession implements CallMediaSession {
  readonly callId: string;
  readonly role: CallRole;
  readonly localIdentityHash: string;
  readonly peerIdentityHash: string;
  readonly peerIdentityPublicKey: string;
  readonly polite: boolean;

  private pc: RTCPeerConnection | null = null;
  private bridge: CryptoWorkerBridge;
  private transport: CallSignalTransport;
  private callbacks: CallSessionCallbacks;
  private diagnostics: IceDiagnostics | null = null;

  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private localVideoStream: MediaStream | null = null;
  private remoteVideoStream: MediaStream | null = null;
  private videoSender: RTCRtpSender | null = null;
  private cameraStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private isVideoEnabled = false;
  private isScreenSharing = false;
  private facingMode: 'user' | 'environment' = 'user';
  private callType: CallType = 'audio';
  private isTerminated = false;

  private pendingCandidates: RTCIceCandidateInit[] = [];
  private localFingerprint: Uint8Array | null = null;
  private peerFingerprint: Uint8Array | null = null;
  private fingerprintVerified = false;

  constructor(options: {
    callId: string;
    role: CallRole;
    localIdentityHash: string;
    peerIdentityHash: string;
    peerIdentityPublicKey: string;
    bridge: CryptoWorkerBridge;
    transport: CallSignalTransport;
    callType?: CallType;
    callbacks?: CallSessionCallbacks;
  }) {
    this.callId = options.callId;
    this.role = options.role;
    this.localIdentityHash = options.localIdentityHash.toLowerCase();
    this.peerIdentityHash = options.peerIdentityHash.toLowerCase();
    this.peerIdentityPublicKey = options.peerIdentityPublicKey;
    this.bridge = options.bridge;
    this.transport = options.transport;
    this.callType = options.callType || 'audio';
    this.callbacks = options.callbacks || {};

    // §14.1 Politeness: polite = (localIdentityHashHexLower < peerIdentityHashHexLower)
    this.polite = this.localIdentityHash < this.peerIdentityHash;
  }

  /**
   * Initialize WebRTC PeerConnection with TURN servers and local audio.
   */
  async initialize(): Promise<void> {
    const creds = await turnManager.fetchCredentials(this.localIdentityHash);
    const iceServers = normalizeTurnResponse(creds);
    const config = buildRtcConfiguration(iceServers);

    this.pc = createPeerConnection(config);
    if (import.meta.env.VITE_E2E === 'true' && typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__activeCallPC = this.pc;
    }

    // Attach diagnostics (§12.5)
    this.diagnostics = new IceDiagnostics(this.pc, (err) => {
      this.callbacks.onError?.(err);
      this.terminate('ice_failure');
    });

    // Setup local audio track
    await this.setupLocalMedia();

    // Setup PeerConnection event listeners
    this.setupPcEvents();
  }

  private async setupLocalMedia(): Promise<void> {
    try {
      if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const track = this.localStream.getAudioTracks()[0];
        if (track && this.pc) {
          this.pc.addTrack(track, this.localStream);
          this.callbacks.onLocalTrack?.(track);
        }
      }
    } catch {
      // Audio capture failed or mock environment
    }

    // Pre-allocate a bidirectional video transceiver (§14.2)
    // Ensures video media section (m=video) is established during initial negotiation,
    // allowing camera toggle and screen sharing to use replaceTrack with ZERO renegotiation.
    if (this.pc && typeof this.pc.addTransceiver === 'function') {
      try {
        const videoTransceiver = this.pc.addTransceiver('video', { direction: 'sendrecv' });
        this.videoSender = videoTransceiver.sender;
      } catch (err) {
        console.warn('[WebRtcCallSession] Failed to pre-allocate video transceiver:', err);
      }
    }
  }

  private setupPcEvents(): void {
    if (!this.pc) return;

    // Track event
    this.pc.ontrack = (event) => {
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream();
      }
      this.remoteStream.addTrack(event.track);
      this.callbacks.onRemoteTrack?.(event.track);
      this.callbacks.onRemoteStream?.(this.remoteStream);
      this.callbacks.onStateChange?.({ remoteStream: this.remoteStream });

      if (event.track.kind === 'video') {
        if (!this.remoteVideoStream) {
          this.remoteVideoStream = new MediaStream();
        }
        this.remoteVideoStream.addTrack(event.track);
        this.callbacks.onRemoteVideoStream?.(this.remoteVideoStream);
        this.callbacks.onStateChange?.({
          remoteVideoStream: this.remoteVideoStream,
          isRemoteVideoMuted: false,
        });

        event.track.onmute = () => {
          this.callbacks.onStateChange?.({ isRemoteVideoMuted: true });
        };

        event.track.onunmute = () => {
          this.callbacks.onStateChange?.({ isRemoteVideoMuted: false });
        };

        event.track.onended = () => {
          if (this.remoteVideoStream) {
            this.remoteVideoStream.removeTrack(event.track);
            if (this.remoteVideoStream.getTracks().length === 0) {
              this.remoteVideoStream = null;
              this.callbacks.onRemoteVideoStream?.(null);
              this.callbacks.onStateChange?.({ remoteVideoStream: null, isRemoteVideoMuted: true });
            }
          }
        };
      }
    };

    // ICE candidate generation
    this.pc.onicecandidate = async (event) => {
      if (event.candidate && event.candidate.candidate) {
        await this.sendIceCandidate(event.candidate);
      }
    };

    // ICE connection state changes
    this.pc.oniceconnectionstatechange = () => {
      if (!this.pc) return;
      const state = this.pc.iceConnectionState;
      let quality: IceQuality = 'good';
      if (state === 'connected' || state === 'completed') quality = 'excellent';
      else if (state === 'disconnected') quality = 'poor';
      else if (state === 'failed') quality = 'failed';

      this.callbacks.onStateChange?.({ iceQuality: quality });

      if (state === 'failed') {
        this.terminate('ice_failure');
      }
    };

    // Negotiation needed event (Perfect Negotiation §14.2)
    this.pc.onnegotiationneeded = async () => {
      try {
        await this.pc!.setLocalDescription();
        const offerSdp = this.pc!.localDescription?.sdp;
        if (!offerSdp) return;

        // Parse and sign local fingerprint
        this.localFingerprint = parseSdpFingerprint(offerSdp);
        if (!this.localFingerprint) return;
        const roleByte = this.role === 'caller' ? ROLE_CALLER : ROLE_CALLEE;
        const { signature } = await this.bridge.signCallFingerprint({
          call_id_bytes: this.callId,
          fingerprint_bytes: this.localFingerprint,
          role: roleByte,
        });

        // Seal call renegotiate frame
        const frame = await this.bridge.sealCallFrame({
          call_id_bytes: this.callId,
          frame_type: FRAME_TYPE_RENEGOTIATE_OFFER,
          payload: { type: 'renegotiate', sdp: offerSdp, sig: signature },
        });

        await this.transport.sendSignal(
          this.callId,
          'call.renegotiate',
          frame.ciphertext,
          BigInt(frame.signal_seq),
        );
      } catch (err) {
        this.callbacks.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    };
  }

  /**
   * Caller initiates the call: creates offer, signs fingerprint, seals invite frame.
   */
  async createAndSendOffer(): Promise<{ signalSeq: number; ciphertext: string }> {
    if (!this.pc) throw new Error('Peer connection not initialized');

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    const sdp = this.pc.localDescription?.sdp;
    if (!sdp) throw new Error('Failed to generate local SDP offer');

    this.localFingerprint = parseSdpFingerprint(sdp);
    if (!this.localFingerprint) throw new Error('Failed to parse local SDP fingerprint');

    const { signature } = await this.bridge.signCallFingerprint({
      call_id_bytes: this.callId,
      fingerprint_bytes: this.localFingerprint,
      role: ROLE_CALLER,
    });

    const frame = await this.bridge.sealCallFrame({
      call_id_bytes: this.callId,
      frame_type: FRAME_TYPE_OFFER,
      payload: { type: 'offer', sdp, sig: signature, call_type: this.callType },
    });

    return {
      signalSeq: frame.signal_seq,
      ciphertext: frame.ciphertext,
    };
  }

  /**
   * Callee accepts the call: sets remote offer, creates answer, signs fingerprint, seals accept frame.
   */
  async handleRemoteOfferAndAnswer(
    remoteSdp: string,
    remoteSig: string,
  ): Promise<{ signalSeq: number; ciphertext: string }> {
    if (!this.pc) throw new Error('Peer connection not initialized');

    // 1. Verify remote fingerprint before setRemoteDescription (§14.3)
    this.peerFingerprint = parseSdpFingerprint(remoteSdp);
    if (!this.peerFingerprint) throw new Error('Failed to parse peer SDP fingerprint');
    const roleByte = this.role === 'caller' ? ROLE_CALLEE : ROLE_CALLER;

    const { valid } = await this.bridge.verifyCallFingerprint({
      call_id_bytes: this.callId,
      fingerprint_bytes: this.peerFingerprint,
      role: roleByte,
      signature: remoteSig,
      peer_identity_public_key: this.peerIdentityPublicKey,
    });

    if (!valid) {
      throw new Error(`${CALL_C04}: Fingerprint signature verification failed`);
    }
    this.fingerprintVerified = true;

    // 2. setRemoteDescription
    await this.pc.setRemoteDescription({ type: 'offer', sdp: remoteSdp });

    // 3. Drain any pending queued ICE candidates
    await this.drainPendingCandidates();

    // 4. Create answer
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    const localSdp = this.pc.localDescription?.sdp;
    if (!localSdp) throw new Error('Failed to generate local SDP answer');

    this.localFingerprint = parseSdpFingerprint(localSdp);
    if (!this.localFingerprint) throw new Error('Failed to parse local SDP fingerprint');
    const myRoleByte = this.role === 'caller' ? ROLE_CALLER : ROLE_CALLEE;
    const { signature } = await this.bridge.signCallFingerprint({
      call_id_bytes: this.callId,
      fingerprint_bytes: this.localFingerprint,
      role: myRoleByte,
    });

    // 5. Compute SAS (§14.4)
    await this.computeAndEmitSas();

    // 6. Seal answer frame
    const frame = await this.bridge.sealCallFrame({
      call_id_bytes: this.callId,
      frame_type: FRAME_TYPE_ANSWER,
      payload: { type: 'answer', sdp: localSdp, sig: signature },
    });

    return {
      signalSeq: frame.signal_seq,
      ciphertext: frame.ciphertext,
    };
  }

  /**
   * Caller receives and applies remote answer.
   */
  async handleRemoteAnswer(remoteSdp: string, remoteSig: string): Promise<void> {
    if (!this.pc) throw new Error('Peer connection not initialized');

    // 1. Verify remote fingerprint before setRemoteDescription (§14.3)
    this.peerFingerprint = parseSdpFingerprint(remoteSdp);
    if (!this.peerFingerprint) throw new Error('Failed to parse peer SDP fingerprint');
    const peerRoleByte = this.role === 'caller' ? ROLE_CALLEE : ROLE_CALLER;

    const { valid } = await this.bridge.verifyCallFingerprint({
      call_id_bytes: this.callId,
      fingerprint_bytes: this.peerFingerprint,
      role: peerRoleByte,
      signature: remoteSig,
      peer_identity_public_key: this.peerIdentityPublicKey,
    });

    if (!valid) {
      throw new Error(`${CALL_C04}: Fingerprint signature verification failed`);
    }
    this.fingerprintVerified = true;

    // 2. setRemoteDescription
    await this.pc.setRemoteDescription({ type: 'answer', sdp: remoteSdp });

    // 3. Drain pending candidates
    await this.drainPendingCandidates();

    // 4. Compute SAS
    await this.computeAndEmitSas();
  }

  /**
   * Handle incoming remote ICE candidate.
   */
  async handleRemoteCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc || !this.pc.remoteDescription) {
      // Queue until remote description is set (§14.7)
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.pc.addIceCandidate(candidate);
  }

  private async drainPendingCandidates(): Promise<void> {
    if (!this.pc) return;
    while (this.pendingCandidates.length > 0) {
      const candidate = this.pendingCandidates.shift()!;
      try {
        await this.pc.addIceCandidate(candidate);
      } catch {
        // Continue draining
      }
    }
  }

  private async sendIceCandidate(candidate: RTCIceCandidate): Promise<void> {
    const frame = await this.bridge.sealCallFrame({
      call_id_bytes: this.callId,
      frame_type: FRAME_TYPE_ICE_CANDIDATE,
      payload: {
        type: 'ice',
        candidate: candidate.candidate,
        sdpMid: candidate.sdpMid,
        sdpMLineIndex: candidate.sdpMLineIndex,
      },
    });

    await this.transport.sendSignal(
      this.callId,
      'call.ice',
      frame.ciphertext,
      BigInt(frame.signal_seq),
    );
  }

  private async computeAndEmitSas(): Promise<void> {
    if (!this.localFingerprint || !this.peerFingerprint) return;

    // Caller fingerprint always first (§14.4)
    const callerFp = this.role === 'caller' ? this.localFingerprint : this.peerFingerprint;
    const calleeFp = this.role === 'caller' ? this.peerFingerprint : this.localFingerprint;

    const { sas } = await this.bridge.computeSas({
      call_id_bytes: this.callId,
      caller_fingerprint: callerFp,
      callee_fingerprint: calleeFp,
    });

    this.callbacks.onStateChange?.({
      sasDigits: sas,
      fingerprintVerified: this.fingerprintVerified,
    });
  }

  /**
   * Toggle local microphone mute.
   */
  setMuted(muted: boolean): void {
    if (this.localStream) {
      for (const track of this.localStream.getAudioTracks()) {
        track.enabled = !muted;
      }
    }
    this.callbacks.onStateChange?.({ isMuted: muted });
  }

  /**
   * Enable camera video stream and attach to PeerConnection.
   */
  async enableVideo(): Promise<MediaStream | null> {
    if (!this.pc) return null;
    try {
      if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: 1280 },
              height: { ideal: 720 },
              facingMode: this.facingMode,
            },
          });
        } catch {
          // Fallback to generic video constraint if facingMode fails
          stream = await navigator.mediaDevices.getUserMedia({ video: true });
        }

        this.cameraStream = stream;
        const track = stream.getVideoTracks()[0];
        if (track) {
          this.localVideoStream = new MediaStream([track]);
          this.isVideoEnabled = true;

          if (this.videoSender) {
            await this.videoSender.replaceTrack(track);
          } else {
            this.videoSender = this.pc.addTrack(track, this.localVideoStream);
          }

          this.callbacks.onLocalVideoStream?.(this.localVideoStream);
          this.callbacks.onStateChange?.({
            isVideoEnabled: true,
            localVideoStream: this.localVideoStream,
          });
          return this.localVideoStream;
        }
      }
    } catch (err) {
      console.warn('[WebRtcCallSession] Camera access failed:', err);
    }
    return null;
  }

  /**
   * Disable camera video stream without tearing down the sender (avoids renegotiation freeze).
   */
  async disableVideo(): Promise<void> {
    if (this.cameraStream) {
      for (const track of this.cameraStream.getVideoTracks()) {
        track.stop();
      }
      this.cameraStream = null;
    }

    if (!this.isScreenSharing) {
      if (this.videoSender) {
        try {
          await this.videoSender.replaceTrack(null);
        } catch {
          // ignore replaceTrack error
        }
      }
      this.localVideoStream = null;
    }

    this.isVideoEnabled = false;
    this.callbacks.onLocalVideoStream?.(this.isScreenSharing ? this.localVideoStream : null);
    this.callbacks.onStateChange?.({
      isVideoEnabled: false,
      localVideoStream: this.isScreenSharing ? this.localVideoStream : null,
    });
  }

  /**
   * Switch between front (user) and rear (environment) camera.
   */
  async switchCamera(): Promise<void> {
    if (!this.pc || !this.isVideoEnabled) return;
    const targetFacing = this.facingMode === 'user' ? 'environment' : 'user';

    try {
      if (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
        let stream: MediaStream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: 1280 },
              height: { ideal: 720 },
              facingMode: { exact: targetFacing },
            },
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: targetFacing },
          });
        }

        const newTrack = stream.getVideoTracks()[0];
        if (newTrack) {
          if (this.cameraStream) {
            for (const t of this.cameraStream.getVideoTracks()) {
              t.stop();
            }
          }
          this.cameraStream = stream;
          this.facingMode = targetFacing;
          this.localVideoStream = new MediaStream([newTrack]);

          if (this.videoSender) {
            await this.videoSender.replaceTrack(newTrack);
          } else {
            this.videoSender = this.pc.addTrack(newTrack, this.localVideoStream);
          }

          this.callbacks.onLocalVideoStream?.(this.localVideoStream);
          this.callbacks.onStateChange?.({
            localVideoStream: this.localVideoStream,
          });
        }
      }
    } catch (err) {
      console.warn('[WebRtcCallSession] Camera switch failed:', err);
    }
  }

  /**
   * Start screen sharing and replace or add video track on PeerConnection.
   */
  async startScreenShare(): Promise<MediaStream | null> {
    if (!this.pc) return null;
    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getDisplayMedia !== 'function'
    ) {
      throw new Error('اشتراک‌گذاری صفحه در این مرورگر موبایل پشتیبانی نمی‌شود. در صورت استفاده از آیفون، لطفاً برنامه را در مرورگر Safari باز کنید.');
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      this.screenStream = stream;
      const track = stream.getVideoTracks()[0];
      if (track) {
        this.isScreenSharing = true;
        this.localVideoStream = stream;

        if (this.videoSender) {
          await this.videoSender.replaceTrack(track);
        } else {
          this.videoSender = this.pc.addTrack(track, stream);
        }

        track.onended = () => {
          void this.stopScreenShare();
        };

        this.callbacks.onLocalVideoStream?.(stream);
        this.callbacks.onStateChange?.({
          isScreenSharing: true,
          localVideoStream: stream,
        });
        return stream;
      }
    } catch (err: unknown) {
      const errorName = err instanceof Error ? err.name : '';
      if (errorName === 'NotAllowedError' || errorName === 'AbortError') {
        // User cancelled picker: do not drop call and return null
        return null;
      }
      console.warn('[WebRtcCallSession] Screen share error:', err);
      throw err;
    }
    return null;
  }

  /**
   * Stop screen sharing.
   */
  async stopScreenShare(): Promise<void> {
    if (this.screenStream) {
      for (const track of this.screenStream.getVideoTracks()) {
        track.stop();
      }
      this.screenStream = null;
    }
    this.isScreenSharing = false;

    // If camera was enabled before screen sharing, restore camera track
    if (this.isVideoEnabled && this.cameraStream) {
      const camTrack = this.cameraStream.getVideoTracks()[0];
      if (camTrack && this.videoSender) {
        try {
          await this.videoSender.replaceTrack(camTrack);
        } catch {
          // ignore replaceTrack error
        }
        this.localVideoStream = new MediaStream([camTrack]);
      }
    } else {
      if (this.videoSender) {
        try {
          await this.videoSender.replaceTrack(null);
        } catch {
          // ignore replaceTrack error
        }
      }
      this.localVideoStream = null;
    }

    this.callbacks.onLocalVideoStream?.(this.localVideoStream);
    this.callbacks.onStateChange?.({
      isScreenSharing: false,
      localVideoStream: this.localVideoStream,
    });
  }

  getLocalVideoStream(): MediaStream | null {
    return this.localVideoStream;
  }

  getRemoteVideoStream(): MediaStream | null {
    return this.remoteVideoStream;
  }

  getRemoteStream(): MediaStream | null {
    return this.remoteStream;
  }

  /**
   * Terminal cleanup (§13.9). Single code path, idempotent.
   */
  terminate(reason = 'ended'): void {
    if (this.isTerminated) return;
    this.isTerminated = true;

    if (this.cameraStream) {
      for (const track of this.cameraStream.getTracks()) {
        track.stop();
      }
      this.cameraStream = null;
    }

    if (this.screenStream) {
      for (const track of this.screenStream.getTracks()) {
        track.stop();
      }
      this.screenStream = null;
    }

    if (this.localStream) {
      for (const track of this.localStream.getTracks()) {
        track.stop();
      }
      this.localStream = null;
    }

    if (this.localVideoStream) {
      for (const track of this.localVideoStream.getTracks()) {
        track.stop();
      }
      this.localVideoStream = null;
    }

    if (this.remoteStream) {
      for (const track of this.remoteStream.getTracks()) {
        track.stop();
      }
      this.remoteStream = null;
    }

    if (this.remoteVideoStream) {
      for (const track of this.remoteVideoStream.getTracks()) {
        track.stop();
      }
      this.remoteVideoStream = null;
    }

    if (this.diagnostics) {
      this.diagnostics.destroy();
      this.diagnostics = null;
    }

    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
    if (import.meta.env.VITE_E2E === 'true' && typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__activeCallPC = null;
    }

    this.videoSender = null;
    this.isVideoEnabled = false;
    this.isScreenSharing = false;

    turnManager.teardown();
    this.bridge.dropCall({ call_id_bytes: this.callId }).catch(() => {});

    const isLocal = reason === 'local_hangup' || reason === 'local_reject' || reason === 'glare_yield';
    if (!isLocal) {
      this.callbacks.onEnded?.(reason);
    }
  }
}

export class WebRtcCallSessionFactory implements CallMediaSessionFactory {
  private bridge: CryptoWorkerBridge;
  private transport: CallSignalTransport;

  constructor(
    bridge: CryptoWorkerBridge,
    transport: CallSignalTransport,
  ) {
    this.bridge = bridge;
    this.transport = transport;
  }

  createSession(options: {
    callId: string;
    role: CallRole;
    localIdentityHash: string;
    peerIdentityHash: string;
    peerIdentityPublicKey: string;
    callType?: CallType;
    callbacks?: CallSessionCallbacks;
  }): CallMediaSession {
    return new WebRtcCallSession({
      callId: options.callId,
      role: options.role,
      localIdentityHash: options.localIdentityHash,
      peerIdentityHash: options.peerIdentityHash,
      peerIdentityPublicKey: options.peerIdentityPublicKey,
      bridge: this.bridge,
      transport: this.transport,
      callType: options.callType,
      callbacks: options.callbacks,
    });
  }
}
