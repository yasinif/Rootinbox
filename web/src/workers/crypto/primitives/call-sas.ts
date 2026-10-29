/**
 * Short Authentication String (SAS).
 * Phase 12B §8.5: SAS computation for voice call verification.
 *
 * Input: callerFingerprint(32) || calleeFingerprint(32) || callId(16) = 80 bytes
 * Hash: SHA-256(input)
 * Val: first 4 bytes as BigEndian uint32
 * If Val >= 4,294,000,000 → rehash (modular reduction bias guard)
 * SAS: Val % 1,000,000 → zero-padded to 6 digits
 */

import { sha256 } from '../encoding';
import { CALL_SAS_INPUT_LENGTH, SAS_BIAS_THRESHOLD } from '../../../domain/call/constants';

/**
 * Compute the 6-digit SAS string.
 * Returns null if computation exhausts rehash attempts (extremely unlikely).
 */
export async function computeSAS(
  callerFingerprint: Uint8Array, // 32 bytes
  calleeFingerprint: Uint8Array, // 32 bytes
  callId: Uint8Array,            // 16 bytes
): Promise<string | null> {
  const input = new Uint8Array(CALL_SAS_INPUT_LENGTH);
  input.set(callerFingerprint, 0);
  input.set(calleeFingerprint, 32);
  input.set(callId, 64);

  let hashInput: Uint8Array = input;
  const MAX_REHASH = 10;

  for (let attempt = 0; attempt <= MAX_REHASH; attempt++) {
    const hash = await sha256(hashInput);
    const view = new DataView(hash.buffer, hash.byteOffset, 4);
    const val = view.getUint32(0, false); // big-endian

    if (val < SAS_BIAS_THRESHOLD) {
      const digits = (val % 1_000_000).toString().padStart(6, '0');
      return digits;
    }

    // Rehash: SHA-256(previous hash)
    hashInput = hash;
  }

  // Exhausted all attempts — extremely unlikely.
  return null;
}
