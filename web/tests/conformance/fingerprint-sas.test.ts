/**
 * Phase 12B Conformance Tests — Fingerprint and SAS.
 */

import { describe, it, expect } from 'vitest';
import vectors from '../../src/__vectors__/crypto-vectors-v2.json';
import { buildFingerprintPayload, parseSdpFingerprint } from '../../src/workers/crypto/primitives/call-fingerprint';
import { computeSAS } from '../../src/workers/crypto/primitives/call-sas';
import { hexEncode, hexDecode } from '../../src/workers/crypto/encoding';
import { CALL_FINGERPRINT_PAYLOAD_LENGTH, ROLE_CALLER, ROLE_CALLEE } from '../../src/domain/call/constants';

const v = vectors.vectors;

describe('C-07: call_fingerprint_payload', () => {
  const vec = v.call_fingerprint_payload;

  it('builds caller fingerprint payload matching vector (73 bytes)', () => {
    const callId = hexDecode(vec.call_id_hex);
    const fingerprint = hexDecode(vec.fingerprint_hex);
    const payload = buildFingerprintPayload(callId, fingerprint, ROLE_CALLER);
    expect(payload.length).toBe(CALL_FINGERPRINT_PAYLOAD_LENGTH);
    expect(hexEncode(payload)).toBe(vec.caller_payload_hex);
  });

  it('builds callee fingerprint payload matching vector', () => {
    const callId = hexDecode(vec.call_id_hex);
    const fingerprint = hexDecode(vec.fingerprint_hex);
    const payload = buildFingerprintPayload(callId, fingerprint, ROLE_CALLEE);
    expect(payload.length).toBe(CALL_FINGERPRINT_PAYLOAD_LENGTH);
    expect(hexEncode(payload)).toBe(vec.callee_payload_hex);
  });
});

describe('C-08: call_fingerprint_sdp', () => {
  const vec = v.call_fingerprint_sdp;

  it('parses SDP fingerprint line correctly', () => {
    const parsed = parseSdpFingerprint(vec.sdp_line);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(vec.byte_length);
    expect(hexEncode(parsed!)).toBe(vec.raw_bytes_hex.toLowerCase());
  });

  it('returns null for SDP without fingerprint', () => {
    expect(parseSdpFingerprint('v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n')).toBeNull();
  });

  it('parses fingerprint from multi-line SDP', () => {
    const sdp = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' + vec.sdp_line + '\r\nm=audio 9\r\n';
    const parsed = parseSdpFingerprint(sdp);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(32);
  });
});

describe('C-09: call_sas', () => {
  const vec = v.call_sas;

  it('computes SAS digits matching vector', async () => {
    const callerFP = hexDecode(vec.caller_fp_hex);
    const calleeFP = hexDecode(vec.callee_fp_hex);
    const callId = hexDecode(vec.call_id_hex);

    const sas = await computeSAS(callerFP, calleeFP, callId);
    expect(sas).toBe(vec.sas_digits);
    expect(sas!.length).toBe(6);
  });

  it('SAS is order-dependent (swapped FPs produce different result)', async () => {
    const callerFP = hexDecode(vec.caller_fp_hex);
    const calleeFP = hexDecode(vec.callee_fp_hex);
    const callId = hexDecode(vec.call_id_hex);

    const sas1 = await computeSAS(callerFP, calleeFP, callId);
    const sas2 = await computeSAS(calleeFP, callerFP, callId);
    // They should be different (different fingerprint order)
    expect(sas1).not.toBe(sas2);
  });
});

describe('C-10: call_sas_rejection', () => {
  it('handles rejection vector with rehash', async () => {
    const vec = v.call_sas_rejection;
    if (!vec) {
      // Rejection vector not found in test data — skip
      console.warn('SAS rejection vector not available');
      return;
    }
    const callerFP = hexDecode(vec.caller_fp_hex);
    const calleeFP = hexDecode(vec.callee_fp_hex);
    const callId = hexDecode(vec.call_id_hex);

    const sas = await computeSAS(callerFP, calleeFP, callId);
    expect(sas).toBe(vec.sas_digits);
  });
});
