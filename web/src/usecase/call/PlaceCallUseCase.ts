/**
 * PlaceCallUseCase — outbound call initiation.
 * Phase 12B Task 10 (§13.4, §13.5).
 *
 * Implements outbound sequence:
 * 1. Resolve peer through DirectoryPort.
 * 2. Generate 16-byte call_id (UUIDv4).
 * 3. deriveCallKeys with role: 'caller' (0x01).
 * 4. Start outbound ringing in CallSessionMachine.
 * 5. Initialize WebRTC media session & generate signed offer.
 * 6. Transmit call.invite frame via CallSignalTransport.
 * 7. Cache sealed frame bytes for retransmission (max 3 times, never re-seal).
 */

import { ROLE_CALLER, CALL_FRAME_INVITE } from '../../domain/call/constants';
import { CALL_C01, CALL_C02, CALL_C03 } from '../../domain/errors';
import { encodeRoutingId } from '../../domain/encoding';
import type { DirectoryPort } from '../../domain/ports';
import type {
  CallSignalTransport,
  CallCryptoPort,
} from '../../domain/ports/call';
import type { CallSessionMachine } from './CallSessionMachine';

export class PlaceCallUseCase {
  private cachedInvite: {
    callId: string;
    ciphertext: string;
    signalSeq: bigint;
    retransmitCount: number;
  } | null = null;

  private machine: CallSessionMachine;
  private directory: DirectoryPort;
  private transport: CallSignalTransport;
  private cryptoPort: CallCryptoPort;

  constructor(
    machine: CallSessionMachine,
    directory: DirectoryPort,
    transport: CallSignalTransport,
    cryptoPort: CallCryptoPort,
  ) {
    this.machine = machine;
    this.directory = directory;
    this.transport = transport;
    this.cryptoPort = cryptoPort;
  }

  async execute(params: {
    peerIdentityHash: string;
    peerDisplayName: string;
    localIdentityHash: string;
    callType?: import('../../domain/call/types').CallType;
  }): Promise<string> {
    // Auto-reset stale 'ended' state so user can immediately place a new call
    if (this.machine.getState().status === 'ended') {
      this.machine.resetToIdle();
    }

    // 1. Resolve peer
    const peerInfo = await this.directory.lookup(params.peerIdentityHash);
    if (!peerInfo || !peerInfo.activeSession) {
      throw new Error(`${CALL_C02}: Peer active session not found`);
    }

    // 2. Generate call_id (UUIDv4)
    const callId = typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : '00000000-0000-4000-8000-000000000000'.replace(/[08]/g, (c) =>
          (parseInt(c, 16) ^ (Math.random() * 16 >> (parseInt(c, 16) / 4))).toString(16)
        );

    // 3. deriveCallKeys with role: 'caller' before any frame transmission (§13.4 step 4)
    try {
      await this.cryptoPort.deriveCallKeys({
        call_id_bytes: callId,
        peer_identity_hash: params.peerIdentityHash,
        peer_session_id: peerInfo.activeSession.sessionId,
        peer_session_pk: peerInfo.activeSession.x25519PublicKey,
        role: ROLE_CALLER,
      });
    } catch (err) {
      console.error('[PlaceCallUseCase] deriveCallKeys error:', err);
      throw new Error(`${CALL_C03}: Call key derivation failed: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
    }

    // 4. Start outbound state machine
    let mediaSession;
    try {
      mediaSession = await this.machine.startOutbound({
        callId,
        peerId: peerInfo.userId,
        peerDisplayName: params.peerDisplayName,
        localIdentityHash: params.localIdentityHash,
        peerIdentityHash: params.peerIdentityHash,
        peerIdentityPublicKey: peerInfo.identityPublicKey,
        callType: params.callType,
      });
    } catch (err) {
      throw new Error(
        `${CALL_C01}: Failed to initiate call state: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    // 5. Initialize media session & create signed offer
    await mediaSession.initialize();
    if (params.callType === 'video') {
      try {
        await mediaSession.enableVideo?.();
      } catch (err) {
        console.warn('Failed to enable camera for video call initiation:', err);
      }
    }
    const offerFrame = await mediaSession.createAndSendOffer();

    // 6. Transmit call.invite
    const seqBigInt = BigInt(offerFrame.signalSeq);
    const routingId = encodeRoutingId(peerInfo.userId);
    this.transport.sendSignal(callId, CALL_FRAME_INVITE, offerFrame.ciphertext, seqBigInt, routingId);

    // 7. Cache invite bytes for byte-identical retransmission (§13.5)
    this.cachedInvite = {
      callId,
      ciphertext: offerFrame.ciphertext,
      signalSeq: seqBigInt,
      retransmitCount: 0,
    };

    return callId;
  }

  /**
   * Retransmit cached invite verbatim on reconnect (max 3 times, never re-seal per §13.5).
   */
  retransmitInvite(): boolean {
    if (!this.cachedInvite || this.cachedInvite.retransmitCount >= 3) {
      return false;
    }
    this.cachedInvite.retransmitCount++;
    this.transport.sendSignal(
      this.cachedInvite.callId,
      CALL_FRAME_INVITE,
      this.cachedInvite.ciphertext,
      this.cachedInvite.signalSeq,
    );
    return true;
  }

  getCachedInvite() {
    return this.cachedInvite;
  }
}
