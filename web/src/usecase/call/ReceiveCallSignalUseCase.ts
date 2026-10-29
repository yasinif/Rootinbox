/**
 * ReceiveCallSignalUseCase — dispatcher for incoming call signaling frames.
 * Phase 12B Tasks 10 & 11 (§13.8, §14.2, §14.3, §14.5).
 *
 * Implements inbound sequence:
 * 1. Reads plaintext call_id and signal_seq.
 * 2. Resolves peer from directory.
 * 3. Derives call keys (callee role) before opening invite.
 * 4. Opens frame via crypto port with sequence replay check.
 * 5. Verifies DTLS fingerprint signature before setRemoteDescription.
 * 6. Dispatches to CallSessionMachine / MediaSession.
 * 7. Glare handling & politeness arbitration.
 */

import {
  CALL_FRAME_INVITE,
  CALL_FRAME_ACCEPT,
  CALL_FRAME_REJECT,
  CALL_FRAME_ICE,
  CALL_FRAME_END,
  CALL_FRAME_BUSY,
  CALL_FRAME_RENEGOTIATE,
  FRAME_TYPE_OFFER,
  FRAME_TYPE_ANSWER,
  FRAME_TYPE_ICE_CANDIDATE,
  FRAME_TYPE_END,
  FRAME_TYPE_REJECT,
  FRAME_TYPE_RENEGOTIATE_OFFER,
  ROLE_CALLEE,
} from '../../domain/call/constants';
import type { DirectoryPort, MetadataPort } from '../../domain/ports';
import type {
  CallSignalTransport,
  CallCryptoPort,
} from '../../domain/ports/call';
import type { CallType } from '../../domain/call/types';
import type { CallSessionMachine } from './CallSessionMachine';

export interface InboundCallOfferData {
  callId: string;
  senderId: string;
  senderDisplayName: string;
  sdp: string;
  sig: string;
}

export class ReceiveCallSignalUseCase {
  private pendingOffer: InboundCallOfferData | null = null;
  private glareWaitingTimer: ReturnType<typeof setTimeout> | null = null;
  private bufferedInvites = new Map<string, {
    senderId: string;
    ciphertext: string;
    seq: bigint;
    receivedAt: number;
  }>();

  private machine: CallSessionMachine;
  private directory: DirectoryPort;
  private transport: CallSignalTransport;
  private cryptoPort: CallCryptoPort;
  private localIdentityHash: string | (() => string);
  private metadataPort?: MetadataPort;

  constructor(
    machine: CallSessionMachine,
    directory: DirectoryPort,
    transport: CallSignalTransport,
    cryptoPort: CallCryptoPort,
    localIdentityHash: string | (() => string),
    metadataPort?: MetadataPort,
  ) {
    this.machine = machine;
    this.directory = directory;
    this.transport = transport;
    this.cryptoPort = cryptoPort;
    this.localIdentityHash = localIdentityHash;
    this.metadataPort = metadataPort;
  }

  setLocalIdentityHash(hash: string): void {
    this.localIdentityHash = hash;
  }

  private getLocalIdentityHash(): string {
    return typeof this.localIdentityHash === 'function'
      ? this.localIdentityHash()
      : this.localIdentityHash;
  }

  getPendingOffer(): InboundCallOfferData | null {
    return this.pendingOffer;
  }

  clearPendingOffer(): void {
    this.pendingOffer = null;
  }

  /**
   * Main dispatch entry point when WS receives call.* envelope.
   */
  async handleSignal(params: {
    callId: string;
    frameType: string;
    senderId: string;
    ciphertext: string;
    signalSeq: bigint;
    glareOverride?: boolean;
    canonicalCallId?: string;
  }): Promise<void> {
    const { callId, frameType, senderId, ciphertext, signalSeq } = params;

    switch (frameType) {
      case CALL_FRAME_INVITE:
        await this.handleInvite(callId, senderId, ciphertext, signalSeq);
        break;
      case CALL_FRAME_ACCEPT:
        await this.handleAccept(callId, ciphertext, signalSeq);
        break;
      case CALL_FRAME_ICE:
        await this.handleIce(callId, ciphertext, signalSeq);
        break;
      case CALL_FRAME_END:
        await this.handleEnd(callId, ciphertext, signalSeq);
        break;
      case CALL_FRAME_REJECT:
        await this.handleReject(callId, ciphertext, signalSeq);
        break;
      case CALL_FRAME_BUSY:
        this.handleBusy(callId, params.glareOverride, params.canonicalCallId);
        break;
      case CALL_FRAME_RENEGOTIATE:
        await this.handleRenegotiate(callId, ciphertext, signalSeq);
        break;
      default:
        // Unknown frame type - drop silently per ADR-P8-3
        break;
    }
  }

  /**
   * §13.8 Inbound call invite.
   */
  private async handleInvite(
    callId: string,
    senderId: string,
    ciphertext: string,
    signalSeq: bigint,
  ): Promise<void> {
    // Auto-reset if previous call ended so new invite can be accepted
    if (this.machine.getState().status === 'ended') {
      this.machine.resetToIdle();
    }

    const state = this.machine.getState();

    // Check if session is already active (Glare or Busy)
    if (state.status !== 'idle') {
      if (state.status === 'outgoing_ringing') {
        // Glare collision (§14.5)
        const localHash = this.getLocalIdentityHash().toLowerCase();
        // Resolve peer identity hash
        const peerInfo = await this.directory.lookup(senderId).catch(() => null);
        const peerHash = (peerInfo?.identityHash ?? '').toLowerCase();

        const isPolite = localHash < peerHash;
        if (isPolite) {
          // Polite peer: yield to the canonical inbound call
          this.machine.yieldToGlare();
        } else {
          // Impolite peer: reject inbound invite, keep outbound ringing
          return;
        }
      } else {
        // Already active in another call: reply with call.reject (§13.2)
        this.transport.sendSignal(callId, CALL_FRAME_REJECT, '', 0n);
        return;
      }
    }

    // 1. Resolve peer from senderId
    let peerInfo = await this.directory.lookup(senderId).catch((err) => {
      console.warn('[ReceiveCallSignalUseCase] Directory lookup failed for', senderId, err);
      return null;
    });

    if (!peerInfo?.activeSession && this.metadataPort) {
      const fallbackHash = await this.metadataPort.get(`peer_hash_for_${senderId}`).catch(() => null);
      if (fallbackHash) {
        peerInfo = await this.directory.lookup(fallbackHash).catch(() => null);
      }
    }

    if (!peerInfo || !peerInfo.activeSession) {
      console.warn('[ReceiveCallSignalUseCase] Inbound call drop: peerInfo or activeSession not found for', senderId);
      return;
    }

    // 2. Try activeSession first, then other candidate sessions in peerInfo.sessions if decryption fails
    const candidateSessions = [
      peerInfo.activeSession,
      ...(peerInfo.sessions || []).filter((s) => s.sessionId !== peerInfo!.activeSession?.sessionId),
    ];

    let payload: Record<string, unknown> | null = null;
    for (const sess of candidateSessions) {
      try {
        await this.cryptoPort.deriveCallKeys({
          call_id_bytes: callId,
          peer_identity_hash: peerInfo.identityHash ?? senderId,
          peer_session_id: sess.sessionId,
          peer_session_pk: sess.x25519PublicKey,
          role: ROLE_CALLEE,
        });

        const result = await this.cryptoPort.openCallFrame({
          call_id_bytes: callId,
          frame_type: FRAME_TYPE_OFFER,
          ciphertext,
          signal_seq: Number(signalSeq),
        });

        if (result?.payload) {
          payload = result.payload as Record<string, unknown>;
          break;
        }
      } catch (err) {
        console.warn('[ReceiveCallSignalUseCase] Failed to decrypt invite with session', sess.sessionId, err);
      }
    }

    if (!payload) {
      console.warn('[ReceiveCallSignalUseCase] Inbound call drop: could not decrypt offer payload for call', callId);
      return;
    }

    const sdp = String(payload.sdp || '');
    const sig = String(payload.sig || '');
    if (!sdp || !sig) {
      console.warn('[ReceiveCallSignalUseCase] Inbound call drop: missing SDP or signature');
      return;
    }

    const incomingCallType: CallType = payload.call_type === 'video' ? 'video' : 'audio';

    const targetHash = peerInfo.identityHash ?? senderId;
    let callerDisplayName = 'Incoming Call';
    if (this.metadataPort) {
      const saved = await this.metadataPort.get(`peer_name_${targetHash}`);
      if (saved) {
        callerDisplayName = saved;
      } else {
        const user = await this.metadataPort.get(`peer_user_${targetHash}`);
        if (user) callerDisplayName = `@${user}`;
      }
    }

    // 4. Record pending offer
    this.pendingOffer = {
      callId,
      senderId,
      senderDisplayName: callerDisplayName,
      sdp,
      sig,
    };

    // 5. Start inbound ringing in state machine
    try {
      this.machine.startInbound({
        callId,
        peerId: senderId,
        peerDisplayName: callerDisplayName,
        localIdentityHash: this.getLocalIdentityHash(),
        peerIdentityHash: targetHash,
        peerIdentityPublicKey: peerInfo.identityPublicKey,
        callType: incomingCallType,
      });
    } catch {
      // Already non-idle
    }


  }

  /**
   * Inbound call accept (caller receives answer).
   */
  private async handleAccept(
    callId: string,
    ciphertext: string,
    signalSeq: bigint,
  ): Promise<void> {
    const state = this.machine.getState();
    if (state.callId !== callId || state.status !== 'outgoing_ringing') {
      return;
    }

    let payload: Record<string, unknown>;
    try {
      const result = await this.cryptoPort.openCallFrame({
        call_id_bytes: callId,
        frame_type: FRAME_TYPE_ANSWER,
        ciphertext,
        signal_seq: Number(signalSeq),
      });
      payload = result.payload;
    } catch {
      return;
    }

    const sdp = String(payload.sdp || '');
    const sig = String(payload.sig || '');
    if (!sdp || !sig) return;

    this.machine.remoteAnswered();

    const mediaSession = this.machine.getActiveMediaSession();
    if (mediaSession) {
      try {
        await mediaSession.handleRemoteAnswer(sdp, sig);
        this.machine.onConnected();
      } catch {
        this.machine.endCall('crypto_error');
      }
    }
  }

  /**
   * Inbound ICE candidate.
   */
  private async handleIce(
    callId: string,
    ciphertext: string,
    signalSeq: bigint,
  ): Promise<void> {
    const state = this.machine.getState();
    if (state.callId !== callId) return;

    let payload: Record<string, unknown>;
    try {
      const result = await this.cryptoPort.openCallFrame({
        call_id_bytes: callId,
        frame_type: FRAME_TYPE_ICE_CANDIDATE,
        ciphertext,
        signal_seq: Number(signalSeq),
      });
      payload = result.payload;
    } catch {
      return;
    }

    const candidate = payload.candidate ? String(payload.candidate) : '';
    if (!candidate) return;

    const mediaSession = this.machine.getActiveMediaSession();
    if (mediaSession) {
      await mediaSession.handleRemoteCandidate({
        candidate,
        sdpMid: payload.sdpMid ? String(payload.sdpMid) : null,
        sdpMLineIndex: payload.sdpMLineIndex !== undefined ? Number(payload.sdpMLineIndex) : null,
      });
    }
  }

  /**
   * Inbound call end.
   */
  private async handleEnd(
    callId: string,
    ciphertext: string,
    signalSeq: bigint,
  ): Promise<void> {
    const state = this.machine.getState();
    if (state.callId !== callId) return;

    try {
      await this.cryptoPort.openCallFrame({
        call_id_bytes: callId,
        frame_type: FRAME_TYPE_END,
        ciphertext,
        signal_seq: Number(signalSeq),
      });
    } catch {
      // Even if open fails, treat as remote hangup
    }

    this.machine.endCall('remote_hangup');
  }

  /**
   * Inbound call reject.
   */
  private async handleReject(
    callId: string,
    ciphertext: string,
    signalSeq: bigint,
  ): Promise<void> {
    const state = this.machine.getState();
    if (state.callId !== callId) return;

    try {
      await this.cryptoPort.openCallFrame({
        call_id_bytes: callId,
        frame_type: FRAME_TYPE_REJECT,
        ciphertext,
        signal_seq: Number(signalSeq),
      });
    } catch {
      // Treat as remote reject
    }

    this.machine.endCall('remote_reject');
  }

  /**
   * Inbound call busy (advisory frame, §14.5).
   */
  private handleBusy(
    _callId: string,
    glareOverride?: boolean,
    canonicalCallId?: string,
  ): void {
    if (!glareOverride || !canonicalCallId) {
      return;
    }

    const state = this.machine.getState();
    if (state.status !== 'outgoing_ringing') {
      return;
    }

    // Check if canonical invite already arrived in buffer (§14.5)
    const buffered = this.bufferedInvites.get(canonicalCallId);
    if (buffered) {
      this.bufferedInvites.delete(canonicalCallId);
      this.machine.yieldToGlare();
      this.handleInvite(
        canonicalCallId,
        buffered.senderId,
        buffered.ciphertext,
        buffered.seq,
      );
      return;
    }

    // Set 10s GLARE_WAITING timer (§14.5)
    if (this.glareWaitingTimer) clearTimeout(this.glareWaitingTimer);
    this.glareWaitingTimer = setTimeout(() => {
      this.glareWaitingTimer = null;
      if (this.machine.getState().status === 'outgoing_ringing') {
        this.machine.endCall('timeout');
      }
    }, 10_000);
  }

  /**
   * Inbound renegotiate.
   */
  private async handleRenegotiate(
    callId: string,
    ciphertext: string,
    signalSeq: bigint,
  ): Promise<void> {
    const state = this.machine.getState();
    if (state.callId !== callId) return;

    try {
      await this.cryptoPort.openCallFrame({
        call_id_bytes: callId,
        frame_type: FRAME_TYPE_RENEGOTIATE_OFFER,
        ciphertext,
        signal_seq: Number(signalSeq),
      });
    } catch {
      // Failed decrypt
    }
  }
}
