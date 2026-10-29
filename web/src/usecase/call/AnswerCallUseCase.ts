/**
 * AnswerCallUseCase — callee accepts incoming call.
 * Phase 12B Task 10 (§13.8).
 *
 * Sequence:
 * 1. Validate incoming_ringing state.
 * 2. Transition machine to connecting.
 * 3. Initialize media session.
 * 4. Generate answer, sign fingerprint, compute SAS, seal accept frame.
 * 5. Transmit call.accept frame.
 */

import { CALL_FRAME_ACCEPT } from '../../domain/call/constants';
import type { CallSignalTransport } from '../../domain/ports/call';
import type { CallSessionMachine } from './CallSessionMachine';

export class AnswerCallUseCase {
  private machine: CallSessionMachine;
  private transport: CallSignalTransport;

  constructor(
    machine: CallSessionMachine,
    transport: CallSignalTransport,
  ) {
    this.machine = machine;
    this.transport = transport;
  }

  async execute(params: {
    remoteSdp: string;
    remoteSig: string;
  }): Promise<void> {
    const state = this.machine.getState();
    if (state.status !== 'incoming_ringing') {
      throw new Error(`Cannot answer call in status ${state.status}`);
    }

    const mediaSession = this.machine.getActiveMediaSession();
    if (!mediaSession) {
      throw new Error('No active media session found for incoming call');
    }

    this.machine.acceptCall();

    await mediaSession.initialize();
    if (state.callType === 'video') {
      try {
        await mediaSession.enableVideo?.();
      } catch (err) {
        console.warn('Failed to enable camera for video call answer:', err);
      }
    }
    const answerFrame = await mediaSession.handleRemoteOfferAndAnswer(
      params.remoteSdp,
      params.remoteSig,
    );

    this.transport.sendSignal(
      state.callId,
      CALL_FRAME_ACCEPT,
      answerFrame.ciphertext,
      BigInt(answerFrame.signalSeq),
    );
  }
}
