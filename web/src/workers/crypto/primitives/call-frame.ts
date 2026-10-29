/**
 * Call Frame Seal/Open.
 * Phase 12B §8.6: Encrypt/decrypt call signaling frames.
 *
 * Uses AES-256-GCM with:
 *   Key: directional call key (32 bytes)
 *   IV: prefix(4) || seq(8) = 12 bytes
 *   AAD: version(1) || call_id(16) || frame_type(1) || seq(8) = 26 bytes
 */

import { aesGcmEncrypt, aesGcmDecrypt } from '../aes';
import { buildCallAAD } from './call-aad';
import { buildCallIV } from './call-iv';

/**
 * Seal a call signaling frame.
 * Returns the ciphertext (plaintext + 16-byte GCM tag).
 */
export async function sealCallFrame(
  key: Uint8Array,         // 32-byte directional key
  ivPrefix: Uint8Array,    // 4-byte IV prefix
  callId: Uint8Array,      // 16 bytes
  frameType: number,       // 0x01-0x07
  seq: bigint,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const iv = buildCallIV(ivPrefix, seq);
  const aad = buildCallAAD(callId, frameType, seq);
  return aesGcmEncrypt(key, iv, plaintext, aad);
}

/**
 * Open (decrypt) a call signaling frame.
 * Returns the plaintext, or throws on authentication failure.
 */
export async function openCallFrame(
  key: Uint8Array,         // 32-byte directional key
  ivPrefix: Uint8Array,    // 4-byte IV prefix
  callId: Uint8Array,      // 16 bytes
  frameType: number,       // 0x01-0x07
  seq: bigint,
  ciphertext: Uint8Array,  // includes 16-byte GCM tag
): Promise<Uint8Array> {
  const iv = buildCallIV(ivPrefix, seq);
  const aad = buildCallAAD(callId, frameType, seq);
  return aesGcmDecrypt(key, iv, ciphertext, aad);
}
