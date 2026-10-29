/**
 * Call WebSocket Envelopes.
 * RFC-0008 §6 + Phase 12B Task 10.
 */

import type { CallFrameType } from '../call/constants';

export interface CallWsEnvelope {
  v: number;
  type: CallFrameType;
  request_id: string;
  call_id: string;
  signal_seq: number;
  sender_id: string;
  receiver_id?: string;
  routing_id?: string;
  payload: string;
  glare_override?: boolean;
  canonical_call_id?: string;
}

export interface CallInvitePayload {
  type: 'offer';
  sdp: string;
  sig: string; // DTLS fingerprint Ed25519 signature
}

export interface CallAcceptPayload {
  type: 'answer';
  sdp: string;
  sig: string; // DTLS fingerprint Ed25519 signature
}

export interface CallIcePayload {
  type: 'ice';
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
}

export interface CallEndPayload {
  type: 'end';
  call_id: string;
  reason: string;
}

export interface CallBusyPayload {
  type: 'busy';
  call_id: string;
  glare_override?: boolean;
  canonical_call_id?: string;
}

export interface CallRenegotiatePayload {
  type: 'renegotiate';
  sdp?: string;
  sig?: string;
}
