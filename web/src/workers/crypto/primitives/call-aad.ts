/**
 * Call AAD Construction.
 * Phase 12B §8.3: 26-byte AAD for call signaling frames.
 * Layout: version(1) || call_id(16) || frame_type(1) || seq(8, BE) = 26 bytes.
 */

import { CALL_AAD_LENGTH, CALL_CRYPTO_SUITE_V1 } from '../../../domain/call/constants';

/**
 * Build a 26-byte AAD for an encrypted call signaling frame.
 */
export function buildCallAAD(
  callId: Uint8Array,   // 16 bytes
  frameType: number,    // 1 byte (0x01-0x07)
  seq: bigint,
): Uint8Array {
  const aad = new Uint8Array(CALL_AAD_LENGTH);
  aad[0] = CALL_CRYPTO_SUITE_V1;
  aad.set(callId, 1);
  aad[17] = frameType;
  const view = new DataView(aad.buffer, aad.byteOffset + 18, 8);
  view.setBigUint64(0, seq, false);
  return aad;
}
