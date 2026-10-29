/**
 * Call Domain Ports.
 * Phase 12B §7.7: Interfaces the use case layer depends on.
 * Implementations live in infrastructure/.
 */

import type { TurnCredentials, PendingCall, CallRole, IceQuality, CallType } from '../call';

/** Call crypto operations executed inside the crypto worker. */
export interface CallCryptoPort {
  deriveCallKeys(params: {
    call_id_bytes: string | Uint8Array;
    peer_identity_hash: string | Uint8Array;
    peer_session_id?: string | Uint8Array;
    peer_session_pk?: string | Uint8Array;
    role: number;
  }): Promise<{ ok: boolean }>;

  signCallFingerprint(params: {
    call_id_bytes: string | Uint8Array;
    fingerprint_bytes: string | Uint8Array;
    role: number;
  }): Promise<{ signature: string }>;

  verifyCallFingerprint(params: {
    call_id_bytes: string | Uint8Array;
    fingerprint_bytes: string | Uint8Array;
    role: number;
    signature: string;
    peer_identity_public_key: string;
  }): Promise<{ valid: boolean }>;

  sealCallFrame(params: {
    call_id_bytes: string | Uint8Array;
    frame_type: number;
    payload: Record<string, unknown>;
  }): Promise<{ ciphertext: string; signal_seq: number }>;

  openCallFrame(params: {
    call_id_bytes: string | Uint8Array;
    frame_type: number;
    ciphertext: string;
    signal_seq: number;
  }): Promise<{ payload: Record<string, unknown> }>;

  computeSas(params: {
    call_id_bytes: string | Uint8Array;
    caller_fingerprint: string | Uint8Array;
    callee_fingerprint: string | Uint8Array;
  }): Promise<{ sas: string }>;

  dropCall(params: { call_id_bytes: string | Uint8Array }): Promise<{ ok: boolean }>;
}

/** Call media session callbacks. */
export interface CallMediaSessionCallbacks {
  onStateChange?: (patch: {
    iceQuality?: IceQuality;
    sasDigits?: string | null;
    sasVerified?: boolean;
    fingerprintVerified?: boolean;
    isVideoEnabled?: boolean;
    isScreenSharing?: boolean;
    isRemoteVideoMuted?: boolean;
    localVideoStream?: MediaStream | null;
    remoteVideoStream?: MediaStream | null;
    remoteStream?: MediaStream | null;
  }) => void;
  onRemoteTrack?: (track: unknown) => void;
  onLocalTrack?: (track: unknown) => void;
  onRemoteVideoStream?: (stream: MediaStream | null) => void;
  onLocalVideoStream?: (stream: MediaStream | null) => void;
  onEnded?: (reason: string) => void;
  onError?: (err: Error) => void;
}

/** Interface for WebRTC media session coordination. */
export interface CallMediaSession {
  readonly callId: string;
  readonly role: CallRole;
  readonly polite: boolean;
  initialize(): Promise<void>;
  createAndSendOffer(): Promise<{ signalSeq: number; ciphertext: string }>;
  handleRemoteOfferAndAnswer(remoteSdp: string, remoteSig: string): Promise<{ signalSeq: number; ciphertext: string }>;
  handleRemoteAnswer(remoteSdp: string, remoteSig: string): Promise<void>;
  handleRemoteCandidate(candidate: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null }): Promise<void>;
  setMuted(muted: boolean): void;
  terminate(reason?: string): void;
  enableVideo?(): Promise<MediaStream | null>;
  disableVideo?(): void;
  switchCamera?(): Promise<void>;
  startScreenShare?(): Promise<MediaStream | null>;
  stopScreenShare?(): Promise<void>;
  getLocalVideoStream?(): MediaStream | null;
  getRemoteVideoStream?(): MediaStream | null;
}

/** Factory to instantiate CallMediaSession implementations. */
export interface CallMediaSessionFactory {
  createSession(options: {
    callId: string;
    role: CallRole;
    localIdentityHash: string;
    peerIdentityHash: string;
    peerIdentityPublicKey: string;
    callType?: CallType;
    callbacks?: CallMediaSessionCallbacks;
  }): CallMediaSession;
}

/** Transport for sending/receiving encrypted call signaling frames. */
export interface CallSignalTransport {
  /** Send an encrypted signaling frame to the peer via WS. */
  sendSignal(
    callId: string,
    frameType: string,
    encryptedPayload: string,
    signalSeq: bigint,
    routingId?: string,
  ): void;

  /** Register a handler for incoming signaling frames. */
  onSignal(handler: (
    callId: string,
    senderSessionId: string,
    encryptedPayload: string,
    signalSeq: bigint,
  ) => void): void;

  /** Unregister the signaling handler. */
  offSignal(): void;
}

/** Repository for call state persistence (Dexie). */
export interface CallRepository {
  /** Get the current active call ID, or null. */
  getActiveCallId(): Promise<string | null>;
  /** Set the active call ID. */
  setActiveCallId(callId: string | null): Promise<void>;
}

/** Probe seam for checking if a call is still alive (Flag B / B2). */
export interface CallStateProbe {
  /**
   * Check if the given call is still active on the server.
   * Returns true if the call exists and hasn't been ended.
   * Used during the 20s grace period after WS drop.
   */
  isCallAlive(callId: string, identityHash: string): Promise<boolean>;
}

/** REST client for call-related endpoints. */
export interface CallRestClient {
  /** GET /api/v1/calls/turn-credentials */
  getTurnCredentials(identityHash: string): Promise<TurnCredentials>;
  /** GET /api/v1/calls/pending */
  getPendingCall(identityHash: string): Promise<PendingCall | null>;
}
