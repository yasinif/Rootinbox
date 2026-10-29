import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallSessionMachine } from '../../src/usecase/call/CallSessionMachine';
import type {
  CallMediaSession,
  CallMediaSessionFactory,
  CallStateProbe,
} from '../../src/domain/ports/call';

describe('CallSessionMachine Unit Tests (§23.2)', () => {
  let machine: CallSessionMachine;
  let mockMediaSession: CallMediaSession;
  let mockFactory: CallMediaSessionFactory;
  let mockProbe: CallStateProbe;

  beforeEach(() => {
    mockMediaSession = {
      callId: 'call-1',
      role: 'caller',
      polite: true,
      initialize: vi.fn().mockResolvedValue(undefined),
      createAndSendOffer: vi.fn().mockResolvedValue({ signalSeq: 1, ciphertext: 'offer-c' }),
      handleRemoteOfferAndAnswer: vi.fn().mockResolvedValue({ signalSeq: 2, ciphertext: 'answer-c' }),
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
  });

  it('starts in idle state', () => {
    const state = machine.getState();
    expect(state.status).toBe('idle');
    expect(state.callId).toBe('');
  });

  it('transitions legally: idle -> outgoing_ringing -> connecting -> connected -> ended', async () => {
    await machine.startOutbound({
      callId: 'call-1',
      peerId: 'user-2',
      peerDisplayName: 'Bob',
      localIdentityHash: 'aaaa',
      peerIdentityHash: 'bbbb',
      peerIdentityPublicKey: 'pk-bob',
    });

    expect(machine.getState().status).toBe('outgoing_ringing');
    expect(machine.getState().callId).toBe('call-1');
    expect(machine.getState().role).toBe('caller');

    // Remote answered
    machine.remoteAnswered();
    expect(machine.getState().status).toBe('connecting');

    // Connection established
    machine.onConnected();
    expect(machine.getState().status).toBe('connected');
    expect(machine.getState().connectedAt).not.toBeNull();

    // Ended
    machine.endCall('local_hangup');
    expect(machine.getState().status).toBe('ended');
    expect(machine.getState().endReason).toBe('local_hangup');
  });

  it('transitions legally for inbound: idle -> incoming_ringing -> connecting -> connected', () => {
    machine.startInbound({
      callId: 'call-2',
      peerId: 'user-1',
      peerDisplayName: 'Alice',
      localIdentityHash: 'bbbb',
      peerIdentityHash: 'aaaa',
      peerIdentityPublicKey: 'pk-alice',
    });

    expect(machine.getState().status).toBe('incoming_ringing');
    expect(machine.getState().role).toBe('callee');

    // Accept call
    machine.acceptCall();
    expect(machine.getState().status).toBe('connecting');

    machine.onConnected();
    expect(machine.getState().status).toBe('connected');
  });

  it('rejects illegal transitions without mutating state', async () => {
    await machine.startOutbound({
      callId: 'call-1',
      peerId: 'user-2',
      peerDisplayName: 'Bob',
      localIdentityHash: 'aaaa',
      peerIdentityHash: 'bbbb',
      peerIdentityPublicKey: 'pk-bob',
    });

    // Attempting to acceptCall() when in outgoing_ringing should throw
    expect(() => machine.acceptCall()).toThrow();
    expect(machine.getState().status).toBe('outgoing_ringing');

    // Attempting to start a second call while ringing should throw
    await expect(machine.startOutbound({
      callId: 'call-2',
      peerId: 'user-3',
      peerDisplayName: 'Charlie',
      localIdentityHash: 'aaaa',
      peerIdentityHash: 'cccc',
      peerIdentityPublicKey: 'pk-charlie',
    })).rejects.toThrow();

    expect(machine.getState().callId).toBe('call-1');
    expect(machine.getState().status).toBe('outgoing_ringing');
  });

  it('terminal cleanup is idempotent under three invocations (§13.9)', async () => {
    await machine.startOutbound({
      callId: 'call-1',
      peerId: 'user-2',
      peerDisplayName: 'Bob',
      localIdentityHash: 'aaaa',
      peerIdentityHash: 'bbbb',
      peerIdentityPublicKey: 'pk-bob',
    });

    // Invocations 1, 2, and 3
    machine.endCall('local_hangup');
    expect(machine.getState().status).toBe('ended');
    expect(mockMediaSession.terminate).toHaveBeenCalledTimes(1);

    machine.endCall('local_hangup');
    expect(machine.getState().status).toBe('ended');
    expect(mockMediaSession.terminate).toHaveBeenCalledTimes(1);

    machine.endCall('remote_hangup');
    expect(machine.getState().status).toBe('ended');
    expect(mockMediaSession.terminate).toHaveBeenCalledTimes(1);
  });

  it('threads remoteStream through state updates and clears on endCall', async () => {
    let sessionCallbacks: any;
    mockFactory.createSession = vi.fn().mockImplementation((params) => {
      sessionCallbacks = params.callbacks;
      return mockMediaSession;
    });

    await machine.startOutbound({
      callId: 'call-stream',
      peerId: 'user-2',
      peerDisplayName: 'Bob',
      localIdentityHash: 'aaaa',
      peerIdentityHash: 'bbbb',
      peerIdentityPublicKey: 'pk-bob',
    });

    expect(machine.getState().remoteStream).toBeNull();

    const fakeStream = { id: 'remote-audio-stream' } as any;
    sessionCallbacks.onStateChange({ remoteStream: fakeStream });
    expect(machine.getState().remoteStream).toBe(fakeStream);

    machine.endCall('local_hangup');
    expect(machine.getState().status).toBe('ended');
    expect(machine.getState().remoteStream).toBeNull();
  });
});
