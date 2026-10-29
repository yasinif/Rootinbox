import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { CallOverlay } from '../../src/presentation/components/call/CallOverlay';
import { AppContext } from '../../src/presentation/context';
import { CallSessionMachine } from '../../src/usecase/call/CallSessionMachine';

describe('CallOverlay Component Test (§23.4, ADR-P12B-42)', () => {
  const mockMediaSession = {
    callId: 'call-overlay-1',
    role: 'caller' as const,
    polite: true,
    initialize: vi.fn(),
    createAndSendOffer: vi.fn(),
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

  it('renders nothing when call machine is idle', () => {
    const callMachine = new CallSessionMachine(mockFactory, mockProbe);
    const mockCtx: any = {
      authUC: {} as any,
      chatUC: {} as any,
      syncUC: {} as any,
      callMachine,
      placeCallUC: {} as any,
      answerCallUC: {} as any,
      endCallUC: {} as any,
    };

    render(
      <AppContext.Provider value={mockCtx}>
        <CallOverlay />
      </AppContext.Provider>,
    );

    expect(screen.queryByTestId('call-overlay')).toBeNull();
  });

  it('renders incoming call sheet on incoming_ringing', () => {
    const callMachine = new CallSessionMachine(mockFactory, mockProbe);
    callMachine.startInbound({
      callId: 'call-inbound-1',
      peerId: 'alice-id',
      peerDisplayName: 'Alice',
      localIdentityHash: 'bbbb',
      peerIdentityHash: 'aaaa',
      peerIdentityPublicKey: 'pk-alice',
    });

    const mockCtx: any = {
      authUC: {} as any,
      chatUC: {} as any,
      syncUC: {} as any,
      callMachine,
      placeCallUC: {} as any,
      answerCallUC: {} as any,
      endCallUC: {} as any,
    };

    render(
      <AppContext.Provider value={mockCtx}>
        <CallOverlay />
      </AppContext.Provider>,
    );

    expect(screen.getByTestId('incoming-call-sheet')).toBeDefined();
    expect(screen.getByTestId('caller-display-name').textContent).toBe('Alice');
  });

  it('renders active call panel on outgoing_ringing and connected', async () => {
    const callMachine = new CallSessionMachine(mockFactory, mockProbe);
    await callMachine.startOutbound({
      callId: 'call-outbound-1',
      peerId: 'bob-id',
      peerDisplayName: 'Bob',
      localIdentityHash: 'aaaa',
      peerIdentityHash: 'bbbb',
      peerIdentityPublicKey: 'pk-bob',
    });

    const mockCtx: any = {
      authUC: {} as any,
      chatUC: {} as any,
      syncUC: {} as any,
      callMachine,
      placeCallUC: {} as any,
      answerCallUC: {} as any,
      endCallUC: {} as any,
    };

    const { rerender } = render(
      <AppContext.Provider value={mockCtx}>
        <CallOverlay />
      </AppContext.Provider>,
    );

    expect(screen.getByTestId('active-call-panel')).toBeDefined();
    expect(screen.getByTestId('peer-display-name').textContent).toBe('Bob');
    expect(screen.getByTestId('call-status-label').textContent).toContain('در حال برقراری تماس');

    // Transition to connected
    callMachine.onConnected();
    rerender(
      <AppContext.Provider value={mockCtx}>
        <CallOverlay />
      </AppContext.Provider>,
    );
    expect(screen.getByTestId('call-status-label').textContent).toContain('00:00');
  });

  it('triggers answer flow when clicking Accept button', async () => {
    const callMachine = new CallSessionMachine(mockFactory, mockProbe);
    callMachine.startInbound({
      callId: 'call-inbound-1',
      peerId: 'alice-id',
      peerDisplayName: 'Alice',
      localIdentityHash: 'bbbb',
      peerIdentityHash: 'aaaa',
      peerIdentityPublicKey: 'pk-alice',
    });

    const mockAnswerCallUC = {
      execute: vi.fn().mockResolvedValue(undefined),
    };
    const mockReceiveSignalUC = {
      getPendingOffer: vi.fn().mockReturnValue({
        callId: 'call-inbound-1',
        senderId: 'alice-id',
        sdp: 'v=0...',
        sig: 'mock-sig',
      }),
      clearPendingOffer: vi.fn(),
    };

    const mockCtx: any = {
      authUC: {} as any,
      chatUC: {} as any,
      syncUC: {} as any,
      callMachine,
      placeCallUC: {} as any,
      answerCallUC: mockAnswerCallUC as any,
      endCallUC: {} as any,
      receiveSignalUC: mockReceiveSignalUC as any,
    };

    render(
      <AppContext.Provider value={mockCtx}>
        <CallOverlay />
      </AppContext.Provider>,
    );

    const acceptBtn = screen.getByTestId('accept-call-btn');
    expect(acceptBtn).toBeDefined();
    fireEvent.click(acceptBtn);

    await waitFor(() => {
      expect(mockReceiveSignalUC.getPendingOffer).toHaveBeenCalled();
      expect(mockAnswerCallUC.execute).toHaveBeenCalledWith({
        remoteSdp: 'v=0...',
        remoteSig: 'mock-sig',
      });
      expect(mockReceiveSignalUC.clearPendingOffer).toHaveBeenCalled();
    });
  });

  it('triggers decline flow when clicking Decline button', async () => {
    const callMachine = new CallSessionMachine(mockFactory, mockProbe);
    callMachine.startInbound({
      callId: 'call-inbound-1',
      peerId: 'alice-id',
      peerDisplayName: 'Alice',
      localIdentityHash: 'bbbb',
      peerIdentityHash: 'aaaa',
      peerIdentityPublicKey: 'pk-alice',
    });

    const mockEndCallUC = {
      execute: vi.fn().mockResolvedValue(undefined),
    };
    const mockReceiveSignalUC = {
      getPendingOffer: vi.fn().mockReturnValue(null),
      clearPendingOffer: vi.fn(),
    };

    const mockCtx: any = {
      authUC: {} as any,
      chatUC: {} as any,
      syncUC: {} as any,
      callMachine,
      placeCallUC: {} as any,
      answerCallUC: {} as any,
      endCallUC: mockEndCallUC as any,
      receiveSignalUC: mockReceiveSignalUC as any,
    };

    render(
      <AppContext.Provider value={mockCtx}>
        <CallOverlay />
      </AppContext.Provider>,
    );

    const declineBtn = screen.getByTestId('decline-call-btn');
    expect(declineBtn).toBeDefined();
    fireEvent.click(declineBtn);

    await waitFor(() => {
      expect(mockEndCallUC.execute).toHaveBeenCalledWith('remote_reject');
      expect(mockReceiveSignalUC.clearPendingOffer).toHaveBeenCalled();
    });
  });

  it('hides video and screenshare buttons in voice calls (callType: audio)', async () => {
    const callMachine = new CallSessionMachine(mockFactory, mockProbe);
    await callMachine.startOutbound({
      callId: 'call-audio-1',
      peerId: 'bob-id',
      peerDisplayName: 'Bob',
      localIdentityHash: 'aaaa',
      peerIdentityHash: 'bbbb',
      peerIdentityPublicKey: 'pk-bob',
      callType: 'audio',
    });

    const mockCtx: any = {
      authUC: {} as any,
      chatUC: {} as any,
      syncUC: {} as any,
      callMachine,
      placeCallUC: {} as any,
      answerCallUC: {} as any,
      endCallUC: {} as any,
    };

    render(
      <AppContext.Provider value={mockCtx}>
        <CallOverlay />
      </AppContext.Provider>,
    );

    expect(screen.getByTestId('active-call-panel')).toBeDefined();
    expect(screen.getByTestId('mute-btn')).toBeDefined();
    expect(screen.getByTestId('speaker-btn')).toBeDefined();
    expect(screen.getByTestId('end-call-btn')).toBeDefined();

    // Voice call MUST NOT render video, screenshare, or camera switch buttons
    expect(screen.queryByTestId('video-btn')).toBeNull();
    expect(screen.queryByTestId('screenshare-btn')).toBeNull();
    expect(screen.queryByTestId('switch-camera-btn')).toBeNull();
  });

  it('shows video and screenshare buttons in video calls (callType: video)', async () => {
    const callMachine = new CallSessionMachine(mockFactory, mockProbe);
    await callMachine.startOutbound({
      callId: 'call-video-1',
      peerId: 'bob-id',
      peerDisplayName: 'Bob',
      localIdentityHash: 'aaaa',
      peerIdentityHash: 'bbbb',
      peerIdentityPublicKey: 'pk-bob',
      callType: 'video',
    });

    const mockCtx: any = {
      authUC: {} as any,
      chatUC: {} as any,
      syncUC: {} as any,
      callMachine,
      placeCallUC: {} as any,
      answerCallUC: {} as any,
      endCallUC: {} as any,
    };

    render(
      <AppContext.Provider value={mockCtx}>
        <CallOverlay />
      </AppContext.Provider>,
    );

    expect(screen.getByTestId('active-call-panel')).toBeDefined();
    // Video call MUST render video and screenshare buttons
    expect(screen.getByTestId('video-btn')).toBeDefined();
    expect(screen.getByTestId('screenshare-btn')).toBeDefined();
    expect(screen.getByTestId('switch-camera-btn')).toBeDefined();
  });
});


