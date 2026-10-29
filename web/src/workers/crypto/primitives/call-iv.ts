/**
 * Call IV Construction.
 * Phase 12B §8.2: 12-byte IV = prefix(4) || counter(8, BigEndian).
 *
 * The 4-byte prefix is derived from HKDF(callKey, salt, "e2ee/v1/call-iv-prefix").
 * Counter is the signal sequence number (BigInt → 8-byte BE).
 */

import { deriveMessageKey } from '../hkdf';
import { CALL_IV_PREFIX_INFO } from '../../../domain/call/constants';

const textEncoder = new TextEncoder();

/**
 * Derive the 4-byte IV prefix from a directional call key.
 * Uses HKDF-SHA256 with the standard protocol salt.
 */
export async function deriveCallIVPrefix(callKey: Uint8Array): Promise<Uint8Array> {
  const info = textEncoder.encode(CALL_IV_PREFIX_INFO);
  // Derive 32 bytes then take first 4.
  const full = await deriveMessageKey(callKey, info);
  return full.slice(0, 4);
}

/**
 * Build a 12-byte IV from a 4-byte prefix and a sequence number.
 * Layout: prefix(4) || BigEndian(seq, 8) = 12 bytes.
 */
export function buildCallIV(prefix: Uint8Array, seq: bigint): Uint8Array {
  const iv = new Uint8Array(12);
  iv.set(prefix, 0);
  // BigEndian encode the 8-byte sequence.
  const view = new DataView(iv.buffer, iv.byteOffset + 4, 8);
  view.setBigUint64(0, seq, false); // false = big-endian
  return iv;
}
