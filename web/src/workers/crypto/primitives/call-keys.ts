/**
 * Call Key Derivation.
 * Phase 12B §8.1: Directional HKDF-SHA256 keys for call signaling.
 *
 * Two keys are derived per call, one per direction:
 *   - caller→callee: info = prefix(40) || call_id(16) || callerHash(32) || calleeHash(32) = 120
 *   - callee→caller: info = prefix(40) || call_id(16) || callerHash(32) || calleeHash(32) = 120
 */

import { deriveMessageKey } from '../hkdf';
import {
  CALL_KEY_PREFIX_CALLER_TO_CALLEE,
  CALL_KEY_PREFIX_CALLEE_TO_CALLER,
  CALL_KEY_INFO_LENGTH,
} from '../../../domain/call/constants';

const textEncoder = new TextEncoder();

/**
 * Build the HKDF info for a directional call key.
 * Layout: prefix || call_id(16) || callerHash(32) || calleeHash(32) = 120 bytes.
 */
export function buildCallKeyInfo(
  prefix: string,
  callId: Uint8Array,    // 16 bytes
  callerHash: Uint8Array, // 32 bytes
  calleeHash: Uint8Array, // 32 bytes
): Uint8Array {
  const prefixBytes = textEncoder.encode(prefix);
  const info = new Uint8Array(CALL_KEY_INFO_LENGTH);
  info.set(prefixBytes, 0);
  info.set(callId, prefixBytes.length);
  info.set(callerHash, prefixBytes.length + 16);
  info.set(calleeHash, prefixBytes.length + 16 + 32);
  return info;
}

/**
 * Derive both directional call keys atomically.
 * Returns [callerToCalleeKey, calleeToCallerKey] — each 32 bytes.
 */
export async function deriveCallKeys(
  sharedSecret: Uint8Array, // 32 bytes
  callId: Uint8Array,        // 16 bytes
  callerHash: Uint8Array,    // 32 bytes
  calleeHash: Uint8Array,    // 32 bytes
): Promise<[Uint8Array, Uint8Array]> {
  const c2cInfo = buildCallKeyInfo(CALL_KEY_PREFIX_CALLER_TO_CALLEE, callId, callerHash, calleeHash);
  const c2rInfo = buildCallKeyInfo(CALL_KEY_PREFIX_CALLEE_TO_CALLER, callId, callerHash, calleeHash);

  const c2cKey = await deriveMessageKey(sharedSecret, c2cInfo);
  const c2rKey = await deriveMessageKey(sharedSecret, c2rInfo);

  return [c2cKey, c2rKey];
}
