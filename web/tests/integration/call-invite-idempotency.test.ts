import { describe, it, expect, vi } from 'vitest';
import { PlaceCallUseCase } from '../../src/usecase/call/PlaceCallUseCase';
import { CallSessionMachine } from '../../src/usecase/call/CallSessionMachine';

describe('Call Invite Idempotency Integration Test (§13.5, §23.3)', () => {
  it('retransmitted invite is byte-identical: same ciphertext and same signal_seq without re-sealing', async () => {
    const mockMediaSession = {
      callId: 'call-idemp',
      role: 'caller' as const,
      polite: true,
      initialize: vi.fn().mockResolvedValue(undefined),
      createAndSendOffer: vi.fn().mockResolvedValue({
        signalSeq: 1,
        ciphertext: 'base64-sealed-offer-bytes-fixed',
      }),
      handleRemoteOfferAndAnswer: vi.fn(),
      handleRemoteAnswer: vi.fn(),
      handleRemoteCandidate: vi.fn(),
      setMuted: vi.fn(),
      terminate: vi.fn(),
    };

    const mockFactory = {
      createSession: vi.fn().mockReturnValue(mockMediaSession),
    };
    const mockProbe = {
      isCallAlive: vi.fn().mockResolvedValue(true),
    };
    const machine = new CallSessionMachine(mockFactory, mockProbe);

    const mockDirectory = {
      lookup: vi.fn().mockResolvedValue({
        userId: 'peer-user',
        identityHash: 'bbbb',
        identityPublicKey: 'pk-peer',
        activeSession: {
          sessionId: 'sess-1',
          x25519PublicKey: 'xpk-peer',
          sessionVersion: 1,
        },
      }),
    };

    const sentSignals: Array<{ callId: string; frameType: string; payload: string; seq: bigint }> = [];
    const mockTransport = {
      sendSignal: vi.fn((callId, frameType, payload, seq) => {
        sentSignals.push({ callId, frameType, payload, seq });
      }),
      onSignal: vi.fn(),
      offSignal: vi.fn(),
    };

    const mockCryptoPort = {
      deriveCallKeys: vi.fn().mockResolvedValue({}),
      signCallFingerprint: vi.fn(),
      verifyCallFingerprint: vi.fn(),
      sealCallFrame: vi.fn(),
      openCallFrame: vi.fn(),
      computeSas: vi.fn(),
      dropCall: vi.fn(),
    };

    const placeCall = new PlaceCallUseCase(
      machine,
      mockDirectory as any,
      mockTransport as any,
      mockCryptoPort as any,
    );

    // Initial invite
    await placeCall.execute({
      peerIdentityHash: 'bbbb',
      peerDisplayName: 'Bob',
      localIdentityHash: 'aaaa',
    });

    expect(sentSignals.length).toBe(1);
    const firstInvite = sentSignals[0];

    // Retransmit invite (e.g. after WS reconnect while still OUTBOUND_RINGING)
    const didRetransmit1 = placeCall.retransmitInvite();
    expect(didRetransmit1).toBe(true);
    expect(sentSignals.length).toBe(2);
    expect(sentSignals[1].payload).toBe(firstInvite.payload);
    expect(sentSignals[1].seq).toBe(firstInvite.seq);

    // Retransmit 2
    const didRetransmit2 = placeCall.retransmitInvite();
    expect(didRetransmit2).toBe(true);
    expect(sentSignals.length).toBe(3);
    expect(sentSignals[2].payload).toBe(firstInvite.payload);

    // Retransmit 3
    const didRetransmit3 = placeCall.retransmitInvite();
    expect(didRetransmit3).toBe(true);
    expect(sentSignals.length).toBe(4);

    // Retransmit 4 (exceeds max 3 retransmits per §13.5)
    const didRetransmit4 = placeCall.retransmitInvite();
    expect(didRetransmit4).toBe(false);
    expect(sentSignals.length).toBe(4);

    // createAndSendOffer was called exactly ONCE (no re-seal occurred)
    expect(mockMediaSession.createAndSendOffer).toHaveBeenCalledTimes(1);
  });

  it('automatically resets ended state to idle when placing subsequent call', async () => {
    const mockMediaSession = {
      callId: 'call-1',
      role: 'caller' as const,
      polite: true,
      initialize: vi.fn().mockResolvedValue(undefined),
      createAndSendOffer: vi.fn().mockResolvedValue({ signalSeq: 1, ciphertext: 'offer-1' }),
      handleRemoteOfferAndAnswer: vi.fn(),
      handleRemoteAnswer: vi.fn(),
      handleRemoteCandidate: vi.fn(),
      setMuted: vi.fn(),
      terminate: vi.fn(),
    };
    const mockFactory = { createSession: vi.fn().mockReturnValue(mockMediaSession) };
    const mockProbe = { isCallAlive: vi.fn().mockResolvedValue(true) };
    const machine = new CallSessionMachine(mockFactory, mockProbe);
    const mockDirectory = {
      lookup: vi.fn().mockResolvedValue({
        userId: 'peer-user',
        identityHash: 'bbbb',
        identityPublicKey: 'pk-peer',
        activeSession: { sessionId: 'sess-1', x25519PublicKey: 'xpk-peer', sessionVersion: 1 },
      }),
    };
    const mockTransport = { sendSignal: vi.fn(), onSignal: vi.fn(), offSignal: vi.fn() };
    const mockCryptoPort = { deriveCallKeys: vi.fn().mockResolvedValue({}) };
    const placeCall = new PlaceCallUseCase(machine, mockDirectory as any, mockTransport as any, mockCryptoPort as any);

    // Call 1
    await placeCall.execute({ peerIdentityHash: 'bbbb', peerDisplayName: 'Bob', localIdentityHash: 'aaaa' });
    expect(machine.getState().status).toBe('outgoing_ringing');

    // End call 1 -> enters ended state
    machine.endCall('local_hangup');
    expect(machine.getState().status).toBe('ended');

    // Call 2 placed immediately before 3.5s auto-reset timer fires
    await expect(placeCall.execute({ peerIdentityHash: 'bbbb', peerDisplayName: 'Bob', localIdentityHash: 'aaaa' })).resolves.toBeDefined();
    expect(machine.getState().status).toBe('outgoing_ringing');
  });
});
