/**
 * EndCallUseCase — call termination and rejection.
 * Phase 12B Task 10 (§13.9).
 *
 * Implements terminal cleanup:
 * - Emits call.end / call.reject frame to peer if connection was established/signaled
 * - Calls machine.endCall() (single code path, idempotent)
 * - Releases media devices, tracks, and worker keys
 */

import {
  CALL_FRAME_END,
  CALL_FRAME_REJECT,
  FRAME_TYPE_END,
  FRAME_TYPE_REJECT,
} from '../../domain/call/constants';
import type { CallEndReason } from '../../domain/call/types';
import type {
  CallSignalTransport,
  CallCryptoPort,
} from '../../domain/ports/call';
import type { CallSessionMachine } from './CallSessionMachine';

export class EndCallUseCase {
  private machine: CallSessionMachine;
  private transport: CallSignalTransport;
  private cryptoPort: CallCryptoPort;

  constructor(
    machine: CallSessionMachine,
    transport: CallSignalTransport,
    cryptoPort: CallCryptoPort,
  ) {
    this.machine = machine;
    this.transport = transport;
    this.cryptoPort = cryptoPort;
  }

  async execute(reason: CallEndReason = 'local_hangup'): Promise<void> {
    const state = this.machine.getState();
    if (state.status === 'idle' || state.status === 'ended') {
      this.machine.endCall(reason);
      return;
    }

    const callId = state.callId;

    // Send peer signaling frame if applicable
    if (callId) {
      try {
        if (state.status === 'incoming_ringing') {
          // Reject frame
          const frame = await this.cryptoPort.sealCallFrame({
            call_id_bytes: callId,
            frame_type: FRAME_TYPE_REJECT,
            payload: { type: 'reject', call_id: callId, reason: 'REJECTED' },
          });
          this.transport.sendSignal(
            callId,
            CALL_FRAME_REJECT,
            frame.ciphertext,
            BigInt(frame.signal_seq),
          );
        } else {
          // End frame
          const frame = await this.cryptoPort.sealCallFrame({
            call_id_bytes: callId,
            frame_type: FRAME_TYPE_END,
            payload: { type: 'end', call_id: callId, reason },
          });
          this.transport.sendSignal(
            callId,
            CALL_FRAME_END,
            frame.ciphertext,
            BigInt(frame.signal_seq),
          );
        }
      } catch {
        // Failing to send signal must not prevent local termination
      }
    }

    // Terminal cleanup on machine
    this.machine.endCall(reason);
  }
}
