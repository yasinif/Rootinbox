import { describe, it, expect } from 'vitest';
import { applyCodecPreferences } from '../../src/infrastructure/transport/webrtc/peer-connection';
import { CALL_C09 } from '../../src/domain/errors';

describe('Codec Preferences Tests (§14.6, §23.2)', () => {
  it('audio: Opus 48kHz is mandatory and preferred', () => {
    const mockTransceiver = {
      setCodecPreferences: (codecs: RTCRtpCodecCapability[]) => {
        expect(codecs[0].mimeType).toBe('audio/opus');
      },
    };

    const codecs: RTCRtpCodecCapability[] = [
      { mimeType: 'audio/PCMU', clockRate: 8000 },
      { mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
      { mimeType: 'audio/PCMA', clockRate: 8000 },
    ];

    const sorted = applyCodecPreferences(mockTransceiver, 'audio', codecs);
    expect(sorted[0].mimeType).toBe('audio/opus');
    expect(sorted[0].clockRate).toBe(48000);
  });

  it('audio: missing Opus 48kHz throws CALL_C09', () => {
    const mockTransceiver = { setCodecPreferences: () => {} };
    const codecs: RTCRtpCodecCapability[] = [
      { mimeType: 'audio/PCMU', clockRate: 8000 },
      { mimeType: 'audio/opus', clockRate: 24000 }, // wrong rate
    ];

    expect(() => applyCodecPreferences(mockTransceiver, 'audio', codecs)).toThrowError(
      new RegExp(CALL_C09),
    );
  });

  it('video: VP8 is mandatory and first, H.264 is never first', () => {
    let appliedCodecs: RTCRtpCodecCapability[] = [];
    const mockTransceiver = {
      setCodecPreferences: (codecs: RTCRtpCodecCapability[]) => {
        appliedCodecs = codecs;
      },
    };

    const codecs: RTCRtpCodecCapability[] = [
      { mimeType: 'video/H264', clockRate: 90000 },
      { mimeType: 'video/AV1', clockRate: 90000 },
      { mimeType: 'video/VP8', clockRate: 90000 },
      { mimeType: 'video/VP9', clockRate: 90000 },
    ];

    const sorted = applyCodecPreferences(mockTransceiver, 'video', codecs);
    expect(sorted[0].mimeType.toLowerCase()).toBe('video/vp8');
    expect(sorted[sorted.length - 1].mimeType.toLowerCase()).toBe('video/h264');
    expect(appliedCodecs[0].mimeType.toLowerCase()).toBe('video/vp8');
  });

  it('video: missing VP8 throws CALL_C09', () => {
    const mockTransceiver = { setCodecPreferences: () => {} };
    const codecs: RTCRtpCodecCapability[] = [
      { mimeType: 'video/H264', clockRate: 90000 },
      { mimeType: 'video/VP9', clockRate: 90000 },
    ];

    expect(() => applyCodecPreferences(mockTransceiver, 'video', codecs)).toThrowError(
      new RegExp(CALL_C09),
    );
  });
});
