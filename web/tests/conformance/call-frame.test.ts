/**
 * Phase 12B Conformance Tests — Call Frame Seal/Open.
 */

import { describe, it, expect } from 'vitest';
import vectors from '../../src/__vectors__/crypto-vectors-v2.json';
import { sealCallFrame, openCallFrame } from '../../src/workers/crypto/primitives/call-frame';
import { hexEncode, hexDecode } from '../../src/workers/crypto/encoding';

const v = vectors.vectors;

describe('C-06: call_frame_sealed', () => {
  const vec = v.call_frame_sealed;

  it('seals a frame matching the vector ciphertext', async () => {
    const key = hexDecode(vec.key_hex);
    const callerPrefix = hexDecode(v.call_iv_prefix.caller_send_prefix_hex);
    const callId = hexDecode(v.call_aad.call_id_hex);
    const plaintext = hexDecode(vec.plaintext_hex);

    const sealed = await sealCallFrame(key, callerPrefix, callId, vec.frame_type, BigInt(vec.seq), plaintext);
    expect(hexEncode(sealed)).toBe(vec.ciphertext_hex);
  });

  it('round-trips: open(seal(plaintext)) === plaintext', async () => {
    const key = hexDecode(vec.key_hex);
    const callerPrefix = hexDecode(v.call_iv_prefix.caller_send_prefix_hex);
    const callId = hexDecode(v.call_aad.call_id_hex);
    const plaintext = hexDecode(vec.plaintext_hex);

    const sealed = await sealCallFrame(key, callerPrefix, callId, vec.frame_type, BigInt(vec.seq), plaintext);
    const opened = await openCallFrame(key, callerPrefix, callId, vec.frame_type, BigInt(vec.seq), sealed);
    expect(hexEncode(opened)).toBe(vec.plaintext_hex);
  });

  it('open with wrong key throws', async () => {
    const wrongKey = new Uint8Array(32);
    const callerPrefix = hexDecode(v.call_iv_prefix.caller_send_prefix_hex);
    const callId = hexDecode(v.call_aad.call_id_hex);
    const ciphertext = hexDecode(vec.ciphertext_hex);

    await expect(openCallFrame(wrongKey, callerPrefix, callId, vec.frame_type, BigInt(vec.seq), ciphertext))
      .rejects.toThrow('decryption failed');
  });

  it('open with wrong seq throws', async () => {
    const key = hexDecode(vec.key_hex);
    const callerPrefix = hexDecode(v.call_iv_prefix.caller_send_prefix_hex);
    const callId = hexDecode(v.call_aad.call_id_hex);
    const ciphertext = hexDecode(vec.ciphertext_hex);

    await expect(openCallFrame(key, callerPrefix, callId, vec.frame_type, BigInt(2), ciphertext))
      .rejects.toThrow('decryption failed');
  });
});
