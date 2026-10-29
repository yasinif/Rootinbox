/**
 * Call Domain Types.
 * Phase 12B §7.2: Pure types, zero imports outside domain.
 */

/** Call session status — FSM states. */
export type CallStatus =
  | 'idle'
  | 'outgoing_ringing'
  | 'incoming_ringing'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'ended';

/** Why a call ended. */
export type CallEndReason =
  | 'local_hangup'
  | 'remote_hangup'
  | 'remote_reject'
  | 'remote_busy'
  | 'timeout'
  | 'ice_failure'
  | 'crypto_error'
  | 'ws_drop'
  | 'glare_yield';

/** Call type — audio or video. */
export type CallType = 'audio' | 'video';

/** Call role (relative to the user). */
export type CallRole = 'caller' | 'callee';

/** ICE connection quality tiers. */
export type IceQuality = 'excellent' | 'good' | 'poor' | 'disconnected' | 'failed';

/** Immutable call session state snapshot — emitted to UI. */
export interface CallSessionState {
  readonly callId: string;
  readonly peerId: string;
  readonly peerIdentityHash?: string;
  readonly peerDisplayName: string;
  readonly role: CallRole;
  readonly status: CallStatus;
  readonly endReason: CallEndReason | null;
  readonly startedAt: number | null;
  readonly connectedAt: number | null;
  readonly duration: number;
  readonly iceQuality: IceQuality;
  readonly isMuted: boolean;
  readonly isSpeakerOn: boolean;
  readonly sasDigits: string | null;
  readonly sasVerified: boolean;
  readonly fingerprintVerified: boolean;
  readonly callType?: CallType;
  readonly isVideoEnabled?: boolean;
  readonly isScreenSharing?: boolean;
  readonly isRemoteVideoMuted?: boolean;
  readonly localVideoStream?: MediaStream | null;
  readonly remoteVideoStream?: MediaStream | null;
  readonly remoteStream?: MediaStream | null;
}

/** TURN credential set returned by the server. */
export interface TurnCredentials {
  readonly urls: string[];
  readonly username: string;
  readonly credential: string;
  readonly ttl: number;
}

/** Pending call from the server (GET /api/v1/calls/pending). */
export interface PendingCall {
  readonly call_id: string;
  readonly caller_id?: string;
  readonly caller_identity_hash?: string;
  readonly caller_session_id: string;
  readonly encrypted_offer: string;   // Base64 standard
  readonly fingerprint_signature: string; // Base64 standard
  readonly expires_at: number;
}

/** Call signaling frame (after decryption). */
export interface CallSignalPayload {
  readonly type: string;
  readonly sdp?: string;
  readonly candidate?: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
  readonly sig?: string;
  readonly reason?: string;
}
