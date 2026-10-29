/**
 * WebRTC RTCPeerConnection Factory.
 * Phase 12B §12.1, §12.6 (Task 9).
 *
 * This file is the exclusive creation point for RTCPeerConnection instances.
 */

import { MockRTCPeerConnection } from '../../../__mocks__/webrtc';
import { CALL_C09 } from '../../../domain/errors';

export function createPeerConnection(config: RTCConfiguration): RTCPeerConnection {
  if (typeof RTCPeerConnection !== 'undefined') {
    return new RTCPeerConnection(config);
  }
  // Test/mock environment fallback
  return new MockRTCPeerConnection(config) as unknown as RTCPeerConnection;
}

export interface CodecCapability {
  mimeType: string;
  clockRate: number;
  channels?: number;
  sdpFmtpLine?: string;
}

export function applyCodecPreferences(
  transceiver: { setCodecPreferences?: (codecs: CodecCapability[]) => void },
  kind: 'audio' | 'video',
  supportedCodecs?: CodecCapability[],
): CodecCapability[] {
  const receiverClass = typeof RTCRtpReceiver !== 'undefined'
    ? (RTCRtpReceiver as unknown as { getCapabilities?: (kind: string) => { codecs: CodecCapability[] } | null })
    : undefined;
  const codecs: CodecCapability[] = supportedCodecs ?? (
    receiverClass && receiverClass.getCapabilities
      ? receiverClass.getCapabilities(kind)?.codecs ?? []
      : []
  );

  if (kind === 'audio') {
    const hasOpus48k = codecs.some(
      (c) => c.mimeType.toLowerCase() === 'audio/opus' && c.clockRate === 48000,
    );
    if (!hasOpus48k) {
      throw new Error(`${CALL_C09}: Mandatory audio codec Opus 48kHz is missing`);
    }
    const opus = codecs.filter((c) => c.mimeType.toLowerCase() === 'audio/opus');
    const others = codecs.filter((c) => c.mimeType.toLowerCase() !== 'audio/opus');
    const sorted = [...opus, ...others];
    transceiver.setCodecPreferences?.(sorted);
    return sorted;
  } else {
    const hasVp8 = codecs.some((c) => c.mimeType.toLowerCase() === 'video/vp8');
    if (!hasVp8) {
      throw new Error(`${CALL_C09}: Mandatory video codec VP8 is missing`);
    }
    const vp8 = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/vp8');
    const h264 = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
    const others = codecs.filter(
      (c) => c.mimeType.toLowerCase() !== 'video/vp8' && c.mimeType.toLowerCase() !== 'video/h264',
    );
    const sorted = [...vp8, ...others, ...h264];
    transceiver.setCodecPreferences?.(sorted);
    return sorted;
  }
}
