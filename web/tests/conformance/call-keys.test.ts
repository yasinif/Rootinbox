/**
 * Phase 12B Conformance Tests — Call Keys, IVs, AADs.
 * Tests against crypto-vectors-v2.json from the Go backend.
 * No hardcoded bytes except the 3 structural constants.
 */

import { describe, it, expect } from 'vitest';
import vectors from '../../src/__vectors__/crypto-vectors-v2.json';
import { buildCallKeyInfo, deriveCallKeys } from '../../src/workers/crypto/primitives/call-keys';
import { deriveCallIVPrefix, buildCallIV } from '../../src/workers/crypto/primitives/call-iv';
import { buildCallAAD } from '../../src/workers/crypto/primitives/call-aad';
import { ReplayWindow } from '../../src/workers/crypto/replay';
import { hexEncode, hexDecode } from '../../src/workers/crypto/encoding';
import { CALL_KEY_INFO_LENGTH, CALL_AAD_LENGTH } from '../../src/domain/call/constants';

const v = vectors.vectors;

describe('C-01: call_key_info', () => {
  const vec = v.call_key_info;

  it('caller_to_callee info is 120 bytes and matches vector', () => {
    const callId = hexDecode(vec.call_id_hex);
    const callerHash = hexDecode(vec.caller_identity_hash_hex);
    const calleeHash = hexDecode(vec.callee_identity_hash_hex);
    const info = buildCallKeyInfo(vec.caller_to_callee_prefix, callId, callerHash, calleeHash);
    expect(info.length).toBe(CALL_KEY_INFO_LENGTH);
    expect(hexEncode(info)).toBe(vec.caller_to_callee_info_hex);
  });

  it('callee_to_caller info is 120 bytes and matches vector', () => {
    const callId = hexDecode(vec.call_id_hex);
    const callerHash = hexDecode(vec.caller_identity_hash_hex);
    const calleeHash = hexDecode(vec.callee_identity_hash_hex);
    const info = buildCallKeyInfo(vec.callee_to_caller_prefix, callId, callerHash, calleeHash);
    expect(info.length).toBe(CALL_KEY_INFO_LENGTH);
    expect(hexEncode(info)).toBe(vec.callee_to_caller_info_hex);
  });
});

describe('C-02: call_keys', () => {
  const vecInfo = v.call_key_info;
  const vecKeys = v.call_keys;

  it('derives caller_to_callee key matching vector', async () => {
    const sharedSecret = hexDecode(vecKeys.shared_secret_hex);
    const callId = hexDecode(vecInfo.call_id_hex);
    const callerHash = hexDecode(vecInfo.caller_identity_hash_hex);
    const calleeHash = hexDecode(vecInfo.callee_identity_hash_hex);

    const [c2cKey, c2rKey] = await deriveCallKeys(sharedSecret, callId, callerHash, calleeHash);
    expect(hexEncode(c2cKey)).toBe(vecKeys.caller_to_callee_key_hex);
    expect(hexEncode(c2rKey)).toBe(vecKeys.callee_to_caller_key_hex);
  });
});

describe('C-03: call_iv_prefix', () => {
  const vecKeys = v.call_keys;
  const vecIV = v.call_iv_prefix;

  it('derives 4-byte caller send prefix matching vector', async () => {
    const callerKey = hexDecode(vecKeys.caller_to_callee_key_hex);
    const prefix = await deriveCallIVPrefix(callerKey);
    expect(prefix.length).toBe(4);
    expect(hexEncode(prefix)).toBe(vecIV.caller_send_prefix_hex);
  });

  it('derives 4-byte callee send prefix matching vector', async () => {
    const calleeKey = hexDecode(vecKeys.callee_to_caller_key_hex);
    const prefix = await deriveCallIVPrefix(calleeKey);
    expect(prefix.length).toBe(4);
    expect(hexEncode(prefix)).toBe(vecIV.callee_send_prefix_hex);
  });
});

describe('C-04: call_iv', () => {
  const vec = v.call_iv;

  it('builds 12-byte IVs matching vectors at multiple sequences', () => {
    const prefix = hexDecode(vec.prefix_hex);
    for (const c of vec.cases) {
      const seq = BigInt(c.seq_bigint);
      const iv = buildCallIV(prefix, seq);
      expect(iv.length).toBe(12);
      expect(hexEncode(iv)).toBe(c.iv_hex);
    }
  });

  it('handles MAX_SAFE_INTEGER and beyond', () => {
    const prefix = hexDecode(vec.prefix_hex);
    // MAX_SAFE_INTEGER = 9007199254740991
    const iv = buildCallIV(prefix, 9007199254740991n);
    expect(iv.length).toBe(12);
    // Beyond MAX_SAFE_INTEGER
    const iv2 = buildCallIV(prefix, 9007199254740992n);
    expect(iv2.length).toBe(12);
    // Must be different
    expect(hexEncode(iv)).not.toBe(hexEncode(iv2));
  });
});

describe('C-05: call_aad', () => {
  const vec = v.call_aad;

  it('builds 26-byte AADs matching vectors for all frame types', () => {
    const callId = hexDecode(vec.call_id_hex);
    for (const c of vec.cases) {
      const aad = buildCallAAD(callId, c.frame_type, BigInt(c.seq));
      expect(aad.length).toBe(CALL_AAD_LENGTH);
      expect(hexEncode(aad)).toBe(c.aad_hex);
    }
  });
});

describe('C-11: call_replay', () => {
  const vec = v.call_replay;

  it('replay window steps match vector', () => {
    const window = new ReplayWindow();
    for (const step of vec.steps) {
      const seq = BigInt(step.seq_num);
      if (step.action === 'check') {
        const res = window.check(seq);
        expect(res).toBe(step.result);
      } else if (step.action === 'accept') {
        window.accept(seq);
        expect(window.highestSequence).toBe(BigInt(step.highest_sequence_after));
        expect(window.bitmap).toBe(BigInt(step.bitmap_after));
      }
    }
  });
});
