import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ReceiveCallSignalUseCase } from '../../src/usecase/call/ReceiveCallSignalUseCase';
import { CallSessionMachine } from '../../src/usecase/call/CallSessionMachine';
import type {
  CallMediaSession,
  CallMediaSessionFactory,
  CallStateProbe,
} from '../../src/domain/ports/call';
import { CALL_FRAME_BUSY, CALL_FRAME_INVITE } from '../../src/domain/call/constants';

describe('Glare & Politeness Arbitration Tests (§14.1, §14.5, §23.2)', () => {
  let machine: CallSessionMachine;
  let mockMediaSession: CallMediaSession;
  let mockFactory: CallMediaSessionFactory;
  let mockProbe: CallStateProbe;
  let mockDirectory: { lookup: ReturnType<typeof vi.fn> };
  let mockTransport: { sendSignal: ReturnType<typeof vi.fn>; onSignal: ReturnType<typeof vi.fn>; offSignal: ReturnType<typeof vi.fn> };
  let mockCryptoPort: {
    deriveCallKeys: ReturnType<typeof vi.fn>;
    signCallFingerprint: ReturnType<typeof vi.fn>;
    verifyCallFingerprint: ReturnType<typeof vi.fn>;
    sealCallFrame: ReturnType<typeof vi.fn>;
    openCallFrame: ReturnType<typeof vi.fn>;
    computeSas: ReturnType<typeof vi.fn>;
    dropCall: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.useFakeTimers();

    mockMediaSession = {
      callId: 'call-local',
      role: 'caller',
      polite: true,
      initialize: vi.fn().mockResolvedValue(undefined),
      createAndSendOffer: vi.fn().mockResolvedValue({ signalSeq: 1, ciphertext: 'offer' }),
      handleRemoteOfferAndAnswer: vi.fn().mockResolvedValue({ signalSeq: 2, ciphertext: 'answer' }),
      handleRemoteAnswer: vi.fn().mockResolvedValue(undefined),
      handleRemoteCandidate: vi.fn().mockResolvedValue(undefined),
      setMuted: vi.fn(),
      terminate: vi.fn(),
    };

    mockFactory = {
      createSession: vi.fn().mockReturnValue(mockMediaSession),
    };

    mockProbe = {
      isCallAlive: vi.fn().mockResolvedValue(true),
    };

    machine = new CallSessionMachine(mockFactory, mockProbe);

    mockDirectory = {
      lookup: vi.fn().mockResolvedValue({
        userId: 'peer-1',
        identityHash: 'bbbbbbbbbbbbbbbb',
        identityPublicKey: 'pk-peer',
        activeSession: {
          sessionId: 'sess-1',
          x25519PublicKey: 'xpk-peer',
          sessionVersion: 1,
        },
      }),
    };

    mockTransport = {
      sendSignal: vi.fn(),
      onSignal: vi.fn(),
      offSignal: vi.fn(),
    };

    mockCryptoPort = {
      deriveCallKeys: vi.fn().mockResolvedValue({}),
      signCallFingerprint: vi.fn().mockResolvedValue({ signature: 'sig' }),
      verifyCallFingerprint: vi.fn().mockResolvedValue({ valid: true }),
      sealCallFrame: vi.fn().mockResolvedValue({ ciphertext: 'sealed', signal_seq: 1 }),
      openCallFrame: vi.fn().mockResolvedValue({ payload: { sdp: 'sdp-canonical', sig: 'sig-canonical' } }),
      computeSas: vi.fn().mockResolvedValue({ sas: '123456' }),
      dropCall: vi.fn().mockResolvedValue({ ok: true }),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('politeness: lowercase hex strings.Compare equivalent (§14.1)', () => {
    const localA = 'aaaaaaaa';
    const peerB = 'bbbbbbbb';
    expect(localA.toLowerCase() < peerB.toLowerCase()).toBe(true); // Local is polite

    const localZ = 'ffffffff';
    expect(localZ.toLowerCase() < peerB.toLowerCase()).toBe(false); // Local is impolite
  });

  it('polite peer yields local call when receiving canonical inbound invite (§14.5)', async () => {
    const politeReceiver = new ReceiveCallSignalUseCase(
      machine,
      mockDirectory as any,
      mockTransport as any,
      mockCryptoPort as any,
      'aaaaaaaa', // lower than peer 'bbbbbbbb' -> polite
    );

    // Local peer starts outbound call
    await machine.startOutbound({
      callId: 'call-local',
      peerId: 'peer-1',
      peerDisplayName: 'Bob',
      localIdentityHash: 'aaaaaaaa',
      peerIdentityHash: 'bbbbbbbb',
      peerIdentityPublicKey: 'pk-peer',
    });

    expect(machine.getState().status).toBe('outgoing_ringing');

    // Inbound invite arrives from peerB (glare collision)
    await politeReceiver.handleSignal({
      callId: 'call-canonical',
      frameType: CALL_FRAME_INVITE,
      senderId: 'peer-1',
      ciphertext: 'inbound-offer-cipher',
      signalSeq: 1n,
    });

    // Polite peer yielded local call and accepted inbound invite as callee
    expect(machine.getState().callId).toBe('call-canonical');
    expect(machine.getState().status).toBe('incoming_ringing');
    expect(machine.getState().role).toBe('callee');
  });

  it('impolite peer ignores glare invite and keeps local outbound ringing (§14.5)', async () => {
    const impoliteReceiver = new ReceiveCallSignalUseCase(
      machine,
      mockDirectory as any,
      mockTransport as any,
      mockCryptoPort as any,
      'cccccccc', // greater than peer 'bbbbbbbb' -> impolite
    );

    // Impolite peer starts outbound call
    await machine.startOutbound({
      callId: 'call-impolite',
      peerId: 'peer-1',
      peerDisplayName: 'Bob',
      localIdentityHash: 'cccccccc',
      peerIdentityHash: 'bbbbbbbb',
      peerIdentityPublicKey: 'pk-peer',
    });

    expect(machine.getState().status).toBe('outgoing_ringing');

    // Inbound invite arrives from peerB
    await impoliteReceiver.handleSignal({
      callId: 'call-losing',
      frameType: CALL_FRAME_INVITE,
      senderId: 'peer-1',
      ciphertext: 'inbound-offer-cipher',
      signalSeq: 1n,
    });

    // Impolite peer maintains its own call
    expect(machine.getState().callId).toBe('call-impolite');
    expect(machine.getState().status).toBe('outgoing_ringing');
  });

  it('10s GLARE_WAITING buffer expires into deterministic timeout outcome (§14.5)', async () => {
    const politeReceiver = new ReceiveCallSignalUseCase(
      machine,
      mockDirectory as any,
      mockTransport as any,
      mockCryptoPort as any,
      'aaaaaaaa',
    );

    await machine.startOutbound({
      callId: 'call-local',
      peerId: 'peer-1',
      peerDisplayName: 'Bob',
      localIdentityHash: 'aaaaaaaa',
      peerIdentityHash: 'bbbbbbbb',
      peerIdentityPublicKey: 'pk-peer',
    });

    // Receive call.busy with glare_override: true
    await politeReceiver.handleSignal({
      callId: 'call-local',
      frameType: CALL_FRAME_BUSY,
      senderId: '',
      ciphertext: '',
      signalSeq: 0n,
      glareOverride: true,
      canonicalCallId: 'call-canonical-never-arrived',
    });

    // Wait 9,999 ms
    vi.advanceTimersByTime(9_999);
    expect(machine.getState().status).toBe('outgoing_ringing');

    // 10s expires
    vi.advanceTimersByTime(1);
    expect(machine.getState().status).toBe('ended');
    expect(machine.getState().endReason).toBe('timeout');
  });

  it('automatically resets ended state to idle and accepts new inbound invite', async () => {
    const receiver = new ReceiveCallSignalUseCase(
      machine,
      mockDirectory as any,
      mockTransport as any,
      mockCryptoPort as any,
      'aaaaaaaa',
    );

    // End previous call -> machine enters 'ended' state
    await machine.startOutbound({
      callId: 'call-old',
      peerId: 'peer-1',
      peerDisplayName: 'Bob',
      localIdentityHash: 'aaaaaaaa',
      peerIdentityHash: 'bbbbbbbb',
      peerIdentityPublicKey: 'pk-peer',
    });
    machine.endCall('local_hangup');
    expect(machine.getState().status).toBe('ended');

    // Now a new invite arrives before the 3.5s UI timer
    await receiver.handleSignal({
      callId: 'call-new',
      frameType: CALL_FRAME_INVITE,
      senderId: 'sess-1',
      ciphertext: 'ciphertext-invite',
      signalSeq: 1n,
    });

    // Should transition to incoming_ringing, NOT reject!
    expect(machine.getState().status).toBe('incoming_ringing');
    expect(machine.getState().callId).toBe('call-new');
  });
});
