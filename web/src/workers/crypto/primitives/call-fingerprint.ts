/**
 * Call Fingerprint.
 * Phase 12B §8.4: DTLS fingerprint signing/verification.
 *
 * Signing payload: "e2ee/v1/call-fingerprint" || call_id(16) || fingerprint(32) || role(1) = 73 bytes.
 * Signed with Ed25519 identity key.
 */

import { CALL_FINGERPRINT_PREFIX, CALL_FINGERPRINT_PAYLOAD_LENGTH } from '../../../domain/call/constants';

const textEncoder = new TextEncoder();

/**
 * Build the 73-byte signing payload for a call fingerprint.
 */
export function buildFingerprintPayload(
  callId: Uint8Array,      // 16 bytes
  fingerprint: Uint8Array,  // 32 bytes (SHA-256 of DTLS cert)
  roleByte: number,         // 0x01=caller, 0x02=callee
): Uint8Array {
  const prefix = textEncoder.encode(CALL_FINGERPRINT_PREFIX);
  const payload = new Uint8Array(CALL_FINGERPRINT_PAYLOAD_LENGTH);
  payload.set(prefix, 0);
  payload.set(callId, prefix.length);
  payload.set(fingerprint, prefix.length + 16);
  payload[prefix.length + 16 + 32] = roleByte;
  return payload;
}

export { parseSdpFingerprint } from '../../../domain/call/fingerprint';

