import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CallSessionMachine } from '../../src/usecase/call/CallSessionMachine';
import type {
  CallMediaSession,
  CallMediaSessionFactory,
  CallStateProbe,
} from '../../src/domain/ports/call';

describe('Control-Plane Grace Tests (§13.6, §23.2)', () => {
  let machine: CallSessionMachine;
  let mockMediaSession: CallMediaSession;
  let mockFactory: CallMediaSessionFactory;
  let mockProbe: CallStateProbe;

  beforeEach(() => {
    vi.useFakeTimers();

    mockMediaSession = {
      callId: 'call-grace',
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
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('caller side: WS disconnect triggers reconnecting, grace timer fires at 20,000ms', async () => {
    await machine.startOutbound({
      callId: 'call-grace',
      peerId: 'user-2',
      peerDisplayName: 'Bob',
      localIdentityHash: 'aaaa',
      peerIdentityHash: 'bbbb',
      peerIdentityPublicKey: 'pk-bob',
    });

    machine.remoteAnswered();
    machine.onConnected();
    expect(machine.getState().status).toBe('connected');

    // WS drops
    machine.handleWsDisconnect();
    expect(machine.getState().status).toBe('reconnecting');

    // Advance 19,999 ms - still reconnecting
    vi.advanceTimersByTime(19_999);
    expect(machine.getState().status).toBe('reconnecting');

    // Advance 1 ms (total 20,000 ms) - grace timer fires
    vi.advanceTimersByTime(1);
    expect(machine.getState().status).toBe('ended');
    expect(machine.getState().endReason).toBe('ws_drop');
    expect(mockMediaSession.terminate).toHaveBeenCalledTimes(1);
  });

  it('callee side: WS disconnect triggers reconnecting, grace timer fires at 20,000ms', () => {
    machine.startInbound({
      callId: 'call-grace-callee',
      peerId: 'user-1',
      peerDisplayName: 'Alice',
      localIdentityHash: 'bbbb',
      peerIdentityHash: 'aaaa',
      peerIdentityPublicKey: 'pk-alice',
    });

    machine.acceptCall();
    machine.onConnected();
    expect(machine.getState().status).toBe('connected');

    // WS drops
    machine.handleWsDisconnect();
    expect(machine.getState().status).toBe('reconnecting');

    // Advance 20,000 ms
    vi.advanceTimersByTime(20_000);
    expect(machine.getState().status).toBe('ended');
    expect(machine.getState().endReason).toBe('ws_drop');
    expect(mockMediaSession.terminate).toHaveBeenCalledTimes(1);
  });

  it('WS reconnect within grace cancels timer and restores connected state via probe', async () => {
    await machine.startOutbound({
      callId: 'call-grace',
      peerId: 'user-2',
      peerDisplayName: 'Bob',
      localIdentityHash: 'aaaa',
      peerIdentityHash: 'bbbb',
      peerIdentityPublicKey: 'pk-bob',
    });

    machine.remoteAnswered();
    machine.onConnected();

    // WS drops
    machine.handleWsDisconnect();
    expect(machine.getState().status).toBe('reconnecting');

    // Advance 10 seconds
    vi.advanceTimersByTime(10_000);

    // Reconnects
    await machine.handleWsReconnect('aaaa');
    expect(mockProbe.isCallAlive).toHaveBeenCalledWith('call-grace', 'aaaa');
    expect(machine.getState().status).toBe('connected');

    // Further timer expiry does not terminate call
    vi.advanceTimersByTime(20_000);
    expect(machine.getState().status).toBe('connected');
  });
});
