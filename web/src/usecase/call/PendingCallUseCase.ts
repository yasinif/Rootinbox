/**
 * PendingCallUseCase — fetches and processes pending call offers.
 * Phase 12B Task 10 (§13.10).
 *
 * Triggered:
 * 1. During boot after WS reaches AUTHENTICATED.
 * 2. On Service Worker 'wake' message.
 *
 * Returns offer processed through §13.8 inbound sequence.
 * Null is normal and never surfaces an error.
 */

import { CALL_FRAME_INVITE } from '../../domain/call/constants';
import type { CallRestClient } from '../../domain/ports/call';
import type { ReceiveCallSignalUseCase } from './ReceiveCallSignalUseCase';

export class PendingCallUseCase {
  private restClient: CallRestClient;
  private signalUseCase: ReceiveCallSignalUseCase;

  constructor(
    restClient: CallRestClient,
    signalUseCase: ReceiveCallSignalUseCase,
  ) {
    this.restClient = restClient;
    this.signalUseCase = signalUseCase;
  }

  async checkPendingCall(localIdentityHash: string): Promise<boolean> {
    let pending;
    try {
      pending = await this.restClient.getPendingCall(localIdentityHash);
    } catch {
      // Net failure / 404 / 204 -> normal, treat as null (§13.10)
      return false;
    }

    if (!pending || !pending.call_id) {
      return false;
    }

    // Check expiration
    if (pending.expires_at && pending.expires_at < Date.now() / 1000) {
      return false;
    }

    // Process through inbound sequence
    const sender = pending.caller_identity_hash || pending.caller_id || pending.caller_session_id;
    await this.signalUseCase.handleSignal({
      callId: pending.call_id,
      frameType: CALL_FRAME_INVITE,
      senderId: sender,
      ciphertext: pending.encrypted_offer,
      signalSeq: 1n,
    });

    return true;
  }
}
