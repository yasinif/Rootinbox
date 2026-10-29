/**
 * WebRTC Test Double.
 * Phase 12B §2.4: Mock RTCPeerConnection and related APIs for vitest.
 * This is the ONLY WebRTC mock in the codebase.
 */

export class MockRTCSessionDescription {
  readonly type: RTCSdpType;
  readonly sdp: string;

  constructor(init?: RTCSessionDescriptionInit) {
    this.type = init?.type ?? 'offer';
    this.sdp = init?.sdp ?? '';
  }
}

export class MockRTCIceCandidate {
  readonly candidate: string;
  readonly sdpMid: string | null;
  readonly sdpMLineIndex: number | null;

  constructor(init?: RTCIceCandidateInit) {
    this.candidate = init?.candidate ?? '';
    this.sdpMid = init?.sdpMid ?? null;
    this.sdpMLineIndex = init?.sdpMLineIndex ?? null;
  }
}

export interface MockCodecCapability {
  mimeType: string;
  clockRate: number;
  channels?: number;
  sdpFmtpLine?: string;
}

interface MockTransceiver {
  readonly mid: string | null;
  readonly sender: { track: MediaStreamTrack | null; replaceTrack: (t: MediaStreamTrack | null) => Promise<void> };
  readonly receiver: { track: MediaStreamTrack };
  direction: RTCRtpTransceiverDirection;
  setCodecPreferences: (codecs: MockCodecCapability[]) => void;
}

type IceConnectionState = 'new' | 'checking' | 'connected' | 'completed' | 'disconnected' | 'failed' | 'closed';
type SignalingState = 'stable' | 'have-local-offer' | 'have-remote-offer' | 'have-local-pranswer' | 'have-remote-pranswer' | 'closed';
type ConnectionState = 'new' | 'connecting' | 'connected' | 'disconnected' | 'failed' | 'closed';

export class MockRTCPeerConnection extends EventTarget {
  localDescription: RTCSessionDescription | null = null;
  remoteDescription: RTCSessionDescription | null = null;
  iceConnectionState: IceConnectionState = 'new';
  signalingState: SignalingState = 'stable';
  connectionState: ConnectionState = 'new';

  private _transceivers: MockTransceiver[] = [];
  private _localCandidates: MockRTCIceCandidate[] = [];
  private _closed = false;

  // Event handlers
  onicecandidate: ((ev: Event) => void) | null = null;
  oniceconnectionstatechange: ((ev: Event) => void) | null = null;
  onsignalingstatechange: ((ev: Event) => void) | null = null;
  onconnectionstatechange: ((ev: Event) => void) | null = null;
  onnegotiationneeded: ((ev: Event) => void) | null = null;
  ontrack: ((ev: Event) => void) | null = null;
  onicecandidateerror: ((ev: Event) => void) | null = null;

  // Track setRemoteDescription calls for fingerprint-gate assertions
  setRemoteDescriptionCallCount = 0;

  constructor(_config?: RTCConfiguration) {
    super();
    void _config;
  }

  async createOffer(_options?: RTCOfferOptions): Promise<RTCSessionDescriptionInit> {
    void _options;
    return {
      type: 'offer',
      sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' +
        'a=fingerprint:sha-256 AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89\r\n' +
        'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' +
        'a=rtpmap:111 opus/48000/2\r\n',
    };
  }

  async createAnswer(_options?: RTCAnswerOptions): Promise<RTCSessionDescriptionInit> {
    void _options;
    return {
      type: 'answer',
      sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' +
        'a=fingerprint:sha-256 12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0:12:34:56:78:9A:BC:DE:F0\r\n' +
        'm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n' +
        'a=rtpmap:111 opus/48000/2\r\n',
    };
  }

  async setLocalDescription(desc?: RTCLocalSessionDescriptionInit): Promise<void> {
    if (this._closed) throw new DOMException('Connection is closed', 'InvalidStateError');
    if (desc?.type === 'rollback') {
      this.localDescription = null;
      this.signalingState = 'stable';
      return;
    }
    const sdp = desc?.sdp ?? (await this.createOffer()).sdp!;
    this.localDescription = new MockRTCSessionDescription({ type: desc?.type ?? 'offer', sdp }) as unknown as RTCSessionDescription;
    this.signalingState = desc?.type === 'answer' ? 'stable' : 'have-local-offer';
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit): Promise<void> {
    if (this._closed) throw new DOMException('Connection is closed', 'InvalidStateError');
    this.setRemoteDescriptionCallCount++;
    this.remoteDescription = new MockRTCSessionDescription(desc) as unknown as RTCSessionDescription;
    this.signalingState = desc.type === 'answer' ? 'stable' : 'have-remote-offer';
  }

  async addIceCandidate(candidate?: RTCIceCandidateInit): Promise<void> {
    if (candidate) {
      this._localCandidates.push(new MockRTCIceCandidate(candidate));
    }
  }

  addTrack(track: MediaStreamTrack, ..._streams: MediaStream[]): RTCRtpSender {
    void _streams;
    const transceiver: MockTransceiver = {
      mid: String(this._transceivers.length),
      sender: {
        track,
        replaceTrack: async (t: MediaStreamTrack | null) => { transceiver.sender.track = t; },
      },
      receiver: { track } as { track: MediaStreamTrack },
      direction: 'sendrecv',
      setCodecPreferences: () => {},
    };
    this._transceivers.push(transceiver);
    return transceiver.sender as unknown as RTCRtpSender;
  }

  addTransceiver(trackOrKind: string | MediaStreamTrack, _init?: RTCRtpTransceiverInit): RTCRtpTransceiver {
    void _init;
    const transceiver: MockTransceiver = {
      mid: String(this._transceivers.length),
      sender: {
        track: typeof trackOrKind === 'string' ? null : trackOrKind,
        replaceTrack: async (t: MediaStreamTrack | null) => { transceiver.sender.track = t; },
      },
      receiver: { track: null } as unknown as { track: MediaStreamTrack },
      direction: 'sendrecv',
      setCodecPreferences: () => {},
    };
    this._transceivers.push(transceiver);
    return transceiver as unknown as RTCRtpTransceiver;
  }

  getTransceivers(): RTCRtpTransceiver[] {
    return this._transceivers as unknown as RTCRtpTransceiver[];
  }

  getSenders(): RTCRtpSender[] {
    return this._transceivers.map(t => t.sender) as unknown as RTCRtpSender[];
  }

  getReceivers(): RTCRtpReceiver[] {
    return this._transceivers.map(t => t.receiver) as unknown as RTCRtpReceiver[];
  }

  close(): void {
    this._closed = true;
    this.signalingState = 'closed';
    this.iceConnectionState = 'closed';
    this.connectionState = 'closed';
  }

  getStats(): Promise<RTCStatsReport> {
    return Promise.resolve(new Map() as unknown as RTCStatsReport);
  }

  // Helpers for test control
  _simulateIceConnectionState(state: IceConnectionState): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.(new Event('iceconnectionstatechange'));
    this.dispatchEvent(new Event('iceconnectionstatechange'));
  }

  _simulateConnectionState(state: ConnectionState): void {
    this.connectionState = state;
    this.onconnectionstatechange?.(new Event('connectionstatechange'));
    this.dispatchEvent(new Event('connectionstatechange'));
  }

  _simulateNegotiationNeeded(): void {
    this.onnegotiationneeded?.(new Event('negotiationneeded'));
    this.dispatchEvent(new Event('negotiationneeded'));
  }

  _simulateIceCandidate(candidate: RTCIceCandidateInit | null): void {
    const event = new Event('icecandidate') as Event & { candidate: RTCIceCandidate | null };
    Object.defineProperty(event, 'candidate', {
      value: candidate ? new MockRTCIceCandidate(candidate) : null,
    });
    this.onicecandidate?.(event);
    this.dispatchEvent(event);
  }

  _simulateIceCandidateError(errorCode: number, url: string, hostCandidate?: string): void {
    const event = new Event('icecandidateerror') as Event & {
      errorCode: number; url: string; hostCandidate: string;
    };
    Object.defineProperty(event, 'errorCode', { value: errorCode });
    Object.defineProperty(event, 'url', { value: url });
    Object.defineProperty(event, 'hostCandidate', { value: hostCandidate ?? '' });
    this.onicecandidateerror?.(event);
    this.dispatchEvent(event);
  }

  _simulateTrack(track: MediaStreamTrack, streams: MediaStream[]): void {
    const event = new Event('track') as Event & {
      track: MediaStreamTrack; streams: readonly MediaStream[]; receiver: RTCRtpReceiver;
      transceiver: RTCRtpTransceiver;
    };
    Object.defineProperty(event, 'track', { value: track });
    Object.defineProperty(event, 'streams', { value: streams });
    Object.defineProperty(event, 'receiver', { value: { track } });
    Object.defineProperty(event, 'transceiver', { value: this._transceivers[0] });
    this.ontrack?.(event);
    this.dispatchEvent(event);
  }
}

/**
 * Install the WebRTC mocks into the global scope.
 * Call this in a vitest setup file or at the top of test suites.
 */
export function installWebRTCMocks(): void {
  const g = globalThis as Record<string, unknown>;
  g.RTCPeerConnection = MockRTCPeerConnection;
  g.RTCSessionDescription = MockRTCSessionDescription;
  g.RTCIceCandidate = MockRTCIceCandidate;
}

/**
 * Remove the WebRTC mocks from the global scope.
 */
export function removeWebRTCMocks(): void {
  const g = globalThis as Record<string, unknown>;
  delete g.RTCPeerConnection;
  delete g.RTCSessionDescription;
  delete g.RTCIceCandidate;
}
