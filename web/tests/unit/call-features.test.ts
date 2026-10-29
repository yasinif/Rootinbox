import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CallSessionMachine } from '../../src/usecase/call/CallSessionMachine';
import type { CallHistoryRecord } from '../../src/usecase/call/CallSessionMachine';
import type {
  CallMediaSession,
  CallMediaSessionFactory,
  CallStateProbe,
} from '../../src/domain/ports/call';
import {
  mceEncodeCall,
  mceDecode,
  mceDisplayText,
} from '../../src/domain/protocol/content-envelope';

describe('Bundle 2: Call Features Unit Tests (Video, Screen Share, Call History)', () => {
  let machine: CallSessionMachine;
  let mockMediaSession: CallMediaSession;
  let mockFactory: CallMediaSessionFactory;
  let mockProbe: CallStateProbe;

  beforeEach(() => {
    mockMediaSession = {
      callId: 'call-video-1',
      role: 'caller',
      polite: true,
      initialize: vi.fn().mockResolvedValue(undefined),
      createAndSendOffer: vi.fn().mockResolvedValue({ signalSeq: 1, ciphertext: 'offer-c' }),
      handleRemoteOfferAndAnswer: vi.fn().mockResolvedValue({ signalSeq: 2, ciphertext: 'answer-c' }),
      handleRemoteAnswer: vi.fn().mockResolvedValue(undefined),
      handleRemoteCandidate: vi.fn().mockResolvedValue(undefined),
      setMuted: vi.fn(),
      terminate: vi.fn(),
      enableVideo: vi.fn().mockResolvedValue({ id: 'local-cam-stream' } as unknown as MediaStream),
      disableVideo: vi.fn(),
      startScreenShare: vi.fn().mockResolvedValue({ id: 'local-screen-stream' } as unknown as MediaStream),
      stopScreenShare: vi.fn().mockResolvedValue(undefined),
      getLocalVideoStream: vi.fn().mockReturnValue({ id: 'local-cam-stream' } as unknown as MediaStream),
      getRemoteVideoStream: vi.fn().mockReturnValue(null),
    };

    mockFactory = {
      createSession: vi.fn().mockReturnValue(mockMediaSession),
    };

    mockProbe = {
      isCallAlive: vi.fn().mockResolvedValue(true),
    };

    machine = new CallSessionMachine(mockFactory, mockProbe);
  });

  it('starts outbound video call with callType video', async () => {
    await machine.startOutbound({
      callId: 'call-video-1',
      peerId: 'user-bob',
      peerDisplayName: 'Bob',
      localIdentityHash: 'id-alice',
      peerIdentityHash: 'id-bob',
      peerIdentityPublicKey: 'pk-bob',
      callType: 'video',
    });

    const state = machine.getState();
    expect(state.callId).toBe('call-video-1');
    expect(state.status).toBe('outgoing_ringing');
    expect(state.callType).toBe('video');
  });

  it('toggles video stream in CallSessionMachine', async () => {
    await machine.startOutbound({
      callId: 'call-video-1',
      peerId: 'user-bob',
      peerDisplayName: 'Bob',
      localIdentityHash: 'id-alice',
      peerIdentityHash: 'id-bob',
      peerIdentityPublicKey: 'pk-bob',
    });

    expect(machine.getState().isVideoEnabled).toBe(false);

    // Enable video
    await machine.toggleVideo();
    expect(mockMediaSession.enableVideo).toHaveBeenCalled();
    expect(machine.getState().isVideoEnabled).toBe(true);
    expect(machine.getState().localVideoStream).not.toBeNull();

    // Disable video
    await machine.toggleVideo();
    expect(mockMediaSession.disableVideo).toHaveBeenCalled();
    expect(machine.getState().isVideoEnabled).toBe(false);
    expect(machine.getState().localVideoStream).toBeNull();
  });

  it('toggles screen share stream in CallSessionMachine', async () => {
    await machine.startOutbound({
      callId: 'call-video-1',
      peerId: 'user-bob',
      peerDisplayName: 'Bob',
      localIdentityHash: 'id-alice',
      peerIdentityHash: 'id-bob',
      peerIdentityPublicKey: 'pk-bob',
    });

    expect(machine.getState().isScreenSharing).toBe(false);

    // Start screen share
    await machine.toggleScreenShare();
    expect(mockMediaSession.startScreenShare).toHaveBeenCalled();
    expect(machine.getState().isScreenSharing).toBe(true);
    expect(machine.getState().localVideoStream).not.toBeNull();

    // Stop screen share
    await machine.toggleScreenShare();
    expect(mockMediaSession.stopScreenShare).toHaveBeenCalled();
    expect(machine.getState().isScreenSharing).toBe(false);
  });

  it('emits call history record on call end', async () => {
    const records: CallHistoryRecord[] = [];
    machine.onCallEnded((rec) => records.push(rec));

    await machine.startOutbound({
      callId: 'call-hist-1',
      peerId: 'user-bob',
      peerDisplayName: 'Bob',
      localIdentityHash: 'id-alice',
      peerIdentityHash: 'id-bob',
      peerIdentityPublicKey: 'pk-bob',
      callType: 'video',
    });

    machine.remoteAnswered();
    machine.onConnected();

    expect(machine.getState().status).toBe('connected');

    machine.endCall('local_hangup');

    expect(records.length).toBe(1);
    expect(records[0].callId).toBe('call-hist-1');
    expect(records[0].peerId).toBe('user-bob');
    expect(records[0].callType).toBe('video');
    expect(records[0].status).toBe('completed');
  });

  it('correctly maps missed and rejected call history statuses', async () => {
    const records: CallHistoryRecord[] = [];
    machine.onCallEnded((rec) => records.push(rec));

    await machine.startOutbound({
      callId: 'call-hist-2',
      peerId: 'user-bob',
      peerDisplayName: 'Bob',
      localIdentityHash: 'id-alice',
      peerIdentityHash: 'id-bob',
      peerIdentityPublicKey: 'pk-bob',
      callType: 'audio',
    });

    // Remote rejected before connect
    machine.endCall('remote_reject');

    expect(records.length).toBe(1);
    expect(records[0].status).toBe('rejected');
    expect(records[0].callType).toBe('audio');
  });

  it('encodes, decodes, and formats MCE call envelopes', () => {
    const encoded = mceEncodeCall({
      callId: 'c-100',
      callType: 'video',
      direction: 'outgoing',
      status: 'completed',
      duration: 125,
    });

    const decoded = mceDecode(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.t).toBe('call');
    if (decoded?.t === 'call') {
      expect(decoded.c.callId).toBe('c-100');
      expect(decoded.c.callType).toBe('video');
      expect(decoded.c.duration).toBe(125);
    }

    const display = mceDisplayText(encoded);
    expect(display).toBe('📹 Video Call (2:05)');

    const missedVoice = mceEncodeCall({
      callId: 'c-101',
      callType: 'audio',
      direction: 'incoming',
      status: 'missed',
      duration: 0,
    });
    expect(mceDisplayText(missedVoice)).toBe('📞 Missed Voice Call');
  });
});
